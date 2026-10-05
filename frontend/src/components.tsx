import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePinchZoom } from './pinchZoom';
import { X, Download, ExternalLink, LoaderCircle, Plus, Trash2, ArrowUp, ArrowDown, Check, Eye, EyeOff, Box, CheckCircle2, Circle, Ban, Undo2, Settings, Layers, Link2, Flame } from 'lucide-react';
import { asset, assetJson, saveBlob } from './api';
import { categories, RAL, suggestions, fmt } from './constants';
import type { Any } from './constants';
import { Select, Combo } from './controls';

// ---------------------------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------------------------
export function Badge({ children, kind = '' }: { children: React.ReactNode; kind?: string }) {
  return <span className={'badge ' + kind}>{children}</span>;
}

export function Swatch({ hex, title, size = 14 }: { hex?: string; title?: string; size?: number }) {
  if (!hex) return null;
  return <span className="swatch" title={title || hex} style={{ background: hex, width: size, height: size }} />;
}

export function Modal({ title, close, children, wide = false, subtitle, top = false }: { title: string; close: () => void; children: React.ReactNode; wide?: boolean; subtitle?: string; top?: boolean }) {
  useEffect(() => {
    // Escape closes an open dropdown first; the modal only closes on the next press.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.getElementById('popover-root')?.childElementCount) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div className={'overlay' + (top ? ' top' : '')} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className={'modal' + (wide ? ' wide' : '')}>
        <header>
          <div><h2>{title}</h2>{subtitle && <p className="muted">{subtitle}</p>}</div>
          <button aria-label="Close" onClick={close}><X size={20} /></button>
        </header>
        {children}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// "Not for production" dialog (replaces the browser prompt)
// ---------------------------------------------------------------------------------------------
const EXCLUDE_REASONS = ['Bought-in finished part', 'Superseded by another part', 'Reference / envelope only', 'Not in this build', 'Made in-house from stock', 'Customer-supplied'];
export function ExcludeDialog({ parts, busy, onConfirm, close }: { parts: Any[]; busy: boolean; onConfirm: (reason: string) => void; close: () => void }) {
  const [reason, setReason] = useState('');
  const ok = reason.trim().length >= 3;
  return (
    <Modal title={parts.length === 1 ? 'Mark not for production' : `Mark ${parts.length} parts not for production`} subtitle="Excluded parts are skipped by release checks, drawing sets, the manufacturing pack and the vendor checklist. You can restore them any time." close={close}>
      <div className="group-summary">{parts.map(p => <Badge key={p.id} kind={p.category}>{p.name}</Badge>)}</div>
      <label>Reason<textarea autoFocus value={reason} placeholder="Why is this part not being made in this revision?" onChange={e => setReason(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ok) onConfirm(reason.trim()); }} /></label>
      <div className="chips">{EXCLUDE_REASONS.map(r => <button type="button" key={r} className={'chip' + (reason === r ? ' chosen' : '')} onClick={() => setReason(r)}>{r}</button>)}</div>
      <div className="modal-actions">
        <button type="button" onClick={close}>Cancel</button>
        <button type="button" className="primary danger-fill" disabled={!ok || busy} onClick={() => onConfirm(reason.trim())}><Ban size={15} />Not for production</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Document preview (PDF inline, download on demand)
// ---------------------------------------------------------------------------------------------
export function DocumentPreview({ blob, name, title, close }: { blob: Blob; name: string; title: string; close: () => void }) {
  const isPdf = name.toLowerCase().endsWith('.pdf');
  const [pages, setPages] = useState<number>(0);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(isPdf);
  const scroller = useRef<HTMLDivElement>(null);
  const docRef = useRef<Any>(null);
  const [url, setUrl] = useState('');
  useEffect(() => {
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.getElementById('popover-root')?.childElementCount) close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Load the PDF once with pdf.js (lazy chunk) so the preview works identically in every browser.
  useEffect(() => {
    if (!isPdf) return;
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const doc = await pdfjs.getDocument({ data: await blob.arrayBuffer() }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setPages(doc.numPages);
      } catch (e: Any) { if (!cancelled) { setError(e.message || 'Could not render PDF'); setRendering(false); } }
    })();
    return () => { cancelled = true; docRef.current?.destroy?.(); };
  }, [blob, isPdf]);

  // While pinching, scale the already-rendered canvases immediately (CSS) so the zoom tracks the fingers;
  // the sharp re-render follows once the gesture pauses.
  useLayoutEffect(() => {
    scroller.current?.querySelectorAll<HTMLCanvasElement>('canvas[data-page]').forEach(canvas => {
      const w1 = Number(canvas.dataset.w1), h1 = Number(canvas.dataset.h1);
      if (w1 && h1) { canvas.style.width = Math.floor(w1 * zoom) + 'px'; canvas.style.height = Math.floor(h1 * zoom) + 'px'; }
    });
  }, [zoom]);
  usePinchZoom(scroller, zoom, setZoom, { min: 0.5, max: 8 });

  // Render every page into its canvas at the current zoom (fit-to-width × zoom).
  useEffect(() => {
    const doc = docRef.current, host = scroller.current;
    if (!doc || !host || !pages) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setRendering(true);
      const width = host.clientWidth - 48;
      for (let i = 1; i <= pages; i++) {
        if (cancelled) return;
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const scale = (width / base.width) * zoom;
        const viewport = page.getViewport({ scale });
        const canvas = host.querySelector<HTMLCanvasElement>(`canvas[data-page="${i}"]`);
        if (!canvas) continue;
        const ratio = Math.min(devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = Math.floor(viewport.width) + 'px';
        canvas.style.height = Math.floor(viewport.height) + 'px';
        canvas.dataset.w1 = String(viewport.width / zoom); canvas.dataset.h1 = String(viewport.height / zoom);
        const ctx = canvas.getContext('2d')!;
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        await page.render({ canvasContext: ctx, viewport }).promise;
      }
      if (!cancelled) setRendering(false);
    }, host.querySelector('canvas[data-w1]') ? 160 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [pages, zoom]);

  const size = blob.size > 1e6 ? (blob.size / 1e6).toFixed(1) + ' MB' : Math.round(blob.size / 1e3) + ' KB';
  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} className="modal preview">
        <header>
          <div><h2>{title}</h2><p className="muted">{name} · {size}{pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''}</p></div>
          <div className="flex">
            {isPdf && <div className="zoom-group"><button type="button" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out">−</button><button type="button" className="zoom-reset" title="Fit width (pinch or Ctrl/⌘ + scroll to zoom)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button><button type="button" onClick={() => setZoom(z => Math.min(8, +(z + 0.25).toFixed(2)))} aria-label="Zoom in">+</button></div>}
            {isPdf && url && <a className="button" href={url} target="_blank" rel="noreferrer"><ExternalLink size={16} />Open in tab</a>}
            <button className="primary" onClick={() => saveBlob(blob, name)}><Download size={16} />Download</button>
            <button aria-label="Close" onClick={close}><X size={20} /></button>
          </div>
        </header>
        <div className="preview-body" ref={scroller}>
          {isPdf ? (
            <>
              {rendering && !error && <div className="preview-state"><span className="spinner" />Rendering pages…</div>}
              {error && <div className="preview-fallback"><p>{error}</p></div>}
              {Array.from({ length: pages }, (_, i) => <canvas key={i} data-page={i + 1} className="pdf-page" />)}
            </>
          ) : <div className="preview-fallback"><p>Preview is available for PDF documents only. Download to open this file in your CAD or CAM software.</p></div>}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Flat pattern (developed sheet) 2D view
// ---------------------------------------------------------------------------------------------
/** Bend lines made in one press stroke: same straight line, angle, radius and direction (split by reliefs). */
function bendGroups(bends: Flat['bends']) {
  const groups: number[][] = [];
  bends.forEach((b, i) => {
    const dx = b.b[0] - b.a[0], dy = b.b[1] - b.a[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L;
    const g = groups.find(gr => {
      const r = bends[gr[0]]; const rx = r.b[0] - r.a[0], ry = r.b[1] - r.a[1], rl = Math.hypot(rx, ry) || 1;
      if (Math.abs(ux * ry / rl - uy * rx / rl) > 1e-4) return false;
      const ox = b.a[0] - r.a[0], oy = b.a[1] - r.a[1];
      return Math.abs(ox * ry / rl - oy * rx / rl) < 0.05 && Math.abs(b.angle - r.angle) < 0.1 && Math.abs(b.radius - r.radius) < 0.01 && b.direction === r.direction;
    });
    if (g) g.push(i); else groups.push([i]);
  });
  return groups;
}
type Flat = { outline: number[][]; holes: number[][][]; bends: { id: string; a: number[]; b: number[]; allowance: number; angle: number; radius: number; direction?: string; length?: number }[]; k_factor: number; status: string };

export function FlatPattern({ partId, thickness, kFactor, approved, name }: { partId: string; thickness: number; kFactor: number; approved: boolean; name: string }) {
  const [flat, setFlat] = useState<Flat | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    setFlat(null); setError(''); setView(null);
    assetJson(`/parts/${partId}/assets/flat.json`).then(setFlat).catch(e => setError(e.message));
  }, [partId]);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, [flat]);

  if (error) return <div className="processing"><h2>Flat pattern unavailable</h2><p>{error}</p></div>;
  if (!flat) return <div className="viewer-state"><span className="spinner" />Loading developed pattern…</div>;

  const pts = [...flat.outline, ...flat.holes.flat()];
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const W = maxX - minX, H = maxY - minY;
  const margin = Math.max(W, H) * 0.16 + 10;
  const X = (x: number) => x - minX + margin;
  const Y = (y: number) => maxY - y + margin;
  const full = { x: 0, y: 0, w: W + 2 * margin, h: H + 2 * margin };
  const vb = view || full;
  const path = (ring: number[][]) => ring.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(3)} ${Y(p[1]).toFixed(3)}`).join(' ') + ' Z';
  const stroke = Math.max(W, H) / 900 * (vb.w / full.w);
  const font = Math.max(W, H) / 42 * (vb.w / full.w);
  const arrow = font * 0.6;

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const rect = svg.current!.getBoundingClientRect();
    const px = vb.x + (e.clientX - rect.left) / rect.width * vb.w;
    const py = vb.y + (e.clientY - rect.top) / rect.height * vb.h;
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const w = Math.min(full.w * 4, Math.max(full.w / 20, vb.w * k));
    const h = w * (vb.h / vb.w);
    setView({ x: px - (px - vb.x) * (w / vb.w), y: py - (py - vb.y) * (h / vb.h), w, h });
  };
  wheelRef.current = onWheel;
  const onDown = (e: React.PointerEvent) => { drag.current = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y }; (e.target as Element).setPointerCapture?.(e.pointerId); };
  const onMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const rect = svg.current!.getBoundingClientRect();
    setView({ ...vb, x: drag.current.vx - (e.clientX - drag.current.x) / rect.width * vb.w, y: drag.current.vy - (e.clientY - drag.current.y) / rect.height * vb.h });
  };
  const onUp = () => { drag.current = null; };

  const dimY = Y(minY) + margin * 0.35;
  const dimX = X(minX) - margin * 0.35;
  return (
    <div className="flat-view">
      <svg ref={svg} viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onDoubleClick={() => setView(null)}>
        <defs>
          <pattern id="flat-grid" width={10} height={10} patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" stroke="#dfe2e6" strokeWidth={stroke * 0.5} />
          </pattern>
        </defs>
        <rect x={vb.x - full.w * 4} y={vb.y - full.h * 4} width={full.w * 9} height={full.h * 9} fill="url(#flat-grid)" />
        <path d={path(flat.outline) + flat.holes.map(path).join(' ')} fill="#c9d5e0" fillOpacity={0.55} stroke="#1c2024" strokeWidth={stroke * 2} strokeLinejoin="round" fillRule="evenodd" />
        {(() => {
          // Bend labels: short tag on the bend line, placed where it does not cover another label (the table
          // below carries radius and allowance). Tries above / below the line at the middle, then at a quarter.
          const placed: number[][] = [];
          const hit = (r: number[]) => placed.some(q => r[0] < q[2] && r[2] > q[0] && r[1] < q[3] && r[3] > q[1]);
          const groups = bendGroups(flat.bends);
          const tagOf = new Map<number, string>(); const rep = new Set<number>();
          groups.forEach((gr, k) => { gr.forEach(i => tagOf.set(i, 'B' + (k + 1))); rep.add(gr.reduce((m, i) => Math.hypot(flat.bends[i].b[0] - flat.bends[i].a[0], flat.bends[i].b[1] - flat.bends[i].a[1]) > Math.hypot(flat.bends[m].b[0] - flat.bends[m].a[0], flat.bends[m].b[1] - flat.bends[m].a[1]) ? i : m, gr[0])); });
          return flat.bends.map((b, bi) => {
            const tag = tagOf.get(bi)!; const n = groups.find(gr => gr.includes(bi))!.length;
            const ax = X(b.a[0]), ay = Y(b.a[1]), bx = X(b.b[0]), by = Y(b.b[1]);
            const len = Math.hypot(bx - ax, by - ay) || 1, ux = (bx - ax) / len, uy = (by - ay) / len;
            let ang = Math.atan2(by - ay, bx - ax) * 180 / Math.PI; if (ang > 90 || ang < -90) ang += 180;
            const rad = ang * Math.PI / 180, nx = Math.sin(rad), ny = -Math.cos(rad);
            const arrow = b.direction === 'up' ? '↑' : b.direction === 'down' ? '↓' : '';
            const texts = rep.has(bi) ? [`${tag} ${arrow}${fmt(b.angle)}°${n > 1 ? ` ×${n}` : ''}`, tag] : [];
            let pick: { t: string; x: number; y: number } | null = null;
            for (const t of texts) {
              const w = t.length * font * 0.58, h = font * 1.1;
              if (w > len * 0.95 && t !== tag) continue;
              for (const f of [0.5, 0.25, 0.75]) for (const off of [-0.45, 1.25]) {
                const cx = ax + (bx - ax) * f + nx * off * font, cy = ay + (by - ay) * f + ny * off * font;
                const hw = (Math.abs(Math.cos(rad)) * w + Math.abs(Math.sin(rad)) * h) / 2, hh = (Math.abs(Math.sin(rad)) * w + Math.abs(Math.cos(rad)) * h) / 2;
                const r = [cx - hw, cy - hh - font * .35, cx + hw, cy + hh - font * .35];
                if (!hit(r)) { placed.push(r); pick = { t, x: cx, y: cy }; break; }
              }
              if (pick) break;
            }
            return (
              <g key={b.id}>
                <line x1={ax} y1={ay} x2={bx} y2={by} stroke="#ff6a1f" strokeWidth={stroke * 1.6} strokeDasharray={`${font * 0.8} ${font * 0.4}`}><title>{`${tag}${n > 1 ? ` (${n} lines, one stroke)` : ''} · ${b.id} · ${fmt(b.angle)}° ${(b.direction || '').toUpperCase()} · R${fmt(b.radius)} · BA ${fmt(b.allowance)}`}</title></line>
                {pick && <text x={pick.x} y={pick.y} fontSize={font} fill="#c8470c" textAnchor="middle" transform={`rotate(${ang} ${pick.x} ${pick.y})`} fontFamily="Manrope Variable, sans-serif" fontWeight={600} paintOrder="stroke" stroke="#fff" strokeWidth={font * 0.18}>{pick.t}</text>}
              </g>
            );
          });
        })()}
        {/* overall dimensions */}
        <g stroke="#4b5158" strokeWidth={stroke} fill="#4b5158" fontSize={font} fontFamily="DM Sans Variable, sans-serif">
          <line x1={X(minX)} y1={dimY} x2={X(maxX)} y2={dimY} />
          <line x1={X(minX)} y1={Y(minY)} x2={X(minX)} y2={dimY + arrow} />
          <line x1={X(maxX)} y1={Y(minY)} x2={X(maxX)} y2={dimY + arrow} />
          <polygon points={`${X(minX)},${dimY} ${X(minX) + arrow},${dimY - arrow / 3} ${X(minX) + arrow},${dimY + arrow / 3}`} />
          <polygon points={`${X(maxX)},${dimY} ${X(maxX) - arrow},${dimY - arrow / 3} ${X(maxX) - arrow},${dimY + arrow / 3}`} />
          <text x={(X(minX) + X(maxX)) / 2} y={dimY - font * 0.4} textAnchor="middle" stroke="none">{fmt(W)}</text>
          <line x1={dimX} y1={Y(minY)} x2={dimX} y2={Y(maxY)} />
          <line x1={X(minX)} y1={Y(minY)} x2={dimX - arrow} y2={Y(minY)} />
          <line x1={X(minX)} y1={Y(maxY)} x2={dimX - arrow} y2={Y(maxY)} />
          <polygon points={`${dimX},${Y(maxY)} ${dimX - arrow / 3},${Y(maxY) + arrow} ${dimX + arrow / 3},${Y(maxY) + arrow}`} />
          <polygon points={`${dimX},${Y(minY)} ${dimX - arrow / 3},${Y(minY) - arrow} ${dimX + arrow / 3},${Y(minY) - arrow}`} />
          <text x={dimX - font * 0.4} y={(Y(minY) + Y(maxY)) / 2} textAnchor="middle" stroke="none" transform={`rotate(-90 ${dimX - font * 0.4} ${(Y(minY) + Y(maxY)) / 2})`}>{fmt(H)}</text>
        </g>
      </svg>
      <div className="flat-legend">
        <div><b>{name}</b><span>Developed blank · {fmt(W)} × {fmt(H)} mm</span></div>
        <div><span>Thickness</span><b>{fmt(thickness)} mm</b></div>
        <div><span>K factor</span><b>{kFactor} {approved ? '· approved' : '· provisional'}</b></div>
        <div><span>Bends</span><b>{bendGroups(flat.bends).length}{bendGroups(flat.bends).length < flat.bends.length ? ` (${flat.bends.length} lines)` : ''}</b></div>
        <div><span>Cut-outs</span><b>{flat.holes.length}</b></div>
        <span className="muted">Scroll to zoom · drag to pan · double-click to reset. {approved ? 'Bend allowance uses the approved K.' : 'Verify K against tooling before cutting blanks.'}</span>
      </div>
      {flat.bends.length > 0 && (
        <div className="bend-table">
          <table>
            <thead><tr><th>Bend</th><th>Angle</th><th>Inside R</th><th>Direction</th><th>Allowance</th><th>Lines</th></tr></thead>
            <tbody>
              {bendGroups(flat.bends).map((gr, k) => { const b = flat.bends[gr[0]]; return (
                <tr key={b.id}>
                  <td><code>B{k + 1}</code></td><td>{fmt(b.angle)}°</td><td>R{fmt(b.radius)} mm</td>
                  <td><span className={'dir ' + (b.direction || '')}>{b.direction ? b.direction.toUpperCase() : '—'}</span></td>
                  <td>{fmt(b.allowance)} mm</td><td title={gr.map(i => flat.bends[i].id).join(', ')}>{gr.length > 1 ? `${gr.length} lines · ${fmt(gr.reduce((t, i) => t + (flat.bends[i].length || 0), 0))} mm` : b.length ? fmt(b.length) + ' mm' : '—'}</td>
                </tr>); })}
            </tbody>
          </table>
          <small>UP folds toward you (viewing the root skin from outside); DOWN folds away. Collinear lines with the same angle, radius and direction are one press stroke. Confirm bend sequence and V-die with the press shop.</small>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Part thumbnail (fetched with credentials, cached per session) and the production checklist
// ---------------------------------------------------------------------------------------------
const thumbCache = new Map<string, string>();
export function PartThumb({ partId, alt, size = 96 }: { partId: string; alt: string; size?: number }) {
  const [url, setUrl] = useState(thumbCache.get(partId) || '');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (thumbCache.has(partId)) { setUrl(thumbCache.get(partId)!); return; }
    let cancelled = false;
    asset(`/parts/${partId}/assets/thumb.png`).then(b => { if (cancelled) return; const u = URL.createObjectURL(b); thumbCache.set(partId, u); setUrl(u); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [partId]);
  return (
    <div className="thumb" style={{ width: size, height: Math.round(size * 0.66) }}>
      {url ? <img src={url} alt={alt} /> : failed ? <Box size={22} /> : <span className="spinner" />}
    </div>
  );
}

export type ProductionRow = { part_id: string; produced: number; quantity_done: number; note: string; actor: string; updated: string };
export function ProductionChecklist({ parts, rows, onSave, onPreview, canEdit, busy }: { parts: Any[]; rows: ProductionRow[]; onSave: (partId: string, r: { produced: boolean; quantity_done: number; note: string }) => Promise<void>; onPreview: (part: Any) => void; canEdit: boolean; busy: boolean }) {
  const byPart = new Map(rows.map(r => [r.part_id, r]));
  const [drafts, setDrafts] = useState<Record<string, { quantity_done: number; note: string }>>({});
  const items = parts.filter(p => !p.excluded);
  const done = items.filter(p => byPart.get(p.id)?.produced).length;
  const draft = (p: Any) => drafts[p.id] || { quantity_done: byPart.get(p.id)?.quantity_done ?? 0, note: byPart.get(p.id)?.note ?? '' };
  return (
    <div className="checklist">
      <div className="checklist-summary">
        <div><b>{done}</b><span>of {items.length} items produced</span></div>
        <div className="bar"><span style={{ width: (items.length ? done / items.length * 100 : 0) + '%' }} /></div>
        <span className="muted">{items.reduce((n, p) => n + (byPart.get(p.id)?.quantity_done || 0), 0)} / {items.reduce((n, p) => n + p.quantity, 0)} pieces</span>
      </div>
      {items.map(p => {
        const row = byPart.get(p.id); const d = draft(p); const produced = !!row?.produced;
        const dirty = drafts[p.id] && (drafts[p.id].quantity_done !== (row?.quantity_done ?? 0) || drafts[p.id].note !== (row?.note ?? ''));
        return (
          <article className={'check-row' + (produced ? ' done' : '')} key={p.id}>
            <button type="button" className="check-toggle" disabled={!canEdit || busy} aria-label={produced ? 'Mark as not produced' : 'Mark as produced'}
              onClick={() => onSave(p.id, { produced: !produced, quantity_done: !produced ? Math.max(d.quantity_done, p.quantity) : d.quantity_done, note: d.note })}>
              {produced ? <CheckCircle2 size={26} /> : <Circle size={26} />}
            </button>
            <PartThumb partId={p.id} alt={p.name} size={112} />
            <div className="check-main">
              <div className="flex"><strong>{p.name}</strong><Badge kind={p.category}>{categories[p.category]}</Badge>{produced && <Badge kind="success">Produced</Badge>}</div>
              <small>
                Qty {p.quantity}{p.spec.material && ` · ${p.spec.material}`}{p.spec.finish && ` · ${p.spec.finish}`}
                {p.spec.coating_hex && <> · <Swatch hex={p.spec.coating_hex} title={p.spec.coating_color} size={11} /> {p.spec.coating_color}</>}
              </small>
              <small>{p.geometry.dimensions.map((x: number) => fmt(x)).join(' × ')} mm{p.geometry.thickness > 0 && ` · t ${fmt(p.geometry.thickness)}`}{p.geometry.holes.length > 0 && ` · ${p.geometry.holes.length} bores`}{p.geometry.bends.length > 0 && ` · ${p.geometry.bends.length} bends`}</small>
              {row?.updated && <small className="faint">{row.produced ? 'Produced' : 'Updated'} by {row.actor} · {new Date(row.updated).toLocaleString()}</small>}
            </div>
            <div className="check-side">
              <button type="button" disabled={!p.assets.includes('drawing.pdf')} title={p.assets.includes('drawing.pdf') ? 'Preview drawing' : 'Drawing not generated'} onClick={() => onPreview(p)}><Eye size={15} />Drawing</button>
              <label>Done<input type="number" min={0} disabled={!canEdit} value={d.quantity_done} onChange={e => setDrafts({ ...drafts, [p.id]: { ...d, quantity_done: +e.target.value } })} /><span>/ {p.quantity}</span></label>
              <input className="note" placeholder="Batch / heat no. / remarks" disabled={!canEdit} value={d.note} onChange={e => setDrafts({ ...drafts, [p.id]: { ...d, note: e.target.value } })} />
              {dirty && <button type="button" className="primary mini" disabled={busy} onClick={() => onSave(p.id, { produced, quantity_done: d.quantity_done, note: d.note }).then(() => setDrafts(({ [p.id]: _, ...rest }) => rest))}><Check size={14} />Save</button>}
            </div>
          </article>
        );
      })}
      {!items.length && <div className="empty-inline"><Box size={30} /><p>No production items in this revision.</p></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Manufacturing specification editor
// ---------------------------------------------------------------------------------------------
function Field({ label, value, onChange, list, placeholder, type = 'text', hint }: { label: string; value: Any; onChange: (v: string) => void; list?: string[]; placeholder?: string; type?: string; hint?: string }) {
  return (
    <label>
      {label}
      {list
        ? <Combo value={value ?? ''} suggestions={list} placeholder={placeholder || 'Approved value or justified N/A'} onChange={onChange} />
        : <input type={type} value={value ?? ''} placeholder={placeholder || 'Approved value or justified N/A'} onChange={e => onChange(e.target.value)} />}
      {hint && <small>{hint}</small>}
    </label>
  );
}

type Op = { name: string; detail: string };
export function OperationsEditor({ ops, setOps }: { ops: Op[]; setOps: (o: Op[]) => void }) {
  return (
    <div className="ops-list">
      {ops.map((op, i) => (
        <div className="op-row" key={i}>
          <b>{String((i + 1) * 10).padStart(3, '0')}</b>
          <Combo size="sm" value={op.name} suggestions={suggestions.operation} placeholder="Operation" onChange={v => setOps(ops.map((o, j) => (j === i ? { ...o, name: v } : o)))} />
          <input value={op.detail} placeholder="Machine, tooling, parameters, acceptance" onChange={e => setOps(ops.map((o, j) => (j === i ? { ...o, detail: e.target.value } : o)))} />
          <button type="button" className="icon" title="Move up" disabled={i === 0} onClick={() => { const n = [...ops]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setOps(n); }}><ArrowUp size={15} /></button>
          <button type="button" className="icon" title="Move down" disabled={i === ops.length - 1} onClick={() => { const n = [...ops]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setOps(n); }}><ArrowDown size={15} /></button>
          <button type="button" className="icon danger" title="Remove" onClick={() => setOps(ops.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={() => setOps([...ops, { name: '', detail: '' }])}><Plus size={15} />Add operation</button>
    </div>
  );
}

export function ColorPicker({ hex, label, onChange }: { hex?: string; label?: string; onChange: (hex: string, label: string) => void }) {
  const [ralQuery, setRalQuery] = useState('');
  const ralMatches = RAL.filter(r => !ralQuery || (r.code + ' ' + r.name).toLowerCase().includes(ralQuery.toLowerCase()));
  return (
    <div className="color-picker">
      <div className="color-current">
        <span className="swatch large" style={{ background: hex || '#e6e8eb' }} />
        <div>
          <input value={label || ''} placeholder="RAL / Pantone / customer code" onChange={e => onChange(hex || '', e.target.value)} />
          <div className="flex">
            <input type="color" aria-label="Custom colour" value={hex || '#808080'} onChange={e => onChange(e.target.value, label || '')} />
            <input value={hex || ''} placeholder="#hex" onChange={e => onChange(e.target.value, label || '')} />
            {hex && <button type="button" className="ghost" onClick={() => onChange('', '')}>Clear</button>}
          </div>
        </div>
      </div>
      <input className="ral-search" placeholder="Search RAL classic…" value={ralQuery} onChange={e => setRalQuery(e.target.value)} />
      <div className="ral-grid">
        {ralMatches.map(r => (
          <button type="button" key={r.code} className={hex?.toLowerCase() === r.hex.toLowerCase() ? 'ral chosen' : 'ral'} title={`${r.code} ${r.name}`} onClick={() => onChange(r.hex, `${r.code} ${r.name}`)}>
            <span style={{ background: r.hex }} />
            <small>{r.code.replace('RAL ', '')}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

export function SpecEditor({ editing, setEditing, config, onSave, busy }: { editing: Any; setEditing: (p: Any) => void; config: Any; onSave: () => void; busy: boolean }) {
  const spec = editing.spec;
  const set = (key: string, value: Any) => setEditing({ ...editing, spec: { ...spec, [key]: value } });
  const ops: { name: string; detail: string }[] = (spec.operations || []).map((o: Any) => (typeof o === 'string' ? { name: o, detail: '' } : { name: o.name || '', detail: o.detail || '' }));
  const setOps = (next: typeof ops) => set('operations', next);
  const features = [
    ...editing.geometry.holes.map((h: Any) => ({ ...h, display: 'Ø' + fmt(h.diameter), unit: 'mm' })),
    ...['X', 'Y', 'Z'].map((axis, i) => ({ id: 'DIM_' + axis, display: fmt(editing.geometry.dimensions[i]), unit: 'mm' })),
    ...editing.geometry.bends.map((b: Any) => ({ id: b.id, display: fmt(b.angle) + '°', unit: 'deg' })),
  ];
  const isSheet = editing.category === 'sheet_metal';
  const coated = /powder|paint|coat/i.test((spec.finish || '') + ' ' + (spec.paint || ''));

  return (
    <form className="spec-form" onSubmit={e => { e.preventDefault(); onSave(); }}>
      <section>
        <h3>Classification</h3>
        <div className="form-grid">
          <label>Manufacturing category
            <Select value={editing.category} onChange={v => setEditing({ ...editing, category: v })} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} />
          </label>
          <label>Quantity per assembly<input value={editing.quantity} readOnly /></label>
        </div>
      </section>

      <section>
        <h3>Material & stock</h3>
        <div className="form-grid">
          <Field label="Material / grade" value={spec.material} onChange={v => set('material', v)} list={suggestions.material} />
          <Field label="Raw stock" value={spec.stock} onChange={v => set('stock', v)} list={suggestions.stock} placeholder="Sheet 3 mm / plate / bar / tube" />
          <Field label="Heat treatment" value={spec.heat_treatment} onChange={v => set('heat_treatment', v)} list={suggestions.heat} />
          <Field label="Hardness" value={spec.hardness} onChange={v => set('hardness', v)} list={suggestions.hardness} />
        </div>
        {editing.geometry.thickness > 0 && <p className="muted">Inferred thickness {fmt(editing.geometry.thickness)} mm · envelope {editing.geometry.dimensions.map((d: number) => fmt(d)).join(' × ')} mm</p>}
      </section>

      <section>
        <h3>Process</h3>
        <div className="form-grid">
          <Field label="Primary process" value={spec.process} onChange={v => set('process', v)} list={suggestions.process} />
          <Field label="Edge treatment" value={spec.edge_treatment} onChange={v => set('edge_treatment', v)} list={suggestions.edge} />
        </div>
        <label>Process sequence</label>
        <OperationsEditor ops={ops} setOps={setOps} />
      </section>

      <section>
        <h3>Surface & coating</h3>
        <div className="form-grid">
          <Field label="Finish" value={spec.finish} onChange={v => set('finish', v)} list={suggestions.finish} />
          <Field label="Coating system" value={spec.paint} onChange={v => set('paint', v)} list={suggestions.paint} hint="Powder / paint / plating system and film thickness" />
          <Field label="Coating thickness" value={spec.coating_thickness} onChange={v => set('coating_thickness', v)} list={suggestions.coatingThickness} />
          <Field label="Masking" value={spec.masking} onChange={v => set('masking', v)} list={suggestions.masking} />
          <Field label="Surface roughness" value={spec.roughness} onChange={v => set('roughness', v)} list={suggestions.roughness} />
        </div>
        <label>Coating colour {coated ? '' : '(only applies to coated parts)'}</label>
        <ColorPicker hex={spec.coating_hex} label={spec.coating_color} onChange={(hex, label) => setEditing({ ...editing, spec: { ...spec, coating_hex: hex, coating_color: label } })} />
      </section>

      <section>
        <h3>Tolerancing & datums</h3>
        <div className="form-grid">
          <Field label="General tolerance" value={spec.general_tolerance} onChange={v => set('general_tolerance', v)} list={suggestions.tolerance} />
          <Field label="Functional datums" value={spec.datums} onChange={v => set('datums', v)} placeholder="A = base face; B = left edge; C = bore H001" />
        </div>
      </section>

      <section>
        <h3>Marking, packaging & other needs</h3>
        <div className="form-grid">
          <Field label="Marking / identification" value={spec.marking} onChange={v => set('marking', v)} list={suggestions.marking} />
          <Field label="Packaging" value={spec.packaging} onChange={v => set('packaging', v)} list={suggestions.packaging} />
        </div>
        <label>Notes to vendor
          <textarea value={spec.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Masking, welding standard, critical faces, inspection sampling, delivery and any other requirements" />
        </label>
      </section>

      {(isSheet || editing.geometry.bends.length > 0) && (
        <section>
          <h3>Sheet development</h3>
          <div className="form-grid">
            <label>K factor
              <input type="number" min="0.01" max="0.99" step="0.01" value={spec.k_factor} onChange={e => set('k_factor', +e.target.value)} />
            </label>
            <label className="check"><input type="checkbox" checked={!!spec.k_factor_approved} onChange={e => set('k_factor_approved', e.target.checked)} />K factor verified against forming tooling</label>
          </div>
        </section>
      )}

      <section>
        <h3>Named features & inspection limits</h3>
        <div className="feature-edit-list">
          {features.map((h: Any) => {
            const f = spec.feature_specs[h.id] || {};
            const update = (k: string, raw: string) => set('feature_specs', { ...spec.feature_specs, [h.id]: { ...f, [k]: k === 'designation' ? raw : raw === '' ? null : +raw } });
            return (
              <div className="feature-edit" key={h.id}>
                <b>{h.id}<small>{h.display} {h.unit}</small></b>
                <input aria-label={h.id + ' designation'} placeholder="Designation, e.g. M8 tapped / H7 reamed" value={f.designation ?? ''} onChange={e => update('designation', e.target.value)} />
                <input aria-label={h.id + ' lower'} placeholder={'Lower (' + h.unit + ')'} type="number" step="any" value={f.lower ?? ''} onChange={e => update('lower', e.target.value)} />
                <input aria-label={h.id + ' upper'} placeholder={'Upper (' + h.unit + ')'} type="number" step="any" value={f.upper ?? ''} onChange={e => update('upper', e.target.value)} />
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <h3>Engineering verification notes</h3>
        <div className="form-grid">
          {Object.entries(config?.manual_checks || {}).map(([k, v]) => (
            <label key={k}>{String(v)}
              <input value={spec.manual_checks[k] || ''} onChange={e => set('manual_checks', { ...spec.manual_checks, [k]: e.target.value })} placeholder="Evidence, calculation reference or justified N/A" />
            </label>
          ))}
        </div>
      </section>

      {editing.findings?.some((f: Any) => f.code.startsWith('DFM')) && (
        <section>
          <h3>Rule dispositions</h3>
          {editing.findings.filter((f: Any) => f.code.startsWith('DFM')).map((f: Any) => {
            const k = f.code + (f.feature ? ':' + f.feature : '');
            return (
              <label key={k}>{f.code} {f.feature} · {f.title}
                <input placeholder="Disposition / deviation reason (optional)" value={spec.rule_waivers[k] || ''} onChange={e => { const w = { ...spec.rule_waivers }; if (e.target.value) w[k] = e.target.value; else delete w[k]; set('rule_waivers', w); }} />
              </label>
            );
          })}
        </section>
      )}

      <label className="check reviewed">
        <input type="checkbox" checked={!!editing.reviewed} onChange={e => setEditing({ ...editing, reviewed: e.target.checked })} />
        I have reviewed this part's classification and specifications
      </label>
      <div className="modal-actions">
        <button className="primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save specification</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Multi-selection: inspector panel and group specification editor
// ---------------------------------------------------------------------------------------------
export function GroupPanel({ parts, vendor, editable, busy, onEdit, onBulk, onExclude, onRemove, onFocus, onClear, onJoint, onProcess, templates = [] }: { parts: Any[]; vendor: boolean; editable: boolean; busy: boolean; onEdit: () => void; onBulk: (body: Any) => void; onExclude: () => void; onRemove: (id: string) => void; onFocus: (id: string) => void; onClear: () => void; onJoint?: () => void; onProcess?: (templateId: string) => void; templates?: Any[] }) {
  const cats = Object.entries(categories).map(([k, v]) => [k, v, parts.filter(p => p.category === k).length] as const).filter(x => x[2] > 0);
  const excluded = parts.filter(p => p.excluded).length, hidden = parts.filter(p => p.hidden).length;
  const qty = parts.reduce((n, p) => n + p.quantity, 0);
  return (
    <>
      <div className="inspector-top">
        <div className="flex">{cats.map(([k, v, n]) => <Badge key={k} kind={k}>{n} {v}</Badge>)}</div>
        <h2>{parts.length} parts selected</h2>
        <span className="muted">{qty} pieces in the assembly{excluded ? ` · ${excluded} not for production` : ''}{hidden ? ` · ${hidden} hidden` : ''}</span>
      </div>
      <div className="inspector-body">
        {!vendor && (
          <div className="group-actions">
            <button type="button" className="primary full" disabled={!editable || busy} title={editable ? 'Set material, process, finish, coating and more for all selected parts at once' : 'Only on an active, ready revision (owner/engineer)'} onClick={onEdit}><Settings size={15} />Edit group manufacturing details</button>
            {editable && (
              <label className="select-action">Set category for all
                <Select size="sm" value="" disabled={busy} placeholder="Choose…" onChange={v => { if (v) onBulk({ category: v }); }} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} />
              </label>
            )}
            {editable && onJoint && <button type="button" className="full" disabled={busy} title="Define how the selected parts are joined: weld type and size, fasteners, faces" onClick={onJoint}><Flame size={15} />Weld these parts…</button>}
            {editable && onProcess && templates.length > 0 && (
              <label className="select-action">Process template for all
                <Select size="sm" value="" disabled={busy} placeholder="Choose a routing…" onChange={v => { if (v) onProcess(v === '__none__' ? '' : v); }} options={[...templates.map((t: Any) => ({ value: t.id, label: t.name, hint: t.data.steps.length + ' steps' })), { value: '__none__', label: 'Remove template' }]} />
              </label>
            )}
            <div className="group-row">
              <button type="button" disabled={busy} onClick={() => onBulk({ hidden: hidden < parts.length })}>{hidden < parts.length ? <EyeOff size={14} /> : <Eye size={14} />}{hidden < parts.length ? 'Hide in viewer' : 'Show in viewer'}</button>
              {editable && (excluded < parts.length
                ? <button type="button" className="danger-ghost" disabled={busy} onClick={onExclude}><Ban size={14} />Not for production</button>
                : <button type="button" disabled={busy} onClick={() => onBulk({ excluded: false })}><Undo2 size={14} />Restore to production</button>)}
            </div>
          </div>
        )}
        <h4>Selected parts</h4>
        <div className="group-list">
          {parts.map(p => (
            <div className={'group-item' + (p.excluded ? ' is-excluded' : '')} key={p.id}>
              <span className={'part-glyph ' + p.category} style={p.spec.coating_hex ? { background: p.spec.coating_hex, color: '#fff' } : undefined}>{p.category === 'sheet_metal' ? <Layers size={14} /> : <Box size={14} />}</span>
              <button type="button" className="group-name" title="Show only this part" onClick={() => onFocus(p.id)}><strong>{p.name}</strong><small>{categories[p.category]} · Qty {p.quantity}{p.spec.material ? ' · ' + p.spec.material : ''}</small></button>
              <button type="button" className="icon" title="Remove from selection" onClick={() => onRemove(p.id)}><X size={13} /></button>
            </div>
          ))}
        </div>
        <button type="button" className="full" onClick={onClear}>Clear selection</button>
        <p className="muted">Shift-click selects a range in the navigator; Ctrl/Cmd-click adds or removes single parts.</p>
      </div>
    </>
  );
}

const GROUP_FIELDS = ['material', 'stock', 'heat_treatment', 'hardness', 'process', 'edge_treatment', 'finish', 'paint', 'coating_thickness', 'masking', 'roughness', 'coating_color', 'coating_hex', 'general_tolerance', 'datums', 'marking', 'packaging', 'notes', 'k_factor', 'k_factor_approved', 'operations'];
const MIXED = '__mixed__';
export function GroupSpecEditor({ parts, config, busy, onSave }: { parts: Any[]; config: Any; busy: boolean; onSave: (patch: Record<string, Any>, category: string | null, reviewed: boolean | null) => void }) {
  // Common value per field, or MIXED when the selected parts disagree.
  const initial = useMemo(() => {
    const out: Record<string, Any> = {};
    for (const key of GROUP_FIELDS) {
      const values = parts.map(p => JSON.stringify(p.spec[key] ?? (key === 'operations' ? [] : key === 'k_factor_approved' ? false : key === 'k_factor' ? 0.4 : '')));
      out[key] = new Set(values).size === 1 ? JSON.parse(values[0]) : MIXED;
    }
    const checks: Record<string, Any> = {};
    for (const k of Object.keys(config?.manual_checks || {})) { const values = parts.map(p => p.spec.manual_checks?.[k] || ''); checks[k] = new Set(values).size === 1 ? values[0] : MIXED; }
    out.manual_checks = checks;
    return out;
  }, [parts, config]);
  const [values, setValues] = useState<Record<string, Any>>(initial);
  const [category, setCategory] = useState<string>(new Set(parts.map(p => p.category)).size === 1 ? parts[0].category : '');
  const [reviewed, setReviewed] = useState<boolean | null>(null);
  const isMixed = (k: string) => values[k] === MIXED;
  const dirty = (k: string) => JSON.stringify(values[k]) !== JSON.stringify(initial[k]);
  const set = (k: string, v: Any) => setValues({ ...values, [k]: v });
  const field = (label: string, k: string, list?: string[], placeholder?: string) => (
    <label key={k} className={dirty(k) ? 'changed' : ''}>{label}{dirty(k) && <em> · will change</em>}
      {list
        ? <Combo value={isMixed(k) ? '' : values[k] ?? ''} suggestions={list} placeholder={isMixed(k) ? 'Mixed values — leave blank to keep each part\'s own' : placeholder || 'Approved value or justified N/A'} onChange={v => set(k, v)} />
        : <input value={isMixed(k) ? '' : values[k] ?? ''} placeholder={isMixed(k) ? 'Mixed values — leave blank to keep each part\'s own' : placeholder || 'Approved value or justified N/A'} onChange={e => set(k, e.target.value)} />}
    </label>
  );
  const ops: Op[] = Array.isArray(values.operations) ? values.operations.map((o: Any) => (typeof o === 'string' ? { name: o, detail: '' } : { name: o.name || '', detail: o.detail || '' })) : [];
  const changedKeys = GROUP_FIELDS.filter(dirty);
  const changedChecks = Object.keys(values.manual_checks || {}).filter(k => values.manual_checks[k] !== initial.manual_checks[k]);
  const submit = () => {
    const patch: Record<string, Any> = {};
    for (const k of changedKeys) patch[k] = values[k];
    if (changedChecks.length) {
      // Merge per part on the server is by whole-object replacement, so send only when every selected part shares the other notes.
      patch.manual_checks = Object.fromEntries(Object.entries(values.manual_checks).filter(([, v]) => v !== MIXED));
    }
    onSave(patch, category && new Set(parts.map(p => p.category)).size !== 1 || (category && category !== parts[0].category) ? category : null, reviewed);
  };
  const sheet = parts.some(p => p.category === 'sheet_metal' || p.geometry.bends.length);
  return (
    <form className="spec-form" onSubmit={e => { e.preventDefault(); submit(); }}>
      <div className="group-summary">{parts.map(p => <Badge key={p.id} kind={p.category}>{p.name}</Badge>)}</div>
      <section>
        <h3>Classification</h3>
        <label>Manufacturing category{category && new Set(parts.map(p => p.category)).size !== 1 && <em> · will change all</em>}
          <Select value={category} onChange={setCategory} options={[...(new Set(parts.map(p => p.category)).size !== 1 ? [{ value: '', label: "Mixed — keep each part's category" }] : []), ...Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))]} />
        </label>
      </section>
      <section>
        <h3>Material & stock</h3>
        <div className="form-grid">
          {field('Material / grade', 'material', suggestions.material)}
          {field('Raw stock', 'stock', suggestions.stock, 'Sheet 3 mm / plate / bar / tube')}
          {field('Heat treatment', 'heat_treatment', suggestions.heat)}
          {field('Hardness', 'hardness', suggestions.hardness)}
        </div>
      </section>
      <section>
        <h3>Process</h3>
        <div className="form-grid">
          {field('Primary process', 'process', suggestions.process)}
          {field('Edge treatment', 'edge_treatment', suggestions.edge)}
        </div>
        <label>Process sequence{dirty('operations') && <em> · will replace on all parts</em>}</label>
        {isMixed('operations') && ops.length === 0 && <p className="muted">Parts have different sequences. Add operations here to give all of them the same sequence, or leave empty to keep each one.</p>}
        <OperationsEditor ops={ops} setOps={o => set('operations', o)} />
      </section>
      <section>
        <h3>Surface & coating</h3>
        <div className="form-grid">
          {field('Finish', 'finish', suggestions.finish)}
          {field('Coating system', 'paint', suggestions.paint)}
          {field('Coating thickness', 'coating_thickness', suggestions.coatingThickness)}
          {field('Masking', 'masking', suggestions.masking)}
          {field('Surface roughness', 'roughness', suggestions.roughness)}
        </div>
        <label>Coating colour{(dirty('coating_hex') || dirty('coating_color')) && <em> · will change all</em>}{isMixed('coating_hex') && !dirty('coating_hex') && <em> · mixed, pick one to unify</em>}</label>
        <ColorPicker hex={isMixed('coating_hex') ? '' : values.coating_hex} label={isMixed('coating_color') ? '' : values.coating_color} onChange={(hex, label) => setValues({ ...values, coating_hex: hex, coating_color: label })} />
      </section>
      <section>
        <h3>Tolerancing & datums</h3>
        <div className="form-grid">
          {field('General tolerance', 'general_tolerance', suggestions.tolerance)}
          {field('Functional datums', 'datums', undefined, 'A = base face; B = left edge')}
        </div>
      </section>
      <section>
        <h3>Marking, packaging & notes</h3>
        <div className="form-grid">
          {field('Marking / identification', 'marking', suggestions.marking)}
          {field('Packaging', 'packaging', suggestions.packaging)}
        </div>
        <label className={dirty('notes') ? 'changed' : ''}>Notes to vendor{dirty('notes') && <em> · will change</em>}<textarea value={isMixed('notes') ? '' : values.notes ?? ''} placeholder={isMixed('notes') ? 'Mixed — leave blank to keep each part\'s notes' : ''} onChange={e => set('notes', e.target.value)} /></label>
      </section>
      {sheet && (
        <section>
          <h3>Sheet development</h3>
          <div className="form-grid">
            <label className={dirty('k_factor') ? 'changed' : ''}>K factor{isMixed('k_factor') && ' (mixed)'}<input type="number" min="0.01" max="0.99" step="0.01" value={isMixed('k_factor') ? '' : values.k_factor} onChange={e => set('k_factor', +e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={values.k_factor_approved === true} onChange={e => set('k_factor_approved', e.target.checked)} />K factor verified against forming tooling{isMixed('k_factor_approved') && !dirty('k_factor_approved') && ' (mixed)'}</label>
          </div>
        </section>
      )}
      <section>
        <h3>Engineering verification notes</h3>
        <div className="form-grid">
          {Object.entries(config?.manual_checks || {}).map(([k, v]) => (
            <label key={k} className={values.manual_checks[k] !== initial.manual_checks[k] ? 'changed' : ''}>{String(v)}
              <input value={values.manual_checks[k] === MIXED ? '' : values.manual_checks[k]} placeholder={values.manual_checks[k] === MIXED ? 'Mixed — leave blank to keep' : 'Evidence, calculation reference or justified N/A'} onChange={e => setValues({ ...values, manual_checks: { ...values.manual_checks, [k]: e.target.value } })} />
            </label>
          ))}
        </div>
        {changedChecks.length > 0 && Object.values(values.manual_checks).includes(MIXED) && <p className="muted">Notes still marked mixed are left as they are on each part.</p>}
      </section>
      <label className="check reviewed"><input type="checkbox" checked={reviewed === true} onChange={e => setReviewed(e.target.checked ? true : null)} />Mark all {parts.length} parts as reviewed</label>
      <div className="modal-actions">
        <span className="muted">{changedKeys.length + changedChecks.length + (category && new Set(parts.map(p => p.category)).size !== 1 || (category && category !== parts[0].category) ? 1 : 0)} field(s) will change on {parts.length} parts</span>
        <button className="primary" disabled={busy || (!changedKeys.length && !changedChecks.length && !(category && (new Set(parts.map(p => p.category)).size !== 1 || category !== parts[0].category)) && reviewed === null)}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Apply to {parts.length} parts</button>
      </div>
    </form>
  );
}

// ============================================================================ In-app dialogs (no browser prompt/confirm)
type AskOptions = {
  title: string; message?: string; confirm?: string; cancel?: string; danger?: boolean;
  /** Ask for text: a label shows an input; `required` blocks empty answers; `choices` offers quick picks. */
  input?: { label: string; placeholder?: string; required?: boolean; choices?: string[]; multiline?: boolean; type?: 'text' | 'date'; initial?: string; min?: string };
};
let openAsk: ((o: AskOptions, done: (v: string | null) => void) => void) | null = null;

/** Promise-based confirm / prompt rendered by <DialogHost/>. Resolves null when cancelled, else the text ('' for a plain confirm). */
export function ask(o: AskOptions): Promise<string | null> {
  return new Promise(resolve => {
    if (!openAsk) { resolve(window.confirm(o.title) ? '' : null); return; }
    openAsk(o, resolve);
  });
}

export function DialogHost() {
  const [state, setState] = useState<{ o: AskOptions; done: (v: string | null) => void } | null>(null);
  const [text, setText] = useState('');
  useEffect(() => { openAsk = (o, done) => { setText(o.input?.initial || ''); setState({ o, done }); }; return () => { openAsk = null; }; }, []);
  if (!state) return null;
  const { o, done } = state;
  const finish = (v: string | null) => { setState(null); done(v); };
  const blocked = !!o.input?.required && !text.trim();
  return (
    <Modal top title={o.title} close={() => finish(null)}>
      <form className="ask-dialog" onSubmit={e => { e.preventDefault(); if (!blocked) finish(o.input ? text.trim() : ''); }}>
        {o.message && <p className="ask-message">{o.message}</p>}
        {o.input && <>
          {o.input.choices && <div className="ask-choices">{o.input.choices.map(c => <button type="button" key={c} className={'chip' + (text === c ? ' selected' : '')} onClick={() => setText(c)}>{c}</button>)}</div>}
          <label>{o.input.label}{o.input.multiline
            ? <textarea autoFocus rows={3} value={text} placeholder={o.input.placeholder} onChange={e => setText(e.target.value)} />
            : <input autoFocus type={o.input.type || 'text'} min={o.input.min} value={text} placeholder={o.input.placeholder} onChange={e => setText(e.target.value)} />}</label>
        </>}
        <div className="modal-actions">
          <button type="button" onClick={() => finish(null)}>{o.cancel || 'Cancel'}</button>
          <button type="submit" autoFocus={!o.input} className={o.danger ? 'danger' : 'primary'} disabled={blocked}>{o.confirm || 'OK'}</button>
        </div>
      </form>
    </Modal>
  );
}
