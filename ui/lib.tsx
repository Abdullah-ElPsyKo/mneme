import { useEffect, useRef, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { X, ArrowUpRight } from 'lucide-react';
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Local service could not complete this operation');
  return result;
}
export const post = (path: string, data: unknown = {}) =>
  api(path, { method: 'POST', body: JSON.stringify(data) });
export const put = (path: string, data: unknown) => api(path, { method: 'PUT', body: JSON.stringify(data) });
export const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const time = (value: string) =>
  new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const pretty = (value: string) => value.replaceAll('_', ' ').replaceAll('-', ' ');
export const plainExcerpt = (value: string) =>
  value
    .replace(/<[^>]*>/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export const color = (type: string) =>
  ({
    project: '#aba5fa',
    note: '#7caed8',
    decision: '#dcb67b',
    procedure: '#79bea6',
    capture: '#b895c8',
    document: '#739bbd',
    concept: '#70bdb9',
    goal: '#cda18a',
    device: '#85a6b9',
  })[type] || '#95abc5';
export function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
    FORBID_TAGS: ['img', 'iframe', 'style', 'form', 'input', 'video', 'audio', 'source', 'svg', 'math'],
    FORBID_ATTR: ['style', 'src', 'srcset', 'id', 'name', 'target'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|#)/i,
  });
  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Empty({
  icon,
  title,
  text,
  action,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon && <div className="empty-icon">{icon}</div>}
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}
export function SectionTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      <div className="section-actions">{actions}</div>
    </div>
  );
}
export function SourceLink({ id, children }: { id: string; children: ReactNode }) {
  return (
    <a className="source-link" href={`/api/sources/${id}/download`}>
      {children}
      <ArrowUpRight size={13} />
    </a>
  );
}
export function cleanMemory(memory: any) {
  const { id, path, content_hash, created_at, updated_at, version, ...rest } = memory;
  return {
    ...rest,
    facts: memory.facts ?? (memory.fact_key ? [{ key: memory.fact_key, value: memory.fact_value }] : []),
    expected_version: version,
  };
}
