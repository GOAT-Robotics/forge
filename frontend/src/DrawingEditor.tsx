import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePinchZoom } from './pinchZoom';
import { api, asset, saveBlob } from './api';
import { X, Save, Download, Undo2, Redo2, Plus, Eye, EyeOff, RotateCcw, ZoomIn, ZoomOut, Trash2, CheckCircle2, Circle, FileText, ScanSearch, GripVertical, Hexagon } from 'lucide-react';
import type { Any } from './constants';
import { ask } from './components';
import { Select, Combo } from './controls';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Separator } from '@/components/ui/separator';
import { Kbd } from '@/components/ui/kbd';

const eyebrow = 'text-2xs font-medium uppercase tracking-wider text-muted-foreground';
const hintCls = 'text-xs leading-relaxed text-muted-foreground';
const noteCls = 'text-2xs leading-relaxed text-muted-foreground';
const codeCls = 'rounded bg-muted px-1 text-2xs text-foreground';
const detailsCls = 'border-t pt-3';
const summaryCls = 'cursor-pointer text-xs font-medium select-none';
/** Toggled toolbar button (was `.selected`). */
const toolOn = (on: boolean) => on ? 'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground dark:bg-selection dark:hover:bg-selection' : '';
/** Preset chip (was `.chip` / `.chip.chosen`). */
const chipCls = (on: boolean) => cn('rounded-full font-normal', on && 'border-primary/40 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground dark:bg-selection dark:hover:bg-selection');
function Field({ label, children, className }: { label: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <Label className={cn('grid items-stretch gap-1.5 text-xs leading-snug font-medium text-muted-foreground', className)}>{label}{children}</Label>;
}
function CheckRow({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <Label className="items-start text-sm leading-snug font-normal text-foreground"><Checkbox className="mt-0.5" checked={checked} disabled={disabled} onCheckedChange={v => onChange(v === true)} /><span>{children}</span></Label>;
}

type Edits = { objects: Record<string, { dx?: number; dy?: number; text?: string; hidden?: boolean; page?: number; hidden_lines?: boolean; flip?: boolean; size?: number }>; notes: Any[]; views: Any[]; details: Any[]; page_order?: number[]; extra_pages?: { id: string; size: string }[] };
const DETAIL_SCALES = [1.5, 2, 2.5, 3, 4, 5, 8, 10];
const DETAIL_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Hidden-detail edges (dashed, two-element dash); centre and bend lines use a four-element chain. */
const isHiddenLine = (n: Any) => n.type === 'path' && n.dash?.length === 2;
const geometryNodes = (g: Any) => g.nodes.filter((n: Any) => n.type === 'path' && (n.width >= .6 || n.dash?.length));
const sheetName = (w: number) => { const mm = Math.round(w / MM_PT); return mm > 560 ? 'A2' : mm > 400 ? 'A3' : 'A4'; };
const MM_PT = 72 / 25.4;
type Pic = { lines: number[][][]; lo: number[]; hi: number[] };
const picCache = new Map<string, Promise<Pic>>();
/** Projected visible edges for a pictorial angle (cached per part + angle). */
const fetchPic = (partId: string, az: number, el: number) => {
  const key = `${partId}:${az.toFixed(3)}:${el.toFixed(3)}`;
  if (!picCache.has(key)) picCache.set(key, api(`/parts/${partId}/pictorial?azimuth=${az.toFixed(3)}&elevation=${el.toFixed(3)}`).catch(e => { picCache.delete(key); throw e; }));
  return picCache.get(key)!;
};
const picPath = (lines: number[][][]) => lines.map(l => 'M' + l.map(p => `${p[0]} ${p[1]}`).join('L')).join('');
const SCALE_OPTIONS: [string, number][] = [['5:1', 5], ['4:1', 4], ['3:1', 3], ['2:1', 2], ['1.5:1', 1.5], ['1:1', 1], ['1:1.5', 1 / 1.5], ['1:2', .5], ['1:2.5', .4], ['1:3', 1 / 3], ['1:4', .25], ['1:5', .2], ['1:10', .1], ['1:20', .05]];
const scaleText = (s: number) => s >= 1 ? `${+s.toFixed(2)}:1` : `1:${+(1 / s).toFixed(2)}`;
/** Palette thumbnail: the part from one pictorial angle, fitted to a small box. */
function ViewThumb({ partId, az, el }: { partId: string; az: number; el: number }) {
  const [pic, setPic] = useState<Pic | null>(null), [err, setErr] = useState(false);
  useEffect(() => { let live = true; setPic(null); setErr(false); fetchPic(partId, az, el).then(p => live && setPic(p)).catch(() => live && setErr(true)); return () => { live = false; }; }, [partId, az, el]);
  if (!pic) return <div className={cn('grid h-16 w-full place-items-center rounded text-zinc-400', !err && 'animate-pulse bg-zinc-100')}>{err ? '—' : ''}</div>;
  const cx = (pic.lo[0] + pic.hi[0]) / 2, cy = (pic.lo[1] + pic.hi[1]) / 2, span = Math.max(pic.hi[0] - pic.lo[0], pic.hi[1] - pic.lo[1]) * 1.1 || 1;
  return <svg className="block h-16 w-full" viewBox={`${-span / 2} ${-span / 2} ${span} ${span}`}><g transform={`scale(1 -1) translate(${-cx} ${-cy})`}><path d={picPath(pic.lines)} fill="none" stroke="#1d2533" strokeWidth={span / 160} strokeLinejoin="round" /></g></svg>;
}
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const rgb = (c: number[]) => `rgb(${c.map(x => Math.round(x * 255)).join(',')})`;
const commands = (node: Any) => node.commands.map((v: Any[]) => v.join(' ')).join(' ');
function offset(g: Any, groups: Record<string, Any>, edits: Edits): [number, number] {
  let x = 0, y = 0; const seen = new Set();
  while (g && !seen.has(g.id)) { seen.add(g.id); const e = edits.objects[g.id] || {}; x += e.dx || 0; y += e.dy || 0; g = groups[g.parent]; }
  return [x, y];
}
function bounds(g: Any): number[] {
  if (g.bounds) return g.bounds;
  const points: number[][] = [];
  for (const n of g.nodes) {
    const [a, b, c, d, e, f] = n.matrix;
    const add = (x: number, y: number) => points.push([a * x + c * y + e, b * x + d * y + f]);
    if (n.type === 'text') { add(n.x, n.y); add(n.x + n.text.length * n.size * .56, n.y + n.size); }
    else for (const [op, ...v] of n.commands) { if (op !== 'Z') for (let i = 0; i < v.length; i += 2) add(v[i], v[i + 1]); }
  }
  return points.length ? [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))] : [0, 0, 0, 0];
}
const applyM = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
function nodeAnchor(n: Any): number[] {
  if (n.type === 'text') return applyM(n.matrix, n.x, n.y);
  const pts: number[][] = [];
  for (const [op, ...v] of n.commands) if (op !== 'Z') for (let i = 0; i + 1 < v.length; i += 2) pts.push(applyM(n.matrix, v[i], v[i + 1]));
  return pts.length ? [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length] : [0, 0];
}
const isGround = (n: Any) => n.type === 'path' && n.doFill && !n.doStroke && n.fill?.[0] === 1 && n.fill?.[1] === 1 && n.fill?.[2] === 1;
/** ISO detail view content: enlarged lines (clipped), and the dimension values / tags / arrowheads / callouts inside
 * the circle moved with the enlargement at drawing text size. Mirrors drawing_scene.detail_plan. */
function detailPlan(d: Any, view: Any, children: Any[], objects: Any) {
  const k = d.scale; const T = (x: number, y: number) => [d.cx + k * (x - d.x), d.cy + k * (y - d.y)];
  const inside = (x: number, y: number) => (x - d.x) ** 2 + (y - d.y) ** 2 <= (d.r * 1.02) ** 2;
  const scaled: Any[] = [], moved: [Any, number, number][] = []; let shift: number[] | null = null;
  const nodes = [...view.nodes, ...children.filter((g: Any) => g.kind === 'dim').flatMap((g: Any) => g.nodes)];
  nodes.forEach((n: Any, i: number) => {
    if (n.type === 'path' && !n.doFill) { scaled.push(n); shift = null; return; }
    if (isGround(n)) {
      const nxt = nodes.slice(i + 1, i + 3).find((m: Any) => m.type === 'text');
      const [ax, ay] = nodeAnchor(nxt || n); const t = T(ax, ay);
      shift = inside(ax, ay) ? [t[0] - ax, t[1] - ay] : null;
      if (shift) moved.push([n, shift[0], shift[1]]);
      return;
    }
    if (n.type === 'text' && shift) { moved.push([n, shift[0], shift[1]]); return; }
    const [ax, ay] = nodeAnchor(n); shift = null;
    if (inside(ax, ay)) { const t = T(ax, ay); moved.push([n, t[0] - ax, t[1] - ay]); }
  });
  const calls: [Any, number, number, number, number][] = [];
  for (const g of children) {
    if (g.style !== 'goat') continue;
    const [cx, cy] = g.center; if (!inside(cx, cy)) continue;
    const e = objects[g.id] || {}; const qx = g.bounds[0] + (e.dx || 0), qy = g.shoulder_y + (e.dy || 0);
    const tc = T(cx, cy), tq = T(qx, qy);
    calls.push([g, tq[0] - qx + (e.dx || 0), tq[1] - qy + (e.dy || 0), tc[0] - cx, tc[1] - cy]);
  }
  return { scaled, moved, calls };
}
const SHEET_RE = /^(SHEET\s*:\s*)\d+(\s+OF\s+)\d+/;
/** Clickable arrowhead: a click flips the arrow to the other side of the feature (SolidWorks arrow handle). */
function ArrowHandle({ x, y, chosen, onFlip }: { x: number; y: number; chosen?: boolean; onFlip?: (e: React.PointerEvent) => void }) {
  if (!onFlip) return null;
  return <circle className="dwg-arrow-handle" cx={x} cy={y} r={2.2 * MM} fill={chosen ? '#f59e0b33' : 'transparent'} stroke={chosen ? '#f59e0b' : 'none'} strokeWidth=".6" style={{ cursor: 'pointer' }} onPointerDown={onFlip}><title>Click to flip the arrow inside / outside</title></circle>;
}
function GoatCallout({ g, lines, dx, dy, px, py, chosen, handlers, flip, onFlip }: { g: Any; lines: string[]; dx: number; dy: number; px: number; py: number; chosen?: boolean; handlers?: Any; flip?: boolean; onFlip?: (e: React.PointerEvent) => void }) {
  const k = goatCallout(g, lines, dx, dy, px, py);
  const d = Math.hypot(k.tx - k.ax, k.ty - k.ay) || 1, ux = (k.tx - k.ax) / d, uy = (k.ty - k.ay) / d, ext = 4.8 * MM;
  return <>{flip
      ? <><line x1={k.tx} y1={k.ty} x2={k.ax} y2={k.ay} stroke="#111" strokeWidth={.18 * MM} pointerEvents="none" /><line x1={k.tx} y1={k.ty} x2={k.tx + ux * ext} y2={k.ty + uy * ext} stroke="#111" strokeWidth={.18 * MM} markerStart="url(#goat-arrow)" pointerEvents="none" /></>
      : <line x1={k.tx} y1={k.ty} x2={k.ax} y2={k.ay} stroke="#111" strokeWidth={.18 * MM} markerStart="url(#goat-arrow)" pointerEvents="none" />}
    <ArrowHandle x={k.tx} y={k.ty} chosen={chosen} onFlip={onFlip} />
    <g {...(handlers || {})}><rect className="dwg-hit" x={k.bx - 2} y={k.by - 3} width={k.w + 4} height={k.top - k.by + 5} fill={chosen ? '#e4f0ff' : 'transparent'} stroke={chosen ? '#2470e8' : 'none'} strokeWidth=".7" />
      <line x1={k.bx} y1={k.by} x2={k.bx + k.w} y2={k.by} stroke="#111" strokeWidth={.18 * MM} />
      {lines.map((line: string, i: number) => { const w = textWidth(line, k.size, GOAT_FONT); const y = k.by + .9 * MM + k.pitch * (k.n - 1 - i); const x = k.attachLeft ? k.bx + .5 * MM : k.bx + k.w - .5 * MM - w;
        return <g key={i}>{!chosen && <rect x={x - .25 * MM} y={y - .22 * k.size} width={w + .5 * MM} height={k.size * .98} fill="#fff" />}<text transform={`translate(${x} ${y}) scale(1 -1)`} fontFamily={GOAT_FONT} fontSize={k.size}>{line}</text></g>; })}</g></>;
}
/** One ordinate / angular dimension (mirrors sheet.paint_dim): dragging the value stretches the extension line
 * with a jog, the feature end stays on the geometry; text override ('<>' = measured value) and size scale. */
