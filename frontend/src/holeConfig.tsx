import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { X, ChevronDown, ChevronUp, Search, MousePointerClick, ArrowDownToLine, ArrowUpToLine, Info, Plus, Trash2, AlertTriangle } from 'lucide-react';
import PartScene, { type SceneApi } from './partScene';
import { api } from './api';
import type { Any } from './constants';
import type { NavStyle } from './cadControls';

type Item = { id: string; type: string; units: string; thread: string; name: string; pn: string; hole: number | null; min_sheet?: number | null; length?: number | null; csk?: number; angle?: number; custom?: boolean };
type Hole = { id: string; diameter: number; axis: number[]; origin: number[]; start: number; end: number; center: number[]; depth: number };

const CHIPS: [string, string][] = [['nut', 'Nut'], ['flush_nut', 'Flush Nut'], ['stud', 'Stud'], ['standoff', 'Standoff'], ['rivnut', 'Rivnut'], ['tap', 'Tap'], ['countersink', 'Countersink']];
const KIND = (t: string) => t === 'tap' ? 'tap' : t === 'countersink' ? 'csk' : 'hw';
const KIND_LABEL: Record<string, string> = { hw: 'Hardware', tap: 'Tap', csk: 'Countersink' };
const COLORS = { hover: 0xf6d34a, selected: 0xf2c200, hw: 0xa78bfa, tap: 0x60a5fa, csk: 0x4ade80, metal: 0xc9a227 };
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
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); if (picker) setPicker(null); else if (selected.length) setSelected([]); else close(changed.current); } };
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
      <span className="hc-type">
        {l.multiple ? <button type="button" className="hc-multi" disabled={!editable} onClick={e => openPicker(ids, dia, e)}><X size={14} />Multiple</button>
          : <button type="button" className={'hc-select' + (hw ? ' set ' + KIND(hw.type) : '') + (picker?.ids.join() === ids.join() ? ' open' : '')} disabled={!editable} onClick={e => openPicker(ids, dia, e)}><span>{l.text}</span><ChevronDown size={15} /></button>}
        {(adjust || thin) && <small className={'hc-note' + (thin ? ' warn' : '')}>{thin ? <><AlertTriangle size={11} />needs ≥ {hw.min_sheet} mm sheet</> : <>cuts Ø{hole!.toFixed(2)}</>}</small>}
      </span>
      <span className="hc-side">{sideable && <button type="button" className="hc-flip" disabled={!editable} title={(hw.side || 1) > 0 ? 'Inserted from the top side — click to flip' : 'Inserted from the bottom side — click to flip'} onClick={() => flip(ids)}>{(hw.side || 1) > 0 ? <ArrowDownToLine size={16} /> : <ArrowUpToLine size={16} />}</button>}</span>
    </>;
  };

  return (
    <div className="overlay top cfg-overlay" onMouseDown={e => { if (e.target === e.currentTarget) close(changed.current); }}>
      <section className="cfg-dialog" role="dialog" aria-modal="true" aria-label="Hole configuration">
        <header className="cfg-head">
          <div className="cfg-banner"><Info size={15} /><b>Hole sizes auto-adjust.</b><span>Inserts, taps and countersinks are cut at their mounting hole in the flat pattern and called out on the drawing.</span></div>
          <div className="cfg-title"><b>{part.name}</b><small>{holes.length} hole{holes.length === 1 ? '' : 's'}{thickness ? ` · ${thickness} mm sheet` : ''}</small></div>
          <button type="button" className="icon cfg-close" aria-label="Close" onClick={() => close(changed.current)}><X size={18} /></button>
        </header>
        <div className="cfg-body">
          <PartScene revision={revision} bodies={[{ part: part.id }]} navStyle={navStyle} cursor={hover ? 'pointer' : undefined}
            onReady={s => { sceneApi.current = s; build(s); paint(); buildGlyphs(); }}
            onHover={(e, s) => setHover(pick(e, s))}
            onClick={(e, s) => {
              const id = pick(e, s);
              if (!id) { if (!e.shiftKey && !e.ctrlKey && !e.metaKey) setSelected([]); return; }
              setSelected(cur => e.shiftKey || e.ctrlKey || e.metaKey ? (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]) : (cur.length === 1 && cur[0] === id ? [] : [id]));
              setPicker(null);
            }}>
            <div className={'cfg-chip' + (selected.length ? ' on' : '')}>
              <MousePointerClick size={16} />
              {selected.length ? <><span><b>{selected.length} selected hole{selected.length === 1 ? '' : 's'}</b><small>Shift+click adds more.</small></span><button type="button" className="mini" onClick={() => setSelected([])}>Clear</button></>
                : <span><b>Click holes to select</b></span>}
            </div>
          </PartScene>
          <aside className="cfg-panel" ref={panel} onScroll={() => setPicker(null)}>
            <div className="hc-table">
              <div className="hc-head"><span /><span>Size</span><span>Type</span><span>Side</span></div>
              {!holes.length && <p className="muted hc-empty">No holes were found on this part.</p>}
              {groups.map(g => {
                const ids = g.holes.map(h => h.id);
                const inSel = ids.filter(id => sel.has(id));
                const whole = inSel.length === ids.length;
                return <div key={g.key} className={'hc-group' + (whole ? ' chosen' : '')}>
                  <div className={'hc-row' + (whole ? ' sel' : '')} onMouseEnter={() => setHover(null)}>
                    <button type="button" className="hc-exp" title={open[g.key] ? 'Hide the holes' : `Show the ${ids.length} holes`} onClick={() => { setOpen(o => ({ ...o, [g.key]: !o[g.key] })); }}>{whole && ids.length > 1 ? <b>{ids.length}</b> : open[g.key] ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button>
                    <span className="hc-size" onClick={() => setSelected(whole ? [] : ids)} title="Select all holes of this size"><b>Ø{g.dia.toFixed(2)} mm</b><small>{inch(g.dia)} · {ids.length}×</small></span>
                    {selRow(ids, g.dia, true)}
                  </div>
                  {label(ids).multiple && !open[g.key] && [...new Set(ids.map(id => hwOf(id) ? `${hwOf(id).id}|${hwOf(id).name}|${hwOf(id).side}` : ''))].map(k => {
                    const sub = ids.filter(id => (hwOf(id) ? `${hwOf(id).id}|${hwOf(id).name}|${hwOf(id).side}` : '') === k);
                    return <div key={'a' + k} className="hc-row sub assigned" onMouseEnter={() => setHover(null)}>
                      <span className="hc-count plain">{sub.length}</span>
                      <span className="hc-size" onClick={() => setSelected(sub)} title="Select these holes"><b>Ø{g.dia.toFixed(2)} mm</b><small>{k ? 'assigned' : 'no hardware'}</small></span>
                      {selRow(sub, g.dia, false)}
                    </div>;
                  })}
                  {inSel.length > 0 && !whole && <div className="hc-row sel sub">
                    <span className="hc-count">{inSel.length}</span>
                    <span className="hc-size"><b>Ø{g.dia.toFixed(2)} mm</b><small>selected</small></span>
                    {selRow(inSel, g.dia, false)}
                  </div>}
                  {open[g.key] && g.holes.map(h => <div key={h.id} className={'hc-row hole' + (sel.has(h.id) ? ' sel' : '') + (hover === h.id ? ' hot' : '')} onMouseEnter={() => setHover(h.id)} onMouseLeave={() => setHover(null)}>
                    <span />
                    <span className="hc-size" onClick={() => setSelected([h.id])}><b>{h.id}</b><small>{Math.abs(h.end - h.start).toFixed(2)} deep</small></span>
                    {selRow([h.id], g.dia, false)}
                  </div>)}
                </div>;
              })}
            </div>
            {error && <div className="cfg-error">{error}</div>}
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
  useEffect(() => { const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.hc-select, .hc-multi')) onClose(); }; setTimeout(() => window.addEventListener('mousedown', out), 0); return () => window.removeEventListener('mousedown', out); }, []);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = catalog.filter(i => (type === 'all' || i.type === type) && (units === 'all' || i.units === units)
      && words.every(w => `${i.name} ${i.pn} ${i.thread} ${i.type}`.toLowerCase().includes(w)));
    const score = (i: Item) => i.hole == null ? 99 : Math.abs(i.hole - dia);
    return list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [catalog, type, q, units, dia]);
  const closest = rows.find(i => i.hole != null && Math.abs(i.hole - dia) < Math.max(0.6, dia * 0.12));
  return (
    <div className="hc-picker" ref={box} style={{ top, height, left, width }} role="dialog" aria-label="Choose hole hardware">
      <div className="hc-chips">
        <button type="button" className={'all' + (type === 'all' ? ' on' : '')} onClick={() => setType('all')}>All</button>
        {CHIPS.map(([k, l]) => <button key={k} type="button" className={KIND(k) + (type === k ? ' on' : '')} onClick={() => setType(type === k ? 'all' : k)}>{l}</button>)}
      </div>
      <div className="hc-tools">
        <label className="hc-search"><Search size={15} /><input autoFocus placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} /></label>
        <select value={units} onChange={e => setUnits(e.target.value)} aria-label="Units"><option value="metric">Metric</option><option value="imperial">Imperial</option><option value="all">All units</option></select>
        <button type="button" className="hc-remove" disabled={!assigned || busy} onClick={onRemove}>Remove</button>
      </div>
      <div className="hc-list">
        <div className="hc-lh"><span>Name</span><span>Type</span><span>P/N</span><span title="Mounting / pilot hole the hardware needs">Hole</span></div>
        {rows.map(i => {
          const fit = i.hole != null && Math.abs(i.hole - dia) <= 0.1;
          const thin = i.min_sheet && thickness && thickness < i.min_sheet - 1e-6;
          return <button type="button" key={i.id} className={'hc-item' + (current?.id === i.id ? ' current' : '')} disabled={busy} onClick={() => onPick(i)}>
            <span className="nm">{i.name}{i === closest && <em className="closest">closest</em>}{thin ? <em className="thin" title={`Needs at least ${i.min_sheet} mm sheet`}>≥{i.min_sheet} mm</em> : null}</span>
            <span><i className={'hc-badge ' + KIND(i.type)}>{KIND_LABEL[KIND(i.type)]}</i></span>
            <span className="pn">{i.pn || '—'}</span>
            <span className={'hl' + (fit ? ' fit' : '')}>{i.hole == null ? <small title="Take the mounting hole from the supplier datasheet">datasheet</small> : `Ø${i.hole.toFixed(2)}`}</span>
          </button>;
        })}
        {!rows.length && <p className="muted hc-empty">Nothing matches.</p>}
        {!custom ? <button type="button" className="hc-item add" onClick={() => setCustom({ type: type === 'all' ? 'nut' : type, name: '', pn: '', hole: dia.toFixed(2) })}><span className="nm"><Plus size={14} />Custom hardware…</span></button>
          : <form className="hc-custom" onSubmit={e => { e.preventDefault(); onCustom(custom); }}>
            <select value={custom.type} onChange={e => setCustom({ ...custom, type: e.target.value })}>{CHIPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
            <input required placeholder="Name, e.g. PEM CLS-M4-2" value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} />
            <input placeholder="Part number" value={custom.pn} onChange={e => setCustom({ ...custom, pn: e.target.value })} />
            <label>Hole Ø<input inputMode="decimal" value={custom.hole} onChange={e => setCustom({ ...custom, hole: e.target.value })} /></label>
            {custom.type === 'countersink' && <label>CSK Ø<input inputMode="decimal" value={custom.csk || ''} onChange={e => setCustom({ ...custom, csk: e.target.value })} /></label>}
            <button type="submit" className="primary" disabled={busy}>Use</button>
            <button type="button" className="icon" title="Cancel" onClick={() => setCustom(null)}><Trash2 size={14} /></button>
          </form>}
      </div>
      <small className="hc-foot">Mounting holes: PEM bulletins, ISO 2306 tap drills, ISO 15065 countersinks — confirm against your supplier's datasheet.</small>
    </div>
  );
}

