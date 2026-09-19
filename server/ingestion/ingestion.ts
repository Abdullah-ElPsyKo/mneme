import { extname } from 'node:path';
import { TextDecoder } from 'node:util';
import { AppError } from '../core/types.js';
import { Objects } from './objects.js';
import { importedFields, readMarkdown } from '../memory/markdown.js';
import type { Memories } from '../memory/memories.js';
export class Ingestion {
  readonly objects: Objects;
  constructor(readonly memories: Memories) {
    this.objects = memories.objects;
  }
  file(name: string, bytes: Uint8Array, mime?: string) {
    const source = this.objects.put(name, bytes, mime || 'application/octet-stream');
    if (source.duplicate && source.memory_id)
      return { source, memory: this.memories.get(source.memory_id), duplicate: true };
    const ext = extname(name).toLowerCase();
    const textTypes = new Set([
      '.md',
      '.markdown',
      '.txt',
      '.log',
      '.json',
      '.csv',
      '.tsv',
      '.xml',
      '.yaml',
      '.yml',
      '.py',
      '.js',
      '.ts',
      '.tsx',
      '.jsx',
      '.rs',
      '.c',
      '.cpp',
      '.h',
      '.sh',
      '.ps1',
      '.sql',
      '.ini',
      '.conf',
      '.html',
      '.css',
    ]);
    let body: string,
      fields: Record<string, any> = {},
      extracted = false;
    if (textTypes.has(ext) || mime?.startsWith('text/')) {
      if (bytes.length > 2_000_000)
        body = `# ${source.name}\n\nOriginal text preserved (${source.size} bytes). This file exceeds the 2 MB text extraction limit. Download the original from Sources.`;
      else {
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          throw new AppError(400, 'Text is not valid UTF-8. Original bytes were preserved in Sources.');
        }
        if (ext === '.md' || ext === '.markdown') {
          const parsed = readMarkdown(body);
          fields = importedFields(parsed.metadata);
          body = parsed.body;
        }
        extracted = true;
      }
    } else
      body = `# ${source.name}\n\nOriginal file preserved in Sources.\n\n- Size: ${source.size} bytes\n- SHA-256: ${source.hash}\n\nText extraction is not available for this format. The original is stored unchanged.`;
    const memory = this.memories.save({
      title: fields.title || body.match(/^#\s+(.+)$/m)?.[1] || source.name,
      type: 'document',
      status: 'inbox',
      ...fields,
      body,
      provenance: {
        kind: 'import',
        actor: 'user',
        source_id: source.id,
        source_location: source.name,
        extraction_method: extracted ? 'utf8-text' : 'original-only',
        evidence: [source.id],
      },
    });
    this.memories.storage.db
      .prepare('UPDATE sources SET memory_id=?,metadata=? WHERE id=?')
      .run(
        memory.id,
        JSON.stringify({ extracted, extraction_method: extracted ? 'utf8-text' : 'original-only' }),
        source.id,
      );
    this.memories.events.append(
      'source.imported',
      source.id,
      { memory_id: memory.id, hash: source.hash, size: source.size, extracted },
      memory.provenance,
    );
    return { source: this.objects.get(source.id), memory, duplicate: false };
  }
  capture(text: string) {
    if (!text.trim()) throw new AppError(400, 'Capture cannot be empty');
    return this.memories.save({
      title: text.trim().split('\n')[0].slice(0, 100),
      body: text,
      status: 'inbox',
      type: 'capture',
      memory_class: 'episodic',
    });
  }
}
