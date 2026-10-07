import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePinchZoom } from './pinchZoom';
import { X, Download, ExternalLink, LoaderCircle, Plus, Trash2, ArrowUp, ArrowDown, Check, Eye, EyeOff, Box, CheckCircle2, Circle, Ban, Minus, Undo2, Settings, Layers, Link2, Flame , Sparkles } from 'lucide-react';
import { asset, assetJson, saveBlob } from './api';
import { categories, RAL, suggestions, fmt } from './constants';
import type { Any } from './constants';
import { Select, Combo } from './controls';
import { cn } from '@/lib/utils';
import { Badge as UiBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Empty, Progress } from './shell';

/** Tooltip for an icon-only button (carries its own provider so it works anywhere). */
function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>
    </TooltipProvider>
  );
}

/** Eyebrow-titled group inside a specification form. */
function FormSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 border-b py-5 first-of-type:pt-1 last-of-type:border-b-0">
      <h3 className="text-2xs font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}
const FORM_GRID = 'grid gap-x-4 gap-y-3 sm:grid-cols-2';
/** "· will change" marker after a group-editor label. */
const Changed = ({ children }: { children: React.ReactNode }) => <span className="text-xs font-normal text-selection-foreground">{children}</span>;
const CHANGED_FIELD = '[&_input]:border-primary/40 [&_input]:bg-selection [&_textarea]:border-primary/40 [&_textarea]:bg-selection';
const GLYPH: Record<string, string> = { machining: 'bg-machining/10 text-machining', sheet_metal: 'bg-sheet/10 text-sheet', purchased: 'bg-purchased/10 text-purchased', other: 'bg-other/10 text-other' };

// ---------------------------------------------------------------------------------------------
// Small primitives
// ---------------------------------------------------------------------------------------------
const BADGE_TONES: Record<string, BadgeTone> = { success: 'success', warning: 'warning', danger: 'danger', accent: 'accent', neutral: 'neutral', welding: 'warning' };
type BadgeTone = 'success' | 'warning' | 'danger' | 'accent' | 'neutral';
/** Status pill. `kind`: success · warning · danger · accent · neutral (default). */
export function Badge({ children, kind = '', className }: { children: React.ReactNode; kind?: string; className?: string }) {
  return <UiBadge variant={BADGE_TONES[kind] || 'neutral'} className={cn('h-5 rounded-full px-2 text-2xs font-medium', className)}>{children}</UiBadge>;
}

export function Swatch({ hex, title, size = 14 }: { hex?: string; title?: string; size?: number }) {
  if (!hex) return null;
  return <span className="inline-block shrink-0 rounded-[4px] ring-1 ring-black/10 ring-inset dark:ring-white/15" title={title || hex} style={{ background: hex, width: size, height: size }} />;
}

/**
 * Dialog (shadcn). The body scrolls; put the action row in <ModalFooter> as the last child so it stays visible.
 * `wide` for editors and tables, `top` is kept for callers that stack a dialog over another (Radix layers them).
 */
