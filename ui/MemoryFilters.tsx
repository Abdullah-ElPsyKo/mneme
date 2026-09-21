import { useEffect, useState } from 'react';
import { api } from './lib';

export type MemoryFilters = {
  project: string;
  type: string;
  class: string;
  status: string;
  tag: string;
  project_state: string;
};
export const emptyFilters: MemoryFilters = {
  project: '',
  type: '',
  class: '',
  status: '',
  tag: '',
  project_state: '',
};

export function MemoryFilterControls({
  value,
  onChange,
  fixedType,
  fixedStatus,
}: {
  value: MemoryFilters;
  onChange: (value: MemoryFilters) => void;
  fixedType?: string;
  fixedStatus?: string;
}) {
  const active = Object.entries(value).filter(([, text]) => text);
  const field = (key: keyof MemoryFilters, text: string) => onChange({ ...value, [key]: text });
  return (
    <div className="memory-filters">
      <details>
        <summary>Filters{active.length ? ` (${active.length})` : ''}</summary>
        <div className="memory-filter-fields">
          <label>
            Project
            <input
              aria-label="Filter by project"
              maxLength={240}
              placeholder="Exact project name"
              value={value.project}
              onChange={(e) => field('project', e.target.value)}
            />
          </label>
          {!fixedType && (
            <label>
              Memory type
              <input
                aria-label="Filter by memory type"
                maxLength={40}
                placeholder="e.g. note, decision"
                value={value.type}
                onChange={(e) => field('type', e.target.value)}
              />
            </label>
          )}
          <label>
            Memory class
            <select
              aria-label="Filter by memory class"
              value={value.class}
              onChange={(e) => field('class', e.target.value)}
            >
              <option value="">All classes</option>
              {['semantic', 'episodic', 'procedural', 'working', 'preference'].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
          {!fixedStatus && (
            <label>
              Status
              <select
                aria-label="Filter by status"
                value={value.status}
                onChange={(e) => field('status', e.target.value)}
              >
                <option value="">All active statuses</option>
                {['active', 'inbox', 'completed'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
          )}
          <label>
            Tag
            <input
              aria-label="Filter by tag"
              maxLength={80}
              placeholder="Exact tag"
              value={value.tag}
              onChange={(e) => field('tag', e.target.value)}
            />
          </label>
        </div>
      </details>
      {active.length > 0 && (
        <div className="active-filters" aria-label="Active filters">
          {active.map(([key, text]) => (
            <button
              key={key}
              aria-label={`Remove ${key} filter`}
              onClick={() => field(key as keyof MemoryFilters, '')}
            >
              {key === 'project_state' ? 'Lifecycle' : key}: {text} ×
            </button>
          ))}
          <button onClick={() => onChange(emptyFilters)}>Clear filters</button>
        </div>
      )}
    </div>
  );
}

export function useMemoryPage(
  revision: number,
  query: string,
  filters: MemoryFilters,
  offset: number,
  fixedType = '',
  fixedStatus = '',
) {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const params = new URLSearchParams({ limit: '60', offset: String(offset) });
  for (const [key, value] of Object.entries({
    ...filters,
    type: fixedType || filters.type,
    status: fixedStatus || filters.status,
  }))
    if (value.trim()) params.set(key, value.trim());
  const archived = fixedStatus === 'archived';
  // Archived content intentionally has no search-index entries. Browse its canonical metadata.
  const searching = !!query.trim() && !archived;
  if (query.trim()) params.set('q', query.trim());
  if (!searching && params.has('class')) {
    params.set('memory_class', params.get('class')!);
    params.delete('class');
  }
  const path = `/${searching ? 'search' : 'memories'}?${params}`;
  useEffect(() => {
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api(path)
        .then((data) => {
          if (live) {
            setItems(searching ? data.hits.map((h: any) => ({ ...h.memory, excerpt: h.excerpt })) : data);
            setError('');
          }
        })
        .catch((e) => {
          if (live) {
            setError(e.message);
            setItems([]);
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
  }, [path, revision, searching]);
  return { items, loading, error };
}
