import { useEffect, useState } from 'react';
import { api, date } from './lib';

export function MemoryPicker({
  value,
  exclude,
  project,
  onChange,
}: {
  value?: string | null;
  exclude?: string;
  project: string;
  onChange: (id: string | null) => void;
}) {
  const [query, setQuery] = useState(''),
    [results, setResults] = useState<any[]>([]),
    [selected, setSelected] = useState<any>(),
    [open, setOpen] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setSelected(undefined);
    if (value)
      api(`/memories/${value}`)
        .then((m) => {
          if (live) setSelected(m);
        })
        .catch(() => {
          if (live) setSelected({ title: 'Referenced memory unavailable' });
        });
    return () => {
      live = false;
    };
  }, [value]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      api(`/memory-options?${new URLSearchParams({ q: query, exclude: exclude || '', project })}`)
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
        });
    }, 180);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, exclude, project]);
  return (
    <div className="memory-picker">
      <label>
        Supersedes
        <input
          aria-label="Search superseded memory"
          placeholder="Search memories…"
          value={query}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
        />
      </label>
      {value && (
        <div className="fact-box">
          <strong>{selected?.title || 'Loading reference…'}</strong>
          <span>
            {selected?.project}
            {selected?.status === 'archived' ? ' · archived' : ''}
          </span>
          <button type="button" onClick={() => onChange(null)}>
            Clear selection
          </button>
        </div>
      )}
      {open && (
        <div aria-label="Supersession results">
          {results.map((m) => (
            <button
              className="memory-option"
              type="button"
              key={m.id}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
                setQuery('');
              }}
            >
              <strong>{m.title}</strong>
              <span>
                {m.project || 'No project'} · {date(m.updated_at)}
                {m.superseded ? ' · already superseded' : ''}
              </span>
            </button>
          ))}
          {!results.length && <p className="muted">{error || 'No eligible memories found.'}</p>}
        </div>
      )}
    </div>
  );
}
