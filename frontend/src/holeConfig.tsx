import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { hardwareModel } from './hardware3d';
import { X, ChevronDown, ChevronUp, Search, MousePointerClick, ArrowDownToLine, ArrowUpToLine, Info, Plus, Trash2, AlertTriangle } from 'lucide-react';
import PartScene, { type SceneApi } from './partScene';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from './controls';
import { api } from './api';
import type { Any } from './constants';
import type { NavStyle } from './cadControls';

type Item = { id: string; type: string; units: string; thread: string; name: string; pn: string; hole: number | null; min_sheet?: number | null; length?: number | null; csk?: number; angle?: number; custom?: boolean };
type Hole = { id: string; diameter: number; axis: number[]; origin: number[]; start: number; end: number; center: number[]; depth: number };

const CHIPS: [string, string][] = [['nut', 'Nut'], ['flush_nut', 'Flush Nut'], ['stud', 'Stud'], ['standoff', 'Standoff'], ['rivnut', 'Rivnut'], ['weld_nut', 'Weld nut'], ['tap', 'Tap'], ['countersink', 'Countersink']];
const KIND = (t: string) => t === 'tap' ? 'tap' : t === 'countersink' ? 'csk' : 'hw';
const KIND_LABEL: Record<string, string> = { hw: 'Hardware', tap: 'Tap', csk: 'Countersink' };
const COLORS = { hover: 0xf6d34a, selected: 0xf2c200, hw: 0xa78bfa, tap: 0x60a5fa, csk: 0x4ade80, metal: 0xc9a227 };
// Hardware kind tints: the same violet / blue / green as the hole markers in the 3D view.
const KIND_TINT: Record<string, { text: string; border: string; on: string; badge: string }> = {
  hw: { text: 'text-violet-600 dark:text-violet-400', border: 'border-violet-300 dark:border-violet-500/40', on: 'bg-violet-500/10 border-violet-400 dark:border-violet-400', badge: 'border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400' },
  tap: { text: 'text-blue-600 dark:text-blue-400', border: 'border-blue-300 dark:border-blue-500/40', on: 'bg-blue-500/10 border-blue-400 dark:border-blue-400', badge: 'border-blue-500/25 bg-blue-500/10 text-blue-600 dark:text-blue-400' },
  csk: { text: 'text-green-600 dark:text-green-400', border: 'border-green-300 dark:border-green-500/40', on: 'bg-green-500/10 border-green-400 dark:border-green-400', badge: 'border-green-500/25 bg-green-500/10 text-green-600 dark:text-green-400' },
};
// hole table (size groups) and catalogue list grids
const HC_GRID = 'grid grid-cols-[44px_minmax(0,1fr)_210px_52px] items-center gap-x-2 px-3';
const HC_SEL = 'bg-warning-soft shadow-[inset_3px_0_0_var(--color-warning)]';
const HC_COUNT = 'grid size-7 place-items-center justify-self-center rounded-md text-sm font-medium tabular-nums';
const PK_GRID = 'grid grid-cols-[minmax(0,1fr)_108px_96px_62px] items-center gap-2 px-3';
const PK_ITEM = 'h-auto min-h-12 w-full justify-stretch rounded-none border-b border-border/60 text-left font-normal';
const inch = (mm: number) => (mm / 25.4).toFixed(4).replace(/^0/, '') + '″';
let catalogCache: Promise<{ items: Item[] }> | null = null;

/** Thread major diameter (mm) from a designation: M5 / M5×0.8 / #10-32 / 1/4-20. */
function threadDia(t: string) {
  const m = /^M([\d.]+)/.exec(t); if (m) return Number(m[1]);
  const n = /^#(\d+)/.exec(t); if (n) return (0.06 + 0.013 * Number(n[1])) * 25.4;
  const f = /^(\d+)\/(\d+)/.exec(t); if (f) return Number(f[1]) / Number(f[2]) * 25.4;
  return 0;
}

