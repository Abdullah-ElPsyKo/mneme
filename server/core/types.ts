import { z } from 'zod';

export const provenanceSchema = z
  .object({
    kind: z.enum(['user', 'import', 'observation', 'software', 'ai', 'summary', 'derived']).default('user'),
    actor: z.string().max(200).default('user'),
    source_id: z.string().max(100).optional(),
    source_location: z.string().max(2000).optional(),
    confidence: z.number().min(0).max(1).optional(),
    extraction_method: z.string().max(200).optional(),
    model: z.string().max(200).optional(),
    parent_event: z.string().max(100).optional(),
    evidence: z.array(z.string().max(100)).max(100).default([]),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;
export const projectStates = ['planned', 'active', 'paused', 'completed', 'abandoned'] as const;
export type ProjectState = (typeof projectStates)[number];
// Legacy revisions have no lifecycle field. Interpret their explicit status without rewriting history.
export function projectState(memory: {
  type: string;
  status: string;
  project_state?: ProjectState | null;
}): ProjectState | null {
  if (memory.type !== 'project') return null;
  return (
    memory.project_state ??
    (memory.status === 'completed' ? 'completed' : memory.status === 'active' ? 'active' : 'planned')
  );
}
export const memorySchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    body: z.string().max(2_000_000).default(''),
    type: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,39}$/)
      .default('note'),
    memory_class: z.enum(['semantic', 'episodic', 'procedural', 'working', 'preference']).default('semantic'),
    status: z.enum(['active', 'inbox', 'archived', 'completed']).default('active'),
    project_state: z.enum(projectStates).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    project: z.string().max(240).default(''),
    importance: z.number().min(0).max(1).default(0.5),
    private: z.boolean().default(false),
    valid_from: z.string().datetime().optional(),
    valid_until: z.string().datetime().nullable().default(null),
    supersedes: z.string().max(100).nullable().default(null),
    fact_key: z.string().max(240).default(''),
    fact_value: z.string().max(10000).default(''),
    facts: z
      .array(z.object({ key: z.string().trim().min(1).max(240), value: z.string().max(10000) }).strict())
      .max(100)
      .optional(),
    provenance: provenanceSchema.default({ kind: 'user', actor: 'user', evidence: [] }),
    expected_version: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((memory, ctx) => {
    if (memory.type !== 'project' && memory.project_state != null)
      ctx.addIssue({
        code: 'custom',
        path: ['project_state'],
        message: 'Only projects have a lifecycle state',
      });
  })
  .transform((memory) => {
    const facts =
      memory.facts ?? (memory.fact_key ? [{ key: memory.fact_key, value: memory.fact_value }] : []);
    return { ...memory, facts, fact_key: facts[0]?.key || '', fact_value: facts[0]?.value || '' };
  });
export type MemoryInput = z.input<typeof memorySchema>;
export type Memory = Omit<z.infer<typeof memorySchema>, 'expected_version'> & {
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  path: string;
  content_hash: string;
};
export type Entity = {
  id: string;
  name: string;
  type: string;
  created_at: string;
  updated_at: string;
  provenance: Provenance;
  memory_id: string | null;
  properties: Record<string, unknown>;
};
export type Relationship = {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  provenance: Provenance;
  created_at: string;
  valid_from: string;
  valid_until: string | null;
};
export type Event = {
  seq: number;
  id: string;
  kind: string;
  aggregate_id: string;
  at: string;
  actor: string;
  provenance: Provenance;
  payload: any;
  supersedes: string | null;
};
export type SearchHit = {
  memory: Memory;
  score: number;
  signals: string[];
  excerpt: string;
  matched_entities: string[];
  semantic_similarity?: number;
  graph_links?: {
    id: string;
    from_id: string;
    to_id: string;
    from: string;
    to: string;
    relationship: string;
  }[];
};
export type Job = {
  id: string;
  type: string;
  payload: any;
  status: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  run_at: string;
  error: string | null;
};
export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
