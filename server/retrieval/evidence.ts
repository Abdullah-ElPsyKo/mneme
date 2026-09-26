import { projectState, projectStates, type Memory, type SearchHit } from '../core/types.js';
import { parseQuery } from './search.js';

const stop = new Set(
  'what who where when why how is are was were be been am i me my mine you your yours the a an and or of to for in on with from it its this that these those do does did have has had can could would should please tell about know recorded remember information currently really exactly purpose define definition describe explanation explain'.split(
    ' ',
  ),
);
const forms: Record<string, string> = {
  tasks: 'task',
  projects: 'project',
  goals: 'goal',
  objectives: 'goal',
  objective: 'goal',
  priorities: 'goal',
  priority: 'goal',
  maximum: 'max',
  minimum: 'min',
  pricing: 'price',
  prices: 'price',
  budget: 'price',
  configuration: 'hardware',
  specifications: 'hardware',
  specs: 'hardware',
  computer: 'hardware',
  pc: 'hardware',
  completed: 'completed',
  complete: 'completed',
  finished: 'completed',
  done: 'completed',
  planning: 'planned',
  discontinued: 'abandoned',
  actively: 'active',
  working: 'active',
  work: 'active',
  current: 'active',
  chosen: 'select',
  choice: 'select',
  selected: 'select',
  selection: 'select',
  choose: 'select',
  robotic: 'robot',
  robotics: 'robot',
  memories: 'memory',
  uses: 'use',
  using: 'use',
  secured: 'security',
  secure: 'security',
};
export function terms(text: string): string[] {
  const normalized = text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’](s|re|ve|ll|d|m)\b/g, ' ')
    .replace(/\bproject\s+([a-z0-9])\b/g, 'project$1');
  return [
    ...new Set(
      (normalized.match(/[\p{L}\p{N}]+/gu) || []).filter((t) => !stop.has(t)).map((t) => forms[t] || t),
    ),
  ];
}
export function askIntent(query: string) {
  // Remove a conversational greeting only in greeting position, preserving named recall (e.g. CHIEF).
  const text = parseQuery(query).text.replace(/^ok(?:ay)?[\s,!]+(?:chief[\s,!]+)?/i, '');
  const words = terms(text).filter((w) => !['our', 'any', 'we', 'us'].includes(w));
  const overviewWords = new Set([
    'project',
    'task',
    'goal',
    'active',
    'completed',
    'planned',
    'paused',
    'abandoned',
    'roadmap',
    'history',
    'lifecycle',
    'status',
    'which',
    'list',
    'all',
    'technical',
    'development',
  ]);
  return {
    words,
    projects: words.includes('project') && words.every((w) => overviewWords.has(w)),
    tasks: words.includes('task'),
    goals: words.includes('goal'),
  };
}
export function queryVariants(query: string) {
  const words = askIntent(query).words;
  return [...words, ...Object.keys(forms).filter((key) => words.includes(forms[key]))];
}
export function factText(memory: Memory) {
  return (memory.facts || []).map((f) => `${f.key.replace(/[._-]/g, ' ')}: ${f.value}`).join('\n');
}
export function embeddingText(memory: Memory) {
  return `${memory.title}\n${memory.type} · ${projectState(memory) || memory.status} · ${memory.project}\n${memory.body}\n${factText(memory)}`;
}

