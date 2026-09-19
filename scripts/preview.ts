import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Brain } from '../server/app.js';
import { serve } from '../server/api/server.js';
const root = resolve(process.env.MNEME_PREVIEW_BRAIN || '.test-brains/visual-review');
const brain = new Brain(root);
if (!brain.status().memories) {
  brain.settings.update({
    ...brain.settings.data,
    name: 'Design review · test data',
    onboarded: true,
    reduced_motion: true,
  });
  const project = brain.memories.save({
    title: 'FORGELINE',
    type: 'project',
    project: 'FORGELINE',
    body: '# Infrastructure, built with intent\n\nA **test fixture** for visual and functional verification. This is not the user’s real project history.\n\n## Current direction\nA resilient identity foundation, clear management boundaries, and repeatable recovery.\n\n## Architecture\nTwo domain controllers provide DNS and directory services. Administrative access originates from a dedicated management host.\n\n## Open questions\n- Confirm the recovery procedure.\n- Document the next deployment decision.',
    tags: ['infrastructure', 'homelab'],
    importance: 1,
  });
  const systems = brain.memories.save({
    title: 'Operating systems',
    type: 'project',
    body: '# Systems notebook\n\nTest fixture: observations about memory, processes, and scheduling.',
    tags: ['programming', 'research'],
    importance: 0.9,
  });
  const desk = brain.memories.save({
    title: 'Studio refresh',
    type: 'project',
    body: 'Test fixture: a quieter workspace and more deliberate tools.',
    tags: ['personal'],
    importance: 0.8,
  });
  const entries = [
    [
      'Administrative RDP boundary',
      'decision',
      'FORGELINE',
      'Restrict administrative RDP to MGMT01.\n\nThe **FL - Allow RDP TCP from MGMT** policy reduces the number of management entry points. This was chosen so access is easier to audit and unintended lateral movement is constrained.\n\nTest fixture, not an assertion about the user’s infrastructure.',
    ],
    [
      'Directory recovery procedure',
      'procedure',
      'FORGELINE',
      '1. Validate the backup.\n2. Restore to an isolated network.\n3. Verify replication before reconnecting.\n\nTest fixture.',
    ],
    [
      'DNS failover validation',
      'note',
      'FORGELINE',
      'Test fixture: record the results of a controlled failover and the observed recovery time.',
    ],
    [
      'Network segmentation',
      'concept',
      '',
      'Keep management traffic separate from everyday client access. Test fixture.',
    ],
    [
      'Least privilege',
      'concept',
      '',
      'Grant the smallest set of permissions required by a task. Test fixture.',
    ],
    [
      'Virtual memory',
      'concept',
      '',
      'An address space connects the process view of memory to physical storage. Test fixture.',
    ],
    [
      'Process scheduling',
      'note',
      'Operating systems',
      'Explore fairness, latency, and throughput tradeoffs. Test fixture.',
    ],
    [
      'Build something understandable',
      'idea',
      '',
      'Systems become easier to trust when their state is inspectable. Test fixture.',
    ],
    [
      'A weekly review',
      'procedure',
      '',
      'Review open tasks, unresolved decisions, and new captures. Test fixture.',
    ],
    [
      'Keep an architecture journal',
      'goal',
      '',
      'Record the reason behind a decision while the context is still fresh. Test fixture.',
    ],
    [
      'Quiet input devices',
      'note',
      'Studio refresh',
      'Research a more comfortable desk setup. Test fixture.',
    ],
    [
      'Capture before organizing',
      'policy',
      '',
      'Store the thought immediately, then connect it to a project later. Test fixture.',
    ],
  ];
  const memories: Record<string, any> = {
    FORGELINE: project,
    'Operating systems': systems,
    'Studio refresh': desk,
  };
  for (const [title, type, projectName, body] of entries)
    memories[title] = brain.memories.save({
      title,
      type,
      project: projectName,
      body,
      tags: projectName ? [projectName.toLowerCase().replaceAll(' ', '-')] : [],
      importance: 0.6,
    });
  for (const [name, type] of [
    ['DC01', 'device'],
    ['DC02', 'device'],
    ['MGMT01', 'device'],
    ['Active Directory', 'technology'],
    ['DNS', 'technology'],
    ['Group Policy', 'technology'],
    ['C++', 'technology'],
    ['Rust', 'technology'],
  ])
    memories[name] = brain.graph.entity({ name, type });
  for (const [from, to, type] of [
    ['FORGELINE', 'DC01', 'contains'],
    ['FORGELINE', 'DC02', 'contains'],
    ['FORGELINE', 'MGMT01', 'management_origin'],
    ['FORGELINE', 'Active Directory', 'uses'],
    ['FORGELINE', 'Group Policy', 'secured_by'],
    ['DC01', 'DNS', 'runs'],
    ['DC02', 'DNS', 'runs'],
    ['FORGELINE', 'Administrative RDP boundary', 'documented_by'],
    ['Administrative RDP boundary', 'MGMT01', 'requires'],
    ['Administrative RDP boundary', 'Least privilege', 'motivated_by'],
    ['FORGELINE', 'Directory recovery procedure', 'documented_by'],
    ['FORGELINE', 'DNS failover validation', 'documented_by'],
    ['Group Policy', 'Network segmentation', 'enforces'],
    ['Operating systems', 'C++', 'uses'],
    ['Operating systems', 'Rust', 'uses'],
    ['Operating systems', 'Virtual memory', 'requires_knowledge'],
    ['Operating systems', 'Process scheduling', 'contains'],
    ['Studio refresh', 'Quiet input devices', 'contains'],
    ['A weekly review', 'Keep an architecture journal', 'supports'],
    ['Capture before organizing', 'Build something understandable', 'supports'],
  ])
    brain.graph.link({ from_id: memories[from].id, to_id: memories[to].id, type });
  brain.structured.task({ title: 'Write down the restore procedure', project: 'FORGELINE' });
  brain.structured.task({ title: 'Review the architecture journal', status: 'doing', project: 'FORGELINE' });
  brain.ingestion.capture('Test fixture: remember why the management boundary exists.');
  brain.ingestion.file(
    'architecture-reference.md',
    Buffer.from(
      '# Architecture reference\n\nTest fixture: preserve the original rationale for the management network.',
    ),
  );
  brain.memories.save(
    {
      ...brain.memories.input(project),
      body:
        project.body +
        '\n\n## Revision\nTest fixture: DNS failover validation added to the current project record.',
    },
    project.id,
  );
}
const server = await serve(brain, { port: Number(process.env.MNEME_PREVIEW_PORT || 4590) });
mkdirSync('artifacts', { recursive: true });
writeFileSync(
  'artifacts/preview-session.json',
  JSON.stringify({ url: server.url, origin: server.origin, token: server.token, root }),
);
console.log(JSON.stringify({ url: server.url, root }));
let closed = false;
const close = async () => {
  if (closed) return;
  closed = true;
  await server.close();
  process.exit(0);
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
