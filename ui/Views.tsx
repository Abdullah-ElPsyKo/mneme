import { useEffect, useState } from 'react';
import { DeleteAction } from './DeleteAction';
import {
  Search,
  Plus,
  FileText,
  FolderOpen,
  ArrowUpRight,
  Check,
  Circle,
  Upload,
  Download,
  Inbox,
  History,
  CheckCheck,
  Link2,
} from 'lucide-react';
import {
  api,
  cleanMemory,
  color,
  date,
  Empty,
  Markdown,
  Modal,
  post,
  pretty,
  plainExcerpt,
  put,
  SectionTitle,
  SourceLink,
  Tag,
  time,
} from './lib';
export function MemoryList({
  view,
  onSelect,
  onCreate,
  revision,
}: {
  view: string;
  onSelect: (id: string) => void;
  onCreate: (type: string) => void;
  revision: number;
}) {
  const [items, setItems] = useState<any[]>([]),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    setOffset(0);
  }, [view, query]);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(
      () => {
        const path = query
          ? `/search?q=${encodeURIComponent((view === 'Projects' ? 'type:project ' : '') + query)}&limit=60&offset=${offset}`
          : `/memories?limit=60&offset=${offset}${view === 'Projects' ? '&type=project' : ''}`;
        api(path)
          .then((data) => {
            if (live) {
              setItems(
                query
                  ? data.hits.map((h: any) => ({ ...h.memory, signals: h.signals, excerpt: h.excerpt }))
                  : data,
              );
              setError('');
            }
          })
          .catch((e) => live && setError(e.message))
          .finally(() => live && setLoading(false));
      },
      query ? 140 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [view, query, revision, offset]);
  const projects = view === 'Projects';
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow={projects ? 'What you are building' : 'Your growing body of knowledge'}
        title={projects ? 'Projects' : 'Notes & memories'}
        description={
          projects
            ? 'Keep the decisions, details, and direction together.'
            : 'A place for the things you don’t want to lose.'
        }
        actions={
          <button className="primary" onClick={() => onCreate(projects ? 'project' : 'note')}>
            <Plus size={15} />
            {projects ? 'New project' : 'New memory'}
          </button>
        }
      />
      <div className="filter-bar">
        <Search size={17} />
        <input
          aria-label={projects ? 'Filter projects' : 'Filter notes'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={projects ? 'Find a project…' : 'Filter by words, tag: or type:…'}
        />
        <span>{loading ? 'Searching…' : `${items.length}${items.length === 60 ? '+' : ''} memories`}</span>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!loading && !items.length ? (
        <Empty
          icon={projects ? <FolderOpen size={28} /> : <FileText size={28} />}
          title={
            query
              ? 'Nothing here matches yet'
              : projects
                ? 'Give your next project a home'
                : 'A clear space for your knowledge'
          }
          text={
            query
              ? 'Try another phrase or remove a filter.'
              : 'Create a memory or import a file. Your original evidence and every revision stay with you.'
          }
          action={
            <button onClick={() => onCreate(projects ? 'project' : 'note')}>
              <Plus size={15} /> Create {projects ? 'project' : 'memory'}
            </button>
          }
        />
      ) : (
        <div className={projects ? 'project-list' : 'memory-list'}>
          {items.map((m) => (
            <button
              className={projects ? 'project-item' : 'memory-row'}
              key={m.id}
              onClick={() => onSelect(m.id)}
            >
              <div className="memory-type-icon" style={{ color: color(m.type) }}>
                {projects ? (
                  <FolderOpen size={24} strokeWidth={1.3} />
                ) : (
                  <FileText size={19} strokeWidth={1.5} />
                )}
              </div>
              <div className="memory-row-main">
                <div className="row-eyebrow">
                  {pretty(m.type)} {m.project && ` / ${m.project}`}
                </div>
                <h3>{m.title}</h3>
                {m.excerpt && <p>{m.excerpt.slice(0, 150)}</p>}
                <div className="tag-list">
                  {m.tags.slice(0, 4).map((tag: string) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </div>
              </div>
              <div className="memory-row-end">
                <span className={`state-label ${m.status}`}>{m.status}</span>
                <small>{date(m.updated_at)}</small>
              </div>
              <ArrowUpRight size={17} />
            </button>
          ))}
        </div>
      )}
      <Pagination offset={offset} count={items.length} size={60} onChange={setOffset} />
    </div>
  );
}
export function Pagination({
  offset,
  count,
  size,
  onChange,
}: {
  offset: number;
  count: number;
  size: number;
  onChange: (offset: number) => void;
}) {
  return offset > 0 || count === size ? (
    <div className="pagination">
      <button disabled={!offset} onClick={() => onChange(Math.max(0, offset - size))}>
        Previous
      </button>
      <span>
        {offset + 1}–{offset + count}
      </span>
      <button disabled={count < size} onClick={() => onChange(offset + size)}>
        Next
      </button>
    </div>
  ) : null;
}
export function SearchView({
  revision,
  onSelect,
  onHighlights,
  initial = '',
}: {
  onSelect: (id: string) => void;
  onHighlights: (ids: string[]) => void;
  initial?: string;
  revision: number;
}) {
  const [query, setQuery] = useState(initial),
    [hits, setHits] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setBusy(true);
    const timer = setTimeout(() => {
      api(`/search?q=${encodeURIComponent(query)}&limit=100`)
        .then((data) => {
          if (active) {
            setHits(data.hits);
            onHighlights(data.hits.map((h: any) => h.memory.id));
            setError('');
          }
        })
        .catch((e) => active && setError(e.message))
        .finally(() => active && setBusy(false));
    }, 160);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, revision]);
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow="Recall, with precision"
        title="Find what matters."
        description="Exact words. Connected ideas. Original evidence."
      />
      <div className="search-hero">
        <Search size={23} />
        <input
          autoFocus
          aria-label="Search memories"
          placeholder="Search your memory…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>/</kbd>
      </div>
      <div className="search-help">
        <span>Refine with</span>
        {['type:decision', 'project:"My project"', 'tag:important', 'before:2026-09-01'].map((filter) => (
          <button key={filter} onClick={() => setQuery((q) => `${q} ${filter}`.trim())}>
            {filter}
          </button>
        ))}
        <span>“quotes” for exact phrases</span>
      </div>
      <div className="results-heading">
        <span>
          {busy ? 'Searching local indexes…' : `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`}
        </span>
        <span>
          <span className="status-dot" /> Local hybrid retrieval
        </span>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {!hits.length && !busy && (
        <Empty
          icon={<Search size={28} />}
          title="No matching memories"
          text="Try a shorter phrase, another project, or an exact identifier."
        />
      )}
      {hits.map((hit) => (
        <button className="search-result" key={hit.memory.id} onClick={() => onSelect(hit.memory.id)}>
          <div className="result-heading">
            <div>
              <span className="row-eyebrow">
                {pretty(hit.memory.type)} {hit.memory.project && ` / ${hit.memory.project}`}
              </span>
              <h3>{hit.memory.title}</h3>
            </div>
            <ArrowUpRight size={17} />
          </div>
          <p>{plainExcerpt(hit.excerpt) || 'No body text.'}</p>
          <div className="search-result-footer">
            <span>
              {hit.memory.provenance.kind} · {date(hit.memory.updated_at)}
            </span>
            <div>
              {hit.signals.map((signal: string) => (
                <Tag key={signal}>{pretty(signal)}</Tag>
              ))}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
export function Timeline({
  onSelect,
  onHistoricalGraph,
  revision,
}: {
  onSelect: (id: string) => void;
  onHistoricalGraph: (at: string) => void;
  revision: number;
}) {
  const [events, setEvents] = useState<any[]>([]),
    [before, setBefore] = useState(''),
    [after, setAfter] = useState(''),
    [offset, setOffset] = useState(0),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<any>();
  useEffect(() => {
    setSelected(undefined);
  }, [revision]);
  useEffect(() => {
    api(
      `/events?limit=80&offset=${offset}${before ? `&before=${new Date(before + 'T23:59:59').toISOString()}` : ''}${after ? `&after=${new Date(after).toISOString()}` : ''}`,
    )
      .then(setEvents)
      .catch((e) => setError(e.message));
  }, [revision, before, after, offset]);
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow="Memory has a history"
        title="The story so far."
        description="Every meaningful change, with its original context."
      />
      <div className="timeline-filter">
        <label>
          From
          <input
            aria-label="Timeline from"
            type="date"
            value={after}
            onChange={(e) => {
              setAfter(e.target.value);
              setOffset(0);
            }}
          />
        </label>
        <label>
          Through
          <input
            aria-label="Timeline through"
            type="date"
            value={before}
            onChange={(e) => {
              setBefore(e.target.value);
              setOffset(0);
            }}
          />
        </label>
      </div>
      {error && <p className="error-banner">{error}</p>}
      {!events.length && (
        <Empty
          icon={<History size={28} />}
          title="Your history starts here"
          text="Captures, edits, tasks, connections, and imports leave an inspectable trail."
        />
      )}
      <div className="timeline">
        {events.map((event, index) => {
          const value = event.payload.memory || event.payload.task || event.payload.entity;
          return (
            <div key={event.id}>
              {(index === 0 || date(event.at) !== date(events[index - 1].at)) && (
                <h3 className="timeline-date">{date(event.at)}</h3>
              )}
              <button className="timeline-event" onClick={() => setSelected(event)}>
                <div className="timeline-dot" />
                <time>{time(event.at)}</time>
                <div>
                  <span className="row-eyebrow">{pretty(event.kind.replace('.', ' '))}</span>
                  <h4>
                    {value?.title ||
                      value?.name ||
                      event.payload.relationship?.type ||
                      event.kind.split('.')[0]}
                  </h4>
                  <p>
                    {event.actor} · {event.provenance.kind}
                    {value?.version ? ` · revision ${value.version}` : ''}
                  </p>
                </div>
                <ArrowUpRight size={15} />
              </button>
            </div>
          );
        })}
      </div>
      <Pagination offset={offset} count={events.length} size={80} onChange={setOffset} />
      {selected && (
        <Modal wide title={pretty(selected.kind.replace('.', ' '))} onClose={() => setSelected(undefined)}>
          <div className="historical-content">
            <div className="eyebrow">
              {date(selected.at)} · {time(selected.at)} · {selected.actor}
            </div>
            {selected.payload.memory ? (
              <>
                <h1>{selected.payload.memory.title}</h1>
                <Markdown text={selected.payload.memory.body} />
              </>
            ) : (
              <pre>{JSON.stringify(selected.payload, null, 2)}</pre>
            )}
            <details>
              <summary>Provenance and event identifier</summary>
              <pre>
                {JSON.stringify(
                  { id: selected.id, provenance: selected.provenance, supersedes: selected.supersedes },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
          <div className="modal-footer">
            <button
              onClick={() => {
                onHistoricalGraph(selected.at);
                setSelected(undefined);
              }}
            >
              View brain at this time
            </button>
            {selected.payload.memory && (
              <button
                className="primary"
                onClick={() => {
                  onSelect(selected.aggregate_id);
                  setSelected(undefined);
                }}
              >
                Open current memory
              </button>
            )}
            {selected.payload.record && (
              <DeleteAction
                kind="records"
                id={selected.aggregate_id}
                title={`${selected.payload.record.type} record`}
                onDeleted={() => setSelected(undefined)}
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
export function Tasks({
  revision,
  refresh,
  notify,
}: {
  revision: number;
  refresh: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [tasks, setTasks] = useState<any[]>([]),
    [title, setTitle] = useState(''),
    [due, setDue] = useState(''),
    [project, setProject] = useState(''),
    [filter, setFilter] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/tasks?limit=200${filter ? `&status=${filter}` : ''}`)
      .then(setTasks)
      .catch((e) => notify(e.message, true));
  }, [revision, filter]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await post('/tasks', { title, due_at: due || null, project });
      setTitle('');
      setDue('');
      refresh();
      notify('Task saved');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const update = async (task: any, status: string) => {
    const { id, created_at, updated_at, version, ...data } = task;
    try {
      await put(`/tasks/${id}`, { ...data, status, expected_version: version });
      refresh();
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow="Make room for doing"
        title="A little forward motion."
        description="Small commitments, kept in context."
      />
      <form className="task-capture" onSubmit={create}>
        <div className="task-capture-main">
          <Plus size={19} />
          <input
            aria-label="Task title"
            placeholder="What needs to happen next?"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>
        <div className="task-capture-details">
          <label>
            Project
            <input value={project} onChange={(e) => setProject(e.target.value)} placeholder="Optional" />
          </label>
          <label>
            Due date
            <input
              aria-label="Task due date"
              type="date"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </label>
          <button className="primary" disabled={busy || !title.trim()}>
            Add task
          </button>
        </div>
      </form>
      <div className="tabs task-tabs">
        {[
          ['', 'All tasks'],
          ['open', 'Open'],
          ['doing', 'In progress'],
          ['done', 'Completed'],
        ].map(([value, label]) => (
          <button className={filter === value ? 'active' : ''} key={value} onClick={() => setFilter(value)}>
            {label}
          </button>
        ))}
      </div>
      {!tasks.length && (
        <Empty
          icon={<CheckCheck size={29} />}
          title="Nothing pulling at your attention"
          text="Add a next step when you need one. Your completed tasks stay in history."
        />
      )}
      {tasks.map((task) => (
        <div className={`task-row ${task.status}`} key={task.id}>
          <button
            className={`task-check ${task.status === 'done' ? 'checked' : ''}`}
            aria-label={`${task.status === 'done' ? 'Reopen' : 'Complete'} ${task.title}`}
            onClick={() => update(task, task.status === 'done' ? 'open' : 'done')}
          >
            {task.status === 'done' && <Check size={13} />}
          </button>
          <div>
            <h3>{task.title}</h3>
            <p>
              {task.project || 'No project'}
              {task.due_at && (
                <span
                  className={
                    task.due_at < new Date().toISOString().slice(0, 10) && task.status !== 'done'
                      ? 'overdue'
                      : ''
                  }
                >
                  {' '}
                  · Due {task.due_at}
                </span>
              )}
            </p>
          </div>
          <select
            aria-label={`Status of ${task.title}`}
            value={task.status}
            onChange={(e) => update(task, e.target.value)}
          >
            {['open', 'doing', 'done', 'cancelled'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <DeleteAction kind="tasks" id={task.id} title={task.title} onDeleted={refresh} />
        </div>
      ))}
    </div>
  );
}
export function InboxView({
  revision,
  refresh,
  onSelect,
  onEdit,
  notify,
}: {
  revision: number;
  refresh: () => void;
  onSelect: (id: string) => void;
  onEdit: (m: any) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [memories, setMemories] = useState<any[]>([]),
    [proposals, setProposals] = useState<any[]>([]),
    [tab, setTab] = useState('Captures'),
    [editing, setEditing] = useState<any>(),
    [json, setJson] = useState('');
  useEffect(() => {
    Promise.all([api('/memories?status=inbox'), api('/proposals')])
      .then(([m, p]) => {
        setMemories(m);
        setProposals(p);
      })
      .catch((e) => notify(e.message, true));
  }, [revision]);
  const resolve = async (id: string, action: string, edited?: any) => {
    try {
      await post(`/proposals/${id}`, { action, ...(edited ? { edited } : {}) });
      refresh();
      setEditing(undefined);
      notify(`Proposal ${action === 'accept' ? 'accepted' : 'rejected'}`);
    } catch (e) {
      notify((e as Error).message, true);
    }
  };
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow="Capture first. Connect later."
        title="Your inbox."
        description="Unsorted thoughts and suggestions awaiting your judgment."
        actions={
          <button
            onClick={async () => {
              try {
                await post('/jobs', { type: 'consolidate' });
                refresh();
                notify('Consolidation queued');
              } catch (e) {
                notify((e as Error).message, true);
              }
            }}
          >
            <Link2 size={15} /> Find connections
          </button>
        }
      />
      <div className="tabs">
        <button className={tab === 'Captures' ? 'active' : ''} onClick={() => setTab('Captures')}>
          Captures <Tag>{memories.length}</Tag>
        </button>
        <button className={tab === 'Proposals' ? 'active' : ''} onClick={() => setTab('Proposals')}>
          Proposals <Tag>{proposals.length}</Tag>
        </button>
      </div>
      {tab === 'Captures' ? (
        <>
          {!memories.length && (
            <Empty
              icon={<Inbox size={30} />}
              title="A little breathing room"
              text="Quick captures and imported files land here. Review them when you’re ready."
            />
          )}
          {memories.map((m) => (
            <div className="inbox-item" key={m.id}>
              <button onClick={() => onSelect(m.id)}>
                <span className="row-eyebrow">
                  {m.provenance.kind} · {date(m.created_at)}
                </span>
                <h3>{m.title}</h3>
              </button>
              <div className="inbox-actions">
                <button onClick={async () => onEdit(await api(`/memories/${m.id}`))}>Organize</button>
                <button
                  className="icon-button"
                  aria-label={`File ${m.title}`}
                  title="Mark reviewed and move out of Inbox"
                  onClick={async () => {
                    try {
                      const memory = await api(`/memories/${m.id}`);
                      await put(`/memories/${m.id}`, { ...cleanMemory(memory), status: 'active' });
                      refresh();
                      notify('Memory filed');
                    } catch (e) {
                      notify((e as Error).message, true);
                    }
                  }}
                >
                  <Check size={16} />
                </button>
              </div>
            </div>
          ))}
        </>
      ) : (
        <>
          {!proposals.length && (
            <Empty
              icon={<Link2 size={29} />}
              title="No suggestions waiting"
              text="Use [[Entity name]] in your notes, then find connections. Suggestions remain separate until accepted."
            />
          )}
          {proposals.map((p) => (
            <div className="proposal-item" key={p.id}>
              <div className="row-eyebrow">
                {p.provenance.kind} · {pretty(p.kind)} suggestion
              </div>
              <h3>{p.payload.title || pretty(p.payload.type || 'Memory proposal')}</h3>
              <pre>{JSON.stringify(p.payload, null, 2)}</pre>
              <p className="muted">
                Method: {p.provenance.extraction_method || 'unspecified'} · Evidence: {p.evidence.length}{' '}
                references
              </p>
              <div className="proposal-evidence">
                {p.evidence.map((id: string) => (
                  <button key={id} onClick={() => onSelect(id)}>
                    <FileText size={13} /> Inspect evidence
                  </button>
                ))}
              </div>
              <div className="proposal-actions">
                <DeleteAction
                  kind="proposals"
                  id={p.id}
                  title={p.payload.title || `${p.kind} suggestion`}
                  onDeleted={() => {
                    setProposals((current) => current.filter((item) => item.id !== p.id));
                    refresh();
                  }}
                />
                <button
                  onClick={() => {
                    setEditing(p);
                    setJson(JSON.stringify(p.payload, null, 2));
                  }}
                >
                  Edit
                </button>
                <button className="primary" onClick={() => resolve(p.id, 'accept')}>
                  <Check size={15} /> Accept
                </button>
              </div>
            </div>
          ))}
        </>
      )}
      {editing && (
        <Modal title="Edit proposal before accepting" onClose={() => setEditing(undefined)}>
          <div className="form-stack">
            <textarea
              className="json-editor"
              aria-label="Proposal payload"
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </div>
          <div className="modal-footer">
            <span className="muted">Original inference provenance is retained.</span>
            <button
              className="primary"
              onClick={() => {
                try {
                  void resolve(editing.id, 'accept', JSON.parse(json));
                } catch {
                  notify('Payload must be valid JSON', true);
                }
              }}
            >
              Accept edited proposal
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
export function Sources({
  refresh,
  revision,
  onImport,
  onSelect,
  notify,
}: {
  revision: number;
  refresh: () => void;
  onImport: () => void;
  onSelect: (id: string) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    api(`/sources?limit=60&offset=${offset}`)
      .then(setItems)
      .catch((e) => notify(e.message, true));
  }, [revision, offset]);
  return (
    <div className="view-scroll">
      <SectionTitle
        eyebrow="The evidence stays with you"
        title="Original sources."
        description="Every import preserved, fingerprinted, and traceable."
        actions={
          <button className="primary" onClick={onImport}>
            <Upload size={15} /> Import files
          </button>
        }
      />
      <div
        className="import-zone"
        onClick={onImport}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') onImport();
        }}
        role="button"
        tabIndex={0}
      >
        <Upload size={23} strokeWidth={1.2} />
        <div>
          <strong>Drop something worth keeping.</strong>
          <p>Markdown, documents, images, code, and more · up to 100 MiB per file</p>
        </div>
        <Plus size={20} />
      </div>
      <p className="source-note">
        UTF-8 text is searchable. Other formats are preserved as originals with searchable metadata.
      </p>
      {!items.length && (
        <Empty
          icon={<FileText size={28} />}
          title="Your evidence library is ready"
          text="Import a file to preserve an exact original and create a linked memory."
        />
      )}
      {items.map((source) => (
        <div className="source-row" key={source.id}>
          <div className="file-extension">{source.name.split('.').pop()?.slice(0, 5).toUpperCase()}</div>
          <div className="source-main">
            <button
              onClick={() => source.memory_id && onSelect(source.memory_id)}
              disabled={!source.memory_id}
            >
              <h3>{source.name}</h3>
            </button>
            <p>
              {(source.size / 1024).toFixed(1)} KiB · {date(source.created_at)} ·{' '}
              {source.metadata.extracted ? 'Text extracted' : 'Original preserved'}
            </p>
            <code title={source.hash}>SHA-256 {source.hash.slice(0, 24)}…</code>
          </div>
          <SourceLink id={source.id}>Original</SourceLink>
          <DeleteAction
            kind="sources"
            id={source.id}
            title={source.name}
            onDeleted={() => {
              setItems((items) => items.filter((item) => item.id !== source.id));
              refresh();
            }}
          />
        </div>
      ))}
      <Pagination offset={offset} count={items.length} size={60} onChange={setOffset} />
    </div>
  );
}