// Candidate rank is deliberately not a relevance threshold: RRF, age, authority and
// graph degree can rank a weak match highly. Evaluate contribution before those boosts.
const overviewWordsForGoals = new Set([
  'goal',
  'task',
  'project',
  'active',
  'technical',
  'development',
  'list',
  'all',
  'which',
]);
export function selectEvidence(query: string, candidates: SearchHit[]) {
  const parsed = parseQuery(query),
    intent = askIntent(query),
    words = intent.words;
  const requestedStates = projectStates.filter((state) => words.includes(state));
  const lifecycleMatches = (memory: Memory) =>
    !intent.projects ||
    requestedStates.length !== 1 ||
    memory.type !== 'project' ||
    projectState(memory) === requestedStates[0];
  const documents = candidates.map((hit) => ({
    hit,
    words: new Set(
      terms(
        `${hit.memory.title} ${hit.memory.body} ${hit.memory.project} ${hit.memory.type} ${projectState(hit.memory) || hit.memory.status} ${hit.memory.tags.join(' ')} ${factText(hit.memory)} ${(
          hit.graph_links || []
        )
          .filter((link) =>
            terms(link.relationship).some(
              (word) => words.includes(word) && !['related', 'references'].includes(word),
            ),
          )
          .map((link) => `${link.from} ${link.to} ${link.relationship}`)
          .join(' ')}`,
      ),
    ),
    header: new Set(terms(`${hit.memory.title} ${hit.memory.project} ${factText(hit.memory)}`)),
  }));
  const weights = new Map(
    words.map((word) => [
      word,
      1 + Math.log(1 + documents.length / (1 + documents.filter((d) => d.words.has(word)).length)),
    ]),
  );
  const total = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  const strongLexical = documents.some(
    (d) => words.reduce((sum, word) => sum + (d.words.has(word) ? weights.get(word)! : 0), 0) / total >= 0.8,
  );
  // Explicit named project scopes are stronger than a loosely related embedding/edge.
  const anchors: string[][] = [];
  for (const { hit } of documents) {
    const labels = [hit.memory.project, ...(hit.memory.type === 'project' ? [hit.memory.title] : [])];
    for (const label of labels) {
      const name = terms(label).filter((w) => !['project', 'active', 'completed', 'technical'].includes(w));
      if (
        name.length &&
        name.every((w) => words.includes(w)) &&
        !anchors.some((a) => a.join(' ') === name.join(' '))
      )
        anchors.push(name);
    }
  }
  const identifiers = words.filter((w) => /\d{2,}/.test(w));
  const bestSemantic = Math.max(0, ...candidates.map((h) => h.semantic_similarity || 0));
  const accepted: { hit: SearchHit; relevance: number }[] = [],
    omitted: { id: string; reason: string }[] = [];
  for (const document of documents) {
    const { hit } = document;
    if (!lifecycleMatches(hit.memory)) {
      omitted.push({ id: hit.memory.id, reason: 'project lifecycle does not match requested work' });
      continue;
    }
    const coverage =
      words.reduce((sum, word) => sum + (document.words.has(word) ? weights.get(word)! : 0), 0) / total;
    const header = words.filter((w) => document.header.has(w)).length / Math.max(1, words.length);
    const inScope =
      (!anchors.length || anchors.some((name) => name.every((w) => document.words.has(w)))) &&
      identifiers.every((w) => document.words.has(w));
    const multiTopic = anchors.length > 1 && anchors.some((name) => name.every((w) => document.words.has(w)));
    const semantic =
      (hit.semantic_similarity || 0) >= Math.max(0.62, bestSemantic - 0.08) &&
      (!strongLexical || coverage >= 0.4);
    const metadataOnly = !parsed.text && Object.keys(parsed.filters).length > 0;
    const projectOverview = intent.projects && hit.memory.type === 'project';
    const goalOverview =
      intent.goals && hit.memory.type === 'goal' && words.every((w) => overviewWordsForGoals.has(w));
    const lexical = words.length > 0 && coverage >= 0.6;
    if (
      inScope &&
      (metadataOnly ||
        projectOverview ||
        goalOverview ||
        multiTopic ||
        (!intent.projects && (lexical || semantic)))
    )
      accepted.push({
        hit,
        relevance: coverage * 2 + header + (projectOverview ? 1 : 0) + Math.min(hit.score, 0.1),
      });
    else omitted.push({ id: hit.memory.id, reason: 'insufficient question relevance' });
  }
  // Keep another current claim about a relevant selected fact even when its prose is different.
  const keys = new Set(
    accepted
      .flatMap(({ hit }) => hit.memory.facts || [])
      .filter((f) => terms(f.key).some((w) => words.includes(w)))
      .map((f) => f.key),
  );
  for (const { hit } of documents)
    if (
      !accepted.some((a) => a.hit.memory.id === hit.memory.id) &&
      lifecycleMatches(hit.memory) &&
      (hit.memory.facts || []).some((f) => keys.has(f.key))
    ) {
      accepted.push({ hit, relevance: 1 });
      const at = omitted.findIndex((o) => o.id === hit.memory.id);
      if (at >= 0) omitted.splice(at, 1);
    }
  // An unprocessed future idea does not establish a selected choice when explicit
  // current facts already answer that choice. Keep ideas for questions about plans.
  if (
    words.includes('select') &&
    !words.includes('future') &&
    !words.includes('idea') &&
    accepted.some(
      ({ hit }) => hit.memory.status !== 'inbox' && (hit.memory.facts || []).some((f) => keys.has(f.key)),
    )
  ) {
    for (let i = accepted.length - 1; i >= 0; i--)
      if (accepted[i].hit.memory.status === 'inbox' && accepted[i].hit.memory.type === 'idea') {
        omitted.push({
          id: accepted[i].hit.memory.id,
          reason: 'future idea does not establish the recorded choice',
        });
        accepted.splice(i, 1);
      }
  }
  return {
    hits: accepted.sort((a, b) => b.relevance - a.relevance || b.hit.score - a.hit.score).map((a) => a.hit),
    omitted,
  };
}
