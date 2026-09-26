import type { Storage } from '../storage/database.js';
import type { ContextPackage } from '../context/compiler.js';
import { activeObject } from '../memory/lifecycle.js';
import { now, parse } from '../core/util.js';
import { askIntent } from './evidence.js';
import { parseQuery } from './search.js';

// Explicit task-domain routing. Residual words scope title/project instead of dumping all tasks.
export function taskEvidence(storage: Storage, query: string): ContextPackage['evidence'] {
  const intent = askIntent(query),
    parsed = parseQuery(query);
  if (!intent.tasks) return [];
  // Memory-specific operators have no task equivalent; do not silently ignore them.
  if (Object.keys(parsed.filters).some((key) => !['project', 'status', 'type'].includes(key))) return [];
  if (parsed.filters.type && parsed.filters.type !== 'task') return [];
  const neutral = new Set([
    'task',
    'goal',
    'project',
    'list',
    'all',
    'which',
    'status',
    'active',
    'open',
    'doing',
    'completed',
    'cancelled',
    'unfinished',
    'pending',
  ]);
  const scope = intent.words.filter((w) => !neutral.has(w));
  if (scope.length > 40) return []; // Avoid partially applying an overlong scope.
  const explicitStatuses = ['open', 'doing', 'cancelled', 'completed']
    .filter((status) => intent.words.includes(status))
    .map((status) => (status === 'completed' ? 'done' : status));
  const statuses = intent.words.includes('all')
    ? ['open', 'doing', 'done', 'cancelled']
    : explicitStatuses.length
      ? explicitStatuses
      : ['open', 'doing'];
  if (parsed.filters.status) {
    if (!['open', 'doing', 'done', 'cancelled'].includes(parsed.filters.status)) return [];
    statuses.splice(0, statuses.length, parsed.filters.status);
  }
  const conditions = [
    activeObject('task', 't.id'),
    `t.status IN (${statuses.map(() => '?').join(',')})`,
    // Tasks have no private flag. A linked memory must be eligible; its privacy wins.
    `(t.memory_id IS NULL OR EXISTS (SELECT 1 FROM memories m WHERE m.id=t.memory_id AND m.private=0 AND m.status!='archived' AND m.valid_from<=? AND (m.valid_until IS NULL OR m.valid_until>?) AND NOT EXISTS (SELECT 1 FROM memories n WHERE n.supersedes=m.id AND n.status!='archived' AND n.valid_from<=? AND (n.valid_until IS NULL OR n.valid_until>?))))`,
  ];
  const at = now(),
    args: string[] = [...statuses, at, at, at, at];
  if (parsed.filters.project) {
    conditions.push('t.project=? COLLATE NOCASE');
    args.push(parsed.filters.project);
  }
  // Provenance may link a task to a memory even when memory_id is absent.
  conditions.push(
    `NOT EXISTS (SELECT 1 FROM json_each(t.provenance,'$.evidence') ref JOIN memories m ON m.id=ref.value WHERE m.private=1 OR m.status='archived' OR m.valid_from>? OR (m.valid_until IS NOT NULL AND m.valid_until<=?) OR EXISTS (SELECT 1 FROM memories n WHERE n.supersedes=m.id AND n.status!='archived' AND n.valid_from<=? AND (n.valid_until IS NULL OR n.valid_until>?)))`,
  );
  args.push(at, at, at, at);
  for (const word of scope) {
    conditions.push("(lower(t.title) LIKE ? ESCAPE '\\' OR lower(t.project) LIKE ? ESCAPE '\\')");
    const value = '%' + word.replace(/[\\%_]/g, '\\$&') + '%';
    args.push(value, value);
  }
  return storage.db
    .prepare(
      `SELECT t.* FROM tasks t WHERE ${conditions.join(' AND ')} ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 ELSE 2 END,t.due_at IS NULL,t.due_at,t.updated_at DESC,t.id LIMIT 20`,
    )
    .all(...args)
    .map((row) => ({
      citation: '',
      source_kind: 'task',
      task_id: String(row.id),
      memory_id: row.memory_id ? String(row.memory_id) : null,
      title: String(row.title),
      type: 'task',
      status: String(row.status),
      project: String(row.project),
      due_at: row.due_at ? String(row.due_at) : null,
      current: true,
      text: String(row.title),
      provenance: parse(row.provenance),
      updated_at: String(row.updated_at),
      version: Number(row.version),
    }));
}
