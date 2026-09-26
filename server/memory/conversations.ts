import type { Storage } from '../storage/database.js';
import { Events } from '../events/events.js';
import { id, now, parse } from '../core/util.js';
import type { ContextPackage } from '../context/compiler.js';
import { activeObject } from './lifecycle.js';
import { AppError } from '../core/types.js';
import { assertErasureComplete } from './erasure.js';
export class Conversations {
  readonly events: Events;
  constructor(readonly storage: Storage) {
    this.events = new Events(storage);
  }
  current(): string {
    return String(
      this.storage.db.prepare('SELECT conversation_id FROM ask_chat WHERE id=1').get()!.conversation_id,
    );
  }
  newChat() {
    return this.storage.transaction(() => {
      assertErasureComplete(this.storage);
      this.assertIdle();
      const chat = id();
      this.storage.db.prepare('UPDATE ask_chat SET conversation_id=? WHERE id=1').run(chat);
      return { id: chat };
    });
  }
  assertIdle() {
    if (
      this.storage.db
        .prepare(
          "SELECT 1 FROM ask_turns WHERE conversation_id=? AND json_extract(data,'$.status')='running'",
        )
        .get(this.current())
    )
      throw new AppError(409, 'Stop the current answer before switching chats');
  }
  chats() {
    const chats = this.storage.db
      .prepare(
        `SELECT conversation_id AS id,min(created_at) AS created_at,count(*) AS turns,
      (SELECT json_extract(first.data,'$.question') FROM ask_turns first WHERE first.conversation_id=t.conversation_id AND ${activeObject('ask', 'first.id')} ORDER BY first.rowid LIMIT 1) AS title
      FROM ask_turns t WHERE ${activeObject('ask', 't.id')} GROUP BY conversation_id ORDER BY max(rowid) DESC LIMIT 100`,
      )
      .all();
    return { current: this.current(), chats };
  }
  selectChat(chat: string) {
    this.storage.transaction(() => {
      assertErasureComplete(this.storage);
      this.assertIdle();
      if (
        chat !== this.current() &&
        !this.storage.db.prepare('SELECT 1 FROM ask_turns WHERE conversation_id=?').get(chat)
      )
        throw new AppError(404, 'Chat not found');
      this.storage.db.prepare('UPDATE ask_chat SET conversation_id=? WHERE id=1').run(chat);
    });
    return { id: chat };
  }
  begin(question: string, context: ContextPackage, model: string | null, conversationId = this.current()) {
    const turn = {
      id: id(),
      conversation_id: conversationId,
      created_at: now(),
      question,
      // Rejected candidates are diagnostics, not durable source dependencies.
      context: { ...context, omitted: [] },
      evidence: context.evidence,
      conflicts: context.conflicts,
      model,
      answer: '',
      warning: '',
      status: 'running',
    };
    this.storage.transaction(() => {
      assertErasureComplete(this.storage);
      if (conversationId !== this.current())
        throw new AppError(409, 'The active chat changed. Ask again in the current chat.');
      for (const evidence of context.evidence)
        if (
          !this.storage.db
            .prepare(
              evidence.task_id ? 'SELECT 1 FROM tasks WHERE id=?' : 'SELECT 1 FROM memories WHERE id=?',
            )
            .get(evidence.task_id || evidence.memory_id)
        )
          throw new AppError(409, 'Retrieved evidence was erased. Ask again to refresh the context.');
      this.storage.db
        .prepare('INSERT INTO ask_turns(id,created_at,data,conversation_id) VALUES (?,?,?,?)')
        .run(turn.id, turn.created_at, JSON.stringify(turn), conversationId);
      this.events.append(
        'ask.started',
        turn.id,
        {
          question,
          citations: context.evidence.map((e) => ({
            memory_id: e.memory_id,
            ...(e.task_id ? { task_id: e.task_id } : {}),
            version: e.version,
          })),
          model,
        },
        { kind: 'user', actor: 'user', evidence: context.evidence.map((e) => e.task_id || e.memory_id!) },
      );
    });
    return turn;
  }
  finish(turnId: string, answer: string, warning = '', interrupted = false) {
    const row = this.storage.db.prepare('SELECT data FROM ask_turns WHERE id=?').get(turnId);
    if (!row) return;
    const turn = { ...parse(row.data), answer, warning, status: interrupted ? 'interrupted' : 'complete' };
    this.storage.transaction(() => {
      this.storage.db.prepare('UPDATE ask_turns SET data=? WHERE id=?').run(JSON.stringify(turn), turnId);
      this.events.append(
        'ask.completed',
        turnId,
        { answer, warning, interrupted, model: turn.model },
        {
          kind: turn.model ? 'ai' : 'software',
          actor: turn.model || 'retrieval',
          model: turn.model || undefined,
          evidence: turn.evidence.map((e: any) => e.task_id || e.memory_id),
        },
      );
    });
  }
  list(limit = 30, offset = 0, conversationId?: string) {
    return this.storage.db
      .prepare(
        `SELECT data FROM ask_turns WHERE ${activeObject('ask', 'ask_turns.id')} ${conversationId ? 'AND conversation_id=?' : ''} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...(conversationId ? [conversationId] : []), Math.min(limit, 100), offset)
      .map((row) => parse(row.data));
  }
  recover() {
    const rows = this.storage.db
      .prepare("SELECT id FROM ask_turns WHERE json_extract(data,'$.status')='running'")
      .all();
    for (const row of rows)
      this.finish(
        String(row.id),
        '',
        'The service stopped before this answer completed. Its selected evidence was preserved.',
        true,
      );
  }
}
