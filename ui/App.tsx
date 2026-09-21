import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Orbit,
  Search,
  History,
  FolderOpen,
  FileText,
  Inbox,
  CheckCheck,
  Library,
  Settings,
  Plus,
  Command,
  ArrowUpRight,
  Upload,
  Sparkles,
  ShieldCheck,
  X,
  PanelLeftClose,
  Link2,
  ChevronDown,
  LoaderCircle,
} from 'lucide-react';
import { api, color, Modal, post, pretty, put, Tag } from './lib';
import { Graph } from './Graph';
import { Editor, Capture } from './Editor';
import { Inspector } from './Inspector';
import { Ask } from './Ask';
import { InboxView, MemoryList, SearchView, Sources, Tasks, Timeline } from './Views';
import { SettingsView } from './Settings';
import { isDesktop, useDesktopVisible, desktopListen } from './desktopBridge';
const nav = [
  { name: 'Brain', icon: Orbit },
  { name: 'Ask', icon: Sparkles },
  { name: 'Search', icon: Search },
  { name: 'Timeline', icon: History },
  { name: 'Projects', icon: FolderOpen },
  { name: 'Notes', icon: FileText },
  { name: 'Inbox', icon: Inbox },
  { name: 'Tasks', icon: CheckCheck },
  { name: 'Sources', icon: Library },
];
const blankGraph = { entities: [], relationships: [], clusters: [], total: 0 };
export function App() {
  const desktopVisible = useDesktopVisible();
  const [view, setView] = useState('Brain'),
    [status, setStatus] = useState<any>(),
    [settings, setSettings] = useState<any>(),
    [graph, setGraph] = useState<any>(blankGraph),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<string>(),
    [highlight, setHighlight] = useState<string[]>([]),
    [graphType, setGraphType] = useState(''),
    [graphOffset, setGraphOffset] = useState(0),
    [historicalAt, setHistoricalAt] = useState(''),
    [editor, setEditor] = useState<any>(),
    [capture, setCapture] = useState(false),
    [palette, setPalette] = useState(false),
    [entityModal, setEntityModal] = useState(false),
    [toast, setToast] = useState<{ text: string; error?: boolean }>(),
    [authenticated, setAuthenticated] = useState(false),
    [authError, setAuthError] = useState(''),
    [sessionKey, setSessionKey] = useState(''),
    [uploading, setUploading] = useState(''),
    [dragging, setDragging] = useState(false),
    [sidebar, setSidebar] = useState(true),
    [loading, setLoading] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    dragCount = useRef(0);
  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), error ? 10000 : 5000);
  }, []);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  const select = useCallback((id: string) => setSelected(id), []);
  const cluster = useCallback((type: string) => {
    setGraphType(type);
    setGraphOffset(0);
  }, []);
  const authenticate = async (key: string) => {
    try {
      if (key) await post('/session', { token: key });
      await api('/status');
      setAuthenticated(true);
      setAuthError('');
    } catch (e) {
      setAuthError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname);
    void authenticate(token || '');
  }, []);
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    Promise.all([api('/status'), api('/settings')])
      .then(([s, p]) => {
        if (live) {
          setStatus(s);
          setSettings(p);
        }
      })
      .catch((e) => notify(e.message, true));
    return () => {
      live = false;
    };
  }, [authenticated, revision]);
  useEffect(() => {
    if (!authenticated) return;
    let live = true;
    api(
      `/graph?limit=350&offset=${graphOffset}${graphType ? `&type=${encodeURIComponent(graphType)}` : ''}${historicalAt ? `&at=${encodeURIComponent(historicalAt)}` : ''}`,
    )
      .then((g) => live && setGraph(g))
      .catch((e) => notify(e.message, true));
    return () => {
      live = false;
    };
  }, [authenticated, revision, graphType, graphOffset, historicalAt]);
  useEffect(() => {
    if (!authenticated || !desktopVisible) return;
    refresh();
    const events = new EventSource('/api/live');
    events.onmessage = () => refresh();
    return () => events.close();
  }, [authenticated, desktopVisible]);
  useEffect(
    () =>
      desktopListen('desktop-status-requested', () => {
        setView('Settings');
        setSelected(undefined);
      }),
    [],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'Space') {
        e.preventDefault();
        setCapture(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setEditor({ type: 'note' });
      }
      if (e.key === 'Escape') setSelected(undefined);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.reducedMotion = settings?.reduced_motion ? 'true' : 'false';
  }, [settings?.reduced_motion]);
  const navigate = (name: string) => {
    setView(name);
    setSelected(undefined);
    setHistoricalAt('');
    if (name !== 'Brain') setHighlight([]);
  };
  const saved = (memory: any) => {
    setEditor(undefined);
    setCapture(false);
    refresh();
    setSelected(memory.id);
    notify('Memory saved · history preserved');
  };
  const importFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      setUploading(file.name);
      try {
        if (file.size > 100 * 1024 * 1024) throw new Error(`${file.name} exceeds 100 MiB`);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768)
          binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        const result = await post('/import', {
          name: file.name,
          mime: file.type || 'application/octet-stream',
          content: btoa(binary),
        });
        notify(result.duplicate ? `${file.name} is already preserved` : `${file.name} imported`);
        refresh();
      } catch (e) {
        notify((e as Error).message, true);
      }
    }
    setUploading('');
    if (fileInput.current) fileInput.current.value = '';
  };
  if (!authenticated)
    return (
      <main className="connection-screen">
        <img src="/mark.svg" alt="Mneme" />
        <div className="eyebrow">Mneme / Personal memory</div>
        <h1>{loading ? 'Opening your memory…' : 'Your memory is private.'}</h1>
        <p>
          {loading
            ? 'Connecting to the local service.'
            : 'Open the private session link printed by your local service, or paste its session key below.'}
        </p>
        {!loading && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void authenticate(sessionKey);
            }}
          >
            <input
              type="password"
              aria-label="Local session key"
              placeholder="Local session key"
              value={sessionKey}
              onChange={(e) => setSessionKey(e.target.value)}
            />
            <button className="primary">Open brain</button>
          </form>
        )}
        {authError && (
          <p role="alert" className="muted">
            {authError}
          </p>
        )}
      </main>
    );
  return (
    <div
      className={`app ${sidebar ? '' : 'sidebar-collapsed'}`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          dragCount.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDragLeave={() => {
        dragCount.current--;
        if (dragCount.current <= 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragCount.current = 0;
        setDragging(false);
        if (e.dataTransfer.files.length) void importFiles(e.dataTransfer.files);
      }}
    >
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate('Brain')} aria-label="Mneme home">
          <img src="/mark.svg" alt="" />
          <div>
            mneme<span>YOUR PERSONAL MEMORY</span>
          </div>
        </button>
        <button aria-label="Find anything" className="command-launch" onClick={() => setPalette(true)}>
          <Search size={15} />
          <span>Find anything</span>
          <kbd>⌃ K</kbd>
        </button>
        <div className="nav-heading">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {nav.map(({ name, icon: Icon }, i) => (
            <button
              className={`${view === name ? 'active' : ''} ${i === 4 ? 'nav-section-start' : ''}`}
              key={name}
              aria-label={name}
              onClick={() => navigate(name)}
            >
              <Icon size={18} strokeWidth={1.6} />
              <span>{name}</span>
              {name === 'Inbox' && !!(status?.inbox + status?.proposals) && (
                <b>{status.inbox + status.proposals}</b>
              )}
              {name === 'Ask' && <small>AI optional</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button aria-label="Quick capture" className="capture-launch" onClick={() => setCapture(true)}>
            <Plus size={17} />
            <span>Quick capture</span>
            <kbd>⌃ ⇧ ␣</kbd>
          </button>
          <button
            aria-label="Settings"
            className={view === 'Settings' ? 'settings-link active' : 'settings-link'}
            onClick={() => navigate('Settings')}
          >
            <Settings size={17} />
            <span>Settings</span>
          </button>
          <div className="local-indicator">
            <span className="status-dot" />
            <div>
              {status?.local_only ? 'Local only' : 'External AI permitted'}
              <small>
                {status?.background ? 'Your memory, on your machine' : 'Background processing paused'}
              </small>
            </div>
            <ShieldCheck size={14} />
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <button
              className="icon-button sidebar-toggle"
              aria-label="Toggle sidebar"
              onClick={() => setSidebar(!sidebar)}
            >
              <PanelLeftClose size={17} />
            </button>
            <span className="breadcrumb">{status?.name || 'My brain'}</span>
            <span className="breadcrumb-divider">/</span>
            <span>{view === 'Brain' ? 'Knowledge space' : view}</span>
            {historicalAt && <Tag>Historical view</Tag>}
          </div>
          <div className="topbar-actions">
            <span className="storage-status">
              <span className="status-dot" />
              {status?.queued_jobs ? `${status.queued_jobs} background jobs` : 'Saved locally'}
            </span>
            <button onClick={() => fileInput.current?.click()} disabled={!!uploading}>
              <Upload size={14} /> Import
            </button>
            <button className="primary compact" onClick={() => setEditor({ type: 'note' })}>
              <Plus size={15} /> New memory
            </button>
          </div>
        </header>
        {(view === 'Brain' || view === 'Ask') && (
          <div className="brain-view">
            <div className="brain-heading">
              <div className="eyebrow">YOUR KNOWLEDGE, CONNECTED</div>
              <h1>{historicalAt ? 'A moment in memory.' : 'A space for your mind.'}</h1>
              <p>
                {historicalAt
                  ? new Date(historicalAt).toLocaleString()
                  : `${status?.memories || 0} memories · ${status?.relationships || 0} connections · one evolving perspective`}
              </p>
            </div>
            <div className="brain-toolbar">
              <div className="cluster-filters">
                <button
                  className={!graphType ? 'active' : ''}
                  onClick={() => {
                    setGraphType('');
                    setGraphOffset(0);
                  }}
                >
                  All knowledge
                </button>
                {graph.clusters.slice(0, 7).map((group: any) => (
                  <button
                    className={graphType === group.type ? 'active' : ''}
                    key={group.type}
                    onClick={() => cluster(group.type)}
                  >
                    <i style={{ background: color(group.type) }} />
                    {pretty(group.type)}
                    <span>{group.count}</span>
                  </button>
                ))}
              </div>
              <button
                className="icon-button"
                title="Create structured entity"
                aria-label="Create entity"
                onClick={() => setEntityModal(true)}
              >
                <Link2 size={17} />
              </button>
            </div>
            {historicalAt && (
              <button className="return-present" onClick={() => setHistoricalAt('')}>
                Return to present <ArrowUpRight size={13} />
              </button>
            )}
            <Graph
              data={graph}
              selected={selected}
              highlights={highlight}
              onSelect={select}
              onCluster={cluster}
              reducedMotion={
                settings?.reduced_motion || matchMedia('(prefers-reduced-motion: reduce)').matches
              }
              onCapture={() => setCapture(true)}
            />
            {graph.truncated && (
              <div className="graph-page">
                <span>
                  Showing {graph.entities.length} of {graph.total} entities
                </span>
                <button disabled={!graphOffset} onClick={() => setGraphOffset((v) => Math.max(0, v - 350))}>
                  Previous
                </button>
                <button disabled={graph.entities.length < 350} onClick={() => setGraphOffset((v) => v + 350)}>
                  Next
                </button>
              </div>
            )}
            {view === 'Ask' && !selected && (
              <Ask
                revision={revision}
                settings={settings}
                onSelect={select}
                onHighlights={setHighlight}
                onClose={() => navigate('Brain')}
              />
            )}
          </div>
        )}
        {(view === 'Notes' || view === 'Projects') && (
          <MemoryList
            view={view}
            revision={revision}
            onSelect={select}
            onCreate={(type) => setEditor({ type })}
          />
        )}
        {view === 'Search' && (
          <SearchView revision={revision} onSelect={select} onHighlights={setHighlight} />
        )}
        {view === 'Timeline' && (
          <Timeline
            revision={revision}
            onSelect={select}
            onHistoricalGraph={(at) => {
              setView('Brain');
              setHistoricalAt(at);
              setSelected(undefined);
            }}
          />
        )}
        {view === 'Tasks' && <Tasks revision={revision} refresh={refresh} notify={notify} />}
        {view === 'Inbox' && (
          <InboxView
            revision={revision}
            refresh={refresh}
            onSelect={select}
            onEdit={(memory) => setEditor({ memory })}
            notify={notify}
          />
        )}
        {view === 'Sources' && (
          <Sources
            refresh={refresh}
            revision={revision}
            onImport={() => fileInput.current?.click()}
            onSelect={select}
            notify={notify}
          />
        )}
        {view === 'Settings' && (
          <SettingsView
            settings={settings}
            status={status}
            refresh={refresh}
            revision={revision}
            notify={notify}
          />
        )}
        {selected && (
          <Inspector
            key={`${selected}:${revision}`}
            id={selected}
            onClose={() => setSelected(undefined)}
            onEdit={(memory) => setEditor({ memory })}
            onSelect={select}
            onRefresh={refresh}
            notify={notify}
          />
        )}
      </main>
      <input
        ref={fileInput}
        type="file"
        multiple
        className="visually-hidden"
        aria-label="Import files"
        onChange={(e) => {
          if (e.target.files) void importFiles(e.target.files);
        }}
      />
      {editor && (
        <Editor
          memory={editor.memory}
          type={editor.type}
          onClose={() => setEditor(undefined)}
          onSaved={saved}
          onDeleted={() => {
            setEditor(undefined);
            setSelected(undefined);
            refresh();
            notify('Memory removed');
          }}
        />
      )}
      {capture && <Capture onClose={() => setCapture(false)} onSaved={saved} />}
      {palette && (
        <Palette
          onClose={() => setPalette(false)}
          onSelect={(id) => {
            select(id);
            setPalette(false);
          }}
          onNavigate={(name) => {
            navigate(name);
            setPalette(false);
          }}
          onCapture={() => {
            setPalette(false);
            setCapture(true);
          }}
          onCreate={() => {
            setPalette(false);
            setEditor({ type: 'note' });
          }}
          onImport={() => {
            setPalette(false);
            fileInput.current?.click();
          }}
        />
      )}
      {entityModal && (
        <EntityModal
          onClose={() => setEntityModal(false)}
          onSaved={(entity) => {
            setEntityModal(false);
            refresh();
            select(entity.id);
          }}
          notify={notify}
        />
      )}
      {settings && !settings.onboarded && (
        <Onboarding settings={settings} root={status?.root} onDone={refresh} notify={notify} />
      )}
      {toast && (
        <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>
          {toast.error ? <X size={16} /> : <ShieldCheck size={16} />}
          <span>{toast.text}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setToast(undefined)}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {uploading && (
        <div className="upload-status" role="status">
          <LoaderCircle size={17} className="spin" />
          Preserving {uploading}…
        </div>
      )}
      {dragging && (
        <div className="drop-overlay">
          <Upload size={38} />
          <h2>Let it land here.</h2>
          <p>Originals preserved. Memories connected.</p>
        </div>
      )}
    </div>
  );
}
function Palette({
  onClose,
  onSelect,
  onNavigate,
  onCapture,
  onCreate,
  onImport,
}: {
  onClose: () => void;
  onSelect: (id: string) => void;
  onNavigate: (name: string) => void;
  onCapture: () => void;
  onCreate: () => void;
  onImport: () => void;
}) {
  const [query, setQuery] = useState(''),
    [hits, setHits] = useState<any[]>([]),
    [index, setIndex] = useState(0),
    [error, setError] = useState('');
  const commands = [
    { title: 'Create a memory', icon: Plus, run: onCreate },
    { title: 'Quick capture', icon: Inbox, run: onCapture },
    { title: 'Import files', icon: Upload, run: onImport },
    ...nav.map((item) => ({ title: `Open ${item.name}`, icon: item.icon, run: () => onNavigate(item.name) })),
    { title: 'Open Settings', icon: Settings, run: () => onNavigate('Settings') },
  ].filter((item) => item.title.toLowerCase().includes(query.toLowerCase().replace(/^>/, '').trim()));
  const entries = [
    ...(query.startsWith('>')
      ? []
      : hits.map((hit) => ({
          title: hit.memory.title,
          type: hit.memory.type,
          icon: FileText,
          run: () => onSelect(hit.memory.id),
        }))),
    ...commands,
  ];
  useEffect(() => {
    setIndex(0);
    let active = true;
    const timer = setTimeout(() => {
      if (query.startsWith('>')) return;
      api(`/search?q=${encodeURIComponent(query)}&limit=8`)
        .then((data) => {
          if (active) setHits(data.hits);
        })
        .catch((e) => active && setError(e.message));
    }, 100);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);
  return (
    <Modal title="Find anything" onClose={onClose}>
      <div className="palette-input">
        <Search size={21} />
        <input
          autoFocus
          aria-label="Command search"
          placeholder="A memory, a project, a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(entries.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              entries[index]?.run();
            }
          }}
        />
      </div>
      <div className="palette-results" role="listbox" aria-label="Search and commands">
        {entries.map((item: any, i) => (
          <button
            role="option"
            aria-selected={i === index}
            className={i === index ? 'active' : ''}
            key={`${item.title}-${i}`}
            onMouseEnter={() => setIndex(i)}
            onClick={item.run}
          >
            <item.icon size={17} />
            <span>{item.title}</span>
            <small>{item.type || 'Command'}</small>
            <ArrowUpRight size={13} />
          </button>
        ))}
        {!entries.length && <p className="muted">No results. Try another phrase.</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
      <div className="palette-footer">
        <span>↑ ↓ to move · Enter to open</span>
        <span>Type &gt; for commands</span>
      </div>
    </Modal>
  );
}
function EntityModal({
  onClose,
  onSaved,
  notify,
}: {
  onClose: () => void;
  onSaved: (entity: any) => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [name, setName] = useState(''),
    [type, setType] = useState('concept'),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="Add something to connect" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            onSaved(await post('/entities', { name, type }));
          } catch (e) {
            notify((e as Error).message, true);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="form-stack">
          <label>
            Entity name
            <input
              autoFocus
              aria-label="Entity name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="A person, technology, device, or concept"
              required
            />
          </label>
          <label>
            Entity type
            <input
              aria-label="Entity type"
              value={type}
              onChange={(e) => setType(e.target.value)}
              pattern="[a-z][a-z0-9_-]*"
              required
            />
          </label>
          <p className="muted">
            An entity gives your knowledge a common point of reference. Add typed connections in its
            inspector.
          </p>
        </div>
        <div className="modal-footer">
          <span />
          <button className="primary" disabled={busy || !name.trim()}>
            Create entity
          </button>
        </div>
      </form>
    </Modal>
  );
}
function Onboarding({
  settings,
  root,
  onDone,
  notify,
}: {
  settings: any;
  root: string;
  onDone: () => void;
  notify: (text: string, error?: boolean) => void;
}) {
  const [name, setName] = useState(settings.name),
    [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const { key_configured, key_storage, ...data } = settings;
      await put('/settings', { ...data, name, onboarded: true });
      onDone();
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Welcome to Mneme" onClose={() => {}}>
      <div className="onboarding">
        <div className="eyebrow">A lasting home for what you know</div>
        <h1>
          Make room
          <br />
          for your mind.
        </h1>
        <p>Your thoughts, decisions, and discoveries deserve a place that belongs to you.</p>
        <label>
          Give your brain a name
          <input aria-label="Brain name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="onboarding-facts">
          <div>
            <ShieldCheck size={18} />
            <span>
              <strong>Private from the first thought.</strong>
              <small>No account. No uploads. No AI required.</small>
            </span>
          </div>
          <div>
            <FileText size={18} />
            <span>
              <strong>Your files stay yours.</strong>
              <small>Readable Markdown and SQLite, right here.</small>
              <code>{root}</code>
            </span>
          </div>
          <div>
            <History size={18} />
            <span>
              <strong>Built to find your way back.</strong>
              <small>Revision history is automatic. Create verified snapshots in Settings → Backups.</small>
            </span>
          </div>
        </div>
        <p className="small muted">
          {isDesktop ? (
            'Choose another brain folder in Settings → General.'
          ) : (
            <>
              Choose another location with the launch option <code>--brain "directory"</code>.
            </>
          )}{' '}
          Optional models can be configured in Settings.
        </p>
      </div>
      <div className="modal-footer">
        <span className="muted">Everything starts locally.</span>
        <button className="primary" disabled={busy || !name.trim()} onClick={start}>
          Open my brain <ArrowUpRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
