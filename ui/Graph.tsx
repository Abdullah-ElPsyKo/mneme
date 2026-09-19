import { useEffect, useMemo, useRef, useState } from 'react';
import { Focus, Minus, Plus, List, Orbit, ArrowUpRight } from 'lucide-react';
import { color, pretty } from './lib';
import { desktopIsVisible, useDesktopVisible } from './desktopBridge';
type Node = {
  id: string;
  name: string;
  type: string;
  importance?: number;
  provenance: any;
  x: number;
  y: number;
};
const seed = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0) / 4294967296;
};
export function Graph({
  data,
  selected,
  highlights,
  onSelect,
  onCluster,
  reducedMotion,
  onCapture,
}: {
  data: any;
  selected?: string;
  highlights: string[];
  onSelect: (id: string) => void;
  onCluster: (type: string) => void;
  reducedMotion: boolean;
  onCapture: () => void;
}) {
  const desktopVisible = useDesktopVisible();
  const canvas = useRef<HTMLCanvasElement>(null),
    parent = useRef<HTMLDivElement>(null);
  const camera = useRef({ x: 0, y: 0, zoom: 0.9 }),
    frame = useRef(0),
    drawRef = useRef<() => void>(() => {});
  const [zoom, setZoom] = useState(0.9),
    [hover, setHover] = useState<Node | null>(null),
    [list, setList] = useState(false);
  const size = useRef({ w: 0, h: 0 });
  const hovered = useRef<string | null>(null);
  const layout = useMemo(() => {
    const types = [...new Set<string>((data.entities || []).map((e: any) => e.type))].sort();
    const clusters = types.map((type, i) => ({
      type,
      x: Math.cos((i / types.length) * Math.PI * 2 - Math.PI / 2) * (types.length > 1 ? 250 : 0),
      y: Math.sin((i / types.length) * Math.PI * 2 - Math.PI / 2) * (types.length > 1 ? 195 : 0),
      count: data.clusters?.find((c: any) => c.type === type)?.count || 0,
    }));
    const nodes: Node[] = (data.entities || []).map((entity: any) => {
      const group = clusters.find((c) => c.type === entity.type)!;
      const angle = seed(entity.id) * Math.PI * 2;
      const members = data.entities.filter((e: any) => e.type === entity.type).length;
      const radius = Math.sqrt(seed(entity.id + 'radius')) * Math.min(165, 35 + Math.sqrt(members) * 18);
      return { ...entity, x: group.x + Math.cos(angle) * radius, y: group.y + Math.sin(angle) * radius };
    });
    for (let iteration = 0; iteration < 18; iteration++)
      for (let i = 0; i < nodes.length; i++)
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i],
            b = nodes[j],
            dx = b.x - a.x,
            dy = b.y - a.y,
            distance = Math.hypot(dx, dy) || 1,
            minimum = 34;
          if (distance < minimum) {
            const push = (minimum - distance) * 0.22;
            a.x -= (dx / distance) * push;
            a.y -= (dy / distance) * push;
            b.x += (dx / distance) * push;
            b.y += (dy / distance) * push;
          }
        }
    return { nodes, clusters, map: new Map(nodes.map((n) => [n.id, n])) };
  }, [data]);
  const neighbors = useMemo(() => {
    const ids = new Set<string>(selected ? [selected] : []);
    for (const r of data.relationships || []) {
      if (r.from_id === selected) ids.add(r.to_id);
      if (r.to_id === selected) ids.add(r.from_id);
    }
    return ids;
  }, [data, selected]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const ctx = element.getContext('2d')!;
    const draw = () => {
      const { w, h } = size.current,
        cam = camera.current,
        dpr = Math.min(devicePixelRatio || 1, 2);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const world = (x: number, y: number) => ({
        x: w / 2 + (x - cam.x) * cam.zoom,
        y: h / 2 + (y - cam.y) * cam.zoom,
      });
      const overview = cam.zoom < 0.55;
      for (const group of layout.clusters) {
        const p = world(group.x, group.y);
        const r = overview ? 33 : 135 * cam.zoom;
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.8);
        glow.addColorStop(0, color(group.type) + (overview ? '20' : '0e'));
        glow.addColorStop(1, color(group.type) + '00');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 1.8, 0, Math.PI * 2);
        ctx.fill();
        if (overview) {
          ctx.strokeStyle = color(group.type) + '80';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.fillStyle = color(group.type);
          ctx.font = '500 19px Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(String(group.count), p.x, p.y + 6);
          ctx.font = '500 11px Segoe UI, sans-serif';
          ctx.fillText(pretty(group.type).toUpperCase(), p.x, p.y + 56);
        } else {
          ctx.fillStyle = color(group.type) + '65';
          ctx.font = '500 10px Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.letterSpacing = '2px';
          ctx.fillText(pretty(group.type).toUpperCase(), p.x, p.y - 153 * cam.zoom);
          ctx.letterSpacing = '0px';
        }
      }
      if (overview) return;
      for (const edge of data.relationships || []) {
        const a = layout.map.get(edge.from_id),
          b = layout.map.get(edge.to_id);
        if (!a || !b) continue;
        const from = world(a.x, a.y),
          to = world(b.x, b.y),
          active = selected && (a.id === selected || b.id === selected),
          retrieved = highlights.includes(a.id) && highlights.includes(b.id);
        ctx.strokeStyle = active ? '#a3bcd699' : retrieved ? '#c3baff99' : '#60759038';
        ctx.lineWidth = active || retrieved ? 1.4 : 0.8;
        ctx.globalAlpha = selected && !active ? 0.2 : 1;
        ctx.setLineDash(edge.provenance?.kind === 'derived' || edge.provenance?.kind === 'ai' ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        ctx.setLineDash([]);
        if ((active && cam.zoom > 1.15) || cam.zoom > 2.1) {
          ctx.fillStyle = '#97a6bd';
          ctx.font = '10px Segoe UI';
          ctx.textAlign = 'center';
          ctx.fillText(pretty(edge.type), (from.x + to.x) / 2, (from.y + to.y) / 2 - 5);
        }
      }
      ctx.globalAlpha = 1;
      const occupied: { x: number; y: number; width: number }[] = [];
      const sorted = [...layout.nodes].sort(
        (a, b) =>
          Number(b.id === selected) - Number(a.id === selected) ||
          Number(highlights.includes(b.id)) - Number(highlights.includes(a.id)) ||
          (b.importance || 0.5) - (a.importance || 0.5),
      );
      for (const node of sorted) {
        const p = world(node.x, node.y);
        if (p.x < -100 || p.y < -30 || p.x > w + 100 || p.y > h + 30) continue;
        const active = node.id === selected,
          related = neighbors.has(node.id),
          found = highlights.includes(node.id),
          hovering = node.id === hovered.current;
        ctx.globalAlpha = selected && !related ? 0.22 : highlights.length && !found && !related ? 0.34 : 1;
        const r = (node.type === 'project' ? 6.5 : 4) + (active ? 2 : 0),
          accent = color(node.type);
        if (active || found || hovering) {
          ctx.shadowColor = accent;
          ctx.shadowBlur = active ? 25 : 14;
        }
        ctx.fillStyle = active ? '#f3f1ff' : accent;
        ctx.beginPath();
        if (node.provenance?.kind === 'ai' || node.provenance?.kind === 'derived') {
          ctx.moveTo(p.x, p.y - r);
          ctx.lineTo(p.x + r, p.y);
          ctx.lineTo(p.x, p.y + r);
          ctx.lineTo(p.x - r, p.y);
          ctx.closePath();
        } else ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (active || found) {
          ctx.strokeStyle = accent + '95';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + (active ? 8 : 5), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.font = `${active ? '600' : '400'} ${active ? 13 : 11}px Segoe UI, sans-serif`;
        ctx.textAlign = 'left';
        const label = node.name.length > 28 && !active ? node.name.slice(0, 27) + '…' : node.name;
        const width = ctx.measureText(label).width,
          x = p.x + r + 9,
          y = p.y + 4;
        const collision = occupied.some(
          (o) => Math.abs(o.y - y) < 18 && o.x < x + width && o.x + o.width > x,
        );
        if (active || hovering || (!collision && (cam.zoom > 0.8 || found || node.type === 'project'))) {
          ctx.fillStyle = active ? '#f2efff' : '#bdc9da';
          ctx.fillText(label, x, y);
          occupied.push({ x, y, width });
        }
      }
      ctx.globalAlpha = 1;
    };
    drawRef.current = () => {
      if (desktopIsVisible()) draw();
    };
    drawRef.current();
  }, [layout, data, selected, highlights, neighbors]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const { width: w, height: h } = entries[0].contentRect;
      if (!size.current.w && w) {
        camera.current.zoom = Math.max(0.3, Math.min(0.95, w / 900, h / 650));
        setZoom(camera.current.zoom);
      }
      size.current = { w, h };
      if (canvas.current) {
        const dpr = Math.min(devicePixelRatio || 1, 2);
        canvas.current.width = w * dpr;
        canvas.current.height = h * dpr;
        drawRef.current();
      }
    });
    if (parent.current) observer.observe(parent.current);
    return () => observer.disconnect();
  }, []);
  const animate = (target: typeof camera.current) => {
    cancelAnimationFrame(frame.current);
    const start = { ...camera.current },
      begin = performance.now();
    const step = (now: number) => {
      if (!desktopIsVisible()) {
        camera.current = target;
        setZoom(target.zoom);
        return;
      }
      const t = reducedMotion ? 1 : Math.min(1, (now - begin) / 420),
        ease = 1 - (1 - t) ** 3;
      camera.current = {
        x: start.x + (target.x - start.x) * ease,
        y: start.y + (target.y - start.y) * ease,
        zoom: start.zoom + (target.zoom - start.zoom) * ease,
      };
      drawRef.current();
      if (t < 1) frame.current = requestAnimationFrame(step);
      else setZoom(target.zoom);
    };
    frame.current = requestAnimationFrame(step);
  };
  useEffect(() => {
    if (!desktopVisible) cancelAnimationFrame(frame.current);
    else drawRef.current();
  }, [desktopVisible]);
  useEffect(() => {
    const node = selected ? layout.map.get(selected) : null;
    if (node) animate({ x: node.x + 110, y: node.y, zoom: Math.max(camera.current.zoom, 1.15) });
    return () => cancelAnimationFrame(frame.current);
  }, [selected]);
  useEffect(() => {
    const element = canvas.current!;
    let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | null = null;
    const point = (e: PointerEvent) => {
      const rect = element.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left - size.current.w / 2) / camera.current.zoom + camera.current.x,
        y: (e.clientY - rect.top - size.current.h / 2) / camera.current.zoom + camera.current.y,
      };
    };
    const down = (e: PointerEvent) => {
      cancelAnimationFrame(frame.current);
      drag = { x: e.clientX, y: e.clientY, ox: camera.current.x, oy: camera.current.y, moved: false };
      element.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x,
          dy = e.clientY - drag.y;
        drag.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
        camera.current.x = drag.ox - dx / camera.current.zoom;
        camera.current.y = drag.oy - dy / camera.current.zoom;
        drawRef.current();
        return;
      }
      const p = point(e),
        node = layout.nodes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 14 / camera.current.zoom) || null;
      hovered.current = node?.id || null;
      element.style.cursor = node ? 'pointer' : 'grab';
      setHover(node);
      drawRef.current();
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const p = point(e);
        if (camera.current.zoom < 0.55) {
          const c = layout.clusters.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 70);
          if (c) {
            onCluster(c.type);
            animate({ x: c.x, y: c.y, zoom: 1.2 });
          }
        } else {
          const node = layout.nodes.find((n) => Math.hypot(n.x - p.x, n.y - p.y) < 15 / camera.current.zoom);
          if (node) onSelect(node.id);
        }
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(frame.current);
      const rect = element.getBoundingClientRect(),
        cam = camera.current,
        before = cam.zoom,
        next = Math.max(0.3, Math.min(3, before * Math.exp(-e.deltaY * 0.001)));
      const dx = e.clientX - rect.left - size.current.w / 2,
        dy = e.clientY - rect.top - size.current.h / 2;
      cam.x += dx / before - dx / next;
      cam.y += dy / before - dy / next;
      cam.zoom = next;
      setZoom(next);
      drawRef.current();
    };
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('wheel', wheel);
    };
  }, [layout, onSelect, onCluster, reducedMotion]);
  return (
    <div ref={parent} className="graph-space">
      <canvas
        ref={canvas}
        aria-label={`Knowledge graph with ${data.entities?.length || 0} entities and ${data.relationships?.length || 0} relationships. Use the entity list for keyboard access.`}
      />
      {!data.entities?.length && (
        <div className="graph-onboarding">
          <div className="orbit-symbol">
            <Orbit size={56} strokeWidth={0.8} />
          </div>
          <span className="eyebrow">A little space for everything you know</span>
          <h2>
            It starts with
            <br />
            <em>one thought.</em>
          </h2>
          <p>
            Capture an idea. Keep a decision. Connect what matters.
            <br />
            Your knowledge will take shape here.
          </p>
          <button className="primary" onClick={onCapture}>
            <Plus size={16} /> Capture your first memory <ArrowUpRight size={15} />
          </button>
        </div>
      )}
      <div className="graph-footer">
        <div className="graph-hint">
          {hover ? (
            <>
              <i style={{ background: color(hover.type) }} />
              {hover.name}
              <span>{pretty(hover.type)}</span>
            </>
          ) : (
            <>
              <span className="crosshair">+</span>
              {zoom < 0.55
                ? 'Overview · select a cluster to explore'
                : 'Scroll to explore · drag to move · select to connect'}
            </>
          )}
        </div>
        <div className="graph-controls">
          <button
            className="icon-button"
            title="Accessible entity list"
            aria-label="Entity list"
            onClick={() => setList(!list)}
          >
            <List size={17} />
          </button>
          <span />
          <button
            className="icon-button"
            aria-label="Zoom out"
            onClick={() => animate({ ...camera.current, zoom: Math.max(0.3, camera.current.zoom / 1.35) })}
          >
            <Minus size={16} />
          </button>
          <small>{Math.round(zoom * 100)}%</small>
          <button
            className="icon-button"
            aria-label="Zoom in"
            onClick={() => animate({ ...camera.current, zoom: Math.min(3, camera.current.zoom * 1.35) })}
          >
            <Plus size={16} />
          </button>
          <span />
          <button
            className="icon-button"
            aria-label="Reset graph view"
            onClick={() => animate({ x: 0, y: 0, zoom: 0.9 })}
          >
            <Focus size={17} />
          </button>
        </div>
      </div>
      {list && (
        <div className="graph-accessible-list">
          <h3>Entities in view</h3>
          {layout.nodes.map((node) => (
            <button key={node.id} onClick={() => onSelect(node.id)}>
              <i style={{ background: color(node.type) }} />
              {node.name}
              <span>{pretty(node.type)}</span>
            </button>
          ))}
          {data.truncated && <p>Choose a type above to explore more entities.</p>}
        </div>
      )}
    </div>
  );
}