function DimGroup({ g, e, chosen, handlers }: { g: Any; e: Any; chosen?: boolean; handlers?: Any }) {
  const mx = (e.dx || 0) / MM, my = (e.dy || 0) / MM, moved = Math.abs(mx) > 1e-6 || Math.abs(my) > 1e-6, scale = e.size ?? 1;
  const P = (p: number[]) => `${p[0] * MM} ${p[1] * MM}`;
  return <>{g.items.filter((it: Any) => it.k !== 'text').map((it: Any, i: number) => {
      if (it.k === 'poly') {
        let pts: number[][] = it.pts;
        if (moved && (g.axis === 'x' || g.axis === 'y')) pts = pts.length <= 2 ? [...pts, [pts[pts.length - 1][0] + mx, pts[pts.length - 1][1] + my]] : [...pts.slice(0, 2), ...pts.slice(2).map(p => [p[0] + mx, p[1] + my])];
        return <path key={i} d={'M' + pts.map(P).join('L') + (it.closed ? 'Z' : '')} fill="none" stroke={chosen ? '#2470e8' : '#111'} strokeWidth={it.w * MM} strokeDasharray={it.dash ? it.dash.map((x: number) => x * MM).join(' ') : undefined} pointerEvents="none" />;
      }
      if (it.k === 'circle') return <circle key={i} cx={it.c[0] * MM} cy={it.c[1] * MM} r={it.r * MM} fill={it.fill ? '#111' : 'none'} stroke="#111" strokeWidth={it.w * MM} pointerEvents="none" />;
      return <path key={i} d={'M' + it.pts.map(P).join('L') + 'Z'} fill={chosen ? '#2470e8' : '#111'} pointerEvents="none" />;
    })}
    {g.items.filter((it: Any) => it.k === 'text').map((it: Any, i: number) => {
      const s = e.text != null ? String(e.text).replace('<>', it.s) : it.s; if (!s) return null;
      const size = it.size * MM * scale, w = textWidth(s, size, GOAT_FONT) * (it.hscale || 1);
      const x0 = it.ha === 'r' ? -w : it.ha === 'c' ? -w / 2 : 0;
      return <g key={'t' + i} transform={`translate(${(it.x + mx) * MM} ${(it.y + my) * MM}) rotate(${it.rot || 0})`} {...(handlers || {})}>
        <rect className="dwg-hit" x={x0 - .6 * MM} y={-.3 * size - .4 * MM} width={w + 1.2 * MM} height={size * 1.05 + .8 * MM} fill={chosen ? '#e4f0ff' : '#fff'} stroke={chosen ? '#2470e8' : 'none'} strokeWidth=".6" />
        <text transform="scale(1 -1)" x={x0} fontFamily={GOAT_FONT} fontSize={size} fill={e.text != null ? '#7a3e00' : '#111'}>{s}</text></g>;
    })}</>;
}
function VectorNode({ n }: { n: Any }) {
  return <g transform={`matrix(${n.matrix.join(' ')})`}>
    {n.type === 'image' ? <g transform={`translate(${n.x} ${n.y + n.h}) scale(1 -1)`}><image href={`data:${n.mime || 'image/jpeg'};base64,${n.data}`} width={n.w} height={n.h} preserveAspectRatio="none" /></g> : n.type === 'text' ? <text transform={`translate(${n.x} ${n.y}) scale(1 -1)`} fontFamily={n.font === 'ForgeDim' ? GOAT_FONT : 'Helvetica, Arial, sans-serif'} fontSize={n.size} fill={rgb(n.fill)}>{n.text}</text> : <path d={commands(n)} stroke={n.doStroke ? rgb(n.stroke) : 'none'} fill={n.doFill ? rgb(n.fill) : 'none'} strokeWidth={n.width} strokeDasharray={n.dash?.join(' ')} />}
  </g>;
}
const GOAT_FONT = '"ForgeDim", "Barlow Semi Condensed", "Arial Narrow", Helvetica, Arial, sans-serif';
const MM = 72 / 25.4;
const textWidth = (text: string, size: number, font = 'Helvetica, Arial, sans-serif') => { const ctx = document.createElement('canvas').getContext('2d')!; ctx.font = `${size}px ${font}`; return ctx.measureText(text).width; };
/** GOAT-template leader note: arrow on the feature (follows its view), shoulder + text move with the note. */
function goatCallout(g: Any, lines: string[], dx: number, dy: number, px: number, py: number) {
  const size = g.size, pitch = g.pitch, n = lines.length;
  const w = Math.max(...lines.map(l => textWidth(l, size, GOAT_FONT))) + MM;
  const [bx0, , bx1] = g.bounds; const left = (bx0 + bx1) / 2 > g.center[0];
  const bx = left ? bx0 + dx : bx1 + dx - w, by = g.shoulder_y + dy;
  const cx = g.center[0] + px, cy = g.center[1] + py; const attachLeft = bx + w / 2 > cx;
  const ax = attachLeft ? bx : bx + w, ay = by; const d = Math.hypot(ax - cx, ay - cy) || 1;
  const tx = cx + (ax - cx) / d * g.radius, ty = cy + (ay - cy) / d * g.radius;
  return { size, pitch, n, w, bx, by, ax, ay, tx, ty, attachLeft, top: by + .9 * MM + pitch * (n - 1) + size * .75 };
}

