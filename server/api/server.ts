import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Brain } from '../app.js';
import { AppError, memorySchema } from '../core/types.js';
import { inside } from '../core/util.js';
import { restoreBackup, verifyBackup } from '../backup/backup.js';
import { citationWarning } from '../context/compiler.js';
import { assertErasureComplete } from '../memory/erasure.js';
import { askSystem, noRecordedAnswer } from '../context/style.js';
const askSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    use_model: z.boolean().default(false),
    semantic: z.boolean().default(false),
    cloud_consent: z.boolean().default(false),
    conversation_id: z.string().min(1).max(100).optional(),
  })
  .strict();
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
async function body(req: IncomingMessage, max = 3_000_000) {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new AppError(415, 'Use application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new AppError(413, 'Request body exceeds limit');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'Invalid JSON');
  }
}
export async function serve(brain: Brain, options: { port?: number; dev?: boolean; desktop?: boolean } = {}) {
  const token = randomBytes(32).toString('hex'),
    sessions = new Map<string, number>();
  let origin = '';
  let activeRequests = 0;
  let drained: (() => void) | undefined;
  let vite: any;
  if (options.dev) {
    const { createServer: createVite } = await import('vite');
    vite = await createVite({
      configFile: resolve('vite.config.ts'),
      server: { middlewareMode: true, hmr: false },
      appType: 'custom',
    });
  }
  const uiRoot = options.dev
    ? resolve('ui')
    : resolve(
        dirname(fileURLToPath(import.meta.url)),
        import.meta.url.endsWith('.ts') ? '../../dist/ui' : '../../ui',
      );
  const json = (res: ServerResponse, data: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    activeRequests++;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'${options.dev ? " 'unsafe-inline'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${options.desktop ? ' ipc: http://ipc.localhost' : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
    );
    try {
      if (req.headers.host !== new URL(origin).host) throw new AppError(403, 'Invalid Host header');
      if (req.headers.origin && req.headers.origin !== origin)
        throw new AppError(403, 'Cross-origin requests are blocked');
      if (req.headers['sec-fetch-site'] === 'cross-site')
        throw new AppError(403, 'Cross-site requests are blocked');
      const url = new URL(req.url || '/', origin),
        path = decodeURIComponent(url.pathname),
        method = req.method || 'GET';
      if (path === '/api/session' && method === 'POST') {
        const data = z
          .object({ token: z.string().max(200) })
          .strict()
          .parse(await body(req));
        if (!sameSecret(data.token, token)) throw new AppError(401, 'Invalid local session key');
        if (sessions.size > 100) sessions.clear();
        const session = randomBytes(32).toString('hex');
        sessions.set(session, Date.now());
        res.setHeader(
          'Set-Cookie',
          `mneme_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`,
        );
        return json(res, { ok: true });
      }
      if (path.startsWith('/api/')) {
        const bearer = req.headers.authorization?.replace(/^Bearer /, '') || '';
        const cookie =
          req.headers.cookie
            ?.split(';')
            .map((c) => c.trim())
            .find((c) => c.startsWith('mneme_session='))
            ?.slice(14) || '';
        const sessionAt = sessions.get(cookie);
        if (!sameSecret(bearer, token) && (!sessionAt || Date.now() - sessionAt > 7 * 86400000))
          throw new AppError(401, 'Open the session link printed by the local service');
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw new AppError(405, 'Unsupported method');
        assertErasureComplete(brain.storage);
        if (path === '/api/live' && method === 'GET') {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Connection', 'keep-alive');
          res.write(': connected\n\n');
          const listener = () => res.write('data: {}\n\n');
          brain.jobs.on('change', listener);
          res.on('close', () => brain.jobs.off('change', listener));
          return;
        }
        const query = Object.fromEntries(url.searchParams);
        const paging = {
          limit: Math.min(Math.max(Number(query.limit) || 100, 1), 500),
          offset: Math.min(Math.max(Number(query.offset) || 0, 0), 1000000),
        };
        if (!Number.isInteger(paging.limit) || !Number.isInteger(paging.offset))
          throw new AppError(400, 'Pagination must use integers');
        if (path === '/api/status' && method === 'GET') return json(res, brain.status());
        if (path === '/api/settings' && method === 'GET') return json(res, brain.settings.public());
        if (path === '/api/settings' && method === 'PUT') {
          const data = brain.settings.update(await body(req));
          brain.jobs.wake();
          if (options.desktop) brain.jobs.emit('change');
          return json(res, brain.settings.public());
        }
        if (path === '/api/settings/key' && method === 'PUT') {
          const data = z
            .object({ key: z.string().max(10000) })
            .strict()
            .parse(await body(req));
          brain.settings.secret(data.key);
          return json(res, { configured: true });
        }
        if (path === '/api/memory-options' && method === 'GET') {
          const q = `%${(query.q || '').slice(0, 240).replace(/[\\%_]/g, '\\$&')}%`;
          return json(
            res,
            brain.storage.db
              .prepare(
                `WITH RECURSIVE descendants(id) AS (
            SELECT id FROM memories WHERE id=? UNION SELECT m.id FROM memories m JOIN descendants d ON m.supersedes=d.id
          ) SELECT m.id,m.title,m.project,m.updated_at,m.status,
            EXISTS(SELECT 1 FROM memories n WHERE n.supersedes=m.id AND n.status!='archived') AS superseded
            FROM memories m WHERE m.status!='archived' AND m.id NOT IN (SELECT id FROM descendants)
            AND (m.title LIKE ? ESCAPE '\\' OR m.project LIKE ? ESCAPE '\\')
            ORDER BY (m.project=? AND m.project!='') DESC,m.updated_at DESC,m.id LIMIT 20`,
              )
              .all(query.exclude || '', q, q, query.project || ''),
          );
        }
        const permanent = path.match(/^\/api\/permanent-deletion\/([\w-]+)$/);
        if (permanent && method === 'GET') return json(res, brain.deletion.permanentPreview(permanent[1]));
        if (permanent && method === 'DELETE')
          return json(res, brain.deletion.permanent(permanent[1], await body(req)));
        if (path === '/api/memories' && method === 'GET')
          return json(
            res,
            brain.memories.list({
              ...paging,
              type: query.type,
              status: query.status,
              project: query.project,
              includeArchived: query.archived === 'true',
            }),
          );
        if (path === '/api/memories' && method === 'POST')
          return json(res, brain.memories.save(memorySchema.parse(await body(req))), 201);
        const memory = path.match(/^\/api\/memories\/([\w-]+)$/);
        const deletion = path.match(/^\/api\/deletion\/([a-z]+)\/([\w-]+)$/);
        if (deletion && method === 'GET') return json(res, brain.deletion.preview(deletion[1], deletion[2]));
        if (deletion && method === 'DELETE')
          return json(res, brain.deletion.remove(deletion[1], deletion[2], await body(req)));
        if (memory && method === 'GET')
          return json(
            res,
            brain.memories.get(memory[1], query.at ? z.string().datetime().parse(query.at) : undefined),
          );
        if (memory && method === 'PUT')
          return json(res, brain.memories.save(memorySchema.parse(await body(req)), memory[1]));
        if (path === '/api/capture' && method === 'POST') {
          const data = z
            .object({ text: z.string().max(2_000_000) })
            .strict()
            .parse(await body(req));
          return json(res, brain.ingestion.capture(data.text), 201);
        }
        if (path === '/api/import' && method === 'POST') {
          const data = z
            .object({
              name: z.string().min(1).max(500),
              content: z.string().max(140_000_000),
              mime: z.string().max(200).optional(),
            })
            .strict()
            .parse(await body(req, 141_000_000));
          if (
            data.content.length % 4 ||
            /[^A-Za-z0-9+/=]/.test(data.content) ||
            /=/.test(data.content.slice(0, -2)) ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(data.content.slice(-4))
          )
            throw new AppError(400, 'Invalid base64');
          return json(
            res,
            brain.ingestion.file(data.name, Buffer.from(data.content, 'base64'), data.mime),
            201,
          );
        }
        if (path === '/api/search' && method === 'GET')
          return json(res, { hits: brain.search.query(query.q || '', paging) });
        if (path === '/api/ask' && method === 'POST') {
          const data = askSchema.parse(await body(req));
          return json(
            res,
            await brain.ask(
              data.query,
              data.use_model,
              data.cloud_consent,
              data.semantic,
              data.conversation_id,
            ),
          );
        }
        if (path === '/api/ask/history' && method === 'GET')
          return json(
            res,
            brain.conversations.list(
              paging.limit,
              paging.offset,
              query.chat || brain.conversations.current(),
            ),
          );
        if (path === '/api/ask/chats' && method === 'GET') return json(res, brain.conversations.chats());
        if (path === '/api/ask/chats' && method === 'POST') {
          const chat = brain.conversations.newChat();
          brain.jobs.emit('change');
          return json(res, chat, 201);
        }
        if (path === '/api/ask/chats/current' && method === 'PUT') {
          const data = z
            .object({ id: z.string().min(1).max(100) })
            .strict()
            .parse(await body(req));
          const chat = brain.conversations.selectChat(data.id);
          brain.jobs.emit('change');
          return json(res, chat);
        }
        if (path === '/api/context' && method === 'POST') {
          const data = askSchema.parse(await body(req));
          return json(res, await brain.context(data.query, data.semantic, data.cloud_consent));
        }
        if (path === '/api/ask/stream' && method === 'POST') {
          const data = askSchema.parse(await body(req));
          const chat = data.conversation_id || brain.conversations.current();
          const result = await brain.context(data.query, data.semantic, data.cloud_consent);
          const turn = brain.conversations.begin(
            data.query,
            result.context,
            data.use_model ? brain.settings.data.model : null,
            chat,
          );
          let answer = '',
            warning = '';
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Connection', 'keep-alive');
          const send = (event: string, data: unknown) =>
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          send('context', { context: { ...result.context, omitted: [] }, warning: result.warning });
          const controller = new AbortController();
          res.on('close', () => controller.abort());
          if (data.use_model && result.context.evidence.length)
            try {
              for await (const fragment of brain.provider.stream({
                system: askSystem,
                prompt: result.context.prompt,
                cloudConsent: data.cloud_consent,
                signal: controller.signal,
              })) {
                answer += fragment;
                if (!send('token', { text: fragment }))
                  await new Promise<void>((resolve) => {
                    res.once('drain', resolve);
                    res.once('close', resolve);
                  });
              }
            } catch (e) {
              warning = (e as Error).message;
              if (!controller.signal.aborted) send('warning', { message: warning });
            }
          if (!result.context.evidence.length) {
            answer = noRecordedAnswer;
            send('token', { text: answer });
          }
          const citationIssue = result.context.evidence.length ? citationWarning(answer, result.context) : '';
          if (citationIssue && !controller.signal.aborted) send('warning', { message: citationIssue });
          warning ||= citationIssue;
          brain.conversations.finish(
            turn.id,
            answer,
            warning || result.warning || '',
            controller.signal.aborted,
          );
          send('done', { id: turn.id });
          res.end();
          return;
        }
        if (path === '/api/graph' && method === 'GET')
          return json(
            res,
            brain.graph.view({
              ...paging,
              focus: query.focus,
              type: query.type,
              at: query.at ? z.string().datetime().parse(query.at) : undefined,
            }),
          );
        const entity = path.match(/^\/api\/entities\/([\w-]+)$/);
        if (entity && method === 'GET') return json(res, brain.graph.inspect(entity[1]));
        if (path === '/api/entities' && method === 'POST')
          return json(res, brain.graph.entity(await body(req)), 201);
        if (path === '/api/relationships' && method === 'POST')
          return json(res, brain.graph.link(await body(req)), 201);
        const relation = path.match(/^\/api\/relationships\/([\w-]+)$/);
        if (relation && method === 'DELETE') {
          brain.deletion.remove('relationships', relation[1], await body(req));
          return json(res, { ok: true });
        }
        if (path === '/api/events' && method === 'GET')
          return json(
            res,
            brain.memories.events.list({
              ...paging,
              aggregate: query.aggregate,
              before: query.before,
              after: query.after,
            }),
          );
        if (path === '/api/tasks' && method === 'GET')
          return json(
            res,
            brain.structured.tasks({ ...paging, status: query.status, project: query.project }),
          );
        if (path === '/api/tasks' && method === 'POST')
          return json(res, brain.structured.task(await body(req)), 201);
        const task = path.match(/^\/api\/tasks\/([\w-]+)$/);
        if (task && method === 'PUT') return json(res, brain.structured.task(await body(req), task[1]));
        if (path === '/api/records' && method === 'GET')
          return json(res, brain.structured.records(query.type, paging.limit, paging.offset));
        if (path === '/api/records' && method === 'POST')
          return json(res, brain.structured.record(await body(req)), 201);
        if (path === '/api/proposals' && method === 'GET')
          return json(res, brain.proposals.list(query.status, paging.limit, paging.offset));
        if (path === '/api/proposals' && method === 'POST')
          return json(res, brain.proposals.create(await body(req)), 201);
        const proposal = path.match(/^\/api\/proposals\/([\w-]+)$/);
        if (proposal && method === 'POST') {
          const data = z
            .object({
              action: z.enum(['accept', 'reject']),
              edited: z.record(z.string(), z.unknown()).optional(),
            })
            .strict()
            .parse(await body(req));
          return json(res, brain.proposals.resolve(proposal[1], data.action, data.edited));
        }
        if (path === '/api/sources' && method === 'GET')
          return json(res, brain.memories.objects.list(paging.limit, paging.offset));
        const source = path.match(/^\/api\/sources\/([\w-]+)\/download$/);
        if (source && method === 'GET') {
          const item = brain.memories.objects.get(source[1]);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader(
            'Content-Disposition',
            `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
          );
          const stream = createReadStream(brain.memories.objects.path(item.hash));
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        if (path === '/api/jobs' && method === 'GET') return json(res, brain.jobs.list());
        if (path === '/api/jobs' && method === 'POST') {
          const data = z
            .object({ type: z.string(), payload: z.record(z.string(), z.unknown()).default({}) })
            .strict()
            .parse(await body(req));
          return json(res, brain.jobs.enqueue(data.type, data.payload, data.type), 202);
        }
        const retry = path.match(/^\/api\/jobs\/([\w-]+)\/retry$/);
        if (retry && method === 'POST') {
          brain.jobs.retry(retry[1]);
          return json(res, { ok: true });
        }
        if (path === '/api/doctor' && method === 'GET') return json(res, brain.doctor(query.deep === 'true'));
        if (path === '/api/backups' && method === 'GET') return json(res, brain.backups.list());
        if (path === '/api/backups' && method === 'POST') {
          const data = z
            .object({ password: z.string().min(12).max(1000).optional() })
            .strict()
            .parse(await body(req));
          return json(res, await brain.backups.create(data.password), 201);
        }
        const backupFile = path.match(/^\/api\/backups\/([\w-]+)\/download$/);
        if (backupFile && method === 'GET') {
          const row = brain.storage.db.prepare('SELECT * FROM backup_runs WHERE id=?').get(backupFile[1]);
          if (!row || !existsSync(String(row.path))) throw new AppError(404, 'Snapshot not found');
          res.setHeader('Content-Type', 'application/zip');
          res.setHeader('Content-Disposition', 'attachment; filename="mneme-backup.zip"');
          const stream = createReadStream(String(row.path));
          stream.on('error', () => res.destroy());
          stream.pipe(res);
          return;
        }
        if (path === '/api/backups/verify' && method === 'POST') {
          const data = z
            .object({ id: z.string(), password: z.string().optional() })
            .strict()
            .parse(await body(req));
          const row = brain.storage.db.prepare('SELECT path FROM backup_runs WHERE id=?').get(data.id);
          if (!row) throw new AppError(404, 'Snapshot not found');
          return json(res, await verifyBackup(String(row.path), data.password));
        }
        if (path === '/api/backups/restore' && method === 'POST') {
          const data = z
            .object({
              id: z.string(),
              destination: z.string().min(1).max(2000),
              password: z.string().optional(),
            })
            .strict()
            .parse(await body(req));
          const row = brain.storage.db.prepare('SELECT path FROM backup_runs WHERE id=?').get(data.id);
          if (!row) throw new AppError(404, 'Snapshot not found');
          return json(res, await restoreBackup(String(row.path), data.destination, data.password));
        }
        throw new AppError(404, 'API endpoint not found');
      }
      if (method !== 'GET' && method !== 'HEAD') throw new AppError(405, 'Unsupported method');
      if (path === '/' || path === '/index.html') {
        let html = readFileSync(join(uiRoot, 'index.html'), 'utf8');
        if (vite) html = await vite.transformIndexHtml('/', html);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(html);
        return;
      }
      if (vite) {
        vite.middlewares(req, res, () => {
          res.statusCode = 404;
          res.end();
        });
        return;
      }
      const file = inside(uiRoot, path.replace(/^\//, ''));
      if (!existsSync(file) || !statSync(file).isFile()) throw new AppError(404, 'Asset not found');
      res.setHeader(
        'Content-Type',
        (
          {
            '.js': 'text/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.woff2': 'font/woff2',
            '.png': 'image/png',
          } as Record<string, string>
        )[extname(file)] || 'application/octet-stream',
      );
      createReadStream(file).pipe(res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof AppError
          ? error.status
          : error instanceof z.ZodError || error instanceof URIError
            ? 400
            : 500;
      const message =
        error instanceof z.ZodError
          ? error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')
          : status === 500
            ? 'Operation failed. Run Doctor for local diagnostics.'
            : (error as Error).message;
      if (status === 500)
        brain.log('request.error', {
          code: (error as any).code || 'INTERNAL',
          error_type: (error as Error).name,
        });
      json(res, { error: message }, status);
    } finally {
      activeRequests--;
      if (!activeRequests) drained?.();
    }
  });
  server.requestTimeout = 70000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 50;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 4589, '127.0.0.1', () => resolve());
  });
  const address = server.address() as any;
  origin = `http://127.0.0.1:${address.port}`;
  brain.jobs.start();
  brain.log('service.started', { port: address.port });
  return {
    server,
    origin,
    token,
    url: `${origin}/#token=${token}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Socket closure aborts streaming providers; asynchronous handlers may still
      // need to persist the partial answer or finish a snapshot before SQLite closes.
      if (activeRequests)
        await new Promise<void>((resolve) => {
          drained = resolve;
        });
      if (vite) await vite.close();
      await brain.close();
    },
  };
}
