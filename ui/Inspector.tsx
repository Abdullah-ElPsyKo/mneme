import { useEffect, useState } from 'react';
import { DeleteAction } from './DeleteAction';
import { ConnectionPicker } from './ConnectionPicker';
import {
  X,
  Pencil,
  History,
  Link2,
  Plus,
  ArrowUpRight,
  ShieldCheck,
  FileText,
  ChevronRight,
  RotateCcw,
} from 'lucide-react';
import {
  api,
  cleanMemory,
  color,
  date,
  Markdown,
  Modal,
  post,
  pretty,
  put,
  SourceLink,
  Tag,
  time,
} from './lib';
export function Inspector({
  id,
  onClose,
  onEdit,
  onSelect,
  onRefresh,
  notify,
}: {
  id: string;
  onClose: () => void;
  onEdit: (memory: any) => void;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [entity, setEntity] = useState<any>(),
    [memory, setMemory] = useState<any>(),
    [events, setEvents] = useState<any[]>([]),
    [tab, setTab] = useState('Overview'),
    [error, setError] = useState(''),
    [link, setLink] = useState(false),
    [target, setTarget] = useState(''),
    [relationType, setRelationType] = useState('related_to'),
    [historical, setHistorical] = useState<any>(),
    [busy, setBusy] = useState(false);
  const load = async () => {
    setError('');
    try {
      const result = await api(`/entities/${id}`);
      setEntity(result);
      setMemory(result.entity.memory_id ? await api(`/memories/${result.entity.memory_id}`) : null);
      setEvents(await api(`/events?aggregate=${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setEntity(undefined);
    setMemory(undefined);
    setHistorical(undefined);
    setTab('Overview');
    void load();
  }, [id]);
  const addLink = async () => {
    setBusy(true);
    try {
      await post('/relationships', { from_id: id, to_id: target, type: relationType });
      setLink(false);
      await load();
      onRefresh();
      notify('Relationship saved');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const restoreRevision = async () => {
    if (!historical || !memory) return;
    setBusy(true);
    try {
      await put(`/memories/${memory.id}`, {
        ...cleanMemory(historical),
        expected_version: memory.version,
        provenance: {
          kind: 'user',
          actor: 'user',
          parent_event: events.find((e) => e.payload.memory?.version === historical.version)?.id,
          extraction_method: 'restore-revision',
          evidence: [memory.id],
        },
      });
      setHistorical(undefined);
      await load();
      onRefresh();
      notify('Historical content saved as a new revision');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className="inspector">
      <div className="inspector-top">
        <span className="eyebrow">Memory inspector</span>
        <button className="icon-button" aria-label="Close inspector" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {error ? (
        <div className="error-banner">{error}</div>
      ) : !entity ? (
        <div className="skeleton">Opening memory…</div>
      ) : (
        <>
          <div className="entity-heading">
            <span className="entity-glyph" style={{ color: color(entity.entity.type) }}>
              <FileText size={23} strokeWidth={1.4} />
            </span>
            <span className="eyebrow">{pretty(entity.entity.type)}</span>
            <h2>{entity.entity.name}</h2>
            <div className="entity-metadata">
              <span className="status-dot" />
              {memory?.type === 'project'
                ? memory.project_state
                : memory?.status || entity.entity.status || 'active'}
              {memory?.type === 'project' && memory.status === 'archived' && <span>· archived</span>}
              <span>·</span>
              <span>{entity.relationships.filter((r: any) => !r.valid_until).length} connections</span>
              {memory && (
                <button
                  className="icon-button"
                  title="Edit memory"
                  aria-label="Edit memory"
                  onClick={() => onEdit(memory)}
                >
                  <Pencil size={14} />
                </button>
              )}
              {(memory?.status || entity.entity.status) !== 'archived' && (
                <DeleteAction
                  kind={memory ? 'memories' : 'entities'}
                  id={id}
                  title={entity.entity.name}
                  onDeleted={() => {
                    onClose();
                    onRefresh();
                    notify('Item removed; history preserved');
                  }}
                />
              )}
              {memory?.status === 'archived' && (
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await put(`/memories/${memory.id}`, { ...cleanMemory(memory), status: 'active' });
                      await load();
                      onRefresh();
                      notify('Memory restored; history preserved');
                    } catch (e) {
                      notify((e as Error).message, true);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  <RotateCcw size={14} /> Restore memory
                </button>
              )}
            </div>
          </div>
          <div className="tabs">
            {['Overview', 'Connections', 'History', 'Evidence'].map((t) => (
              <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
                {t}
              </button>
            ))}
          </div>
          <div className="inspector-body">
            {memory?.status === 'archived' && (
              <p className="muted">
                Archived and retained in your brain. Restoring adds a visible revision and preserves project
                lifecycle; previously ended connections stay in history.
              </p>
            )}
            {tab === 'Overview' && (
              <>
                {memory ? (
                  <>
                    <div className="tag-list">
                      {memory.tags.map((t: string) => (
                        <Tag key={t}>{t}</Tag>
                      ))}
                    </div>
                    {memory.project && (
                      <div className="detail-row">
                        <span>Project</span>
                        <strong>{memory.project}</strong>
                      </div>
                    )}
                    <Markdown text={memory.body || '*This memory has no body yet.*'} />
                    {(memory.facts || []).map((fact: any, index: number) => (
                      <div className="fact-box" key={index}>
                        <span>{fact.key}</span>
                        <strong>{fact.value}</strong>
                      </div>
                    ))}
                    <DeleteAction
                      permanent
                      kind="memories"
                      id={memory.id}
                      title={memory.title}
                      onDeleted={() => {
                        onClose();
                        onRefresh();
                        notify('Memory and its history permanently deleted');
                      }}
                    />
                    <div className="inspector-footnote">
                      <ShieldCheck size={15} />
                      <span>
                        {pretty(memory.provenance.kind)} · revision {memory.version}
                        <br />
                        Updated {date(memory.updated_at)}
                      </span>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">A structured entity in your knowledge graph.</p>
                    <dl>
                      {Object.entries(entity.entity.properties || {}).map(([key, value]) => (
                        <div className="detail-row" key={key}>
                          <dt>{key}</dt>
                          <dd>{String(value)}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                )}
              </>
            )}
            {tab === 'Connections' && (
              <>
                <div className="pane-heading">
                  <h3>Typed relationships</h3>
                  <button
                    className="icon-button"
                    aria-label="Add relationship"
                    disabled={(memory?.status || entity.entity.status) === 'archived'}
                    onClick={() => {
                      setTarget('');
                      setLink(true);
                    }}
                  >
                    <Plus size={17} />
                  </button>
                </div>
                {!entity.relationships.length && (
                  <p className="muted">Connect this memory to another entity to give it context.</p>
                )}
                {entity.relationships.map((r: any) => (
                  <div key={r.id} className={`relationship-row ${r.valid_until ? 'ended' : ''}`}>
                    <Link2 size={15} />
                    <button onClick={() => onSelect(r.from_id === id ? r.to_id : r.from_id)}>
                      <small>
                        {r.from_id === id ? '→' : '←'} {pretty(r.type)} {r.valid_until && '(ended)'}
                      </small>
                      <strong>{r.from_id === id ? r.to_name : r.from_name}</strong>
                      <span>
                        {pretty(r.provenance.kind)} · {date(r.created_at)}
                      </span>
                    </button>
                    {!r.valid_until && (
                      <DeleteAction
                        kind="relationships"
                        id={r.id}
                        title={`${pretty(r.type)}: ${r.from_name} → ${r.to_name}`}
                        onDeleted={() => {
                          void load();
                          onRefresh();
                        }}
                      />
                    )}
                  </div>
                ))}
              </>
            )}
            {tab === 'History' && (
              <>
                <h3>Every version has a story</h3>
                <p className="muted">Open a revision to inspect the exact content at that time.</p>
                {events.map((event) => (
                  <button
                    key={event.id}
                    className="history-item"
                    onClick={() => setHistorical(event.payload.memory || null)}
                    disabled={!event.payload.memory}
                  >
                    <div className="timeline-dot" />
                    <span>
                      <small>
                        {date(event.at)} · {time(event.at)}
                      </small>
                      <strong>{pretty(event.kind.replace('.', ' '))}</strong>
                      <span>
                        {event.actor}
                        {event.payload.memory && ` · revision ${event.payload.memory.version}`}
                        {event.payload.memory?.project_state && ` · ${event.payload.memory.project_state}`}
                      </span>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                ))}
              </>
            )}
            {tab === 'Evidence' && (
              <>
                <div className="provenance-banner">
                  <ShieldCheck size={21} />
                  <div>
                    <strong>{pretty((memory?.provenance || entity.entity.provenance).kind)}</strong>
                    <span>Recorded provenance</span>
                  </div>
                </div>
                {Object.entries(memory?.provenance || entity.entity.provenance).map(([key, value]) => (
                  <div className="provenance-field" key={key}>
                    <label>{pretty(key)}</label>
                    {key === 'source_id' && value ? (
                      <SourceLink id={String(value)}>Download original</SourceLink>
                    ) : (
                      <p>
                        {Array.isArray(value)
                          ? value.length
                            ? value.join('\n')
                            : 'None recorded'
                          : String(value)}
                      </p>
                    )}
                  </div>
                ))}
                {memory && (
                  <div className="provenance-field">
                    <label>Canonical file</label>
                    <code>{memory.path}</code>
                    <label>SHA-256</label>
                    <code>{memory.content_hash}</code>
                    <label>Memory ID</label>
                    <code>{memory.id}</code>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
      {link && (
        <Modal title="Connect this memory" onClose={() => setLink(false)}>
          <div className="form-stack">
            <label>
              Relationship type
              <input
                value={relationType}
                onChange={(e) => setRelationType(e.target.value)}
                placeholder="uses, contains, secured_by…"
              />
            </label>
            <ConnectionPicker exclude={id} value={target} onChange={setTarget} />
            <p className="muted">This connection is recorded as explicitly provided by you.</p>
          </div>
          <div className="modal-footer">
            <span />
            <button className="primary" onClick={addLink} disabled={busy || !target}>
              Save relationship
            </button>
          </div>
        </Modal>
      )}
      {historical && (
        <Modal
          wide
          title={`Revision ${historical.version} · ${date(historical.updated_at)}`}
          onClose={() => setHistorical(undefined)}
        >
          <div className="historical-content">
            <h1>{historical.title}</h1>
            {historical.project_state && <p>Project lifecycle: {historical.project_state}</p>}
            <Markdown text={historical.body} />
          </div>
          <div className="modal-footer">
            <span className="muted">Restoring preserves all intervening history.</span>
            <button disabled={busy} onClick={restoreRevision}>
              <RotateCcw size={15} /> Restore as new revision
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
