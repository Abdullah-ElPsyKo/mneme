import { useEffect, useState } from 'react';
import { api } from './lib';

export function ConnectionPicker({
  exclude,
  value,
  onChange,
}: {
  exclude: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api(`/connection-options?${new URLSearchParams({ q: query, exclude, offset: String(offset) })}`)
        .then((items) => {
          if (live) {
            setResults(items);
            setError('');
          }
        })
        .catch((e) => {
          if (live) {
            setResults([]);
            setError(e.message);
          }
        })
        .finally(() => {
          if (live) setLoading(false);
        });
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, exclude, offset]);
  return (
    <div className="connection-picker">
      <label>
        Search the whole brain
        <input
          aria-label="Search connection targets"
          placeholder="Name or project…"
          maxLength={240}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
            onChange('');
          }}
        />
      </label>
      {loading ? (
        <p role="status">Searching…</p>
      ) : (
        <>
          <label>
            Connect to
            <select aria-label="Relationship target" value={value} onChange={(e) => onChange(e.target.value)}>
              <option value="">Choose an entity</option>
              {results.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.type}
                </option>
              ))}
            </select>
          </label>
          {!results.length && <p className="muted">{error || 'No eligible memories or entities found.'}</p>}
          {(offset > 0 || results.length === 20) && (
            <div className="pagination">
              <button
                type="button"
                disabled={!offset}
                onClick={() => {
                  setOffset(offset - 20);
                  onChange('');
                }}
              >
                Previous targets
              </button>
              <button
                type="button"
                disabled={results.length < 20}
                onClick={() => {
                  setOffset(offset + 20);
                  onChange('');
                }}
              >
                Next targets
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