export function Modal({ title, close, children, wide = false, subtitle }: { title: string; close: () => void; children: React.ReactNode; wide?: boolean; subtitle?: string; top?: boolean }) {
  return (
    <Dialog open onOpenChange={o => { if (!o) close(); }}>
      <DialogContent className={cn('flex max-h-[min(88vh,900px)] flex-col gap-0 overflow-hidden bg-card p-0', wide ? 'sm:max-w-4xl' : 'sm:max-w-lg')}
        onInteractOutside={e => { if ((e.target as HTMLElement)?.closest?.('[data-sonner-toaster], #popover-root')) e.preventDefault(); }}>
        <DialogHeader className="shrink-0 gap-1 border-b px-5 py-4 pr-12">
          <DialogTitle className="text-base font-semibold">{title}</DialogTitle>
          {subtitle ? <DialogDescription className="text-sm">{subtitle}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

/** Action row at the bottom of a Modal: stays visible while the body scrolls. Left content (a note) via `note`. */
export function ModalFooter({ children, note, className }: { children: React.ReactNode; note?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('sticky -bottom-4 z-10 -mx-5 -mb-4 mt-5 flex items-center justify-end gap-2 border-t bg-card px-5 py-3', className)}>
      {note && <div className="mr-auto min-w-0 text-xs text-muted-foreground">{note}</div>}
      {children}
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
      <div className="grid gap-4">
        <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">{parts.map(p => <Badge key={p.id} kind={p.category}>{p.name}</Badge>)}</div>
        <div className="grid gap-1.5">
          <Label htmlFor="exclude-reason">Reason</Label>
          <Textarea id="exclude-reason" autoFocus rows={3} value={reason} placeholder="Why is this part not being made in this revision?" onChange={e => setReason(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ok) onConfirm(reason.trim()); }} />
        </div>
        <div className="flex flex-wrap gap-1.5">{EXCLUDE_REASONS.map(r => <Button type="button" size="xs" variant={reason === r ? 'secondary' : 'outline'} key={r} className={cn('rounded-full font-normal', reason === r && 'bg-selection text-selection-foreground hover:bg-selection')} onClick={() => setReason(r)}>{r}</Button>)}</div>
      </div>
      <ModalFooter>
        <Button type="button" variant="outline" onClick={close}>Cancel</Button>
        <Button type="button" variant="destructive" disabled={!ok || busy} onClick={() => onConfirm(reason.trim())}><Ban />Not for production</Button>
      </ModalFooter>
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-[2vh] backdrop-blur-[2px] animate-in fade-in-0" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <section role="dialog" aria-modal="true" aria-label={title} data-slot="dialog-content" className="flex h-[92vh] w-[min(1400px,96vw)] flex-col items-stretch gap-0 overflow-hidden rounded-xl border bg-card shadow-pop">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            <p className="truncate text-xs text-muted-foreground">{name} · {size}{pages ? ` · ${pages} page${pages > 1 ? 's' : ''}` : ''}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {isPdf && (
              <div className="flex items-center gap-0 rounded-md border bg-card shadow-xs">
                <Button type="button" variant="ghost" size="icon-sm" className="rounded-r-none" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out"><Minus /></Button>
                <Button type="button" variant="ghost" size="sm" className="min-w-14 rounded-none font-normal text-muted-foreground tabular-nums" title="Fit width (pinch or Ctrl/⌘ + scroll to zoom)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
                <Button type="button" variant="ghost" size="icon-sm" className="rounded-l-none" onClick={() => setZoom(z => Math.min(8, +(z + 0.25).toFixed(2)))} aria-label="Zoom in"><Plus /></Button>
              </div>
            )}
            {isPdf && url && <Button variant="outline" size="sm" asChild><a href={url} target="_blank" rel="noreferrer"><ExternalLink />Open in tab</a></Button>}
            <Button size="sm" onClick={() => saveBlob(blob, name)}><Download />Download</Button>
            <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}><X /></Button>
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 touch-pan-x touch-pan-y flex-col items-start gap-4 overflow-auto overscroll-contain bg-muted p-6" ref={scroller}>
          {isPdf ? (
            <>
              {rendering && !error && <div className="sticky top-0 z-[2] flex items-center gap-2 self-center rounded-full border bg-card px-3.5 py-1.5 text-sm text-muted-foreground shadow-pop"><LoaderCircle className="size-4 animate-spin" />Rendering pages…</div>}
              {error && <div className="grid h-full place-items-center self-stretch p-10 text-center text-sm text-muted-foreground"><p>{error}</p></div>}
              {Array.from({ length: pages }, (_, i) => <canvas key={i} data-page={i + 1} className="mx-auto max-w-none shrink-0 bg-white shadow-md ring-1 ring-black/5" />)}
            </>
          ) : <div className="grid h-full place-items-center self-stretch p-10 text-center text-sm text-muted-foreground"><p className="max-w-md">Preview is available for PDF documents only. Download to open this file in your CAD or CAM software.</p></div>}
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

  if (error) return <div className="flex min-h-[370px] flex-1 flex-col items-center justify-center gap-3 bg-viewer px-6 py-16 text-center text-sm text-muted-foreground"><h2 className="text-lg font-semibold text-foreground">Flat pattern unavailable</h2><p className="max-w-[550px]">{error}</p></div>;
  if (!flat) return <div className="absolute inset-0 flex items-center justify-center gap-2.5 bg-viewer/85 text-base text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Loading developed pattern…</div>;

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
    <div className="relative flex min-h-[300px] flex-1 flex-col items-stretch gap-0 bg-subtle">
      <svg ref={svg} className="min-h-0 w-full flex-1 cursor-grab touch-none active:cursor-grabbing" viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onUp} onDoubleClick={() => setView(null)}>
        <defs>
          <pattern id="flat-grid" width={10} height={10} patternUnits="userSpaceOnUse">
            <path d="M 10 0 L 0 0 0 10" fill="none" className="stroke-border" strokeWidth={stroke * 0.5} />
          </pattern>
        </defs>
        <rect x={vb.x - full.w * 4} y={vb.y - full.h * 4} width={full.w * 9} height={full.h * 9} fill="url(#flat-grid)" />
        <path d={path(flat.outline) + flat.holes.map(path).join(' ')} fill="#c9d5e0" fillOpacity={0.55} className="stroke-foreground" strokeWidth={stroke * 2} strokeLinejoin="round" fillRule="evenodd" />
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
                {pick && <text x={pick.x} y={pick.y} fontSize={font} fill="#c8470c" textAnchor="middle" transform={`rotate(${ang} ${pick.x} ${pick.y})`} fontFamily="Geist Variable, sans-serif" fontWeight={500} paintOrder="stroke" className="stroke-subtle" strokeWidth={font * 0.18}>{pick.t}</text>}
              </g>
            );
          });
        })()}
        {/* overall dimensions */}
        <g className="fill-muted-foreground stroke-muted-foreground" strokeWidth={stroke} fontSize={font} fontFamily="Geist Variable, sans-serif">
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
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t bg-card px-4 py-2.5 text-sm">
        <div className="flex flex-col items-start gap-0"><span className="font-medium">{name}</span><span className="text-xs text-muted-foreground">Developed blank · {fmt(W)} × {fmt(H)} mm</span></div>
        <div className="flex flex-col items-start gap-0"><span className="text-xs text-muted-foreground">Thickness</span><span className="font-medium tabular-nums">{fmt(thickness)} mm</span></div>
        <div className="flex flex-col items-start gap-0"><span className="text-xs text-muted-foreground">K factor</span><span className="font-medium tabular-nums">{kFactor} {approved ? '· approved' : '· provisional'}</span></div>
        <div className="flex flex-col items-start gap-0"><span className="text-xs text-muted-foreground">Bends</span><span className="font-medium tabular-nums">{bendGroups(flat.bends).length}{bendGroups(flat.bends).length < flat.bends.length ? ` (${flat.bends.length} lines)` : ''}</span></div>
        <div className="flex flex-col items-start gap-0"><span className="text-xs text-muted-foreground">Cut-outs</span><span className="font-medium tabular-nums">{flat.holes.length}</span></div>
        <span className="ml-auto text-xs text-muted-foreground">Scroll to zoom · drag to pan · double-click to reset. {approved ? 'Bend allowance uses the approved K.' : 'Verify K against tooling before cutting blanks.'}</span>
      </div>
      {flat.bends.length > 0 && (
        <div className="max-h-[190px] overflow-auto border-t bg-card px-4 pt-1 pb-3">
          <Table>
            <TableHeader><TableRow className="hover:bg-transparent">{['Bend', 'Angle', 'Inside R', 'Direction', 'Allowance', 'Lines'].map(h => <TableHead key={h} className="h-8 text-xs text-muted-foreground">{h}</TableHead>)}</TableRow></TableHeader>
            <TableBody>
              {bendGroups(flat.bends).map((gr, k) => { const b = flat.bends[gr[0]]; return (
                <TableRow key={b.id} className="hover:bg-transparent">
                  <TableCell className="py-1.5"><code className="text-xs">B{k + 1}</code></TableCell><TableCell className="py-1.5">{fmt(b.angle)}°</TableCell><TableCell className="py-1.5">R{fmt(b.radius)} mm</TableCell>
                  <TableCell className="py-1.5"><span className={cn('rounded px-1.5 py-0.5 text-xs font-medium', b.direction === 'up' ? 'bg-selection text-selection-foreground' : b.direction === 'down' ? 'bg-machining/10 text-machining' : 'bg-muted')}>{b.direction ? b.direction.toUpperCase() : '—'}</span></TableCell>
                  <TableCell className="py-1.5">{fmt(b.allowance)} mm</TableCell><TableCell className="py-1.5" title={gr.map(i => flat.bends[i].id).join(', ')}>{gr.length > 1 ? `${gr.length} lines · ${fmt(gr.reduce((t, i) => t + (flat.bends[i].length || 0), 0))} mm` : b.length ? fmt(b.length) + ' mm' : '—'}</TableCell>
                </TableRow>); })}
            </TableBody>
          </Table>
          <p className="mt-1.5 text-xs text-muted-foreground">UP folds toward you (viewing the root skin from outside); DOWN folds away. Collinear lines with the same angle, radius and direction are one press stroke. Confirm bend sequence and V-die with the press shop.</p>
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
    <div className="grid shrink-0 place-items-center overflow-hidden rounded-md border bg-white text-faint" style={{ width: size, height: Math.round(size * 0.66) }}>
      {url ? <img className="block size-full object-contain" src={url} alt={alt} /> : failed ? <Box className="size-5" /> : <LoaderCircle className="size-4 animate-spin" />}
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
    <div className="flex flex-col gap-2.5">
      <div className="mb-1.5 flex items-center gap-4 rounded-lg border bg-card px-4 py-3.5">
        <div className="flex items-baseline gap-2"><span className="text-2xl font-semibold tabular-nums">{done}</span><span className="text-sm text-muted-foreground">of {items.length} items produced</span></div>
        <div className="flex-1"><Progress value={items.length ? done / items.length * 100 : 0} tone="success" /></div>
        <span className="text-sm text-muted-foreground tabular-nums">{items.reduce((n, p) => n + (byPart.get(p.id)?.quantity_done || 0), 0)} / {items.reduce((n, p) => n + p.quantity, 0)} pieces</span>
      </div>
      {items.map(p => {
        const row = byPart.get(p.id); const d = draft(p); const produced = !!row?.produced;
        const dirty = drafts[p.id] && (drafts[p.id].quantity_done !== (row?.quantity_done ?? 0) || drafts[p.id].note !== (row?.note ?? ''));
        return (
          <article className={cn('grid grid-cols-[40px_112px_1fr_260px] items-center gap-4 rounded-lg border bg-card px-4 py-3 max-[900px]:grid-cols-[34px_90px_1fr]', produced && 'border-success/20 bg-success-soft')} key={p.id}>
            <Button type="button" variant="ghost" size="icon" className={cn('size-10 hover:bg-transparent', produced ? 'text-success hover:text-success' : 'text-faint hover:text-foreground')} disabled={!canEdit || busy} aria-label={produced ? 'Mark as not produced' : 'Mark as produced'}
              onClick={() => onSave(p.id, { produced: !produced, quantity_done: !produced ? Math.max(d.quantity_done, p.quantity) : d.quantity_done, note: d.note })}>
              {produced ? <CheckCircle2 className="size-6.5" /> : <Circle className="size-6.5" />}
            </Button>
            <PartThumb partId={p.id} alt={p.name} size={112} />
            <div className="grid min-w-0 gap-1">
              <div className="flex flex-wrap items-center gap-2"><span className="truncate text-base font-medium">{p.name}</span><Badge kind={p.category}>{categories[p.category]}</Badge>{produced && <Badge kind="success">Produced</Badge>}</div>
              <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                Qty {p.quantity}{p.spec.material && ` · ${p.spec.material}`}{p.spec.finish && ` · ${p.spec.finish}`}
                {p.spec.coating_hex && <> · <Swatch hex={p.spec.coating_hex} title={p.spec.coating_color} size={11} /> {p.spec.coating_color}</>}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">{p.geometry.dimensions.map((x: number) => fmt(x)).join(' × ')} mm{p.geometry.thickness > 0 && ` · t ${fmt(p.geometry.thickness)}`}{p.geometry.holes.length > 0 && ` · ${p.geometry.holes.length} bores`}{p.geometry.bends.length > 0 && ` · ${p.geometry.bends.length} bends`}</p>
              {row?.updated && <p className="text-xs text-faint">{row.produced ? 'Produced' : 'Updated'} by {row.actor} · {new Date(row.updated).toLocaleString()}</p>}
            </div>
            <div className="grid grid-cols-2 items-center gap-x-2 gap-y-1.5 max-[900px]:col-span-3">
              <Button type="button" variant="outline" size="sm" className="col-span-2" disabled={!p.assets.includes('drawing.pdf')} title={p.assets.includes('drawing.pdf') ? 'Preview drawing' : 'Drawing not generated'} onClick={() => onPreview(p)}><Eye />Drawing</Button>
              <Label className="gap-1.5 text-xs font-normal text-muted-foreground">Done<Input type="number" min={0} className="h-7 w-16 text-xs tabular-nums" disabled={!canEdit} value={d.quantity_done} onChange={e => setDrafts({ ...drafts, [p.id]: { ...d, quantity_done: +e.target.value } })} /><span className="tabular-nums">/ {p.quantity}</span></Label>
              <Input className="h-7 text-xs" placeholder="Batch / heat no. / remarks" disabled={!canEdit} value={d.note} onChange={e => setDrafts({ ...drafts, [p.id]: { ...d, note: e.target.value } })} />
              {dirty && <Button type="button" size="sm" className="col-span-2 justify-self-end" disabled={busy} onClick={() => onSave(p.id, { produced, quantity_done: d.quantity_done, note: d.note }).then(() => setDrafts(({ [p.id]: _, ...rest }) => rest))}><Check />Save</Button>}
            </div>
          </article>
        );
      })}
      {!items.length && <Empty icon={<Box />} title="No production items in this revision." />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Manufacturing specification editor
// ---------------------------------------------------------------------------------------------
function Field({ label, value, onChange, list, placeholder, type = 'text', hint }: { label: string; value: Any; onChange: (v: string) => void; list?: string[]; placeholder?: string; type?: string; hint?: string }) {
  const id = useId();
  return (
    <div className="grid content-start gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {list
        ? <Combo value={value ?? ''} suggestions={list} aria-label={label} placeholder={placeholder || 'Approved value or justified N/A'} onChange={onChange} />
        : <Input id={id} type={type} value={value ?? ''} placeholder={placeholder || 'Approved value or justified N/A'} onChange={e => onChange(e.target.value)} />}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

type Op = { name: string; detail: string };
export function OperationsEditor({ ops, setOps }: { ops: Op[]; setOps: (o: Op[]) => void }) {
  return (
    <div className="grid gap-1.5">
      {ops.map((op, i) => (
        <div className="grid grid-cols-[40px_1.1fr_2fr_28px_28px_28px] items-center gap-1.5 max-sm:grid-cols-[1fr_1fr_28px_28px_28px]" key={i}>
          <span className="font-mono text-xs font-medium text-primary tabular-nums max-sm:hidden">{String((i + 1) * 10).padStart(3, '0')}</span>
          <Combo size="sm" value={op.name} suggestions={suggestions.operation} placeholder="Operation" onChange={v => setOps(ops.map((o, j) => (j === i ? { ...o, name: v } : o)))} />
          <Input className="h-7 text-xs" value={op.detail} placeholder="Machine, tooling, parameters, acceptance" onChange={e => setOps(ops.map((o, j) => (j === i ? { ...o, detail: e.target.value } : o)))} />
          <Tip label="Move up"><Button type="button" variant="ghost" size="icon-sm" aria-label="Move up" disabled={i === 0} onClick={() => { const n = [...ops]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; setOps(n); }}><ArrowUp /></Button></Tip>
          <Tip label="Move down"><Button type="button" variant="ghost" size="icon-sm" aria-label="Move down" disabled={i === ops.length - 1} onClick={() => { const n = [...ops]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; setOps(n); }}><ArrowDown /></Button></Tip>
          <Tip label="Remove"><Button type="button" variant="ghost" size="icon-sm" aria-label="Remove" className="text-muted-foreground hover:bg-danger-soft hover:text-destructive" onClick={() => setOps(ops.filter((_, j) => j !== i))}><Trash2 /></Button></Tip>
        </div>
      ))}
      <Button type="button" variant="ghost" size="sm" className="justify-self-start" onClick={() => setOps([...ops, { name: '', detail: '' }])}><Plus />Add operation</Button>
    </div>
  );
}

export function ColorPicker({ hex, label, onChange }: { hex?: string; label?: string; onChange: (hex: string, label: string) => void }) {
  const [ralQuery, setRalQuery] = useState('');
  const ralMatches = RAL.filter(r => !ralQuery || (r.code + ' ' + r.name).toLowerCase().includes(ralQuery.toLowerCase()));
  return (
    <div className="grid gap-3 rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <span className="size-11 shrink-0 rounded-lg ring-1 ring-black/10 ring-inset dark:ring-white/15" style={{ background: hex || 'var(--ui-muted)' }} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <Input value={label || ''} placeholder="RAL / Pantone / customer code" onChange={e => onChange(hex || '', e.target.value)} />
          <div className="flex items-center gap-1.5">
            <Input type="color" className="w-11 shrink-0 cursor-pointer p-0.5" aria-label="Custom colour" value={hex || '#808080'} onChange={e => onChange(e.target.value, label || '')} />
            <Input className="font-mono" value={hex || ''} placeholder="#hex" onChange={e => onChange(e.target.value, label || '')} />
            {hex && <Button type="button" variant="ghost" onClick={() => onChange('', '')}>Clear</Button>}
          </div>
        </div>
      </div>
      <Input className="h-7 text-xs" placeholder="Search RAL classic…" value={ralQuery} onChange={e => setRalQuery(e.target.value)} />
      <div className="grid max-h-[190px] grid-cols-[repeat(auto-fill,minmax(58px,1fr))] gap-1.5 overflow-auto">
        {ralMatches.map(r => (
          <Button type="button" variant="ghost" key={r.code} className={cn('h-auto flex-col gap-1 border border-transparent p-1', hex?.toLowerCase() === r.hex.toLowerCase() && 'border-primary bg-selection hover:bg-selection')} title={`${r.code} ${r.name}`} onClick={() => onChange(r.hex, `${r.code} ${r.name}`)}>
            <span className="block h-6.5 w-full rounded ring-1 ring-black/10 ring-inset dark:ring-white/15" style={{ background: r.hex }} />
            <span className="text-2xs text-muted-foreground tabular-nums">{r.code.replace('RAL ', '')}</span>
          </Button>
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
  const uid = useId();

  return (
    <form className="grid" onSubmit={e => { e.preventDefault(); onSave(); }}>
      <FormSection title="Classification">
        <div className={FORM_GRID}>
          <div className="grid gap-1.5">
            <Label>Manufacturing category</Label>
            <Select aria-label="Manufacturing category" value={editing.category} onChange={v => setEditing({ ...editing, category: v })} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={uid + '-qty'}>Quantity per assembly</Label>
            <Input id={uid + '-qty'} className="tabular-nums" value={editing.quantity} readOnly />
          </div>
        </div>
      </FormSection>

      <FormSection title="Material & stock">
        <div className={FORM_GRID}>
          <Field label="Material / grade" value={spec.material} onChange={v => set('material', v)} list={suggestions.material} />
          <Field label="Raw stock" value={spec.stock} onChange={v => set('stock', v)} list={suggestions.stock} placeholder="Sheet 3 mm / plate / bar / tube" />
          <Field label="Heat treatment" value={spec.heat_treatment} onChange={v => set('heat_treatment', v)} list={suggestions.heat} />
          <Field label="Hardness" value={spec.hardness} onChange={v => set('hardness', v)} list={suggestions.hardness} />
        </div>
        {editing.geometry.thickness > 0 && <p className="text-xs text-muted-foreground">Inferred thickness {fmt(editing.geometry.thickness)} mm · envelope {editing.geometry.dimensions.map((d: number) => fmt(d)).join(' × ')} mm</p>}
      </FormSection>

      <FormSection title="Process">
        <div className={FORM_GRID}>
          <Field label="Primary process" value={spec.process} onChange={v => set('process', v)} list={suggestions.process} />
          <Field label="Edge treatment" value={spec.edge_treatment} onChange={v => set('edge_treatment', v)} list={suggestions.edge} />
        </div>
        <div className="grid gap-1.5">
          <Label>Process sequence</Label>
          <OperationsEditor ops={ops} setOps={setOps} />
        </div>
      </FormSection>

      <FormSection title="Surface & coating">
        <div className={FORM_GRID}>
          <Field label="Finish" value={spec.finish} onChange={v => set('finish', v)} list={suggestions.finish} />
          <Field label="Coating system" value={spec.paint} onChange={v => set('paint', v)} list={suggestions.paint} hint="Powder / paint / plating system and film thickness" />
          <Field label="Coating thickness" value={spec.coating_thickness} onChange={v => set('coating_thickness', v)} list={suggestions.coatingThickness} />
          <Field label="Masking" value={spec.masking} onChange={v => set('masking', v)} list={suggestions.masking} />
          <Field label="Surface roughness" value={spec.roughness} onChange={v => set('roughness', v)} list={suggestions.roughness} />
        </div>
        <div className="grid gap-1.5">
          <Label>Coating colour {coated ? '' : <span className="font-normal text-muted-foreground">(only applies to coated parts)</span>}</Label>
          <ColorPicker hex={spec.coating_hex} label={spec.coating_color} onChange={(hex, label) => setEditing({ ...editing, spec: { ...spec, coating_hex: hex, coating_color: label } })} />
        </div>
      </FormSection>

      <FormSection title="Tolerancing & datums">
        <div className={FORM_GRID}>
          <Field label="General tolerance" value={spec.general_tolerance} onChange={v => set('general_tolerance', v)} list={suggestions.tolerance} />
          <Field label="Functional datums" value={spec.datums} onChange={v => set('datums', v)} placeholder="A = base face; B = left edge; C = bore H001" />
        </div>
      </FormSection>

      <FormSection title="Marking, packaging & other needs">
        <div className={FORM_GRID}>
          <Field label="Marking / identification" value={spec.marking} onChange={v => set('marking', v)} list={suggestions.marking} />
          <Field label="Packaging" value={spec.packaging} onChange={v => set('packaging', v)} list={suggestions.packaging} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={uid + '-notes'}>Notes to vendor</Label>
          <Textarea id={uid + '-notes'} value={spec.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Masking, welding standard, critical faces, inspection sampling, delivery and any other requirements" />
        </div>
      </FormSection>

      {(isSheet || editing.geometry.bends.length > 0) && (
        <FormSection title="Sheet development">
          <div className={FORM_GRID}>
            <div className="grid gap-1.5">
              <Label htmlFor={uid + '-k'}>K factor</Label>
              <Input id={uid + '-k'} className="tabular-nums" type="number" min="0.01" max="0.99" step="0.01" value={spec.k_factor} onChange={e => set('k_factor', +e.target.value)} />
            </div>
            <Label className="h-8 self-end font-normal"><Checkbox checked={!!spec.k_factor_approved} onCheckedChange={v => set('k_factor_approved', v === true)} />K factor verified against forming tooling</Label>
          </div>
        </FormSection>
      )}

      <FormSection title="Named features & inspection limits">
        <div className="max-h-[330px] overflow-auto rounded-md border">
          {features.map((h: Any) => {
            const f = spec.feature_specs[h.id] || {};
            const update = (k: string, raw: string) => set('feature_specs', { ...spec.feature_specs, [h.id]: { ...f, [k]: k === 'designation' ? raw : raw === '' ? null : +raw } });
            return (
              <div className="grid grid-cols-[80px_2fr_1fr_1fr] items-center gap-2 border-b px-2.5 py-2 last:border-b-0 max-sm:grid-cols-[60px_1fr]" key={h.id}>
                <span className="grid font-mono text-xs font-medium">{h.id}<span className="font-sans text-2xs font-normal text-muted-foreground tabular-nums">{h.display} {h.unit}</span></span>
                <Input className="h-7 text-xs" aria-label={h.id + ' designation'} placeholder="Designation, e.g. M8 tapped / H7 reamed" value={f.designation ?? ''} onChange={e => update('designation', e.target.value)} />
                <Input className="h-7 text-xs tabular-nums" aria-label={h.id + ' lower'} placeholder={'Lower (' + h.unit + ')'} type="number" step="any" value={f.lower ?? ''} onChange={e => update('lower', e.target.value)} />
                <Input className="h-7 text-xs tabular-nums" aria-label={h.id + ' upper'} placeholder={'Upper (' + h.unit + ')'} type="number" step="any" value={f.upper ?? ''} onChange={e => update('upper', e.target.value)} />
              </div>
            );
          })}
        </div>
      </FormSection>

      <FormSection title="Engineering verification notes">
        <div className={FORM_GRID}>
          {Object.entries(config?.manual_checks || {}).map(([k, v]) => (
            <div className="grid content-start gap-1.5" key={k}>
              <Label htmlFor={uid + '-check-' + k} className="leading-snug">{String(v)}</Label>
              <Input id={uid + '-check-' + k} value={spec.manual_checks[k] || ''} onChange={e => set('manual_checks', { ...spec.manual_checks, [k]: e.target.value })} placeholder="Evidence, calculation reference or justified N/A" />
            </div>
          ))}
        </div>
      </FormSection>

      {editing.findings?.some((f: Any) => f.code.startsWith('DFM')) && (
        <FormSection title="Rule dispositions">
          {editing.findings.filter((f: Any) => f.code.startsWith('DFM')).map((f: Any) => {
            const k = f.code + (f.feature ? ':' + f.feature : '');
            return (
              <div className="grid gap-1.5" key={k}>
                <Label htmlFor={uid + '-waive-' + k} className="leading-snug">{f.code} {f.feature} · {f.title}</Label>
                <Input id={uid + '-waive-' + k} placeholder="Disposition / deviation reason (optional)" value={spec.rule_waivers[k] || ''} onChange={e => { const w = { ...spec.rule_waivers }; if (e.target.value) w[k] = e.target.value; else delete w[k]; set('rule_waivers', w); }} />
              </div>
            );
          })}
        </FormSection>
      )}

      <Label className="mt-2 rounded-md border bg-subtle px-3.5 py-3 font-normal leading-normal">
        <Checkbox checked={!!editing.reviewed} onCheckedChange={v => setEditing({ ...editing, reviewed: v === true })} />
        I have reviewed this part's classification and specifications
      </Label>
      <ModalFooter>
        <Button type="submit" disabled={busy}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}Save specification</Button>
      </ModalFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
// Multi-selection: inspector panel and group specification editor
// ---------------------------------------------------------------------------------------------
export function GroupPanel({ parts, vendor, editable, busy, onEdit, onReady, onBulk, onExclude, onRemove, onFocus, onClear, onJoint, onProcess, templates = [] }: { parts: Any[]; vendor: boolean; editable: boolean; busy: boolean; onEdit: () => void; onReady?: () => void; onBulk: (body: Any) => void; onExclude: () => void; onRemove: (id: string) => void; onFocus: (id: string) => void; onClear: () => void; onJoint?: () => void; onProcess?: (templateId: string) => void; templates?: Any[] }) {
  const cats = Object.entries(categories).map(([k, v]) => [k, v, parts.filter(p => p.category === k).length] as const).filter(x => x[2] > 0);
  const excluded = parts.filter(p => p.excluded).length, hidden = parts.filter(p => p.hidden).length;
  const qty = parts.reduce((n, p) => n + p.quantity, 0);
  return (
    <>
      <div className="px-4 pt-3 pb-2.5">
        <div className="flex flex-wrap gap-1.5">{cats.map(([k, v, n]) => <Badge key={k} kind={k}>{n} {v}</Badge>)}</div>
        <h2 className="mt-2 mb-0.5 text-lg leading-snug font-semibold break-words">{parts.length} parts selected</h2>
        <span className="text-xs text-muted-foreground">{qty} pieces in the assembly{excluded ? ` · ${excluded} not for production` : ''}{hidden ? ` · ${hidden} hidden` : ''}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pt-3 pb-5">
        {!vendor && (
          <div className="grid gap-2">
            {onReady && <Button type="button" className="w-full" disabled={!editable || busy} title="Fill what is missing, verify, and sign off all selected parts at once" onClick={onReady}><Sparkles />Make production ready</Button>}
            <Button type="button" variant={onReady ? 'outline' : 'default'} className="w-full" disabled={!editable || busy} title={editable ? 'Set material, process, finish, coating and more for all selected parts at once' : 'Only on an active, ready revision (owner/engineer)'} onClick={onEdit}><Settings />Edit group manufacturing details</Button>
            {editable && (
              <div className="grid gap-1.5">
                <Label className="text-xs font-normal text-muted-foreground">Set category for all</Label>
                <Select size="sm" aria-label="Set category for all" value="" disabled={busy} placeholder="Choose…" onChange={v => { if (v) onBulk({ category: v }); }} options={Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))} />
              </div>
            )}
            {editable && onJoint && <Button type="button" variant="outline" className="w-full" disabled={busy} title="Define how the selected parts are joined: weld type and size, fasteners, faces" onClick={onJoint}><Flame />Weld these parts…</Button>}
            {editable && onProcess && templates.length > 0 && (
              <div className="grid gap-1.5">
                <Label className="text-xs font-normal text-muted-foreground">Process template for all</Label>
                <Select size="sm" aria-label="Process template for all" value="" disabled={busy} placeholder="Choose a routing…" onChange={v => { if (v) onProcess(v === '__none__' ? '' : v); }} options={[...templates.map((t: Any) => ({ value: t.id, label: t.name, hint: t.data.steps.length + ' steps' })), { value: '__none__', label: 'Remove template' }]} />
              </div>
            )}
            <div className="flex gap-1.5">
              <Button type="button" variant="outline" size="sm" className="flex-1" disabled={busy} onClick={() => onBulk({ hidden: hidden < parts.length })}>{hidden < parts.length ? <EyeOff /> : <Eye />}{hidden < parts.length ? 'Hide in viewer' : 'Show in viewer'}</Button>
              {editable && (excluded < parts.length
                ? <Button type="button" variant="outline" size="sm" className="flex-1 text-destructive hover:bg-danger-soft hover:text-destructive" disabled={busy} onClick={onExclude}><Ban />Not for production</Button>
                : <Button type="button" variant="outline" size="sm" className="flex-1" disabled={busy} onClick={() => onBulk({ excluded: false })}><Undo2 />Restore to production</Button>)}
            </div>
          </div>
        )}
        <h4 className="mt-5 mb-2 text-2xs font-medium tracking-wider text-muted-foreground uppercase">Selected parts</h4>
        <div className="mb-2.5 flex flex-col gap-1">
          {parts.map(p => (
            <div className="flex items-center gap-2 rounded-md border bg-subtle py-1.5 pr-1.5 pl-2" key={p.id}>
              <span className={cn('grid size-6.5 shrink-0 place-items-center rounded-md', GLYPH[p.category] || GLYPH.machining)} style={p.spec.coating_hex ? { background: p.spec.coating_hex, color: '#fff' } : undefined}>{p.category === 'sheet_metal' ? <Layers className="size-3.5" /> : <Box className="size-3.5" />}</span>
              <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 flex-col items-stretch gap-0 px-1 py-0.5 text-left font-normal hover:bg-transparent" title="Show only this part" onClick={() => onFocus(p.id)}>
                <span className={cn('block truncate text-sm font-medium', p.excluded && 'text-muted-foreground line-through')}>{p.name}</span>
                <span className="block truncate text-xs text-muted-foreground">{categories[p.category]} · Qty {p.quantity}{p.spec.material ? ' · ' + p.spec.material : ''}</span>
              </Button>
              <Tip label="Remove from selection"><Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="Remove from selection" onClick={() => onRemove(p.id)}><X /></Button></Tip>
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" className="w-full" onClick={onClear}>Clear selection</Button>
        <p className="mt-3 text-xs text-muted-foreground">Shift-click selects a range in the navigator; Ctrl/Cmd-click adds or removes single parts.</p>
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
  const uid = useId();
  const field = (label: string, k: string, list?: string[], placeholder?: string) => (
    <div key={k} className={cn('grid content-start gap-1.5', dirty(k) && CHANGED_FIELD)}>
      <Label htmlFor={uid + '-' + k} className={cn(dirty(k) && 'text-selection-foreground')}>{label}{dirty(k) && <Changed>· will change</Changed>}</Label>
      {list
        ? <Combo value={isMixed(k) ? '' : values[k] ?? ''} suggestions={list} aria-label={label} placeholder={isMixed(k) ? 'Mixed values — leave blank to keep each part\'s own' : placeholder || 'Approved value or justified N/A'} onChange={v => set(k, v)} />
        : <Input id={uid + '-' + k} value={isMixed(k) ? '' : values[k] ?? ''} placeholder={isMixed(k) ? 'Mixed values — leave blank to keep each part\'s own' : placeholder || 'Approved value or justified N/A'} onChange={e => set(k, e.target.value)} />}
    </div>
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
    <form className="grid" onSubmit={e => { e.preventDefault(); submit(); }}>
      <div className="mb-4 flex max-h-24 flex-wrap gap-1 overflow-y-auto">{parts.map(p => <Badge key={p.id} kind={p.category}>{p.name}</Badge>)}</div>
      <FormSection title="Classification">
        <div className="grid gap-1.5">
          <Label className={cn(category && new Set(parts.map(p => p.category)).size !== 1 && 'text-selection-foreground')}>Manufacturing category{category && new Set(parts.map(p => p.category)).size !== 1 && <Changed>· will change all</Changed>}</Label>
          <Select aria-label="Manufacturing category" value={category} onChange={setCategory} options={[...(new Set(parts.map(p => p.category)).size !== 1 ? [{ value: '', label: "Mixed — keep each part's category" }] : []), ...Object.entries(categories).map(([k, v]) => ({ value: k, label: v }))]} />
        </div>
      </FormSection>
      <FormSection title="Material & stock">
        <div className={FORM_GRID}>
          {field('Material / grade', 'material', suggestions.material)}
          {field('Raw stock', 'stock', suggestions.stock, 'Sheet 3 mm / plate / bar / tube')}
          {field('Heat treatment', 'heat_treatment', suggestions.heat)}
          {field('Hardness', 'hardness', suggestions.hardness)}
        </div>
      </FormSection>
      <FormSection title="Process">
        <div className={FORM_GRID}>
          {field('Primary process', 'process', suggestions.process)}
          {field('Edge treatment', 'edge_treatment', suggestions.edge)}
        </div>
        <div className="grid gap-1.5">
          <Label className={cn(dirty('operations') && 'text-selection-foreground')}>Process sequence{dirty('operations') && <Changed>· will replace on all parts</Changed>}</Label>
          {isMixed('operations') && ops.length === 0 && <p className="text-xs text-muted-foreground">Parts have different sequences. Add operations here to give all of them the same sequence, or leave empty to keep each one.</p>}
          <OperationsEditor ops={ops} setOps={o => set('operations', o)} />
        </div>
      </FormSection>
      <FormSection title="Surface & coating">
        <div className={FORM_GRID}>
          {field('Finish', 'finish', suggestions.finish)}
          {field('Coating system', 'paint', suggestions.paint)}
          {field('Coating thickness', 'coating_thickness', suggestions.coatingThickness)}
          {field('Masking', 'masking', suggestions.masking)}
          {field('Surface roughness', 'roughness', suggestions.roughness)}
        </div>
        <div className="grid gap-1.5">
          <Label className={cn((dirty('coating_hex') || dirty('coating_color')) && 'text-selection-foreground')}>Coating colour{(dirty('coating_hex') || dirty('coating_color')) && <Changed>· will change all</Changed>}{isMixed('coating_hex') && !dirty('coating_hex') && <Changed>· mixed, pick one to unify</Changed>}</Label>
          <ColorPicker hex={isMixed('coating_hex') ? '' : values.coating_hex} label={isMixed('coating_color') ? '' : values.coating_color} onChange={(hex, label) => setValues({ ...values, coating_hex: hex, coating_color: label })} />
        </div>
      </FormSection>
      <FormSection title="Tolerancing & datums">
        <div className={FORM_GRID}>
          {field('General tolerance', 'general_tolerance', suggestions.tolerance)}
          {field('Functional datums', 'datums', undefined, 'A = base face; B = left edge')}
        </div>
      </FormSection>
      <FormSection title="Marking, packaging & notes">
        <div className={FORM_GRID}>
          {field('Marking / identification', 'marking', suggestions.marking)}
          {field('Packaging', 'packaging', suggestions.packaging)}
        </div>
        <div className={cn('grid gap-1.5', dirty('notes') && CHANGED_FIELD)}>
          <Label htmlFor={uid + '-notes'} className={cn(dirty('notes') && 'text-selection-foreground')}>Notes to vendor{dirty('notes') && <Changed>· will change</Changed>}</Label>
          <Textarea id={uid + '-notes'} value={isMixed('notes') ? '' : values.notes ?? ''} placeholder={isMixed('notes') ? 'Mixed — leave blank to keep each part\'s notes' : ''} onChange={e => set('notes', e.target.value)} />
        </div>
      </FormSection>
      {sheet && (
        <FormSection title="Sheet development">
          <div className={FORM_GRID}>
            <div className={cn('grid gap-1.5', dirty('k_factor') && CHANGED_FIELD)}>
              <Label htmlFor={uid + '-k'} className={cn(dirty('k_factor') && 'text-selection-foreground')}>K factor{isMixed('k_factor') && ' (mixed)'}</Label>
              <Input id={uid + '-k'} className="tabular-nums" type="number" min="0.01" max="0.99" step="0.01" value={isMixed('k_factor') ? '' : values.k_factor} onChange={e => set('k_factor', +e.target.value)} />
            </div>
            <Label className="h-8 self-end font-normal"><Checkbox checked={values.k_factor_approved === true} onCheckedChange={v => set('k_factor_approved', v === true)} />K factor verified against forming tooling{isMixed('k_factor_approved') && !dirty('k_factor_approved') && ' (mixed)'}</Label>
          </div>
        </FormSection>
      )}
      <FormSection title="Engineering verification notes">
        <div className={FORM_GRID}>
          {Object.entries(config?.manual_checks || {}).map(([k, v]) => {
            const changed = values.manual_checks[k] !== initial.manual_checks[k];
            return (
              <div key={k} className={cn('grid content-start gap-1.5', changed && CHANGED_FIELD)}>
                <Label htmlFor={uid + '-check-' + k} className={cn('leading-snug', changed && 'text-selection-foreground')}>{String(v)}</Label>
                <Input id={uid + '-check-' + k} value={values.manual_checks[k] === MIXED ? '' : values.manual_checks[k]} placeholder={values.manual_checks[k] === MIXED ? 'Mixed — leave blank to keep' : 'Evidence, calculation reference or justified N/A'} onChange={e => setValues({ ...values, manual_checks: { ...values.manual_checks, [k]: e.target.value } })} />
              </div>
            );
          })}
        </div>
        {changedChecks.length > 0 && Object.values(values.manual_checks).includes(MIXED) && <p className="text-xs text-muted-foreground">Notes still marked mixed are left as they are on each part.</p>}
      </FormSection>
      <Label className="mt-2 rounded-md border bg-subtle px-3.5 py-3 font-normal leading-normal"><Checkbox checked={reviewed === true} onCheckedChange={v => setReviewed(v === true ? true : null)} />Mark all {parts.length} parts as reviewed</Label>
      <ModalFooter note={<>{changedKeys.length + changedChecks.length + (category && new Set(parts.map(p => p.category)).size !== 1 || (category && category !== parts[0].category) ? 1 : 0)} field(s) will change on {parts.length} parts</>}>
        <Button type="submit" disabled={busy || (!changedKeys.length && !changedChecks.length && !(category && (new Set(parts.map(p => p.category)).size !== 1 || category !== parts[0].category)) && reviewed === null)}>{busy ? <LoaderCircle className="animate-spin" /> : <Check />}Apply to {parts.length} parts</Button>
      </ModalFooter>
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
    <Modal title={o.title} close={() => finish(null)}>
      <form className="grid gap-3" onSubmit={e => { e.preventDefault(); if (!blocked) finish(o.input ? text.trim() : ''); }}>
        {o.message && <p className="text-sm leading-relaxed text-muted-foreground">{o.message}</p>}
        {o.input && <>
          {o.input.choices && <div className="flex flex-wrap gap-1.5">{o.input.choices.map(c => <Button type="button" size="sm" variant={text === c ? 'secondary' : 'outline'} key={c} className={cn('rounded-full', text === c && 'bg-selection text-selection-foreground')} onClick={() => setText(c)}>{c}</Button>)}</div>}
          <div className="grid gap-1.5">
            <Label htmlFor="ask-input">{o.input.label}</Label>
            {o.input.multiline
              ? <Textarea id="ask-input" autoFocus rows={3} value={text} placeholder={o.input.placeholder} onChange={e => setText(e.target.value)} />
              : <Input id="ask-input" autoFocus type={o.input.type || 'text'} min={o.input.min} value={text} placeholder={o.input.placeholder} onChange={e => setText(e.target.value)} />}
          </div>
        </>}
        <ModalFooter>
          <Button type="button" variant="outline" onClick={() => finish(null)}>{o.cancel || 'Cancel'}</Button>
          <Button type="submit" autoFocus={!o.input} variant={o.danger ? 'destructive' : 'default'} disabled={blocked}>{o.confirm || 'OK'}</Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
