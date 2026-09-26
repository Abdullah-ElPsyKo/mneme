import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowDown, Sparkles, BookOpen, X, Square } from 'lucide-react';
import { api, Markdown } from './lib';
import { DeleteAction } from './DeleteAction';
export function Ask({
  settings,
  onSelect,
  onHighlights,
  onClose,
  revision,
}: {
  settings: any;
  onSelect: (id: string) => void;
  onHighlights: (ids: string[]) => void;
  onClose: () => void;
  revision: number;
}) {
  const [question, setQuestion] = useState(''),
    [history, setHistory] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [loadingHistory, setLoadingHistory] = useState(true),
    [useModel, setUseModel] = useState(false),
    [consent, setConsent] = useState(false),
    [semantic, setSemantic] = useState(false),
    [chatId, setChatId] = useState(''),
    [chats, setChats] = useState<any[]>([]),
    [chatRevision, setChatRevision] = useState(0),
    [error, setError] = useState(''),
    [following, setFollowing] = useState(true);
  const controller = useRef<AbortController | null>(null),
    conversation = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const jump = () => {
    follow.current = true;
    setFollowing(true);
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  };
  useLayoutEffect(() => {
    if (follow.current) jump();
  }, [history]);
  useEffect(() => {
    let active = true;
    if (busy) return;
    api('/ask/chats')
      .then(async (data) => {
        const turns = await api(`/ask/history?limit=100&chat=${encodeURIComponent(data.current)}`);
        if (active) {
          setChatId(data.current);
          setChats(data.chats);
          setError('');
          if (data.current !== chatId) follow.current = true;
          setHistory((current) =>
            turns.reverse().map((turn: any) => ({
              ...turn,
              clientId: current.find((old) => old.id === turn.id)?.clientId,
              loading: false,
            })),
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => {
      active = false;
    };
  }, [revision, busy, chatRevision]);
  useEffect(() => () => controller.current?.abort(), []);
  const switchChat = async (id?: string) => {
    setLoadingHistory(true);
    setError('');
    try {
      const result = await api(id ? '/ask/chats/current' : '/ask/chats', {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(id ? { id } : {}),
      });
      setChatId(result.id);
      setHistory([]);
      setQuestion('');
      setConsent(false);
      onHighlights([]);
      follow.current = true;
      setFollowing(true);
      setChatRevision((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
      setLoadingHistory(false);
    }
  };
  const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/.test(settings?.endpoint || '');
  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim() || busy || loadingHistory) return;
    const q = question.trim();
    setQuestion('');
    setBusy(true);
    setError('');
    follow.current = true;
    setFollowing(true);
    controller.current = new AbortController();
    const clientId = crypto.randomUUID();
    setHistory((current) => [...current, { clientId, question: q, answer: '', evidence: [], loading: true }]);
    const update = (fields: any) =>
      setHistory((current) =>
        current.map((item) => (item.clientId === clientId ? { ...item, ...fields } : item)),
      );
    try {
      const response = await fetch('/api/ask/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: q,
          use_model: useModel,
          cloud_consent: consent,
          semantic,
          conversation_id: chatId,
        }),
        signal: controller.current.signal,
      });
      if (!response.ok) throw new Error((await response.json()).error);
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let buffer = '',
        answer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = block.match(/^event: (.+)$/m)?.[1],
            data = JSON.parse(block.match(/^data: (.+)$/m)?.[1] || '{}');
          if (event === 'context') {
            update({
              evidence: data.context.evidence,
              conflicts: data.context.conflicts,
              context: data.context,
              warning: data.warning,
            });
            onHighlights(data.context.evidence.filter((e: any) => !e.task_id).map((e: any) => e.memory_id));
          }
          if (event === 'token') {
            answer += data.text;
            update({ answer });
          }
          if (event === 'warning') update({ warning: data.message });
          if (event === 'done') update({ id: data.id });
        }
      }
    } catch (error) {
      update({
        warning:
          (error as Error).name === 'AbortError'
            ? 'Generation stopped. Retrieved evidence remains available.'
            : (error as Error).message,
      });
    } finally {
      update({ loading: false });
      setBusy(false);
      setConsent(false);
    }
  };
  return (
    <aside className="ask-pane">
      <div className="inspector-top">
        <span className="eyebrow">
          <Sparkles size={13} /> Ask your memory
        </span>
        <button
          type="button"
          disabled={busy || loadingHistory}
          onClick={() => void switchChat()}
          title="Start a fresh chat; previous chats are kept"
        >
          New chat
        </button>
        <button className="icon-button" aria-label="Close Ask" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {chats.length > 0 && (
        <select
          className="ask-chat-select"
          aria-label="Ask chat history"
          value={chatId}
          disabled={busy || loadingHistory}
          onChange={(e) => void switchChat(e.target.value)}
        >
          {!chats.some((c) => c.id === chatId) && <option value={chatId}>New chat</option>}
          {chats.map((chat) => (
            <option value={chat.id} key={chat.id}>
              {chat.title || 'Chat'} · {chat.turns}
            </option>
          ))}
        </select>
      )}
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <div
        className="ask-conversation"
        ref={conversation}
        role="log"
        aria-label="Ask conversation"
        onScroll={() => {
          const element = conversation.current!;
          const near = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          follow.current = near;
          setFollowing(near);
        }}
      >
        {!history.length && (
          <div className="ask-intro">
            <div className="ask-symbol">
              <Sparkles size={26} strokeWidth={1.2} />
            </div>
            <h2>Find the thread.</h2>
            <p>
              Ask a question. Follow the evidence.
              <br />
              Reconnect with what you already know.
            </p>
            <div className="ask-explainer">
              <BookOpen size={17} />
              <span>Evidence mode works entirely offline. A model is optional.</span>
            </div>
          </div>
        )}
        {history.map((item) => (
          <div className="ask-turn" key={item.clientId || item.id}>
            <div className="ask-question">
              <span>You asked</span>
              <h3>{item.question}</h3>
              {item.id && (
                <DeleteAction
                  kind="conversations"
                  id={item.id}
                  title={item.question}
                  disabled={busy}
                  onDeleted={() => setHistory((current) => current.filter((turn) => turn.id !== item.id))}
                />
              )}
            </div>
            {item.warning && <div className="notice">{item.warning}</div>}
            {item.answer && <Markdown text={item.answer} />}
            {item.loading && (
              <div className="evidence-label" role="status">
                {item.answer ? 'Writing…' : 'Thinking…'}
              </div>
            )}
            {!item.answer && item.conflicts?.length > 0 && (
              <div className="notice">
                Conflicting values were found:{' '}
                {item.conflicts.map((c: any) => `${c.fact_key}: ${c.values.join(' / ')}`).join('; ')}
              </div>
            )}
            <details className="ask-sources">
              <summary>Sources · {item.evidence.length}</summary>
              {item.evidence.map((e: any) =>
                e.task_id ? (
                  <details className="evidence-item task-source" key={e.citation}>
                    <summary>
                      <span className="citation">{e.citation}</span> {e.title} · Tasks
                    </summary>
                    <p>
                      {e.status}
                      {e.project ? ` · ${e.project}` : ''}
                      {e.due_at ? ` · due ${e.due_at}` : ''}
                    </p>
                    <small>
                      {e.provenance.kind} · revision {e.version} · snapshot at answer time
                    </small>
                  </details>
                ) : (
                  <button className="evidence-item" key={e.citation} onClick={() => onSelect(e.memory_id)}>
                    <span className="citation">{e.citation}</span>
                    <div>
                      <strong>{e.title}</strong>
                      <small>
                        {e.provenance.kind} · revision {e.version}
                      </small>
                    </div>
                  </button>
                ),
              )}
            </details>
            {!item.loading && !item.evidence.length && !item.answer && (
              <p className="muted">You haven't recorded anything that answers that yet.</p>
            )}
          </div>
        ))}
      </div>
      {!following && history.length > 0 && (
        <button className="ask-jump" type="button" onClick={jump}>
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
      <form className="ask-composer" onSubmit={ask}>
        <div className="ask-options">
          <label className="check-label">
            <input
              type="checkbox"
              checked={useModel}
              disabled={settings?.provider === 'disabled'}
              onChange={(e) => setUseModel(e.target.checked)}
            />
            <span>Use {settings?.model || 'a model'}</span>
          </label>
          {settings?.embedding_model && (
            <label className="check-label">
              <input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} />
              <span>Semantic</span>
            </label>
          )}
        </div>
        {!local && (useModel || semantic) && (
          <label className="cloud-consent">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Send
            this question and selected evidence to {settings.endpoint} for this request.
          </label>
        )}
        <div className="ask-input">
          <textarea
            aria-label="Ask a question"
            placeholder="What would you like to remember?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (local || !(useModel || semantic) || consent) void ask(e);
              }
            }}
          />
          {busy ? (
            <button
              type="button"
              className="icon-button"
              aria-label="Stop generation"
              onClick={() => controller.current?.abort()}
            >
              <Square size={15} />
            </button>
          ) : (
            <button
              className="send-button"
              aria-label="Ask"
              disabled={loadingHistory || !question.trim() || (!local && (useModel || semantic) && !consent)}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
        <div className="ask-privacy">
          <span className="status-dot" />
          {useModel
            ? local
              ? 'Local model · cited evidence'
              : 'External model · explicit consent'
            : 'Local evidence · no model call'}
        </div>
      </form>
    </aside>
  );
}
