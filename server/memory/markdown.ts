import { parseDocument, stringify } from 'yaml';
import { AppError, type Memory } from '../core/types.js';
export function readMarkdown(text: string): { metadata: Record<string, any>; body: string } {
  const normal = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normal.startsWith('---\n')) return { metadata: {}, body: normal };
  const end = normal.indexOf('\n---', 4);
  if (end < 0 || !/^(\n|$)/.test(normal.slice(end + 4, end + 5)))
    throw new AppError(400, 'Unclosed YAML frontmatter');
  if (end > 65536) throw new AppError(400, 'Frontmatter exceeds 64 KiB');
  const document = parseDocument(normal.slice(4, end), { uniqueKeys: true });
  if (document.errors.length)
    throw new AppError(400, `Invalid YAML frontmatter: ${document.errors[0].message.split('\n')[0]}`);
  let metadata: any;
  try {
    metadata = document.toJS({ maxAliasCount: 20 }) || {};
  } catch {
    throw new AppError(400, 'Unsafe YAML alias expansion');
  }
  if (typeof metadata !== 'object' || Array.isArray(metadata))
    throw new AppError(400, 'Frontmatter must be a mapping');
  for (const key of ['__proto__', 'constructor', 'prototype'])
    if (Object.hasOwn(metadata, key)) throw new AppError(400, 'Reserved frontmatter key');
  return { metadata, body: normal.slice(end + 4).replace(/^\n/, '') };
}
export function writeMarkdown(memory: Omit<Memory, 'content_hash'> | Memory) {
  const { body, content_hash, path, ...frontmatter } = memory as Memory;
  const yaml = stringify(frontmatter, { lineWidth: 0 });
  if (yaml.length + 4 > 65536)
    throw new AppError(400, 'Memory metadata and facts exceed the 64 KiB frontmatter limit');
  return `---\n${yaml}---\n${body}`;
}
export function importedFields(metadata: Record<string, any>) {
  const allowed = [
    'title',
    'type',
    'memory_class',
    'status',
    'tags',
    'project',
    'importance',
    'private',
    'valid_from',
    'valid_until',
    'supersedes',
    'fact_key',
    'fact_value',
    'facts',
  ];
  const fields: Record<string, any> = {};
  for (const name of allowed) if (Object.hasOwn(metadata, name)) fields[name] = metadata[name];
  return fields;
}
