import { useEffect, useState } from 'react';
import { FolderOpen, HardDrive, LoaderCircle, ShieldCheck, Check } from 'lucide-react';
import { desktop, desktopListen, isDesktop } from './desktopBridge';
import { Capture } from './Editor';
import { api, Modal, post } from './lib';

export function DesktopHost() {
  const [close, setClose] = useState<{ dirty: boolean; explicit_exit: boolean }>(),
    [remember, setRemember] = useState(false),
    [closing, setClosing] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (!isDesktop) return;
    const stopClose = desktopListen<any>('desktop-close-requested', (payload) => {
      setRemember(false);
      setClose(payload);
    });
    const stopClosing = desktopListen('desktop-closing', () => {
      setClose(undefined);
      setClosing(true);
    });
    const key = (event: KeyboardEvent) => {
      if (event.key === 'F11') {
        event.preventDefault();
        void desktop('desktop_toggle_fullscreen').catch((e) => setError(String(e)));
      }
    };
    const reference = (event: MouseEvent) => {
      const anchor = (event.target as Element)?.closest?.('a');
      if (!anchor || anchor.origin === location.origin || anchor.getAttribute('href')?.startsWith('#'))
        return;
      event.preventDefault();
      void desktop('desktop_open_reference', { url: anchor.href }).catch((e) => setError(String(e)));
    };
    window.addEventListener('keydown', key);
    document.addEventListener('click', reference);
    return () => {
      stopClose();
      stopClosing();
      window.removeEventListener('keydown', key);
      document.removeEventListener('click', reference);
    };
  }, []);
  const finish = async (action: string) => {
    try {
      await desktop('desktop_finish_close', { action, remember });
      setClose(undefined);
    } catch (error) {
      setError(String(error));
    }
  };
  return (
    <>
      {close && (
        <Modal
          title="Close Mneme?"
          onClose={() => {
            void finish('cancel');
          }}
        >
          <div className="capture-body">
            <p>
              {close.dirty
                ? 'You have unsaved drafts. Keeping Mneme in the tray preserves them for this session.'
                : 'Keep Quick Capture available in the tray, or exit Mneme completely.'}
            </p>
            <p className="muted">
              Background processing follows your Desktop settings. Saved memories stay on disk.
            </p>
            {!close.explicit_exit && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Remember my choice
              </label>
            )}
          </div>
          <div className="modal-footer desktop-close-actions">
            <button
              onClick={() => {
                void finish('cancel');
              }}
            >
              Keep open
            </button>
            <button
              onClick={() => {
                void finish('tray');
              }}
            >
              Keep in tray
            </button>
            <button
              className={close.dirty ? 'danger' : 'primary'}
              onClick={() => {
                void finish('exit');
              }}
            >
              {close.dirty ? 'Discard drafts and exit' : 'Exit Mneme'}
            </button>
          </div>
        </Modal>
      )}
      {closing && (
        <Modal title="Closing Mneme" onClose={() => {}}>
          <div className="capture-body">
            <LoaderCircle size={20} className="spin" />
            <p>Finishing active work and closing your brain safely…</p>
          </div>
        </Modal>
      )}
      {error && (
        <Modal title="Desktop action unavailable" onClose={() => setError('')}>
          <div className="capture-body">
            <p role="alert">{error}</p>
          </div>
        </Modal>
      )}
    </>
  );
}
export function DesktopBootstrap() {
  const [state, setState] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    const refresh = () => {
      void desktop('desktop_state')
        .then(setState)
        .catch((e) => setError(String(e)));
    };
    refresh();
    return desktopListen('desktop-state', refresh);
  }, []);
  const choose = async (mode: string) => {
    setBusy(true);
    setError('');
    try {
      await desktop('desktop_choose_brain', { mode });
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  const starting = busy || state?.phase === 'starting';
  return (
    <main className="connection-screen">
      <div className="desktop-welcome">
        <img className="desktop-mark" src="/mark.svg" alt="" />
        <div className="eyebrow">A home for your memory</div>
        <h1>{starting ? 'Opening your brain…' : 'Welcome to Mneme'}</h1>
        <p className="muted">
          Your notes, connections, and original files live together in a folder you own.
        </p>
        {(error || state?.error) && (
          <div className="error-banner" role="alert">
            {error || state.error}
          </div>
        )}
        {starting ? (
          <LoaderCircle className="spin" size={24} />
        ) : (
          <>
            <div className="desktop-brain-options">
              {state?.root && (
                <button
                  className="primary"
                  onClick={() => {
                    void choose('reopen');
                  }}
                >
                  <FolderOpen size={17} /> Reopen selected brain
                </button>
              )}
              <button
                className={state?.root ? '' : 'primary'}
                onClick={() => {
                  void choose('recommended');
                }}
              >
                <HardDrive size={17} /> Use recommended location
              </button>
              <code className="storage-path">{state?.recommended}</code>
              <button
                onClick={() => {
                  void choose('new');
                }}
              >
                <FolderOpen size={17} /> Choose another folder
              </button>
              <button
                onClick={() => {
                  void choose('existing');
                }}
              >
                <FolderOpen size={17} /> Open existing brain
              </button>
            </div>
            <p className="muted desktop-local-note">
              <ShieldCheck size={16} /> Local by default. AI is optional. Existing brains stay where they are.
            </p>
          </>
        )}
        {state?.shortcut_error && <p className="error-text">{state.shortcut_error}</p>}
        <span className="muted desktop-version">Mneme 0.2.3</span>
      </div>
      <DesktopHost />
    </main>
  );
}
export function DesktopCapture() {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    document.documentElement.dataset.desktopCapture = 'true';
    const token = new URLSearchParams(location.hash.slice(1)).get('token');
    history.replaceState(null, '', location.pathname + location.search);
    void (async () => {
      if (token) await post('/session', { token });
      await api('/status');
      setReady(true);
    })().catch((e) => setError(String(e)));
    return desktopListen('desktop-capture-focus', () => {
      document.querySelector('textarea')?.focus();
    });
  }, []);
  const hide = (saved: boolean) => {
    void desktop('desktop_capture_done', { saved }).catch((e) => setError(String(e)));
  };
  if (error)
    return (
      <main className="connection-screen">
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Reconnect</button>
      </main>
    );
  if (!ready)
    return (
      <main className="connection-screen">
        <LoaderCircle className="spin" />
      </main>
    );
  return (
    <Capture
      key={revision}
      onClose={() => hide(false)}
      onSaved={() => {
        setRevision((value) => value + 1);
        hide(true);
      }}
    />
  );
}
export function DesktopBrainActions() {
  const [error, setError] = useState('');
  return (
    <div className="notice">
      <div className="desktop-inline-actions">
        <button
          onClick={() => {
            void desktop('desktop_choose_brain', { mode: 'existing' }).catch((e) => setError(String(e)));
          }}
        >
          Open existing brain
        </button>
        <button
          onClick={() => {
            void desktop('desktop_choose_brain', { mode: 'new' }).catch((e) => setError(String(e)));
          }}
        >
          New brain folder
        </button>
      </div>
      <p>
        Save open drafts before switching. Your current brain stays in its folder. Restore always creates a
        new directory.
      </p>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
    </div>
  );
}
export function DesktopSettings() {
  const [draft, setDraft] = useState<any>(),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void desktop('desktop_preferences')
      .then(setDraft)
      .catch((e) => setError(String(e)));
    void desktop('desktop_state').then((state) => {
      if (state.shortcut_error) setError(state.shortcut_error);
    });
  }, []);
  const save = async () => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setDraft(await desktop('desktop_save_preferences', { preferences: draft }));
      setMessage('Desktop preferences saved');
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  if (!draft) return <p role="status">{error || 'Loading desktop preferences…'}</p>;
  return (
    <div className="settings-section">
      <h2>At home on your desktop</h2>
      <label>
        When I close the window
        <select
          value={draft.close_behavior}
          onChange={(e) => setDraft({ ...draft, close_behavior: e.target.value })}
        >
          <option value="ask">Ask each time</option>
          <option value="exit">Exit Mneme</option>
          <option value="tray">Keep in system tray</option>
        </select>
      </label>
      {[
        [
          'minimize_to_tray',
          'Minimize to tray',
          'Hide the taskbar window when minimized. Open it again from the Mneme tray icon.',
        ],
        [
          'run_background_when_hidden',
          'Process while hidden',
          'Allow enabled background jobs to run in tray mode. Otherwise active work finishes and the queue rests.',
        ],
        ['start_with_windows', 'Start with Windows', 'Launch quietly in the tray when you sign in.'],
        [
          'shortcut_enabled',
          'Global Quick Capture',
          'Capture a thought from another app while Mneme is running.',
        ],
      ].map(([key, title, description]) => (
        <label className="toggle-row" key={key}>
          <div>
            <strong>{title}</strong>
            <p>{description}</p>
          </div>
          <input
            type="checkbox"
            checked={draft[key]}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })}
          />
        </label>
      ))}
      <label>
        Global capture shortcut
        <input
          value={draft.shortcut}
          onChange={(e) => setDraft({ ...draft, shortcut: e.target.value })}
          placeholder="Ctrl+Alt+Space"
        />
      </label>
      <p className="muted">
        Use a modifier such as Ctrl or Alt. The in-app Ctrl + Shift + Space shortcut remains available. F11
        toggles fullscreen.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <button className="primary" disabled={busy} onClick={save}>
        <Check size={15} />
        {busy ? 'Saving…' : 'Save desktop preferences'}
      </button>
      <div className="settings-row">
        <div>
          <strong>Mneme 0.2.3</strong>
          <p>
            Your memory engine runs inside this installation. App updates and uninstallation preserve brain
            folders. Updates are installed manually.
          </p>
        </div>
      </div>
    </div>
  );
}