/** 3D sign of the hardware in the hole, on its insertion side. */
function glyph(h: Hole, hw: Any): THREE.Object3D | null {
  const a = new THREE.Vector3(...h.axis).normalize(), o = new THREE.Vector3(...h.origin);
  const side = hw.side || 1;
  const top = side > 0 ? Math.max(h.start, h.end) : Math.min(h.start, h.end), bottom = side > 0 ? Math.min(h.start, h.end) : Math.max(h.start, h.end);
  const face = o.clone().addScaledVector(a, top), back = o.clone().addScaledVector(a, bottom);
  const out = a.clone().multiplyScalar(side);
  const d = threadDia(hw.thread || '') || (hw.hole || h.diameter) * 0.8;
  const g = new THREE.Group();
  const mat = (c: number, opacity = 1) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.35, transparent: opacity < 1, opacity });
  const along = (len: number, from: THREE.Vector3, dir: THREE.Vector3, geo: THREE.BufferGeometry, m: THREE.Material) => {
    const mesh = new THREE.Mesh(geo, m); mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize()); mesh.position.copy(from).addScaledVector(dir.clone().normalize(), len / 2); return mesh;
  };
  const rings = (from: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, color: number) => {
    const n = Math.max(3, Math.floor(len / Math.max(0.5, d * 0.18)));
    for (let i = 1; i < n; i++) { const t = new THREE.Mesh(new THREE.TorusGeometry(r, Math.max(0.06, r * 0.07), 6, 24), mat(color)); t.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir.clone().normalize()); t.position.copy(from).addScaledVector(dir.clone().normalize(), len * i / n); g.add(t); }
  };
  if (hw.type === 'nut' || hw.type === 'flush_nut') {
    const R = (hw.hole || h.diameter) * (hw.type === 'nut' ? 0.95 : 0.75), H = hw.type === 'nut' ? Math.max(0.6, d * 0.45) : 0.15;
    g.add(along(H, face, out, new THREE.CylinderGeometry(R, R, H, 6), mat(COLORS.hw)));
  } else if (hw.type === 'stud') {
    const L = Number(hw.length || d * 2.5);
    g.add(along(0.25, face, out, new THREE.CylinderGeometry(d * 0.85, d * 0.85, 0.25, 32), mat(COLORS.metal)));
    g.add(along(L, back, out.clone().negate(), new THREE.CylinderGeometry(d / 2 * 0.92, d / 2 * 0.92, L, 24), mat(COLORS.metal)));
    rings(back, out.clone().negate(), L, d / 2 * 0.93, 0x9c7c12);
  } else if (hw.type === 'standoff') {
    const L = Number(hw.length || d * 3), R = Math.max(d * 0.9, (hw.hole || d) / 2 * 1.4);
    g.add(along(L, back, out.clone().negate(), new THREE.CylinderGeometry(R, R, L, 6), mat(COLORS.hw)));
  } else if (hw.type === 'rivnut') {
    const R = (hw.hole || h.diameter) * 0.85;
    g.add(along(0.6, face, out, new THREE.CylinderGeometry(R, R, 0.6, 32), mat(COLORS.hw)));
    g.add(along(d * 1.6, back, out.clone().negate(), new THREE.CylinderGeometry((hw.hole || h.diameter) / 2 * 0.98, (hw.hole || h.diameter) / 2 * 0.98, d * 1.6, 24), mat(COLORS.hw, 0.85)));
  } else if (hw.type === 'tap') {
    rings(back, a.clone().multiplyScalar(top - bottom >= 0 ? 1 : -1), Math.abs(top - bottom), (hw.hole || h.diameter) / 2 * 1.02, 0x2563eb);
  } else if (hw.type === 'countersink') {
    const R = (hw.csk || h.diameter * 2) / 2, ang = THREE.MathUtils.degToRad((hw.angle || 90) / 2), depth = (R - h.diameter / 2) / Math.tan(ang);
    const cone = new THREE.Mesh(new THREE.CylinderGeometry(R, h.diameter / 2, depth, 40, 1, true), new THREE.MeshStandardMaterial({ color: COLORS.csk, side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
    cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out); cone.position.copy(face).addScaledVector(out, -depth / 2 + 0.02); g.add(cone);
  }
  g.userData.hole = h.id;
  return g;
}
