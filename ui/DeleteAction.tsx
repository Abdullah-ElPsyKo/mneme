import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api, Modal } from './lib';

// One preview/confirmation/mutation flow for every deletable domain object.
export function DeleteAction({
  kind,
  id,
  title,
  onDeleted,
  disabled = false,
  detail,
  permanent = false,
}: {
  kind: string;
  id: string;
  title: string;
  onDeleted: () => void;
  disabled?: boolean;
  detail?: string;
  permanent?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [preview, setPreview] = useState<any>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [understood, setUnderstood] = useState(false);
  const endpoint = permanent ? `/permanent-deletion/${id}` : `/deletion/${kind}/${id}`;
  const review = async () => {
    setOpen(true);
    setPreview(undefined);
    setError('');
    setUnderstood(false);
    setBusy(true);
    try {
      setPreview(await api(endpoint));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await api(endpoint, {
        method: 'DELETE',
        body: JSON.stringify({ confirmed: true, expected_revision: preview.revision }),
      });
      setOpen(false);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
      setPreview(undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={permanent ? 'danger' : 'icon-button'}
        title={permanent ? `Delete permanently: ${title}` : `Delete ${title}`}
        aria-label={permanent ? `Delete permanently: ${title}` : `Delete ${title}`}
        disabled={disabled}
        onClick={() => void review()}
      >
        <Trash2 size={15} />
        {permanent && 'Delete permanently'}
      </button>
      {open && (
        <Modal
          title={
            permanent ? 'Delete permanently?' : kind === 'memories' ? 'Archive memory?' : 'Delete this item?'
          }
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <div className="form-stack">
            <h3>{preview?.title || title}</h3>
            {detail && <p>{detail}</p>}
            <p>
              {preview?.description ||
                (busy ? 'Checking this item and its dependencies…' : 'Review the item before deleting.')}
            </p>
            {preview && !permanent && (
              <p className="muted">
                {preview.deleted
                  ? 'This item has already been removed from current views.'
                  : 'This removes the current item, not its audit history. It is not a permanent erasure of retained data or backups.'}
              </p>
            )}
            {permanent && (
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={understood}
                  onChange={(e) => setUnderstood(e.target.checked)}
                />
                I understand this memory and its history cannot be restored from this brain.
              </label>
            )}
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="modal-footer">
            <button type="button" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            {!preview && !busy ? (
              <button type="button" onClick={() => void review()}>
                Review again
              </button>
            ) : (
              <button
                type="button"
                className="danger"
                disabled={busy || !preview || preview.deleted || (permanent && !understood)}
                onClick={() => void remove()}
              >
                {busy ? 'Please wait…' : permanent ? 'Delete permanently' : 'Delete item'}
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