/**
 * Hole hardware dialog: click holes on the part (Shift / Ctrl adds), pick what goes in them — self-clinching
 * nut, flush nut, stud, standoff, rivet nut, tapped thread or countersink — and which side it is pressed in
 * from. Holes are grouped by size; each change is saved at once. The hardware's mounting hole is what the
 * flat pattern cuts and the drawing calls out.
 */
export default function HoleConfig({ part, revision, editable, navStyle, close }: { part: Any; revision: string; editable: boolean; navStyle?: NavStyle; close: (changed: boolean) => void }) {
  const holes: Hole[] = part.geometry?.holes || [];
  const [specs, setSpecs] = useState<Record<string, Any>>(part.spec?.feature_specs || {});
  const [catalog, setCatalog] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<{ ids: string[]; dia: number; top: number; height: number; left: number; width: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = useRef(false);
  const sceneApi = useRef<SceneApi | null>(null);
  const markers = useRef<{ group: THREE.Group; discs: Map<string, THREE.Mesh[]>; glyphs: THREE.Group } | null>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => { (catalogCache ||= api('/hardware-catalog')).then(r => setCatalog(r.items)).catch(e => { catalogCache = null; setError(e.message); }); }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (document.querySelector('[data-slot="select-content"]')) return; /* an open list closes first */ e.stopPropagation(); if (picker) setPicker(null); else if (selected.length) setSelected([]); else close(changed.current); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, [picker, selected]);

  const hwOf = (id: string): Any | null => specs[id]?.hardware || null;
  const groups = useMemo(() => {
    const by = new Map<string, Hole[]>();
    for (const h of holes) { const k = h.diameter.toFixed(2); by.set(k, [...(by.get(k) || []), h]); }
    return [...by.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, list]) => ({ key: k, dia: Number(k), holes: list }));
  }, [holes]);
  const label = (ids: string[]) => {
    const names = [...new Set(ids.map(id => { const h = hwOf(id); return h ? `${h.id}|${h.name}` : '' }))];
    if (names.length > 1) return { text: 'Multiple', multiple: true, hw: null };
    const h = hwOf(ids[0]); return { text: h ? h.name : 'Select', multiple: false, hw: h };
  };

  // ---------------------------------------------------------------- 3D markers
  const build = (s: SceneApi) => {
    if (markers.current) { s.overlay.remove(markers.current.group); }
    const group = new THREE.Group(); const glyphs = new THREE.Group(); group.add(glyphs);
    const discs = new Map<string, THREE.Mesh[]>();
    for (const h of holes) {
      const a = new THREE.Vector3(...h.axis).normalize(), o = new THREE.Vector3(...h.origin), r = h.diameter / 2;
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), a);
      const list: THREE.Mesh[] = [];
      for (const [t, sgn] of [[Math.max(h.start, h.end), 1], [Math.min(h.start, h.end), -1]] as const) {
        const disc = new THREE.Mesh(new THREE.CircleGeometry(r * 1.02, 40), new THREE.MeshBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
        disc.quaternion.copy(q); disc.position.copy(o).addScaledVector(a, t + sgn * 0.03); disc.userData = { hole: h.id }; disc.renderOrder = 11;
        group.add(disc); list.push(disc);
      }
      discs.set(h.id, list);
    }
    s.overlay.add(group);
    markers.current = { group, discs, glyphs };
  };
  const paint = () => {
    const m = markers.current; if (!m) return;
    const sel = new Set(selected);
    for (const [id, list] of m.discs) {
      const hw = hwOf(id);
      const color = id === hover ? COLORS.hover : sel.has(id) ? COLORS.selected : hw ? COLORS[KIND(hw.type) as 'hw' | 'tap' | 'csk'] : COLORS.hover;
      const opacity = id === hover ? 0.85 : sel.has(id) ? 0.95 : hw ? 0.9 : 0;
      for (const d of list) { const mat = d.material as THREE.MeshBasicMaterial; mat.color.setHex(color); mat.opacity = opacity; }
    }
    sceneApi.current?.invalidate();
  };
  // hardware glyphs on the insertion side: rebuilt only when assignments change
  const buildGlyphs = () => {
    const m = markers.current; if (!m) return;
    m.glyphs.children.slice().forEach(c => { m.glyphs.remove(c); c.traverse(o => { const x = o as THREE.Mesh; x.geometry?.dispose?.(); (x.material as THREE.Material | undefined)?.dispose?.(); }); });
    for (const h of holes) {
      const hw = hwOf(h.id); if (!hw) continue;
      const g = glyph(h, hw); if (g) m.glyphs.add(g);
    }
    sceneApi.current?.invalidate();
  };
  useEffect(buildGlyphs, [specs, holes]);
  useEffect(paint, [selected, hover, specs, holes]);

  const pick = (e: PointerEvent, s: SceneApi) => {
    const m = markers.current; if (!m) return null;
    const ray = new THREE.Raycaster(); ray.setFromCamera(s.ndc(e.clientX, e.clientY), s.camera);
    const discs = [...m.discs.values()].flat();
    const hit = ray.intersectObjects(discs, false)[0];
    const model = s.hitModel(e.clientX, e.clientY);
    if (hit && (!model || hit.distance <= model.distance + Math.max(0.5, s.radius * 0.002))) return hit.object.userData.hole as string;
    // near a hole rim on the surface: snap to it (holes are small at assembly zoom)
    if (model) {
      let best: [string, number] | null = null;
      for (const h of holes) {
        const c = new THREE.Vector3(...h.center); const px = s.screenDistance(c, e.clientX, e.clientY);
        const rpx = h.diameter / 2 * s.pxPerMm(c);
        if (px < Math.max(rpx + 4, 7) && model.point.distanceTo(c) < h.diameter + Math.abs(h.end - h.start) + 2 && (!best || px < best[1])) best = [h.id, px];
      }
      return best?.[0] || null;
    }
    return null;
  };

  // ---------------------------------------------------------------- saving
  const save = async (ids: string[], body: Any) => {
    if (!editable || !ids.length) return;
    setBusy(true); setError('');
    try { const r = await api(`/parts/${part.id}/hardware`, 'PUT', { holes: ids, ...body }); setSpecs(r.feature_specs); changed.current = true; }
    catch (e: Any) { setError(e.message); } finally { setBusy(false); }
  };
  const flip = (ids: string[]) => { const s = hwOf(ids[0])?.side || 1; save(ids.filter(id => hwOf(id)), { side: -s }); };
  const openPicker = (ids: string[], dia: number, ev: React.MouseEvent) => {
    if (!editable) return;
    const el = panel.current!, btn = ev.currentTarget as HTMLElement;
    if (picker && picker.ids.join() === ids.join()) { setPicker(null); return; }
    // popover over the panel: below the row when there is room, otherwise above it
    const host = el.getBoundingClientRect(), box = btn.getBoundingClientRect();
    const below = innerHeight - box.bottom - 18, above = box.top - host.top - 12;
    const want = 560;
    const height = Math.min(want, below >= 360 || below >= above ? below : above);
    const top = below >= 360 || below >= above ? box.bottom + 6 : box.top - 6 - height;
    setPicker({ ids, dia, top, height, left: host.left + 6, width: host.width - 12 });
  };

  const thickness = Number(part.geometry?.thickness || 0);
  const sel = new Set(selected);
  const selRow = (ids: string[], dia: number, inGroup: boolean) => {
    const l = label(ids); const hw = l.hw; const sideable = hw && hw.type !== 'tap';
    const hole = hw?.hole ? Number(hw.hole) : null;
    const adjust = hole != null && Math.abs(hole - dia) > 0.02;
    const thin = hw?.min_sheet && thickness && thickness < hw.min_sheet - 1e-6;
    return <>
      <span className="flex min-w-0 flex-col gap-0.5">
        {l.multiple ? <Button type="button" variant="ghost" data-hc-trigger="" className="justify-start gap-2 px-2.5 font-normal [&_svg]:text-muted-foreground" disabled={!editable} onClick={e => openPicker(ids, dia, e)}><X />Multiple</Button>
          : <Button type="button" variant="outline" data-hc-trigger="" className={cn('w-full justify-between px-3 font-normal shadow-none', hw && KIND_TINT[KIND(hw.type)].border, picker?.ids.join() === ids.join() && 'border-ring')} disabled={!editable} onClick={e => openPicker(ids, dia, e)}><span className="truncate">{l.text}</span><ChevronDown className="text-muted-foreground" /></Button>}
        {(adjust || thin) && <small className={cn('inline-flex items-center gap-1 text-2xs', thin ? 'text-warning' : KIND_TINT.hw.text)}>{thin ? <><AlertTriangle className="size-3" />needs ≥ {hw.min_sheet} mm sheet</> : <>cuts Ø{hole!.toFixed(2)}</>}</small>}
      </span>
      <span className="grid place-items-center">{sideable && <Button type="button" variant="outline" size="icon" className="shadow-none" disabled={!editable} title={(hw.side || 1) > 0 ? 'Inserted from the top side — click to flip' : 'Inserted from the bottom side — click to flip'} onClick={() => flip(ids)}>{(hw.side || 1) > 0 ? <ArrowDownToLine /> : <ArrowUpToLine />}</Button>}</span>
    </>;
  };
  const sizeCell = 'flex min-w-0 cursor-pointer flex-col';
  const sizeMain = 'text-sm font-medium tabular-nums';
  const sizeSub = 'truncate text-xs text-muted-foreground';

  return (
    <div data-forge-config="" className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-[2vw] py-[2.5vh] backdrop-blur-[3px]" onMouseDown={e => { if (e.target === e.currentTarget) close(changed.current); }}>
      <section data-slot="dialog-content" className="flex h-[min(980px,95vh)] w-[min(1680px,96vw)] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-pop" role="dialog" aria-modal="true" aria-label="Hole configuration">
        <header className="flex min-h-14 items-center gap-4 border-b py-2.5 pr-3 pl-4">
          <div className="order-2 flex max-w-[52%] min-w-0 items-center gap-2 rounded-lg border border-primary/20 bg-selection px-3 py-1.5 text-sm text-selection-foreground max-[1100px]:hidden"><Info className="size-4 shrink-0" /><span className="font-medium whitespace-nowrap">Hole sizes auto-adjust.</span><span className="truncate text-muted-foreground">Inserts, taps and countersinks are cut at their mounting hole in the flat pattern and called out on the drawing.</span></div>
          <div className="mr-auto flex min-w-0 flex-col"><span className="truncate text-lg font-semibold">{part.name}</span><small className="truncate text-xs text-muted-foreground">{holes.length} hole{holes.length === 1 ? '' : 's'}{thickness ? ` · ${thickness} mm sheet` : ''}</small></div>
          <Button type="button" variant="ghost" size="icon" className="order-3" aria-label="Close" onClick={() => close(changed.current)}><X /></Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_470px] gap-3.5 p-3.5 max-[1100px]:grid-cols-[minmax(0,1fr)_380px]">
          <PartScene revision={revision} bodies={[{ part: part.id }]} navStyle={navStyle} cursor={hover ? 'pointer' : undefined}
            onReady={s => { sceneApi.current = s; build(s); paint(); buildGlyphs(); }}
            onHover={(e, s) => setHover(pick(e, s))}
            onClick={(e, s) => {
              const id = pick(e, s);
              if (!id) { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSelected([]); return; }
              setSelected(cur => e.shiftKey || e.ctrlKey || e.metaKey ? (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]) : (cur.length === 1 && cur[0] === id ? [] : [id]));
              setPicker(null);
            }}>
            <div className="glass absolute top-3.5 right-3.5 z-[3] flex max-w-[calc(100%-120px)] items-center gap-2.5 rounded-xl px-3 py-2">
              <MousePointerClick className={cn('size-4 shrink-0', selected.length ? 'box-content rounded-md bg-warning-soft p-1 text-warning' : 'text-muted-foreground')} />
              {selected.length ? <><span className="flex min-w-0 flex-col"><span className="text-sm font-medium whitespace-nowrap">{selected.length} selected hole{selected.length === 1 ? '' : 's'}</span><small className="text-xs whitespace-nowrap text-muted-foreground">Shift+click adds more.</small></span><Button type="button" variant="outline" size="xs" className="ml-1" onClick={() => setSelected([])}>Clear</Button></>
                : <span className="flex min-w-0 flex-col"><span className="text-sm font-medium whitespace-nowrap">Click holes to select</span></span>}
            </div>
          </PartScene>
          <aside className="relative min-h-0 overflow-auto rounded-xl border bg-card" ref={panel} onScroll={() => setPicker(null)}>
            <div className="pt-1 pb-2.5">
              <div className={cn(HC_GRID, 'sticky top-0 z-[2] h-10 border-b bg-card text-xs font-medium text-muted-foreground')}><span /><span>Size</span><span>Type</span><span className="text-center">Side</span></div>
              {!holes.length && <p className="p-4 text-sm text-muted-foreground">No holes were found on this part.</p>}
              {groups.map(g => {
                const ids = g.holes.map(h => h.id);
                const inSel = ids.filter(id => sel.has(id));
                const whole = inSel.length === ids.length;
                return <div key={g.key} className="border-b">
                  <div className={cn(HC_GRID, 'relative min-h-14', whole && HC_SEL)} onMouseEnter={() => setHover(null)}>
                    <Button type="button" variant="outline" size="icon-sm" className="justify-self-center rounded-full shadow-none" title={open[g.key] ? 'Hide the holes' : `Show the ${ids.length} holes`} onClick={() => { setOpen(o => ({ ...o, [g.key]: !o[g.key] })); }}>{whole && ids.length > 1 ? <span className="text-xs font-medium tabular-nums">{ids.length}</span> : open[g.key] ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}</Button>
                    <span className={sizeCell} onClick={() => setSelected(whole ? [] : ids)} title="Select all holes of this size"><span className={sizeMain}>Ø{g.dia.toFixed(2)} mm</span><small className={sizeSub}>{inch(g.dia)} · {ids.length}×</small></span>
                    {selRow(ids, g.dia, true)}
                  </div>
                  {label(ids).multiple && !open[g.key] && [...new Set(ids.map(id => hwOf(id) ? `${hwOf(id).id}|${hwOf(id).name}|${hwOf(id).side}` : ''))].map(k => {
                    const sub = ids.filter(id => (hwOf(id) ? `${hwOf(id).id}|${hwOf(id).name}|${hwOf(id).side}` : '') === k);
                    return <div key={'a' + k} className={cn(HC_GRID, 'relative min-h-13 border-t border-dashed')} onMouseEnter={() => setHover(null)}>
                      <span className={cn(HC_COUNT, 'bg-muted text-foreground')}>{sub.length}</span>
                      <span className={sizeCell} onClick={() => setSelected(sub)} title="Select these holes"><span className={sizeMain}>Ø{g.dia.toFixed(2)} mm</span><small className={sizeSub}>{k ? 'assigned' : 'no hardware'}</small></span>
                      {selRow(sub, g.dia, false)}
                    </div>;
                  })}
                  {inSel.length > 0 && !whole && <div className={cn(HC_GRID, 'relative min-h-13 border-t border-dashed border-warning/30', HC_SEL)}>
                    <span className={cn(HC_COUNT, 'bg-warning-soft text-warning')}>{inSel.length}</span>
                    <span className={sizeCell}><span className={sizeMain}>Ø{g.dia.toFixed(2)} mm</span><small className={sizeSub}>selected</small></span>
                    {selRow(inSel, g.dia, false)}
                  </div>}
                  {open[g.key] && g.holes.map(h => <div key={h.id} className={cn(HC_GRID, 'relative min-h-11 bg-subtle', sel.has(h.id) && 'bg-warning/15', hover === h.id && 'bg-warning/10')} onMouseEnter={() => setHover(h.id)} onMouseLeave={() => setHover(null)}>
                    <span />
                    <span className={sizeCell} onClick={() => setSelected([h.id])}><span className={sizeMain}>{h.id}</span><small className={sizeSub}>{Math.abs(h.end - h.start).toFixed(2)} deep</small></span>
                    {selRow([h.id], g.dia, false)}
                  </div>)}
                </div>;
              })}
            </div>
            {error && <div className="m-2.5 rounded-md bg-danger-soft px-2.5 py-2 text-xs text-destructive">{error}</div>}
            {picker && <Picker catalog={catalog} dia={picker.dia} top={picker.top} height={picker.height} left={picker.left} width={picker.width} thickness={thickness}
              assigned={picker.ids.some(id => hwOf(id))} busy={busy}
              current={label(picker.ids).hw}
              onPick={item => { save(picker.ids, { item: item.id, side: label(picker.ids).hw?.side ?? 1 }); setPicker(null); }}
              onCustom={c => { save(picker.ids, { custom: c }); setPicker(null); }}
              onRemove={() => { save(picker.ids, { item: null }); setPicker(null); }}
              onClose={() => setPicker(null)} />}
          </aside>
        </div>
      </section>
    </div>
  );
}