export default function DrawingEditor({ partId, close, onSaved, balloons: balloonsInitially = false }: { partId: string; close: () => void; onSaved: () => void; balloons?: boolean }) {
  // Inspection balloons (overlay; saved separately from the drawing arrangement)
  const [showBalloons, setShowBalloons] = useState(balloonsInitially);
  const [plan, setPlan] = useState<Any>(null);
  const balloonDrag = useRef<Any>(null);
  const loadPlan = () => api(`/parts/${partId}/characteristics`).then(setPlan).catch((e: Any) => { setPlan({ chars: [], editable: false, error: e.message }); });
  useEffect(() => { if (showBalloons && !plan) loadPlan(); }, [showBalloons]);
  const [data, setData] = useState<Any>(null), [edits, setEdits] = useState<Edits>({ objects: {}, notes: [], views: [], details: [] });
  const [detailMode, setDetailMode] = useState(false);
  const [newSize, setNewSize] = useState('A3');
  const [, setFontReady] = useState(false);
  useEffect(() => { document.fonts?.load('10px ForgeDim').then(() => setFontReady(true)).catch(() => {}); }, []);
  const [saved, setSaved] = useState(''), [selected, select] = useState(''), [page, setPage] = useState(0), [zoom, setZoom] = useState(1);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [past, setPast] = useState<Edits[]>([]), [future, setFuture] = useState<Edits[]>([]);
  const [thread, setThread] = useState('M6'), [threadDepth, setThreadDepth] = useState(''), [threadClass, setThreadClass] = useState('6H');
  const [fit, setFit] = useState(''), [fitNote, setFitNote] = useState('');
  const svg = useRef<SVGSVGElement>(null); const paper = useRef<HTMLElement>(null); const dragging = useRef<Any>(null); const current = useRef(edits); current.current = edits;
  const [customAz, setCustomAz] = useState(30), [customEl, setCustomEl] = useState(20);
  const extraData = useRef<Record<string, Any>>({});
  function loaded(d: Any) {
    const extras: { id: string; size: string }[] = d.edits.extra_pages || [];
    const base = d.scene.pages.length - extras.length;
    extras.forEach((x, j) => { extraData.current[x.id] = d.scene.pages[base + j]; });
    const e: Edits = { objects: d.edits.objects || {}, notes: d.edits.notes || [], views: d.edits.views || [], details: d.edits.details || [], ...(d.edits.page_order ? { page_order: d.edits.page_order } : {}), ...(extras.length ? { extra_pages: extras } : {}) };
    setData({ ...d, basePages: d.scene.pages.slice(0, base) }); setEdits(e); setSaved(JSON.stringify(e));
  }
  useEffect(() => { let live = true; api(`/parts/${partId}/drawing`).then(d => { if (live) loaded(d); }).catch(e => live && setError(e.message)); return () => { live = false; }; }, [partId]);
  const dirty = JSON.stringify(edits) !== saved;
  useEffect(() => { const guard = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard); }, [dirty]);
  /** generated sheets followed by the sheets added in the editor */
  const pages: Any[] = useMemo(() => data ? [...data.basePages, ...(edits.extra_pages || []).map(x => extraData.current[x.id]).filter(Boolean)] : [], [data?.basePages, edits.extra_pages]);
  const sheet = pages[page] || pages[0];
  /** every group of every sheet (ids are unique), and the sheet each one was generated on */
  const groups: Record<string, Any> = useMemo(() => Object.fromEntries(pages.flatMap((pg: Any) => pg.groups.map((g: Any) => [g.id, g]))), [pages]);
  const sourcePage: Record<string, number> = useMemo(() => Object.fromEntries(pages.flatMap((pg: Any, i: number) => pg.groups.map((g: Any) => [g.id, i]))), [pages]);
  const rootOf = (g: Any) => { const seen = new Set(); while (g?.parent && groups[g.parent] && !seen.has(g.id)) { seen.add(g.id); g = groups[g.parent]; } return g; };
  /** sheet a group is shown on: its view may have been moved to another (e.g. added) sheet */
  const pageOf = (g: Any) => { const r = rootOf(g); const t = r?.kind === 'view' ? edits.objects[r.id]?.page : undefined; return typeof t === 'number' && t < pages.length ? t : sourcePage[g.id]; };
  const shown: Any[] = useMemo(() => pages.flatMap((pg: Any) => pg.groups).filter((g: Any) => pageOf(g) === page), [pages, edits.objects, page, groups]);
  const group = groups[selected]; const note = edits.notes.find(n => n.id === selected); const writable = data?.editable && !busy;
  function change(next: Edits) { setPast(p => [...p.slice(-49), clone(current.current)]); setFuture([]); setEdits(next); }
  /** Views that carry dashed hidden edges, and whether all of them currently show them. */
  const hiddenViews: string[] = useMemo(() => pages.flatMap((pg: Any) => pg.groups).filter((g: Any) => g.kind === 'view' && g.nodes?.some(isHiddenLine)).map((g: Any) => g.id), [pages]);
  const allHiddenShown = hiddenViews.some(id => edits.objects[id]?.hidden_lines !== false);
  function setHiddenLines(ids: string[], show: boolean) {
    const next = clone(edits);
    for (const id of ids) {
      const o: Any = { ...(next.objects[id] || {}) };
      if (show) delete o.hidden_lines; else o.hidden_lines = false;
      if (Object.keys(o).length) next.objects[id] = o; else delete next.objects[id];
    }
    change(next);
  }
  function patch(patch: Any) { const next = clone(edits); next.objects[selected] = { ...next.objects[selected], ...patch }; change(next); }
  /** Toggle one object flag (hidden, flip ...) without leaving empty edit records behind. */
  function toggleFlag(id: string, key: 'hidden' | 'flip') {
    const next = clone(edits); const o: Any = { ...(next.objects[id] || {}) };
    if (o[key]) delete o[key]; else o[key] = true;
    if (Object.keys(o).length) next.objects[id] = o; else delete next.objects[id];
    change(next);
  }
  function flipArrow(e: React.PointerEvent, id: string) {
    e.stopPropagation(); if (e.button !== 0) return; select(id); if (writable) toggleFlag(id, 'flip');
  }
  function resetPosition(id: string) {
    const next = clone(edits); const o: Any = { ...(next.objects[id] || {}) }; delete o.dx; delete o.dy;
    if (Object.keys(o).length) next.objects[id] = o; else delete next.objects[id]; change(next);
  }
  /** Arrow-key nudge of the selected item (points; Shift = 10x), as in a CAD drawing. */
  function nudge(dx: number, dy: number) {
    if (!writable || !selected) return;
    const next = clone(edits);
    const n: Any = next.notes.find(n => n.id === selected); const pv: Any = next.views.find(v => v.id === selected);
    const det: Any = next.details.find(d => 'detail:' + d.id === selected || 'marker:' + d.id === selected);
    if (n) { n.x += dx; n.y += dy; }
    else if (pv) { pv.cx += dx; pv.cy += dy; }
    else if (det) { if (selected.startsWith('detail:')) { det.cx += dx; det.cy += dy; } else { det.x += dx; det.y += dy; } }
    else if (groups[selected] && ['view', 'callout', 'dim'].includes(groups[selected].kind)) { const o = next.objects[selected] || {}; next.objects[selected] = { ...o, dx: (o.dx || 0) + dx, dy: (o.dy || 0) + dy }; }
    else return;
    change(next);
  }
  function deleteSelected() {
    if (!writable || !selected) return;
    if (edits.notes.some(n => n.id === selected)) { change({ ...edits, notes: edits.notes.filter(n => n.id !== selected) }); select(''); return; }
    if (edits.views.some(v => v.id === selected)) { change({ ...edits, views: edits.views.filter(v => v.id !== selected) }); select(''); return; }
    const det = edits.details.find(d => 'detail:' + d.id === selected || 'marker:' + d.id === selected);
    if (det) { change({ ...edits, details: edits.details.filter(d => d !== det) }); select(''); return; }
    if (groups[selected] && ['view', 'callout', 'dim'].includes(groups[selected].kind) && !edits.objects[selected]?.hidden) toggleFlag(selected, 'hidden');
  }
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  function openMenu(e: React.MouseEvent, id: string) { e.preventDefault(); e.stopPropagation(); select(id); setMenu({ x: e.clientX, y: e.clientY, id }); }
  function fitSheet() { const w = paper.current; if (!w || !sheet) return; setZoom(Math.max(.25, Math.min(8, +(Math.min((w.clientWidth - 32) / sheet.width, (w.clientHeight - 32) / sheet.height)).toFixed(2)))); }
  // SolidWorks-style keys: Esc deselect, Delete removes/hides, arrows nudge, F fits the sheet, Ctrl/⌘ Z/Y/S.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    // native fields and their Radix stand-ins (Select trigger/list, Checkbox, Slider) keep their own keys
    if (t && (t.closest('input, textarea, select, [contenteditable="true"], [role="combobox"], [role="listbox"], [role="checkbox"], [role="slider"]'))) return;
    if (document.querySelector('[data-slot="dialog-content"]')) return; // a confirmation dialog is open
    const mod = e.metaKey || e.ctrlKey; const k = e.key.toLowerCase();
    if (mod && k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (mod && k === 's') { e.preventDefault(); if (writable && dirty) save(); return; }
    if (mod) return;
    if (e.key === 'Escape') { e.stopPropagation(); if (menu) setMenu(null); else if (detailMode) setDetailMode(false); else select(''); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    const step = e.shiftKey ? 10 : 1;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (arrows[e.key] && selected) { e.preventDefault(); nudge(...arrows[e.key]); return; }
    if (k === 'f') { e.preventDefault(); fitSheet(); }
  };
  useEffect(() => { const h = (e: KeyboardEvent) => keyRef.current(e); window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true); }, []);
  // Middle-button or Space + drag pans the sheet.
  const pan = useRef<{ x: number; y: number; l: number; t: number } | null>(null); const space = useRef(false); const [panning, setPanning] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !(e.target as HTMLElement)?.closest?.('input, textarea, select, button, [role="slider"]')) { space.current = true; setPanning(true); e.preventDefault(); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space') { space.current = false; setPanning(false); } };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);
  function panStart(e: React.PointerEvent) {
    if (!(e.button === 1 || (e.button === 0 && space.current)) || !paper.current) return false;
    e.preventDefault(); e.stopPropagation(); pan.current = { x: e.clientX, y: e.clientY, l: paper.current.scrollLeft, t: paper.current.scrollTop }; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setPanning(true); return true;
  }
  function panMove(e: React.PointerEvent) { const p0 = pan.current; if (!p0 || !paper.current) return false; paper.current.scrollLeft = p0.l - (e.clientX - p0.x); paper.current.scrollTop = p0.t - (e.clientY - p0.y); return true; }
  function panEnd() { if (!pan.current) return false; pan.current = null; setPanning(space.current); return true; }
  function notePatch(patch: Any) { const next = clone(edits); next.notes = next.notes.map(n => n.id === selected ? { ...n, ...patch } : n); change(next); }
  function undo() { if (!past.length) return; setFuture(f => [clone(edits), ...f]); setEdits(past[past.length - 1]); setPast(p => p.slice(0, -1)); }
  function redo() { if (!future.length) return; setPast(p => [...p, clone(edits)]); setEdits(future[0]); setFuture(f => f.slice(1)); }
  function position(e: React.PointerEvent): [number, number] { const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.current!.getScreenCTM()!.inverse()); return [p.x, sheet.height - p.y]; }
  function start(e: React.PointerEvent, id: string) {
    if (e.button === 1 || space.current) return; // let the paper pan
    if (e.button === 2) { e.stopPropagation(); return; }
    e.stopPropagation(); if (detailMode && writable) { addDetail(e); return; } select(id); if (!writable) return;
    const [x, y] = position(e); dragging.current = { id, x, y, edits: clone(current.current) }; svg.current!.setPointerCapture(e.pointerId);
  }
  // Pinch (trackpad / touch) or Ctrl/⌘ + scroll zooms about the fingers; a pinch cancels any drag it started.
  const pinching = usePinchZoom(paper, zoom, setZoom, { min: .25, max: 8, active: !!data, onPinchStart: () => { const drag = dragging.current; if (drag) { dragging.current = null; setEdits(drag.edits); } } });
  function move(e: React.PointerEvent) {
    if (pinching.current) return;
    const bd = balloonDrag.current;
    if (bd) { const [x, y] = position(e); setPlan((p: Any) => ({ ...p, chars: p.chars.map((c: Any) => c.id === bd.n ? { ...c, dx: bd.dx + x - bd.x, dy: bd.dy + y - bd.y } : c) })); bd.moved = true; return; }
    const drag = dragging.current; if (!drag) return;
    const [x, y] = position(e); const dx = x - drag.x, dy = y - drag.y; const next = clone<Edits>(drag.edits);
    if (drag.id.startsWith('detail:') || drag.id.startsWith('marker:')) {
      const d = next.details.find(d => 'detail:' + d.id === drag.id || 'marker:' + d.id === drag.id);
      if (d && drag.id.startsWith('detail:')) { d.cx = Math.max(0, Math.min(sheet.width, d.cx + dx)); d.cy = Math.max(0, Math.min(sheet.height, d.cy + dy)); }
      else if (d) { d.x += dx; d.y += dy; }
      setEdits(next); return;
    }
    const n: Any = next.notes.find(n => n.id === drag.id) || next.views.find(v => v.id === drag.id);
    if (n && 'cx' in n) { n.cx = Math.max(0, Math.min(sheet.width, n.cx + dx)); n.cy = Math.max(0, Math.min(sheet.height, n.cy + dy)); }
    else if (n) { n.x = Math.max(0, Math.min(sheet.width, n.x + dx)); n.y = Math.max(0, Math.min(sheet.height, n.y + dy)); }
    else { const edit = next.objects[drag.id] || {}; next.objects[drag.id] = { ...edit, dx: (edit.dx || 0) + dx, dy: (edit.dy || 0) + dy }; }
    setEdits(next);
  }
  function end() {
    const bd = balloonDrag.current;
    if (bd) {
      balloonDrag.current = null;
      const c = plan?.chars.find((c: Any) => c.id === bd.n);
      if (bd.moved && c) api(`/parts/${partId}/balloons/${c.id}`, 'PUT', { dx: c.dx, dy: c.dy }).catch((e: Any) => setError(e.message));
      return;
    }
    if (!dragging.current) return; const before = dragging.current.edits; dragging.current = null; if (JSON.stringify(before) !== JSON.stringify(current.current)) { setPast(p => [...p.slice(-49), before]); setFuture([]); } }
  async function save() {
    setBusy(true); setError('');
    try {
      const body: Any = { scene_hash: data.scene.scene_hash, version: data.version, objects: edits.objects, notes: edits.notes, details: edits.details, page_order: order, extra_pages: edits.extra_pages || [] };
      body.views = edits.views.map(({ lines, lo, hi, ...v }: Any) => v);
      const result = await api(`/parts/${partId}/drawing`, 'PUT', body);
      const e: Edits = { objects: result.edits.objects || {}, notes: result.edits.notes || [], views: edits.views, details: result.edits.details || [], ...(result.edits.page_order ? { page_order: result.edits.page_order } : {}), ...(result.edits.extra_pages ? { extra_pages: result.edits.extra_pages } : {}) };
      setData({ ...data, version: result.version, doc_reviewed: false }); setSaved(JSON.stringify(e)); setEdits(e);
      if (result.regenerating) await waitForRegeneration();
      onSaved(); return true;
    }
    catch (e: Any) { setError(e.message); return false; } finally { setBusy(false); }
  }
  /** Pictorial changes need new hidden-line projections from the CAD worker; reload the sheet when done. */
  async function waitForRegeneration() {
    {
      for (let i = 0; i < 240; i++) {
        await new Promise(r => setTimeout(r, 1500));
        try { const d = await api(`/parts/${partId}/drawing`); loaded(d); setPast([]); setFuture([]); select(''); setPage(p => Math.min(p, d.scene.pages.length - 1)); return; }
        catch (e: Any) { if (!/wait|generat|regenerat|job/i.test(e.message)) throw e; }
      }
      throw new Error('Drawing regeneration is taking longer than expected; reopen the editor later.');
    }
  }
  const selectedView = edits.views.find(v => v.id === selected);
  const hiddenAncestor = (g: Any) => { const seen = new Set(); while (g && !seen.has(g.id)) { seen.add(g.id); if (edits.objects[g.id]?.hidden) return true; g = groups[g.parent]; } return false; };
  /** Place a pictorial view (from the palette) on the current sheet. */
  async function placeView(preset: Any, x?: number, y?: number) {
    if (!writable) return;
    try {
      const pic = await fetchPic(partId, preset.azimuth, preset.elevation);
      const v = { id: 'pv' + Math.random().toString(36).slice(2, 9), page, cx: x ?? sheet.width / 2, cy: y ?? sheet.height / 2, scale: data.scene.frame?.scale ?? 1,
        azimuth: preset.azimuth, elevation: preset.elevation, roll: 0, label: preset.label, caption: false, ...pic };
      change({ ...edits, views: [...edits.views, v] }); select(v.id); setError('');
    } catch (e: Any) { setError(e.message); }
  }
  function viewPatch(patch: Any) { change({ ...edits, views: edits.views.map(v => v.id === selected ? { ...v, ...patch } : v) }); }
  async function viewAngles(az: number, el: number) {
    if (!Number.isFinite(az) || !Number.isFinite(el)) return;
    el = Math.max(-89, Math.min(89, el));
    try { const pic = await fetchPic(partId, az, el); viewPatch({ azimuth: az, elevation: el, ...pic }); } catch (e: Any) { setError(e.message); }
  }
  function drop(e: React.DragEvent) {
    e.preventDefault(); const raw = e.dataTransfer.getData('application/x-forge-view'); if (!raw) return;
    const [x, y] = position(e as Any); placeView(JSON.parse(raw), x, y);
  }
  const palette = [...(data?.pictorial_presets || []), { preset: 'custom', label: `Custom ${customAz}° / ${customEl}°`, azimuth: customAz, elevation: customEl }];
  async function exportPdf() { if (dirty && !(await save())) return; setBusy(true); try { saveBlob(await asset(`/parts/${partId}/assets/drawing.pdf`), data.name + '_drawing.pdf'); } catch (e: Any) { setError(e.message); } finally { setBusy(false); } }
  const closeEditor = async () => { if (!dirty || await ask({ title: 'Discard unsaved drawing edits?', message: 'Your changes since the last save will be lost.', confirm: 'Discard', cancel: 'Keep editing', danger: true }) !== null) close(); };
  const currentText = group?.kind === 'callout' ? edits.objects[selected]?.text ?? group.lines.join('\n') : '';
  const quantity = group?.measurements?.filter((m: Any) => m.hole_ids).length || 1;
  const goat = group?.style === 'goat';
  const count = quantity > 1 ? (goat ? `${quantity} x ` : `${quantity}X `) : '';
  function applyThread() {
    if (!threadDepth.trim()) { setError('Enter the specified thread depth, or THRU. It is not inferred from the bore.'); return; }
    if (goat) {
      // GOAT order: drill line, thread line, counterbore/countersink lines.
      const kept = currentText.split('\n').filter((line: string) => !/^(\d+ x )?M\d/.test(line));
      const depth = threadDepth.toUpperCase() === 'THRU' ? 'THRU' : '\u21a7 ' + threadDepth;
      patch({ text: [kept[0], `${thread} - ${threadClass} ${depth}`, ...kept.slice(1)].join('\n') }); setError(''); return;
    }
    const rest = currentText.split('\n').filter((line: string, i: number) => i > 0 && !line.startsWith('STEP DIA'));
    patch({ text: [`${count}${thread} - ${threadClass} ${threadDepth.toUpperCase() === 'THRU' ? 'THRU' : 'DEPTH ' + threadDepth}`, ...rest].join('\n') }); setError('');
  }
  function applyFit() { const rest = currentText.split('\n');
    if (goat) { const m = group.measurements[0]; rest[0] = `${count}\u00d8 ${m.diameter.toFixed(2)}${fit ? ' ' + fit : ''} ${m.through ? 'THRU' : '\u21a7 ' + m.depth.toFixed(2)}`; if (fitNote.trim()) rest.push(fitNote.trim()); patch({ text: rest.join('\n') }); return; } rest[0] = `${count}DIA ${group.measurements[0].diameter.toFixed(3)}${fit ? ' ' + fit : ''} ${group.measurements[0].through ? 'THRU' : 'DEPTH ' + group.measurements[0].depth.toFixed(2)}`; if (fitNote.trim()) rest.push(fitNote.trim()); patch({ text: rest.join('\n') }); }
  const order: number[] = edits.page_order && edits.page_order.length === pages.length ? edits.page_order : pages.map((_: Any, i: number) => i);
  const baseCount = data?.basePages?.length || 0;
  async function addSheet(size: string) {
    try {
      const pg = await api(`/parts/${partId}/drawing/blank-sheet?size=${size}`);
      const id = 'sheet' + Math.random().toString(36).slice(2, 8); extraData.current[id] = { ...pg, groups: pg.groups.map((g: Any) => ({ ...g, id: `${id}:${g.id}`, ...(g.parent ? { parent: `${id}:${g.parent}` } : {}) })) };
      const idx = pages.length;
      change({ ...edits, extra_pages: [...(edits.extra_pages || []), { id, size }], page_order: [...order, idx] }); setPage(idx); select('');
    } catch (e: Any) { setError(e.message); }
  }
  /** Remove an added sheet: whatever was moved onto it returns to its own sheet. */
  function removeSheet(idx: number) {
    const j = idx - baseCount; if (j < 0) return;
    const fix = (p: number) => (p > idx ? p - 1 : p);
    const objects: Any = {};
    for (const [id, o] of Object.entries(edits.objects)) { const n: Any = { ...o }; if (n.page === idx) delete n.page; else if (typeof n.page === 'number') n.page = fix(n.page); objects[id] = n; }
    const next: Edits = { ...edits, objects,
      details: edits.details.map(d => ({ ...d, target_page: d.target_page === idx ? d.page : fix(d.target_page) })),
      views: edits.views.map(v => ({ ...v, page: v.page === idx ? 0 : fix(v.page) })),
      notes: edits.notes.map(n => ({ ...n, page: n.page === idx ? 0 : fix(n.page) })),
      extra_pages: (edits.extra_pages || []).filter((_, k) => k !== j),
      page_order: order.filter(p => p !== idx).map(fix) };
    change(next); setPage(p => (p === idx ? 0 : fix(p))); select('');
  }
  function dropSheet(from: number, to: number) {
    if (from === to) return; const next = [...order]; const [x] = next.splice(from, 1); next.splice(to, 0, x); change({ ...edits, page_order: next });
  }
  function moveViewTo(target: number) {
    const next = clone(edits); const o: Any = { ...(next.objects[selected] || {}) };
    if (target === sourcePage[selected]) delete o.page; else o.page = target;
    if (Object.keys(o).length) next.objects[selected] = o; else delete next.objects[selected];
    change(next); setPage(target);
  }

  function movePage(dir: number) {
    const i = order.indexOf(page), j = i + dir; if (j < 0 || j >= order.length) return;
    const next = [...order]; [next[i], next[j]] = [next[j], next[i]]; change({ ...edits, page_order: next });
  }
  /** Detail view (ISO 128-3): click on a view to circle the crowded area; the enlargement is placed free on the sheet. */
  function addDetail(e: React.PointerEvent) {
    const [x, y] = position(e);
    const hit = shown.filter((g: Any) => g.kind === 'view' && !g.parent).find((g: Any) => { const [dx, dy] = offset(g, groups, edits); const [x0, y0, x1, y1] = bounds(g); return x >= x0 + dx && x <= x1 + dx && y >= y0 + dy && y <= y1 + dy; });
    setDetailMode(false);
    if (!hit) { setError('Click inside a drawing view to place the detail circle.'); return; }
    const [dx, dy] = offset(hit, groups, edits);
    const used = new Set(edits.details.map(d => d.label)); const label = [...DETAIL_LETTERS].find(l => !used.has(l)) || 'Z';
    const r = 10 * MM, scale = 2;
    const [cx, cy] = freeSpot(r * scale);
    const d = { id: label, label, page: sourcePage[hit.id], view: hit.id, x: x - dx, y: y - dy, r, scale, target_page: page, cx, cy };
    change({ ...edits, details: [...edits.details, d] }); select('detail:' + d.id); setError('');
  }
  /** Emptiest spot on the sheet for an enlarged detail of radius R (clear of views, callouts, notes, title block). */
  function freeSpot(R: number, skip?: string): [number, number] {
    const boxes: number[][] = [];
    for (const g of shown) if (g.kind === 'view' || g.kind === 'callout') { const [ox, oy] = offset(g, groups, edits); const b = g.kind === 'callout' && g.bounds ? g.bounds : bounds(g); boxes.push([b[0] + ox, b[1] + oy, b[2] + ox, b[3] + oy]); }
    // tables and notes drawn with the template (bend table, hole table, notes); frame lines span the sheet and are skipped
    for (const g of shown) if (g.kind === 'fixed') { const b = bounds(g); if (b[2] - b[0] < sheet.width * .6 && b[3] - b[1] < sheet.height * .6 && b[2] - b[0] + b[3] - b[1] > 2) boxes.push(b); }
    for (const d of edits.details) if (d.target_page === page && d.id !== skip) boxes.push([d.cx - d.r * d.scale, d.cy - d.r * d.scale - 8 * MM, d.cx + d.r * d.scale, d.cy + d.r * d.scale]);
    for (const n of edits.notes) if (n.page === page) boxes.push([n.x, n.y - 40, n.x + 160, n.y + 12]);
    const pad = 4 * MM, W = sheet.width, H = sheet.height, bottom = H * .2 + R + 8 * MM;
    let best: [number, number] = [W * .78, H * .62], score = -Infinity;
    for (let cy = H - 22 * MM - R; cy >= bottom; cy -= 6 * MM) for (let cx = W - 22 * MM - R; cx >= 22 * MM + R; cx -= 6 * MM) {
      let clear = Infinity;
      for (const b of boxes) { const ddx = Math.max(b[0] - cx, 0, cx - b[2]), ddy = Math.max(b[1] - cy, 0, cy - b[3]); clear = Math.min(clear, Math.hypot(ddx, ddy) - R); }
      if (clear > score + 1e-6) { score = clear; best = [cx, cy]; }
      if (clear >= pad && score >= pad) { /* keep scanning top-down for the first clear spot */ return best; }
    }
    return best;
  }
  const selectedDetail = edits.details.find(d => 'detail:' + d.id === selected || 'marker:' + d.id === selected);
  function detailPatch(patch: Any) {
    let p = patch;
    if (selectedDetail && ('scale' in patch || 'r' in patch)) {
      // a bigger enlargement needs a new free spot on the sheet (clear of the views, tables and other details)
      const R = (patch.r ?? selectedDetail.r) * (patch.scale ?? selectedDetail.scale);
      const [cx, cy] = freeSpot(R, selectedDetail.id); p = { ...patch, cx, cy };
    }
    change({ ...edits, details: edits.details.map(d => d === selectedDetail ? { ...d, ...p } : d) });
  }
  async function markReviewed(reviewed: boolean) {
    if (dirty && !(await save())) return;
    setBusy(true);
    try { await api(`/parts/${partId}/doc-review`, 'POST', { reviewed }); setData((d: Any) => ({ ...d, doc_reviewed: reviewed })); onSaved(); }
    catch (e: Any) { setError(e.message); } finally { setBusy(false); }
  }
  async function setTemplate(v: string) {
    if (dirty && !(await save())) return;
    setBusy(true); setError('');
    try {
      const isTpl = (data.drawing_templates || []).some((t: Any) => t.id === v);
      await api(`/revisions/${data.revision_id}/parts/drawing-options`, 'POST', { ids: [partId], template_id: isTpl ? v : '', size: isTpl ? '' : v });
      await waitForRegeneration(); onSaved();
    } catch (e: Any) { setError(e.message); } finally { setBusy(false); }
  }
  return <div className="fixed inset-0 z-50 flex bg-black/60 p-3"><section className="flex size-full flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-pop" role="dialog" aria-modal="true" aria-label="Drawing editor">
    <header className="flex items-center justify-between gap-3 border-b bg-card px-4 py-2 max-lg:flex-wrap"><div className="min-w-0"><div className="truncate text-sm font-semibold">{data?.name || 'Drawing editor'}</div><small className="mt-0.5 block text-xs text-muted-foreground">{data ? (data.editable ? 'STEP-linked drawing · ' + (dirty ? 'Unsaved changes' : 'Saved') : 'Read-only drawing') : 'Loading drawing…'}{data && (data.doc_reviewed ? ' · Reviewed' : ' · Not reviewed')}</small></div>
      <nav className="flex items-center gap-1 max-lg:flex-wrap"><Button variant="ghost" size="icon-sm" onClick={undo} disabled={!writable || !past.length} title="Undo"><Undo2 /></Button><Button variant="ghost" size="icon-sm" onClick={redo} disabled={!writable || !future.length} title="Redo"><Redo2 /></Button>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <Button variant="ghost" size="sm" disabled={!writable} onClick={() => { const id = 'note:' + crypto.randomUUID(); change({ ...edits, notes: [...edits.notes, { id, page, x: 150, y: sheet.height - 180, text: 'Manufacturing note', size: 10 }] }); select(id); }}><Plus />Note</Button>
        {hiddenViews.length > 0 && <Button variant="ghost" size="sm" disabled={!writable} className={toolOn(allHiddenShown)} title={allHiddenShown ? 'Hide the dashed hidden edges (holes, pockets behind faces) in every view' : 'Show the dashed hidden edges in every view'} onClick={() => setHiddenLines(hiddenViews, !allHiddenShown)}>{allHiddenShown ? <Eye /> : <EyeOff />}Hidden lines</Button>}
        <Button variant="ghost" size="sm" disabled={!writable} className={toolOn(detailMode)} title="Detail view: click a crowded area of a view to enlarge it (ISO 128-3)" onClick={() => setDetailMode(!detailMode)}><ScanSearch />Detail</Button>
        <Button variant="ghost" size="sm" className={toolOn(showBalloons)} title="Inspection balloons: every dimension and note numbered; click one to mark it critical or set its limits" onClick={() => setShowBalloons(!showBalloons)}><Hexagon />Balloons</Button>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <Button variant="ghost" size="icon-sm" onClick={() => setZoom(z => Math.max(.25, +(z - .2).toFixed(2)))} aria-label="Zoom out"><ZoomOut /></Button><Button variant="ghost" size="sm" className="min-w-[58px] tabular-nums" title="Reset to 100% (pinch or Ctrl/⌘ + scroll to zoom)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button><Button variant="ghost" size="icon-sm" onClick={() => setZoom(z => Math.min(8, +(z + .2).toFixed(2)))} aria-label="Zoom in"><ZoomIn /></Button>
        <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-5" />
        <Button variant="outline" size="sm" onClick={save} disabled={!writable || !dirty}><Save />Save</Button>
        {data?.can_review && (data.doc_reviewed
          ? <Button variant="outline" size="sm" className={toolOn(true)} disabled={busy} title={`Reviewed by ${data.doc_reviewed_by}`} onClick={() => markReviewed(false)}><CheckCircle2 />Reviewed</Button>
          : <Button size="sm" disabled={busy} title="Save the arrangement and record that this drawing was reviewed" onClick={() => markReviewed(true)}><Circle />Mark reviewed</Button>)}<Button variant="outline" size="sm" onClick={exportPdf} disabled={!data || busy}><Download />Export PDF</Button><Button variant="ghost" size="icon-sm" onClick={closeEditor} aria-label="Close drawing editor"><X /></Button></nav>
    </header>
    {error && <div className="border-b border-destructive/20 bg-danger-soft px-4 py-2 text-sm text-destructive" role="alert">{error}</div>}
    {data && <div className="flex min-h-0 flex-1"><aside className="flex w-[150px] shrink-0 flex-col gap-2 overflow-auto border-r bg-card px-2.5 py-4 lg:w-[216px]">
        <div className={eyebrow}>Sheets</div>
        <div className="flex flex-col gap-1">{order.map((pi, i) => { const pg = pages[pi]; const added = pi >= baseCount; return (
          <div key={pi} className={cn('flex cursor-pointer items-center gap-1.5 rounded-md border bg-card px-1.5 py-1 text-xs select-none hover:border-input [&.drop]:ring-2 [&.drop]:ring-primary', page === pi && 'border-primary/40 bg-selection font-medium text-selection-foreground hover:border-primary/40')} draggable={!!writable} onClick={() => { setPage(pi); select(''); }}
            onDragStart={e => { e.dataTransfer.setData('application/x-forge-sheet', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
            onDragOver={e => { if (writable && e.dataTransfer.types.includes('application/x-forge-sheet')) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }}
            onDragLeave={e => e.currentTarget.classList.remove('drop')}
            onDrop={e => { e.currentTarget.classList.remove('drop'); const from = Number(e.dataTransfer.getData('application/x-forge-sheet')); if (Number.isFinite(from)) dropSheet(from, i); }}>
            <GripVertical className="size-3 shrink-0 cursor-grab text-faint" /><FileText className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">Sheet {i + 1}</span><span className="rounded bg-muted px-1 text-2xs font-normal text-muted-foreground">{pg ? sheetName(pg.width) : ''}</span>
            {added && writable && <Button type="button" variant="ghost" size="icon-xs" className="size-[18px] text-muted-foreground" title="Remove this added sheet (its views go back)" onClick={e => { e.stopPropagation(); removeSheet(pi); }}><X /></Button>}
          </div>); })}</div>
        {writable && <div className="flex gap-1.5"><Select size="sm" className="w-16 shrink-0" value={newSize} onChange={setNewSize} aria-label="New sheet size" options={['A4', 'A3', 'A2'].map(v => ({ value: v, label: v }))} /><Button type="button" variant="outline" size="sm" className="min-w-0 flex-1" onClick={() => addSheet(newSize)}><Plus />New sheet</Button></div>}
        {data.editable && <Field label="Sheet template (regenerates)" className="mt-1">
          <Select size="sm" value={data.drawing_options?.template_id || data.drawing_options?.size || ''} disabled={busy} onChange={v => setTemplate(v)}
            options={[{ value: '', label: 'Project default' }, { value: 'A4', label: 'A4 landscape' }, { value: 'A3', label: 'A3 landscape' }, { value: 'A2', label: 'A2 landscape' }, ...(data.drawing_templates || []).map((t: Any) => ({ value: t.id, label: t.name }))]} /></Field>}
        <p className={noteCls}>Drag sheets to reorder. Drag views, dimensions or callouts on the sheet; leaders stay attached to their feature.</p>
        <div className={cn(eyebrow, 'mt-3')}>Views</div><p className={noteCls}>Drag a view onto the sheet, or press + to add it at the centre.</p>
        <div className="grid grid-cols-1 gap-1.5 lg:grid-cols-2">{palette.map((pr: Any) => <div key={pr.preset} className="relative grid cursor-grab justify-items-center gap-0.5 rounded-lg border bg-white p-1 pb-1.5 select-none hover:border-primary active:cursor-grabbing dark:bg-zinc-200" draggable={!!writable} title={pr.label}
          onDragStart={e => { e.dataTransfer.setData('application/x-forge-view', JSON.stringify(pr)); e.dataTransfer.effectAllowed = 'copy'; }}>
          <ViewThumb partId={partId} az={pr.azimuth} el={pr.elevation} /><span className="text-center text-2xs leading-tight text-zinc-500 dark:text-zinc-700">{pr.label.replace('Isometric - ', 'Iso · ')}</span>
          <Button type="button" variant="ghost" size="icon-xs" className="absolute top-0.5 right-0.5 text-zinc-600 hover:bg-black/5 hover:text-zinc-900 dark:hover:bg-black/10 dark:hover:text-zinc-900" disabled={!writable} aria-label={'Add ' + pr.label} onClick={() => placeView(pr)}><Plus /></Button></div>)}</div>
        <div className="grid grid-cols-2 gap-1.5"><Field label="Azimuth °"><Input className="h-7 px-2 text-xs" type="number" step="15" value={customAz} onChange={e => setCustomAz(Number(e.target.value) || 0)} /></Field><Field label="Elevation °"><Input className="h-7 px-2 text-xs" type="number" step="5" min="-89" max="89" value={customEl} onChange={e => setCustomEl(Math.max(-89, Math.min(89, Number(e.target.value) || 0)))} /></Field></div>
      </aside>
      <main className={cn('min-w-0 flex-1 overflow-auto overscroll-contain bg-viewer p-7 [touch-action:pan-x_pan-y]', panning && 'cursor-grab! [&_*]:cursor-grab!')} ref={paper} onPointerDownCapture={e => { if (panStart(e)) setMenu(null); }} onPointerMove={e => { panMove(e); }} onPointerUp={() => panEnd()} onAuxClick={e => e.preventDefault()} onContextMenu={e => e.preventDefault()}><svg ref={svg} data-drawing-paper="" className="block max-w-none shrink-0 touch-none bg-white shadow-[0_4px_20px_rgb(29_41_59/0.14)] select-none" viewBox={`0 0 ${sheet.width} ${sheet.height}`} style={{ width: `${sheet.width * zoom}px`, height: `${sheet.height * zoom}px` }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onPointerDown={e => { setMenu(null); if (e.button !== 0) return; if (detailMode && writable) addDetail(e); else select(''); }} onDragOver={e => { if (writable) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }} onDrop={drop}>
        <defs><marker id="goat-arrow" viewBox="0 0 10 6" refX="0" refY="3" markerUnits="userSpaceOnUse" markerWidth={3.3 * MM} markerHeight={1.0 * MM} orient="auto-start-reverse"><path d="M 10 0 L 0 3 L 10 6 Z" fill="#111" /></marker><marker id="drawing-arrow" viewBox="0 0 10 6" refX="0" refY="3" markerUnits="userSpaceOnUse" markerWidth={3 * 72 / 25.4} markerHeight={1.8 * 72 / 25.4} orient="auto-start-reverse"><path d="M 10 0 L 0 3 L 10 6 Z" fill="#111" /></marker></defs>
        <g transform={`translate(0 ${sheet.height}) scale(1 -1)`}>
          {shown.map((g: Any) => {
            const [dx, dy] = offset(g, groups, edits); const chosen = selected === g.id; const movable = ['view', 'callout'].includes(g.kind); const props = { onPointerDown: (e: React.PointerEvent) => start(e, g.id), onContextMenu: (e: React.MouseEvent) => openMenu(e, g.id), onDoubleClick: () => { if (g.kind === 'callout') setTimeout(() => (document.querySelector('[data-drawing-properties] textarea') as HTMLTextAreaElement | null)?.focus(), 0); }, style: { cursor: writable ? 'move' : 'pointer' } };
            if (g.kind === 'dim') {
              const [px, py] = groups[g.parent] ? offset(groups[g.parent], groups, edits) : [0, 0];
              const dprops = { ...props, onDoubleClick: () => setTimeout(() => (document.querySelector('[data-drawing-properties] input[aria-label="Dimension text"]') as HTMLInputElement | null)?.select(), 0) };
              return <g key={g.id} data-drawing-id={g.id} opacity={hiddenAncestor(g) ? .18 : 1} transform={`translate(${px} ${py})`}><DimGroup g={g} e={edits.objects[g.id] || {}} chosen={chosen} handlers={dprops} /></g>;
            }
            if (g.kind === 'callout' && g.style === 'goat') {
              const lines = (edits.objects[g.id]?.text ?? g.lines.join('\n')).split('\n');
              const [px, py] = groups[g.parent] ? offset(groups[g.parent], groups, edits) : [0, 0];
              return <g key={g.id} data-drawing-id={g.id} opacity={hiddenAncestor(g) ? .18 : 1}><GoatCallout g={g} lines={lines} dx={dx} dy={dy} px={px} py={py} chosen={chosen} handlers={props} flip={!!edits.objects[g.id]?.flip} onFlip={e => flipArrow(e, g.id)} /></g>;
            }
            if (g.kind === 'callout') {
              const lines = (edits.objects[g.id]?.text ?? g.lines.join('\n')).split('\n'); const size = g.size || 7.5; const [x0, , , y1] = g.bounds; const x1 = x0 + Math.max(...lines.map((l: string) => textWidth(l, size))) + 6, y0 = y1 - lines.length * 10 - 3;
              const [px, py] = groups[g.parent] ? offset(groups[g.parent], groups, edits) : [0, 0]; const ax = g.anchor[0] + px, ay = g.anchor[1] + py;
              const ex = Math.max(x0 + dx, Math.min(ax, x1 + dx)), ey = Math.max(y0 + dy, Math.min(ay, y1 + dy));
              const fl = !!edits.objects[g.id]?.flip, ln = Math.hypot(ex - ax, ey - ay) || 1, ext = 4.5 * MM;
              return <g key={g.id} data-drawing-id={g.id} opacity={hiddenAncestor(g) ? .18 : 1}><line x1={ax} y1={ay} x2={ex} y2={ey} stroke="#111" strokeWidth=".4" markerStart={fl ? undefined : 'url(#drawing-arrow)'} pointerEvents="none" />
                {fl && <line x1={ax} y1={ay} x2={ax - (ex - ax) / ln * ext} y2={ay - (ey - ay) / ln * ext} stroke="#111" strokeWidth=".4" markerStart="url(#drawing-arrow)" pointerEvents="none" />}
                <ArrowHandle x={ax} y={ay} chosen={chosen} onFlip={e => flipArrow(e, g.id)} />
                <g transform={`translate(${dx} ${dy})`} {...props}><rect className="dwg-hit" x={x0 - 2} y={y0 - 2} width={x1 - x0 + 4} height={y1 - y0 + 4} fill={chosen ? '#e4f0ff' : 'transparent'} stroke={chosen ? '#2470e8' : 'none'} strokeWidth=".7" />{lines.map((line: string, i: number) => <text key={i} transform={`translate(${x0 + 3} ${y1 - 8.5 - i * 10}) scale(1 -1)`} fontFamily="Helvetica, Arial, sans-serif" fontSize={size}>{line}</text>)}</g></g>;
            }
            const [x0, y0, x1, y1] = bounds(g);
            return <g key={g.id} data-drawing-id={g.id} opacity={hiddenAncestor(g) ? .18 : 1} transform={`translate(${dx} ${dy})`} {...(movable ? props : { pointerEvents: 'none' as const })}>
              {movable && <rect className="dwg-hit" x={x0 - 3} y={y0 - 3} width={x1 - x0 + 6} height={y1 - y0 + 6} fill="transparent" stroke={chosen ? '#2470e8' : 'none'} strokeDasharray="3 2" strokeWidth=".7" />}
              {(g.kind === 'view' && edits.objects[g.id]?.hidden_lines === false ? g.nodes.filter((n: Any) => !isHiddenLine(n)) : g.nodes).map((n: Any, i: number) => <VectorNode key={i} n={g.kind === 'fixed' && n.type === 'text' && SHEET_RE.test(n.text) ? { ...n, text: n.text.replace(SHEET_RE, (_m: string, a: string, b: string) => `${a}${order.indexOf(page) + 1}${b}${order.length}`) } : n} />)}</g>;
          })}
          {edits.views.filter(v => v.page === page && v.lines).map(v => {
            const cx = (v.lo[0] + v.hi[0]) / 2, cy = (v.lo[1] + v.hi[1]) / 2, k = v.scale * MM; const chosen = selected === v.id;
            const w = (v.hi[0] - v.lo[0]) * k, h = (v.hi[1] - v.lo[1]) * k;
            return <g key={v.id} data-drawing-id={v.id} onPointerDown={e => start(e, v.id)} style={{ cursor: writable ? 'move' : 'pointer' }} transform={`translate(${v.cx} ${v.cy}) rotate(${v.roll || 0})`}>
              <rect x={-w / 2 - 4} y={-h / 2 - 4} width={w + 8} height={h + 8} fill="transparent" stroke={chosen ? '#2470e8' : 'none'} strokeDasharray="3 2" strokeWidth=".7" />
              <g transform={`scale(${k}) translate(${-cx} ${-cy})`}><path d={picPath(v.lines)} fill="none" stroke="#000" strokeWidth={.25 * MM} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /></g>
              {v.caption && <text transform={`rotate(${-(v.roll || 0)}) translate(0 ${-Math.max(w, h) / 2 - 14}) scale(1 -1)`} textAnchor="middle" fontSize="8" fontFamily="Helvetica, Arial, sans-serif">{`${v.label.toUpperCase()}  (${scaleText(v.scale)})`}</text>}
            </g>;
          })}
          {edits.details.filter(d => groups[d.view] && pageOf(groups[d.view]) === page).map(d => {
            const vg = groups[d.view]; if (!vg) return null; const [dx, dy] = offset(vg, groups, edits); const chosen = selectedDetail === d;
            return <g key={'m' + d.id} onPointerDown={e => start(e, 'marker:' + d.id)} style={{ cursor: writable ? 'move' : 'pointer' }}>
              <circle cx={d.x + dx} cy={d.y + dy} r={d.r} fill="transparent" stroke={chosen ? '#2563eb' : '#111'} strokeWidth={.18 * MM} />
              <text transform={`translate(${d.x + dx + d.r * .72 + 1.5 * MM} ${d.y + dy + d.r * .72 + 1.5 * MM}) scale(1 -1)`} fontSize={3.5 * MM} fontWeight="700" fontFamily="Helvetica, Arial, sans-serif">{d.label}</text></g>;
          })}
          {edits.details.filter(d => d.target_page === page).map(d => {
            const vg = groups[d.view]; if (!vg) return null;
            const R = d.r * d.scale; const chosen = selectedDetail === d; const base = (vg.scale_used || data.scene.frame?.scale || 1) * d.scale;
            return <g key={'d' + d.id} onPointerDown={e => start(e, 'detail:' + d.id)} style={{ cursor: writable ? 'move' : 'pointer' }}>
              <defs><clipPath id={'clip-' + d.id}><circle cx={d.cx} cy={d.cy} r={R} /></clipPath></defs>
              <circle cx={d.cx} cy={d.cy} r={R} fill={chosen ? '#eff4ff' : 'white'} stroke={chosen ? '#2563eb' : '#111'} strokeWidth={.18 * MM} />
              {(() => { const kids = Object.values(groups).filter((c: Any) => c.parent === vg.id && !edits.objects[c.id]?.hidden); const plan = detailPlan(d, vg, kids, edits.objects);
                return <><g clipPath={`url(#clip-${d.id})`}><g transform={`translate(${d.cx} ${d.cy}) scale(${d.scale}) translate(${-d.x} ${-d.y})`}>{plan.scaled.map((n: Any, i: number) => <VectorNode key={i} n={{ ...n, width: n.width / d.scale, dash: (n.dash || []).map((x: number) => x / d.scale) }} />)}</g></g>
                  {plan.moved.map(([n, mx, my], i) => <g key={'mv' + i} transform={`translate(${mx} ${my})`}><VectorNode n={n} /></g>)}
                  {plan.calls.map(([g, cdx, cdy, cpx, cpy]) => { const t = edits.objects[g.id]?.text; return <GoatCallout key={g.id} g={{ ...g, radius: (g.radius || 0) * d.scale }} lines={(t ?? g.lines.join('\n')).split('\n')} dx={cdx} dy={cdy} px={cpx} py={cpy} />; })}</>; })()}
              <text transform={`translate(${d.cx} ${d.cy - R - 5 * MM}) scale(1 -1)`} textAnchor="middle" fontSize={3.5 * MM * .72} fontFamily="Helvetica, Arial, sans-serif">{`DETAIL ${d.label} (${scaleText(base)})`}</text></g>;
          })}
          {edits.notes.filter(n => n.page === page).map(n => <g key={n.id} data-drawing-id={n.id} onPointerDown={e => start(e, n.id)} onContextMenu={e => openMenu(e, n.id)} style={{ cursor: writable ? 'move' : 'pointer' }}>
            <rect x={n.x - 3} y={n.y - (n.text.split('\n').length - 1) * 12 - 3} width={Math.max(...n.text.split('\n').map((l: string) => textWidth(l, n.size))) + 6} height={n.text.split('\n').length * 12 + 3} fill={selected === n.id ? '#e4f0ff' : 'transparent'} stroke={selected === n.id ? '#2470e8' : 'none'} />
            {n.text.split('\n').map((line: string, i: number) => <text key={i} transform={`translate(${n.x} ${n.y - i * 12}) scale(1 -1)`} fontSize={n.size} fontFamily="Helvetica, Arial, sans-serif">{line}</text>)}</g>)}
          {showBalloons && plan?.chars?.filter((c: Any) => (c.sg && groups[c.sg] ? pageOf(groups[c.sg]) : c.page) === page).map((c: Any) => {
            const [ox, oy] = c.sg && groups[c.sg] ? offset(groups[c.sg], groups, edits) : [0, 0];
            const bx = c.balloon[0] + ox + (c.dx || 0), by = c.balloon[1] + oy + (c.dy || 0), r = c.balloon_r;
            const [x0, y0, x1, y1] = [c.rect[0] + ox, c.rect[1] + oy, c.rect[2] + ox, c.rect[3] + oy];
            const chosen = selected === 'balloon:' + c.id;
            if (!c.selected) {
              // candidate: a faint "+" — click to inspect this dimension / note
              return <g key={'b' + c.id} className="dwg-balloon dwg-balloon-candidate" style={{ cursor: plan.editable ? 'copy' : 'pointer' }} onPointerDown={e => { e.stopPropagation(); if (e.button !== 0) return; select('balloon:' + c.id);
                if (plan.editable) api(`/parts/${partId}/characteristics`, 'PUT', { keys: c.reqs.map((q: Any) => q.key), inspect: true }).then(loadPlan).catch((er: Any) => setError(er.message)); }}>
                <rect x={x0 - 1} y={y0 - 1} width={x1 - x0 + 2} height={y1 - y0 + 2} fill="transparent" stroke={chosen ? '#1f5fd6' : '#c5d6f2'} strokeWidth=".5" />
                <circle cx={bx} cy={by} r={r * .7} fill="#fff" stroke="#9aa6b8" strokeWidth={.15 * MM} strokeDasharray="1.5 1" />
                <text transform={`translate(${bx} ${by - r * .3}) scale(1 -1)`} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={r * .9} fill="#9aa6b8">+</text>
                <title>Click to inspect: {c.text}</title></g>;
            }
            const nx = Math.max(x0, Math.min(bx, x1)), ny = Math.max(y0, Math.min(by, y1)), d = Math.hypot(nx - bx, ny - by) || 1;
            const kc = c.reqs.some((q: Any) => q.critical), col = kc ? '#c0392b' : '#1f5fd6';
            const hex = Array.from({ length: 6 }, (_, k) => { const a = Math.PI / 6 + k * Math.PI / 3; return `${bx + r * 1.12 * Math.cos(a)},${by + r * 1.12 * Math.sin(a)}`; }).join(' ');
            return <g key={'b' + c.id} className="dwg-balloon" style={{ cursor: plan.editable ? 'move' : 'pointer' }}
              onPointerDown={e => { e.stopPropagation(); if (e.button !== 0) return; select('balloon:' + c.id); if (plan.editable) { const [x, y] = position(e); balloonDrag.current = { n: c.id, x, y, dx: c.dx || 0, dy: c.dy || 0 }; svg.current!.setPointerCapture(e.pointerId); } }}>
              {c.source.endsWith('_table') ? null : d > r + .5 && <line x1={bx + (nx - bx) / d * r} y1={by + (ny - by) / d * r} x2={nx} y2={ny} stroke={col} strokeWidth={.18 * MM} />}
              {kc ? <polygon points={hex} fill={chosen ? '#fde2e2' : '#fff'} stroke={col} strokeWidth={.18 * MM * (chosen ? 2 : 1)} /> : <circle cx={bx} cy={by} r={r} fill={chosen ? '#e4f0ff' : '#fff'} stroke={col} strokeWidth={.18 * MM * (chosen ? 2 : 1)} />}
              <text transform={`translate(${bx} ${by - r * .36}) scale(1 -1)`} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={r * (String(c.number).length < 3 ? 1 : .8)} fill={col}>{c.number}</text></g>;
          })}
        </g></svg>
        {menu && (() => { const mg = groups[menu.id]; const mo = edits.objects[menu.id] || {}; const isNote = edits.notes.some(n => n.id === menu.id);
          const item = (label: string, fn: () => void, disabled = !writable) => <Button type="button" variant="ghost" size="sm" role="menuitem" className="h-7 justify-start px-2.5 text-sm font-normal" disabled={disabled} onClick={() => { setMenu(null); fn(); }}>{label}</Button>;
          return <div className="fixed z-50 grid min-w-52 gap-px rounded-lg border bg-popover p-1 text-popover-foreground shadow-pop" role="menu" style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}>
            {mg?.kind === 'callout' && <>{item(mo.flip ? 'Arrow outside → inside' : 'Flip arrow (inside / outside)', () => toggleFlag(menu.id, 'flip'))}{item('Edit text…', () => setTimeout(() => (document.querySelector('[data-drawing-properties] textarea') as HTMLTextAreaElement | null)?.focus(), 0), false)}</>}
            {mg?.kind === 'dim' && <>{item('Edit dimension text…', () => setTimeout(() => (document.querySelector('[data-drawing-properties] input[aria-label="Dimension text"]') as HTMLInputElement | null)?.select(), 0), false)}{item('Reset text & size', () => { const next = clone(edits); const o: Any = { ...(next.objects[menu.id] || {}) }; delete o.text; delete o.size; if (Object.keys(o).length) next.objects[menu.id] = o; else delete next.objects[menu.id]; change(next); }, !writable || (mo.text == null && mo.size == null))}</>}
            {mg && ['view', 'callout', 'dim'].includes(mg.kind) && <>{item(mo.hidden ? 'Show' : 'Hide', () => toggleFlag(menu.id, 'hidden'))}{item('Reset position', () => resetPosition(menu.id), !writable || !(mo.dx || mo.dy))}</>}
            {mg?.kind === 'view' && mg.nodes?.some(isHiddenLine) && item(mo.hidden_lines === false ? 'Show hidden lines' : 'Hide hidden lines', () => setHiddenLines([menu.id], mo.hidden_lines === false))}
            {isNote && item('Delete note', deleteSelected)}
            <small className="mt-1 border-t px-2.5 pt-1.5 pb-0.5 text-2xs text-muted-foreground">Arrows nudge · Del hides · Esc deselects · F fits</small>
          </div>; })()}
      </main>
      <aside data-drawing-properties="" className="flex w-[230px] shrink-0 flex-col gap-3 overflow-auto border-l bg-card p-4 lg:w-72"><h3 className="text-base font-semibold">{selected.startsWith('balloon:') ? (() => { const c = plan?.chars.find((c: Any) => 'balloon:' + c.id === selected); return c?.number ? `Balloon ${c.number}` : 'Not inspected'; })() : selectedDetail ? `Detail ${selectedDetail.label}` : group?.kind === 'callout' ? 'Hole / feature callout' : group?.kind === 'dim' ? (group.axis === 'angle' ? 'Angle dimension' : 'Ordinate dimension') : group?.kind === 'view' ? group.title + ' view' : note ? 'Drawing note' : 'Drawing properties'}</h3>
        {selected.startsWith('balloon:') && plan && (() => { const c = plan.chars.find((c: Any) => 'balloon:' + c.id === selected); if (!c) return null;
          const putChar = async (q: Any, body: Any) => { try { await api(`/parts/${partId}/characteristics/${q.key}`, 'PUT', body); await loadPlan(); setError(''); } catch (e: Any) { setError(e.message); } };
          const putBalloon = async (b: Any) => { try { await api(`/parts/${partId}/balloons/${c.id}`, 'PUT', { dx: c.dx || 0, dy: c.dy || 0, ...b }); await loadPlan(); } catch (e: Any) { setError(e.message); } };
          return <div className="grid gap-2.5">
            <small className={hintCls}>Zone {c.zone} · sheet {c.page + 1} · “{c.text}”</small>
            {c.reqs.map((q: Any) => <div key={q.key} className={cn('grid gap-2 rounded-lg border p-2.5', q.critical && 'border-destructive/40 bg-danger-soft')}>
              <CheckRow checked={!!q.inspect} disabled={!plan.editable} onChange={v => putChar(q, { inspect: v })}><span className="font-medium">{q.no ? q.no + ' · ' : ''}{q.label}{q.qty > 1 ? ` (${q.qty}×)` : ''}</span></CheckRow>
              {q.nominal === null ? <small className={hintCls}>Attribute check (pass / fail, gauge)</small> : <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <Field label="Lower"><Input key={'l' + q.lower} defaultValue={q.lower ?? ''} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v !== q.lower) putChar(q, { lower: v, upper: q.upper }); }} /></Field>
                <span className="pb-1.5 font-medium tabular-nums">{q.nominal}</span>
                <Field label="Upper"><Input key={'u' + q.upper} defaultValue={q.upper ?? ''} disabled={!plan.editable} onBlur={e => { const v = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(v) && v !== q.upper) putChar(q, { lower: q.lower, upper: v }); }} /></Field></div>}
              <small className={hintCls}>{q.basis}{q.basis === 'specified' && plan.editable && <> · <Button variant="link" size="xs" className="h-auto p-0 text-xs font-normal" onClick={() => putChar(q, { reset_limits: true })}>use general tolerance</Button></>}</small>
              <CheckRow checked={!!q.critical} disabled={!plan.editable} onChange={v => putChar(q, { critical: v })}>Critical (KC) — measured on every part</CheckRow>
              <Field label="Method / gauge"><Input key={'m' + q.method} defaultValue={q.method} disabled={!plan.editable} placeholder="e.g. CMM, pin gauge, thread gauge" onBlur={e => { if (e.target.value !== (q.method || '')) putChar(q, { method: e.target.value }); }} /></Field>
            </div>)}
            {plan.editable && <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={!c.selected} onClick={() => api(`/parts/${partId}/characteristics`, 'PUT', { keys: c.reqs.map((q: Any) => q.key), inspect: false }).then(loadPlan).catch((e: Any) => setError(e.message))}>Don't inspect</Button><Button type="button" variant="outline" size="sm" disabled={!c.dx && !c.dy} onClick={() => putBalloon({ dx: 0, dy: 0 })}>Reset position</Button></div>}
            <small className={hintCls}>Tick what is checked; unticked dimensions get no balloon. Grey “+” marks on the sheet add a dimension. Hexagon = critical. Saves immediately; the ballooned copy is the “Inspection drawing” PDF.</small>
          </div>; })()}
        {showBalloons && plan?.error && <div className="rounded-md bg-danger-soft px-3 py-2 text-xs text-destructive">{plan.error}</div>}
        {selectedDetail && <div className="grid gap-3">
          <Field label="Label"><Select value={selectedDetail.label} disabled={!writable} onChange={v => detailPatch({ label: v, id: v })} options={[...DETAIL_LETTERS].filter(l => l === selectedDetail.label || !edits.details.some(d => d.label === l)).map(l => ({ value: l, label: l }))} /></Field>
          {(() => { const vg = groups[selectedDetail.view]; const base = vg?.scale_used || data.scene.frame?.scale || 1; return <>
            <Field label="Enlargement (%)"><Input type="number" min={105} max={2000} step={5} disabled={!writable} value={Math.round(selectedDetail.scale * 100)} onChange={e => { const v = Number(e.target.value) / 100; if (Number.isFinite(v) && v >= 1.05 && v <= 20) detailPatch({ scale: v }); }} /></Field>
            <div className="flex flex-wrap gap-1.5">{DETAIL_SCALES.map(v => <Button type="button" variant="outline" size="xs" key={v} disabled={!writable} className={chipCls(Math.abs(selectedDetail.scale - v) < 1e-6)} onClick={() => detailPatch({ scale: v })}>{v * 100}%</Button>)}</div>
            <Field label="Detail scale (on paper)"><Input type="text" disabled={!writable} defaultValue={scaleText(base * selectedDetail.scale)} key={selectedDetail.id + selectedDetail.scale}
              onBlur={e => { const m = e.target.value.trim().match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/); if (!m) return; const abs = Number(m[1]) / Number(m[2]); const k = abs / base; if (k >= 1.05 && k <= 20) detailPatch({ scale: Math.round(k * 1000) / 1000 }); else setError(`That scale is ${Math.round(k * 100)} % of the sheet scale; use 105–2000 %.`); }} />
              <small className={cn(hintCls, 'font-normal')}>Sheet scale {scaleText(base)} · type e.g. 2:1 or 5:1</small></Field></>; })()}
          <Field label="Circle radius (mm)"><Input type="number" min={3} max={60} step={1} disabled={!writable} value={Math.round(selectedDetail.r / MM)} onChange={e => detailPatch({ r: Math.max(3, Math.min(60, Number(e.target.value) || 10)) * MM })} /></Field>
          <Field label="Place on sheet"><Select value={String(selectedDetail.target_page)} disabled={!writable} onChange={v => detailPatch({ target_page: Number(v) })} options={order.map((pi, i) => ({ value: String(pi), label: `Sheet ${i + 1}` }))} /></Field>
          <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={!writable} onClick={() => { change({ ...edits, details: edits.details.filter(d => d !== selectedDetail) }); select(''); }}><Trash2 />Remove detail</Button>
          <small className={hintCls}>Drag the circle on the view to choose the area; drag the enlarged view to place it. The detail shows the part geometry; add dimensions as notes if needed.</small>
        </div>}
        {!group && !note && !selectedView && !selectedDetail && !selected.startsWith('balloon:') && <><p className={hintCls}>Select a view, dimension, callout or note on the sheet, or drag another view from the Views palette. Measured geometry remains linked to the STEP; drawing text records your manufacturing intent.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs [&_dd]:text-muted-foreground [&_dt]:font-medium [&_dt]:whitespace-nowrap"><dt>Drag a dimension value</dt><dd>move it (leader follows)</dd><dt>Double-click a value</dt><dd>edit dimension text</dd><dt>Click arrowhead</dt><dd>flip arrow inside / outside</dd><dt>Right-click</dt><dd>flip, hide, reset</dd><dt>Arrow keys</dt><dd>nudge (Shift ×10)</dd><dt>Delete</dt><dd>hide callout / view, delete note</dd><dt>Middle drag / Space drag</dt><dd>pan</dd><dt>Ctrl/⌘ scroll, pinch</dt><dd>zoom</dd><dt><Kbd>F</Kbd></dt><dd>fit sheet</dd><dt><Kbd>Esc</Kbd></dt><dd>deselect</dd><dt>⌘/Ctrl Z · Y · S</dt><dd>undo · redo · save</dd></dl></>}
        {selectedView && <div className="grid gap-3">
          <Field label="Name"><Input value={selectedView.label} maxLength={80} disabled={!writable} onChange={e => viewPatch({ label: e.target.value })} /></Field>
          <Field label="Scale"><Select value={String(selectedView.scale)} disabled={!writable} onChange={v => viewPatch({ scale: Number(v) })} options={[...(!SCALE_OPTIONS.some(([, v]) => Math.abs(v - selectedView.scale) < 1e-6) ? [{ value: String(selectedView.scale), label: scaleText(selectedView.scale) }] : []), ...SCALE_OPTIONS.map(([t, v]) => ({ value: String(v), label: t }))]} /></Field>
          <div className="grid grid-cols-3 gap-1.5">
            <Field label="Azimuth °"><Input className="px-2" type="number" step="15" disabled={!writable} value={Math.round(selectedView.azimuth * 10) / 10} onChange={e => viewAngles(Number(e.target.value), selectedView.elevation)} /></Field>
            <Field label="Elevation °"><Input className="px-2" type="number" step="5" min="-89" max="89" disabled={!writable} value={Math.round(selectedView.elevation * 10) / 10} onChange={e => viewAngles(selectedView.azimuth, Number(e.target.value))} /></Field>
            <Field label="Rotate °"><Input className="px-2" type="number" step="15" disabled={!writable} value={selectedView.roll || 0} onChange={e => viewPatch({ roll: Number(e.target.value) || 0 })} /></Field>
          </div>
          <div className="flex flex-wrap items-center gap-3"><Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => viewPatch({ roll: ((selectedView.roll || 0) + 90) % 360 })}><RotateCcw />Rotate 90°</Button>
            <CheckRow disabled={!writable} checked={!!selectedView.caption} onChange={v => viewPatch({ caption: v })}>Caption</CheckRow></div>
          <Button type="button" variant="outline" size="sm" className="justify-self-start" disabled={!writable} onClick={() => { change({ ...edits, views: edits.views.filter(v => v.id !== selected) }); select(''); }}><Trash2 />Remove view</Button>
          <small className={hintCls}>Azimuth turns about the vertical axis (0 = front, 90 = right side); elevation looks from above (+) or below (−); rotate spins the view on the sheet.</small>
        </div>}
        {group?.kind === 'view' && <>{!group.parent && <Field label="Sheet"><Select value={String(pageOf(group))} disabled={!writable} onChange={v => moveViewTo(Number(v))} options={order.map((pi, i) => ({ value: String(pi), label: `Sheet ${i + 1}${pi >= baseCount ? ' (added)' : ''}` }))} /></Field>}
          <p className={hintCls}>Drag this view to reposition it. Attached callouts follow. Dimensions and geometry stay at the source scale. Move it to another sheet (e.g. a new one) to give it room for details.</p><Button variant="outline" size="sm" className="self-start" disabled={!writable} onClick={() => { const next = clone(edits); const { hidden, hidden_lines } = next.objects[selected] || {}; delete next.objects[selected]; const keep: Any = {}; if (hidden) keep.hidden = hidden; if (hidden_lines === false) keep.hidden_lines = false; if (Object.keys(keep).length) next.objects[selected] = keep; change(next); }}><RotateCcw />Reset position</Button>
          {group.nodes.some(isHiddenLine) && <CheckRow disabled={!writable} checked={edits.objects[selected]?.hidden_lines !== false} onChange={v => setHiddenLines([selected], v)}>Show hidden lines (dashed edges behind faces)</CheckRow>}
          <Button variant="outline" size="sm" className="self-start" disabled={!writable} onClick={() => { const next = clone(edits); const o: Any = { ...(next.objects[selected] || {}) }; if (o.hidden) delete o.hidden; else o.hidden = true; if (Object.keys(o).length) next.objects[selected] = o; else delete next.objects[selected]; change(next); }}>{edits.objects[selected]?.hidden ? 'Show view' : 'Hide view'}</Button>
          {edits.objects[selected]?.hidden && <small className={hintCls}>Hidden views (with their dimensions and callouts) are left out of the PDF.</small>}</>}
        {group?.kind === 'dim' && (() => { const o: Any = edits.objects[selected] || {}; const sz = o.size ?? 1;
          const setO = (k: string, v: Any) => { const next = clone(edits); const n: Any = { ...(next.objects[selected] || {}) }; if (v === undefined) delete n[k]; else n[k] = v; if (Object.keys(n).length) next.objects[selected] = n; else delete next.objects[selected]; change(next); };
          return <div className="grid gap-3">
            <Field label="Dimension text"><Input aria-label="Dimension text" maxLength={80} disabled={!writable} value={o.text ?? '<>'} onChange={e => setO('text', e.target.value === '<>' ? undefined : e.target.value)} /></Field>
            <small className={hintCls}>&lt;&gt; is the measured value ({group.text}); add text around it, e.g. <code className={codeCls}>&lt;&gt; TYP</code>, <code className={codeCls}>(&lt;&gt;)</code>, <code className={codeCls}>&lt;&gt; ±0.05</code>. Replacing it overrides the value on the drawing only — the inspection plan keeps the STEP value.</small>
            <div className="flex flex-wrap gap-1.5">{['<> TYP', '(<>)', '<> REF', '<> ±0.1'].map(t => <Button type="button" variant="outline" size="xs" key={t} className={chipCls(o.text === t)} disabled={!writable} onClick={() => setO('text', t)}>{t}</Button>)}</div>
            <Field label={`Text size (${Math.round(sz * 100)} %)`}><Slider className="py-1.5" min={50} max={300} step={10} disabled={!writable} value={[Math.round(sz * 100)]} onValueChange={([n]) => { const v = n / 100; setO('size', Math.abs(v - 1) < 1e-6 ? undefined : v); }} /></Field>
            <div className="flex flex-wrap gap-1.5">{[.75, 1, 1.25, 1.5, 2].map(v => <Button type="button" variant="outline" size="xs" key={v} className={chipCls(Math.abs(sz - v) < 1e-6)} disabled={!writable} onClick={() => setO('size', v === 1 ? undefined : v)}>{v * 100}%</Button>)}</div>
            <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={!writable || !(o.dx || o.dy)} onClick={() => resetPosition(selected)}>Reset position</Button>
              <Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => toggleFlag(selected, 'hidden')}>{o.hidden ? 'Show dimension' : 'Hide dimension'}</Button></div>
            <small className={hintCls}>Drag the value to move it — the extension line stays on the feature and stretches with a jog. Arrow keys nudge (Shift ×10).</small>
          </div>; })()}
        {group?.kind === 'callout' && <><Field label="Callout text"><Textarea aria-label="Callout text" className="resize-y font-mono text-xs field-sizing-fixed" rows={9} disabled={!writable} value={currentText} onChange={e => patch({ text: e.target.value })} /></Field>
          <small className={hintCls}>{edits.objects[selected]?.text !== undefined ? 'User-specified callout. Source measurements below are unchanged.' : 'Generated from STEP geometry.'}</small>
          <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="outline" size="sm" disabled={!writable} className={toolOn(!!edits.objects[selected]?.flip)} title="Arrow on the other side of the feature (or click the arrowhead on the sheet)" onClick={() => toggleFlag(selected, 'flip')}>Flip arrow</Button>
            <Button type="button" variant="outline" size="sm" disabled={!writable} onClick={() => toggleFlag(selected, 'hidden')}>{edits.objects[selected]?.hidden ? 'Show callout' : 'Hide callout'}</Button>
            <Button type="button" variant="outline" size="sm" disabled={!writable || !(edits.objects[selected]?.dx || edits.objects[selected]?.dy)} onClick={() => resetPosition(selected)}>Reset position</Button></div>
          <Button variant="outline" size="sm" className="self-start" disabled={!writable} onClick={() => { const next = clone(edits); delete next.objects[selected]; change(next); }}><RotateCcw />Reset to generated callout</Button>
          {group.measurements?.[0]?.hole_ids && <><details className={detailsCls}><summary className={summaryCls}>Thread specification</summary><div className="mt-3 grid gap-3"><p className={hintCls}>Choose only after confirming the intended thread. A bore diameter does not establish a thread or tolerance class.</p>
            <Field label="Thread"><Combo aria-label="Thread" disabled={!writable} value={thread} onChange={setThread} suggestions={['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12']} /></Field>
            <Field label="Class"><Input value={threadClass} disabled={!writable} onChange={e => setThreadClass(e.target.value)} /></Field><Field label="Thread depth (mm) or THRU"><Input aria-label="Thread depth" disabled={!writable} value={threadDepth} onChange={e => setThreadDepth(e.target.value)} /></Field>
            <Button variant="outline" size="sm" className="justify-self-start" disabled={!writable} onClick={applyThread}>Apply specified thread</Button></div></details>
            <details className={detailsCls}><summary className={summaryCls}>Fit / press-fit note</summary><div className="mt-3 grid gap-3"><Field label="Fit designation"><Input aria-label="Fit designation" placeholder="e.g. H7" value={fit} disabled={!writable} onChange={e => setFit(e.target.value)} /></Field><Field label="Manufacturing note"><Input aria-label="Fit note" placeholder="PRESS FIT FOR DOWEL" disabled={!writable} value={fitNote} onChange={e => setFitNote(e.target.value)} /></Field><Button variant="outline" size="sm" className="justify-self-start" disabled={!writable} onClick={applyFit}>Apply fit and note</Button></div></details></>}
          <details className={detailsCls} open><summary className={summaryCls}>Read-only source measurements</summary>{group.measurements?.map((m: Any, i: number) => <div className="mt-2.5 flex flex-col gap-1 rounded-md bg-subtle p-2.5 text-2xs" key={i}>{m.hole_ids ? <><span className="font-medium">{m.hole_ids.join(' + ')}</span><span>Diameter {m.diameter.toFixed(3)} mm · {m.through ? 'THRU' : `Cylindrical depth ${m.depth.toFixed(3)} mm`}</span>{m.entrances?.map((a: Any, j: number) => <span key={j}>Chamfer Ø{a.diameter.toFixed(3)} × {a.angle.toFixed(1)}°</span>)}</> : <span>Chamfer {m.length?.toFixed(3)} mm × {m.angle?.toFixed(1)}°</span>}</div>)}</details></>}
        {note && <><Field label="Note"><Textarea aria-label="Note text" className="resize-y font-mono text-xs field-sizing-fixed" rows={7} disabled={!writable} value={note.text} onChange={e => notePatch({ text: e.target.value })} /></Field><Field label="Font size"><Input type="number" min="5" max="24" disabled={!writable} value={note.size} onChange={e => notePatch({ size: Number(e.target.value) })} /></Field><Button variant="outline" size="sm" className="self-start text-destructive hover:text-destructive" disabled={!writable} onClick={() => { change({ ...edits, notes: edits.notes.filter(n => n.id !== selected) }); select(''); }}>Delete note</Button></>}
      </aside></div>}
  </section></div>;
}
