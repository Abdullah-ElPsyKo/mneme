import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  HardDrive,
  Cpu,
  Archive,
  Activity,
  Check,
  Download,
  RotateCcw,
  Play,
  Pause,
  KeyRound,
  ArrowUpRight,
} from 'lucide-react';
import { api, date, Modal, post, pretty, put, SectionTitle, Tag } from './lib';
import { isDesktop } from './desktopBridge';
import { DesktopBrainActions, DesktopSettings } from './Desktop';
export function SettingsView({
  settings,
  status,
  refresh,
  revision,
  notify,
}: {
  settings: any;
  status: any;
  refresh: () => void;
  revision: number;
  notify: (text: string, error?: boolean) => void;
}) {
  const [draft, setDraft] = useState<any>(settings),
    [tab, setTab] = useState('General'),
    [saving, setSaving] = useState(false),
    [jobs, setJobs] = useState<any[]>([]),
    [backups, setBackups] = useState<any[]>([]),
    [doctor, setDoctor] = useState<any>(),
    [password, setPassword] = useState(''),
    [key, setKey] = useState(''),
    [restore, setRestore] = useState<any>(),
    [destination, setDestination] = useState(''),
    [busy, setBusy] = useState('');
  useEffect(() => {
    setDraft(settings);
  }, [settings]);
  useEffect(() => {
    Promise.all([api('/jobs'), api('/backups')])
      .then(([j, b]) => {
        setJobs(j);
        setBackups(b);
      })
      .catch((e) => notify(e.message, true));
  }, [revision]);
  const change = (field: string, value: any) => setDraft((d: any) => ({ ...d, [field]: value }));
  const save = async () => {
    setSaving(true);
    try {
      const { key_configured, key_storage, ...input } = draft;
      await put('/settings', input);
      refresh();
      notify('Preferences saved locally');
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setSaving(false);
    }
  };
  const run = async (name: string, operation: () => Promise<any>) => {
    setBusy(name);
    try {
      const result = await operation();
      refresh();
      notify(name === 'Restore' ? `Restored to ${result.path}` : `${name} complete`);
      return result;
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setBusy('');
    }
  };
  const enqueue = (type: string) => run('Job queued', () => post('/jobs', { type }));
  if (!draft) return null;
  return (
    <div className="view-scroll settings-view">
      <SectionTitle
        eyebrow="Your brain. Your rules."
        title="Settings"
        description="Everything begins and stays on this machine, unless you choose otherwise."
        actions={
          tab !== 'Desktop' && (
            <button className="primary" disabled={saving} onClick={save}>
              <Check size={15} />
              {saving ? 'Saving…' : 'Save preferences'}
            </button>
          )
        }
      />
      <div className="settings-tabs">
        {[
          ['General', HardDrive],
          ['Privacy & AI', ShieldCheck],
          ['Backups', Archive],
          ['Processing', Cpu],
          ['Diagnostics', Activity],
          ...(isDesktop ? [['Desktop', HardDrive]] : []),
        ].map(([label, Icon]: any) => (
          <button className={tab === label ? 'active' : ''} key={label} onClick={() => setTab(label)}>
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>
      {tab === 'Desktop' && <DesktopSettings />}
      {tab === 'General' && (
        <div className="settings-section">
          <h2>A home for your memory</h2>
          <label>
            Brain name
            <input value={draft.name} onChange={(e) => change('name', e.target.value)} />
          </label>
          <div className="settings-row">
            <div>
              <strong>Storage location</strong>
              <p>Human-readable Markdown, SQLite, and immutable original files.</p>
              <code className="storage-path">{status?.root}</code>
            </div>
            <HardDrive size={24} strokeWidth={1.3} />
          </div>
          {isDesktop ? (
            <DesktopBrainActions />
          ) : (
            <div className="notice">
              To choose a different brain directory, start with <code>npm start -- --brain "directory"</code>.
              Restore always creates a new directory.
            </div>
          )}
          <label className="toggle-row">
            <div>
              <strong>Reduce motion</strong>
              <p>Use immediate camera transitions and quieter interface movement.</p>
            </div>
            <input
              type="checkbox"
              checked={draft.reduced_motion}
              onChange={(e) => change('reduced_motion', e.target.checked)}
            />
          </label>
          <div className="settings-row">
            <div>
              <strong>Portable by design</strong>
              <p>Your notes are readable without Mneme. Indexes can be rebuilt. AI is optional.</p>
            </div>
            <ArrowUpRight size={20} />
          </div>
        </div>
      )}
      {tab === 'Privacy & AI' && (
        <div className="settings-section">
          <div className="privacy-header">
            <ShieldCheck size={26} />
            <div>
              <h2>{draft.local_only ? 'Local only' : 'External providers permitted'}</h2>
              <p>
                {draft.local_only
                  ? 'External AI and embedding endpoints are blocked.'
                  : 'Each external model request still asks for explicit consent.'}
              </p>
            </div>
          </div>
          <label className="toggle-row">
            <div>
              <strong>Local-only privacy mode</strong>
              <p>Restrict configured providers to loopback addresses. No telemetry is sent.</p>
            </div>
            <input
              type="checkbox"
              checked={draft.local_only}
              onChange={(e) => change('local_only', e.target.checked)}
            />
          </label>
          <label>
            Provider
            <select value={draft.provider} onChange={(e) => change('provider', e.target.value)}>
              <option value="disabled">Disabled — evidence works without AI</option>
              <option value="ollama">Ollama</option>
              <option value="openai-compatible">OpenAI-compatible endpoint</option>
            </select>
          </label>
          {draft.provider !== 'disabled' && (
            <>
              <label>
                Endpoint
                <input
                  aria-label="Model endpoint"
                  value={draft.endpoint}
                  onChange={(e) => change('endpoint', e.target.value)}
                />
                <small>Ollama: http://127.0.0.1:11434 · Compatible APIs: include /v1</small>
              </label>
              <div className="form-columns">
                <label>
                  Chat model
                  <input
                    value={draft.model}
                    placeholder="Your installed model name"
                    onChange={(e) => change('model', e.target.value)}
                  />
                </label>
                <label>
                  Embedding model
                  <input
                    value={draft.embedding_model}
                    placeholder="Optional installed model"
                    onChange={(e) => change('embedding_model', e.target.value)}
                  />
                </label>
              </div>
              <label>
                Maximum context tokens
                <input
                  type="number"
                  min="300"
                  max="32000"
                  value={draft.context_budget}
                  onChange={(e) => change('context_budget', Number(e.target.value))}
                />
                <small>Conservative UTF-8 estimate. This limits selected evidence.</small>
              </label>
              <div className="secret-section">
                <h3>Provider credential</h3>
                <p>
                  {settings?.key_storage}.{' '}
                  {settings?.key_configured ? 'A credential is configured.' : 'No credential configured.'}
                </p>
                <div className="inline-input">
                  <input
                    type="password"
                    autoComplete="new-password"
                    aria-label="Provider API key"
                    placeholder="Optional API key"
                    value={key}
                    onChange={(e) => setKey(e.target.value)}
                  />
                  <button
                    disabled={!key || !!busy}
                    onClick={() =>
                      run('Credential protection', async () => {
                        const result = await put('/settings/key', { key });
                        setKey('');
                        return result;
                      })
                    }
                  >
                    <KeyRound size={14} /> Protect key
                  </button>
                </div>
              </div>
            </>
          )}
          <div className="notice">
            Models receive selected evidence and citations. They have no tools or direct authority to edit
            memory. Imported content is treated as untrusted data.
          </div>
        </div>
      )}
      {tab === 'Backups' && (
        <div className="settings-section">
          <h2>Keep a way back.</h2>
          <p className="muted">
            Each snapshot includes a consistent SQLite database, Markdown revisions, original objects, and a
            SHA-256 manifest. Every new snapshot is verified before it is retained.
          </p>
          <label>
            Backup directory
            <input
              value={draft.backup_directory}
              placeholder="Default: backups inside your brain"
              onChange={(e) => change('backup_directory', e.target.value)}
            />
          </label>
          <div className="form-columns">
            <label>
              Retain snapshots
              <input
                type="number"
                min="1"
                max="1000"
                value={draft.backup_retention}
                onChange={(e) => change('backup_retention', Number(e.target.value))}
              />
            </label>
            <label>
              Automatic backup interval (hours)
              <input
                type="number"
                min="0"
                max="8760"
                value={draft.backup_interval_hours}
                onChange={(e) => change('backup_interval_hours', Number(e.target.value))}
              />
              <small>0 disables automatic backups. Scheduled backups are unencrypted.</small>
            </label>
          </div>
          <div className="backup-action">
            <div>
              <strong>Create a verified snapshot</strong>
              <p>
                Add a passphrase to use standard WinZip AES-256 encryption. Keep it safe; it cannot be
                recovered.
              </p>
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Backup passphrase"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Optional passphrase · at least 12 characters"
              />
            </div>
            <button
              className="primary"
              disabled={!!busy || (!!password && password.length < 12)}
              onClick={() => run('Backup', () => post('/backups', password ? { password } : {}))}
            >
              <Archive size={16} />
              {busy === 'Backup' ? 'Creating…' : 'Back up now'}
            </button>
          </div>
          {backups.map((backup) => (
            <div className="backup-row" key={backup.id}>
              <Archive size={20} />
              <div>
                <strong>{date(backup.created_at)}</strong>
                <p>{backup.path.split(/[\\/]/).pop()}</p>
                <small>
                  {backup.path.includes('.encrypted.') ? 'AES-256 encrypted' : 'Unencrypted local snapshot'}
                </small>
              </div>
              <a
                className="icon-button"
                aria-label="Download backup"
                href={`/api/backups/${backup.id}/download`}
              >
                <Download size={16} />
              </a>
              <button
                disabled={!!busy}
                onClick={() =>
                  run('Verification', () =>
                    post('/backups/verify', { id: backup.id, ...(password ? { password } : {}) }),
                  )
                }
              >
                Verify
              </button>
              <button
                disabled={!!busy}
                onClick={() => {
                  setRestore(backup);
                  setDestination('');
                }}
              >
                <RotateCcw size={14} /> Restore
              </button>
            </div>
          ))}
          {!backups.length && <p className="muted">No snapshots yet. Create one before you need it.</p>}
        </div>
      )}
      {tab === 'Processing' && (
        <div className="settings-section">
          <h2>Quietly, in the background.</h2>
          <label className="toggle-row">
            <div>
              <strong>Background processing</strong>
              <p>Watch Markdown files, run queued work, and maintain indexes.</p>
            </div>
            <input
              type="checkbox"
              checked={draft.background}
              onChange={(e) => change('background', e.target.checked)}
            />
          </label>
          <label className="toggle-row">
            <div>
              <strong>Background AI</strong>
              <p>Permit explicitly queued local embedding jobs. External models never run unattended.</p>
            </div>
            <input
              type="checkbox"
              checked={draft.ai_background}
              onChange={(e) => change('ai_background', e.target.checked)}
            />
          </label>
          <label className="toggle-row">
            <div>
              <strong>Accept explicit wiki links automatically</strong>
              <p>Only unambiguous [[Entity name]] references. Provenance and history are preserved.</p>
            </div>
            <input
              type="checkbox"
              checked={draft.auto_accept_links}
              onChange={(e) => change('auto_accept_links', e.target.checked)}
            />
          </label>
          <label>
            Consolidation interval (hours)
            <input
              type="number"
              min="0"
              max="8760"
              value={draft.consolidation_interval_hours}
              onChange={(e) => change('consolidation_interval_hours', Number(e.target.value))}
            />
            <small>Incremental proposals and conflict checks. 0 disables scheduling.</small>
          </label>
          <div className="maintenance-actions">
            {[
              ['reconcile', 'Reconcile files'],
              ['rebuild', 'Rebuild index'],
              ['consolidate', 'Find connections'],
              ['embed', 'Embed recent memories'],
            ].map(([type, label]) => (
              <button
                key={type}
                disabled={!!busy || (type === 'embed' && (!draft.embedding_model || !draft.ai_background))}
                onClick={() => enqueue(type)}
              >
                {label}
              </button>
            ))}
          </div>
          <h3>Background activity</h3>
          {jobs.map((job) => (
            <div className="job-row" key={job.id}>
              <span className={`job-dot ${job.status}`} />
              <div>
                <strong>{pretty(job.type)}</strong>
                <small>
                  {date(job.created_at)}
                  {job.error && ` · ${job.error}`}
                </small>
              </div>
              <Tag>{job.status}</Tag>
              {job.status === 'failed' && (
                <button onClick={() => run('Retry queued', () => post(`/jobs/${job.id}/retry`))}>
                  Retry
                </button>
              )}
            </div>
          ))}
          {!jobs.length && <p className="muted">No jobs queued. Idle means idle.</p>}
        </div>
      )}
      {tab === 'Diagnostics' && (
        <div className="settings-section">
          <h2>Look under the surface.</h2>
          <p className="muted">
            Check database integrity, foreign keys, Markdown, original objects, and derived indexes without
            contacting any model.
          </p>
          <button
            className="primary"
            disabled={!!busy}
            onClick={async () => {
              const result = await run('Health check', () => api('/doctor?deep=true'));
              if (result) setDoctor(result);
            }}
          >
            <Activity size={16} />
            {busy ? 'Checking…' : 'Run Doctor'}
          </button>
          {doctor && (
            <>
              <div className={`doctor-heading ${doctor.ok ? 'healthy' : ''}`}>
                <ShieldCheck size={22} />
                {doctor.ok ? 'Your brain passed all checks.' : 'Some checks need attention.'}
              </div>
              {[
                ['SQLite', doctor.sqlite],
                ['Foreign keys', doctor.foreign_keys.length ? 'violations found' : 'ok'],
                [
                  'Markdown & originals',
                  doctor.missing.length + doctor.damaged.length ? 'missing or changed files' : 'ok',
                ],
                ['FTS index', `${doctor.fts} · ${doctor.indexed} of ${doctor.canonical} memories`],
                ['Pending file writes', doctor.pending_writes],
                ['Stored embeddings', doctor.vector_count],
              ].map(([label, value]) => (
                <div className="detail-row" key={String(label)}>
                  <span>{label}</span>
                  <strong>{String(value)}</strong>
                </div>
              ))}
              <details>
                <summary>Full diagnostic report</summary>
                <pre>{JSON.stringify(doctor, null, 2)}</pre>
              </details>
            </>
          )}
          {status?.reconciliation?.errors?.length > 0 && (
            <div className="error-banner">
              <strong>Files needing attention</strong>
              <pre>{JSON.stringify(status.reconciliation.errors, null, 2)}</pre>
            </div>
          )}
          {status?.consolidation && (
            <details>
              <summary>Last consolidation report</summary>
              <pre>{JSON.stringify(status.consolidation, null, 2)}</pre>
            </details>
          )}
        </div>
      )}
      {restore && (
        <Modal title="Restore into a new brain" onClose={() => setRestore(undefined)}>
          <div className="form-stack">
            <p>
              The current brain stays available. The snapshot will be validated and restored to a new
              directory.
            </p>
            <label>
              New directory
              <input
                aria-label="Restore destination"
                placeholder="C:\Users\you\Documents\restored-brain"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              />
            </label>
            <label>
              Snapshot passphrase
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <div className="modal-footer">
            <span className="muted">Destination must not already exist.</span>
            <button
              className="primary"
              disabled={!destination || !!busy}
              onClick={async () => {
                const result = await run('Restore', () =>
                  post('/backups/restore', {
                    id: restore.id,
                    destination,
                    ...(password ? { password } : {}),
                  }),
                );
                if (result) setRestore(undefined);
              }}
            >
              {busy === 'Restore' ? 'Restoring…' : 'Verify & restore'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
