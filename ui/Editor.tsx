import { useEffect, useRef, useState } from 'react';
import { Check, Eye, Pencil, Save, FileText, LockKeyhole } from 'lucide-react';
import { Modal, Markdown, cleanMemory, post, put } from './lib';
import { useDesktopDraft } from './desktopBridge';
import { DeleteAction } from './DeleteAction';
import { MemoryPicker } from './MemoryPicker';
const types = ['note', 'project', 'decision', 'procedure', 'idea', 'goal', 'policy', 'capture', 'document'];
export function Editor({
  memory,
  type = 'note',
  onClose,
  onSaved,
  onDeleted,
}: {
  memory?: any;
  type?: string;
  onClose: () => void;
  onSaved: (m: any) => void;
  onDeleted: () => void;
}) {
  const [draft, setDraft] = useState<any>(
    memory
      ? cleanMemory(memory)
      : {
          title: '',
          body: '',
          type,
          memory_class: 'semantic',
          status: 'active',
          project_state: type === 'project' ? 'planned' : null,
          tags: [],
          project: '',
          importance: 0.5,
          private: false,
          facts: [],
        },
  );
  const [tags, setTags] = useState(draft.tags.join(', ')),
    [preview, setPreview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false),
    [confirmClose, setConfirmClose] = useState(false);
  useDesktopDraft(dirty || busy);
  const change = (key: string, value: any) => {
    setDraft((current: any) => ({
      ...current,
      [key]: value,
      ...(key === 'type'
        ? { project_state: value === 'project' ? current.project_state || 'planned' : null }
        : {}),
    }));
    setDirty(true);
  };
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = {
        ...draft,
        tags: tags
          .split(',')
          .map((tag: string) => tag.trim())
          .filter(Boolean),
      };
      const saved = memory ? await put(`/memories/${memory.id}`, payload) : await post('/memories', payload);
      onSaved(saved);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={memory ? 'Edit memory' : type === 'project' ? 'Create a project' : 'Create a memory'}
      onClose={() => (dirty ? setConfirmClose(true) : onClose())}
    >
      <div className="editor-layout">
        <div className="editor-main">
          <input
            className="title-input"
            aria-label="Memory title"
            placeholder="Give this thought a name"
            autoFocus
            value={draft.title}
            onChange={(e) => change('title', e.target.value)}
          />
          <div className="editor-toolbar">
            <div className="segmented">
              <button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>
                <Pencil size={13} /> Write
              </button>
              <button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>
                <Eye size={14} /> Preview
              </button>
            </div>
            <span>Markdown · [[wiki links]]</span>
          </div>
          {preview ? (
            <div className="editor-preview">
              <Markdown text={draft.body || '*Your words will appear here.*'} />
            </div>
          ) : (
            <textarea
              className="markdown-editor"
              aria-label="Memory content"
              placeholder="What’s worth remembering?\n\nWrite freely. You can connect the details later."
              value={draft.body}
              onChange={(e) => change('body', e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                }
              }}
            />
          )}
        </div>
        <aside className="editor-properties">
          <div className="eyebrow">Give it context</div>
          <label>
            Memory type
            <select
              aria-label="Memory type"
              value={draft.type}
              onChange={(e) => change('type', e.target.value)}
            >
              {[...new Set([...types, draft.type])].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Memory class
            <select
              aria-label="Memory class"
              value={draft.memory_class}
              onChange={(e) => change('memory_class', e.target.value)}
            >
              {['semantic', 'episodic', 'procedural', 'working', 'preference'].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          <label>
            Project
            <input
              value={draft.project}
              placeholder="Optional project name"
              onChange={(e) => change('project', e.target.value)}
            />
          </label>
          {draft.type === 'project' && (
            <label>
              Project lifecycle
              <select
                aria-label="Project lifecycle"
                value={draft.project_state || 'planned'}
                onChange={(e) => change('project_state', e.target.value)}
              >
                {['planned', 'active', 'paused', 'completed', 'abandoned'].map((state) => (
                  <option key={state}>{state}</option>
                ))}
              </select>
              <small>
                Planned: not started · Active: current work · Paused: on hold · Completed: finished ·
                Abandoned: discontinued
              </small>
            </label>
          )}
          <label>
            Tags
            <input
              value={tags}
              placeholder="Separate with commas"
              onChange={(e) => {
                setTags(e.target.value);
                setDirty(true);
              }}
            />
          </label>
          <label>
            {draft.type === 'project' ? 'Memory visibility' : 'Status'}
            <select
              aria-label="Memory status"
              value={draft.status}
              onChange={(e) => change('status', e.target.value)}
            >
              {[
                'active',
                'inbox',
                ...(draft.type !== 'project' || draft.status === 'completed' ? ['completed'] : []),
                'archived',
              ].map((t) => (
                <option key={t} value={t}>
                  {draft.type === 'project' && ['active', 'completed'].includes(t) ? 'Visible' : t}
                </option>
              ))}
            </select>
          </label>
          <label className="check-label">
            <input
              type="checkbox"
              checked={draft.private}
              onChange={(e) => change('private', e.target.checked)}
            />
            <span>
              <LockKeyhole size={12} /> Exclude from AI context
            </span>
          </label>
          <details>
            <summary>Temporal facts & priority</summary>
            <label>
              Importance
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={draft.importance}
                onChange={(e) => change('importance', Number(e.target.value))}
              />
            </label>
            <div className="facts-editor">
              <div className="eyebrow">Facts</div>
              {(draft.facts || []).map((fact: any, index: number) => (
                <div className="fact-editor-row" key={index}>
                  <label>
                    Key
                    <input
                      aria-label={`Fact key ${index + 1}`}
                      value={fact.key}
                      placeholder="joint2.current_torque"
                      onChange={(e) =>
                        change(
                          'facts',
                          draft.facts.map((f: any, i: number) =>
                            i === index ? { ...f, key: e.target.value } : f,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Value
                    <input
                      aria-label={`Fact value ${index + 1}`}
                      value={fact.value}
                      placeholder="1.0 Nm"
                      onChange={(e) =>
                        change(
                          'facts',
                          draft.facts.map((f: any, i: number) =>
                            i === index ? { ...f, value: e.target.value } : f,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove fact ${index + 1}`}
                    onClick={() =>
                      change(
                        'facts',
                        draft.facts.filter((_: any, i: number) => i !== index),
                      )
                    }
                  >
                    Remove row
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => change('facts', [...(draft.facts || []), { key: '', value: '' }])}
              >
                + Add fact
              </button>
            </div>
            <MemoryPicker
              value={draft.supersedes}
              exclude={memory?.id}
              project={draft.project}
              onChange={(id) => change('supersedes', id)}
            />
            <label>
              Valid from
              <input
                type="datetime-local"
                value={draft.valid_from?.slice(0, 16) || ''}
                onChange={(e) =>
                  change('valid_from', e.target.value ? new Date(e.target.value).toISOString() : undefined)
                }
              />
            </label>
          </details>
          <div className="property-note">
            <FileText size={15} />
            <p>
              Saved as readable Markdown. Revisions stay in history unless you permanently delete the memory.
            </p>
          </div>
        </aside>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="modal-footer">
        {memory && memory.status !== 'archived' && (
          <DeleteAction
            kind="memories"
            id={memory.id}
            title={memory.title}
            detail={dirty ? 'Your unsaved editor changes will also be discarded.' : undefined}
            disabled={busy}
            onDeleted={onDeleted}
          />
        )}
        {memory && (
          <DeleteAction
            permanent
            kind="memories"
            id={memory.id}
            title={memory.title}
            disabled={busy}
            detail={dirty ? 'Your unsaved changes will also be discarded.' : undefined}
            onDeleted={onDeleted}
          />
        )}
        <span className="muted">
          {dirty ? 'Unsaved changes' : 'All changes are local'} · Ctrl + Enter to save
        </span>
        <button className="primary" disabled={busy || !draft.title.trim()} onClick={save}>
          <Save size={15} />
          {busy ? 'Saving…' : 'Save memory'}
        </button>
      </div>
      {confirmClose && (
        <div className="discard-panel">
          <p>Keep your unsaved changes?</p>
          <button onClick={() => setConfirmClose(false)}>Keep editing</button>
          <button className="danger" onClick={onClose}>
            Discard changes
          </button>
        </div>
      )}
    </Modal>
  );
}
export function Capture({ onClose, onSaved }: { onClose: () => void; onSaved: (m: any) => void }) {
  const input = useRef<HTMLTextAreaElement>(null);
  // Modal.showModal runs in the child effect first; focus after the dialog opens.
  useEffect(() => {
    input.current?.focus();
  }, []);
  const [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useDesktopDraft(!!text.trim() || busy);
  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      onSaved(await post('/capture', { text }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Catch a thought" onClose={onClose}>
      <div className="capture-body">
        <p className="muted">Off your mind. Into your memory. Organize it later.</p>
        <textarea
          autoFocus
          aria-label="Quick capture text"
          ref={input}
          placeholder="What do you want to remember?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void save();
          }}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
      </div>
      <div className="modal-footer">
        <span className="muted">Saved to Inbox · Ctrl + Enter</span>
        <button className="primary" disabled={busy || !text.trim()} onClick={save}>
          <Check size={16} />
          {busy ? 'Saving…' : 'Capture'}
        </button>
      </div>
    </Modal>
  );
}