/** Catalogue picker: type chips, search, units, closest match for the hole, remove, custom hardware. */
function Picker({ catalog, dia, top, height, left, width, thickness, assigned, current, busy, onPick, onCustom, onRemove, onClose }: {
  catalog: Item[]; dia: number; top: number; height: number; left: number; width: number; thickness: number; assigned: boolean; current: Any; busy: boolean;
  onPick: (i: Item) => void; onCustom: (c: Any) => void; onRemove: () => void; onClose: () => void;
}) {
  const [type, setType] = useState<string>('all');
  const [q, setQ] = useState('');
  const [units, setUnits] = useState<string>(() => { try { return localStorage.getItem('forge-hw-units') || 'metric'; } catch { return 'metric'; } });
  const [custom, setCustom] = useState<Any | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { try { localStorage.setItem('forge-hw-units', units); } catch { /* private window */ } }, [units]);
  // a click on a row's type button toggles the picker itself; the units / custom-type lists open in a portal
  useEffect(() => { const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-hc-trigger], [data-slot="select-content"]')) onClose(); }; setTimeout(() => window.addEventListener('mousedown', out), 0); return () => window.removeEventListener('mousedown', out); }, []);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = catalog.filter(i => (type === 'all' || i.type === type) && (units === 'all' || i.units === units)
      && words.every(w => `${i.name} ${i.pn} ${i.thread} ${i.type}`.toLowerCase().includes(w)));
    const score = (i: Item) => i.hole == null ? 99 : Math.abs(i.hole - dia);
    return list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [catalog, type, q, units, dia]);
  const closest = rows.find(i => i.hole != null && Math.abs(i.hole - dia) < Math.max(0.6, dia * 0.12));
  const chip = 'h-8 px-1.5 font-normal shadow-none';
  return (
    <div className="fixed z-10 flex flex-col rounded-xl border bg-popover pt-3 text-popover-foreground shadow-pop" ref={box} style={{ top, height, left, width }} role="dialog" aria-label="Choose hole hardware">
      <div className="grid grid-cols-4 gap-1.5 px-3">
        <Button type="button" variant="outline" className={cn(chip, 'col-span-full border-warning/30 bg-warning-soft text-warning hover:bg-warning-soft hover:text-warning', type === 'all' && 'border-warning')} onClick={() => setType('all')}>All</Button>
        {CHIPS.map(([k, l]) => <Button key={k} type="button" variant="outline" className={cn(chip, KIND_TINT[KIND(k)].text, KIND_TINT[KIND(k)].border, type === k && KIND_TINT[KIND(k)].on)} onClick={() => setType(type === k ? 'all' : k)}>{l}</Button>)}
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_130px_auto] gap-2 px-3 py-2.5">
        <div className="relative"><Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input autoFocus className="pl-8" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} /></div>
        <Select value={units} onChange={setUnits} aria-label="Units" options={[{ value: 'metric', label: 'Metric' }, { value: 'imperial', label: 'Imperial' }, { value: 'all', label: 'All units' }]} />
        <Button type="button" variant="ghost" className="bg-danger-soft font-normal text-destructive hover:bg-danger-soft hover:text-destructive" disabled={!assigned || busy} onClick={onRemove}>Remove</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t">
        <div className={cn(PK_GRID, 'sticky top-0 z-[1] h-9 border-b bg-popover text-xs font-medium text-muted-foreground')}><span>Name</span><span>Type</span><span>P/N</span><span title="Mounting / pilot hole the hardware needs">Hole</span></div>
        {rows.map(i => {
          const fit = i.hole != null && Math.abs(i.hole - dia) <= 0.1;
          const thin = i.min_sheet && thickness && thickness < i.min_sheet - 1e-6;
          return <Button type="button" variant="ghost" key={i.id} className={cn(PK_GRID, PK_ITEM, current?.id === i.id && 'bg-selection hover:bg-selection')} disabled={busy} onClick={() => onPick(i)}>
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-sm text-ellipsis">{i.name}{i === closest && <em className="rounded-sm bg-success-soft px-1.5 text-2xs not-italic text-success">closest</em>}{thin ? <em className="rounded-sm bg-warning-soft px-1.5 text-2xs not-italic text-warning" title={`Needs at least ${i.min_sheet} mm sheet`}>≥{i.min_sheet} mm</em> : null}</span>
            <span><i className={cn('inline-flex rounded-md border px-2 py-0.5 text-xs not-italic', KIND_TINT[KIND(i.type)].badge)}>{KIND_LABEL[KIND(i.type)]}</i></span>
            <span className="truncate text-xs text-primary">{i.pn || '—'}</span>
            <span className={cn('text-xs tabular-nums', fit ? 'font-medium text-success' : 'text-muted-foreground')}>{i.hole == null ? <small title="Take the mounting hole from the supplier datasheet">datasheet</small> : `Ø${i.hole.toFixed(2)}`}</span>
          </Button>;
        })}
        {!rows.length && <p className="p-4 text-sm text-muted-foreground">Nothing matches.</p>}
        {!custom ? <Button type="button" variant="ghost" className={cn(PK_GRID, PK_ITEM)} onClick={() => setCustom({ type: type === 'all' ? 'nut' : type, name: '', pn: '', hole: dia.toFixed(2) })}><span className="flex min-w-0 items-center gap-1.5 text-sm text-primary"><Plus className="size-3.5" />Custom hardware…</span></Button>
          : <form className="grid grid-cols-[110px_minmax(0,1fr)_110px] items-end gap-1.5 bg-subtle px-3 py-2.5" onSubmit={e => { e.preventDefault(); onCustom(custom); }}>
            <Select value={custom.type} onChange={v => setCustom({ ...custom, type: v })} aria-label="Hardware type" options={CHIPS.map(([k, l]) => ({ value: k, label: l }))} />
            <Input required placeholder="Name, e.g. PEM CLS-M4-2" value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} />
            <Input placeholder="Part number" value={custom.pn} onChange={e => setCustom({ ...custom, pn: e.target.value })} />
            <Label className="flex-col items-stretch gap-1 text-2xs leading-normal font-normal text-muted-foreground select-auto">Hole Ø<Input inputMode="decimal" value={custom.hole} onChange={e => setCustom({ ...custom, hole: e.target.value })} /></Label>
            {custom.type === 'countersink' && <Label className="flex-col items-stretch gap-1 text-2xs leading-normal font-normal text-muted-foreground select-auto">CSK Ø<Input inputMode="decimal" value={custom.csk || ''} onChange={e => setCustom({ ...custom, csk: e.target.value })} /></Label>}
            <Button type="submit" disabled={busy}>Use</Button>
            <Button type="button" variant="ghost" size="icon" title="Cancel" onClick={() => setCustom(null)}><Trash2 className="size-3.5" /></Button>
          </form>}
      </div>
      <small className="border-t px-3 pt-2 pb-2.5 text-2xs text-faint">Mounting holes: PEM bulletins, ISO 2306 tap drills, ISO 15065 countersinks — confirm against your supplier's datasheet.</small>
    </div>
  );
}

/** 3D model of the hardware in the hole, on its insertion side (see hardware3d.ts). */
function glyph(h: Hole, hw: Any): THREE.Object3D | null {
  const g = hardwareModel(h, hw);
  if (g) g.userData.hole = h.id;
  return g;
}
