import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { X, Crosshair, Trash2, Flame, LoaderCircle, ClipboardList, Layers, Target } from 'lucide-react';
import PartScene, { type SceneApi, type SceneBody } from './partScene';
import { api, assetJson } from './api';
import type { Any } from './constants';
import type { NavStyle } from './cadControls';
import { pathLength, pathSection, pointAt } from './weld3d';
import { seamSelection, findAllSeams, Field, MmInput } from './welding';
import { Select } from './controls';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const cardCls = 'grid gap-3 rounded-lg border bg-card p-4';
const msgCls = 'flex items-center gap-1.5 rounded-lg border bg-card/95 px-3 py-2 text-xs text-muted-foreground shadow-pop';
/** segmented control: track + items (Button for the tab list, ToggleGroupItem for the side filter) */
const segCls = 'grid w-full auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-muted p-0.5';
const segItem = (on: boolean) => cn('h-7 text-xs font-normal', on ? 'bg-card text-foreground shadow-xs hover:bg-card dark:bg-input dark:hover:bg-input' : 'text-muted-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent');
const segToggle = 'h-7 gap-1 px-2 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-xs dark:data-[state=on]:bg-input';
/** seam / weld colours, matching the 3D overlay (COL) */
const dotCls = 'inline-block size-2 shrink-0 rounded-full align-[-1px]';
const DOT: Record<string, string> = { inside: 'bg-[#0ea5e9]', outside: 'bg-[#f59e0b]', weld: 'bg-[#e0479e]' };
const SIDE_TAG: Record<string, string> = { inside: 'bg-sky-500/15 text-sky-700 dark:text-sky-300', outside: 'bg-amber-500/15 text-amber-700 dark:text-amber-300' };

type Mode = 'full' | 'stitch' | 'tack' | 'manual';
type Seam = Any & { world: THREE.Vector3[]; len: number; air: THREE.Vector3 | null };
type Hit = { seam: Seam; s: number; px: number };
type Candidate = { seam: Seam; type: 'linear' | 'stitch' | 'tack'; range: [number, number]; pitch?: number; length?: number; pattern: 'single' | 'full' | 'manual' };

const COL = { preview: 0xf5c518, weld: 0xe0479e, remove: 0xef4444, focus: 0x2563eb, seam: 0xf59e0b, inside: 0x0ea5e9, outside: 0xf59e0b };
type Side = 'all' | 'inside' | 'outside';
const SIDE_LABEL: Record<string, string> = { inside: 'inside', outside: 'outside' };
const PROCESSES = [['MIG/MAG (135)', 'MIG/MAG'], ['TIG (141)', 'TIG'], ['Laser (52)', 'Laser'], ['MMA (111)', 'Stick']];
const seamId = (f: Any) => `${f.part}|${f.occurrence || 0}|${f.key ?? f.index}`;
const fmt = (mm: number) => mm >= 1000 ? `${(mm / 1000).toFixed(2)} m` : `${mm < 10 ? mm.toFixed(1) : Math.round(mm)} mm`;
const m4 = (m?: number[][]) => { const t = new THREE.Matrix4(); if (m) t.set(...(m.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number])); return t; };

/** Evenly spaced pattern over a seam: n beads of `len` with `gap` between, centred. */
function pattern(L: number, len: number, gap: number): [number, number, number] {
  const n = Math.max(1, Math.floor((L + gap) / (len + gap)));
  const used = n * len + (n - 1) * gap, off = Math.max(0, (L - used) / 2);
  return [off, Math.min(L, L - off), len + gap];
}

/**
 * Weld dialog: hover a seam to preview the weld, click to add it, click a weld to remove it. Full welds the
 * whole seam; Stitch places one stitch (or a stitch pattern along the seam); Tack places one tack (or a row);
 * Manual: press on a seam and drag along it. Overlapping welds on a seam merge. Each weld is saved at once.
 */
export default function WeldConfig({ revision, partIds: initialParts, weldment, parts, joints, editable, navStyle, canJobOrder, onJobOrder, close }: {
  revision: string; partIds: string[]; weldment?: Any | null; parts: Any[]; joints: Any[]; editable: boolean; navStyle?: NavStyle;
  canJobOrder?: boolean; onJobOrder?: (w: Any) => void; close: (changed: boolean) => void;
}) {
  const [partIds, setPartIds] = useState<string[]>(initialParts);
  const [asm, setAsm] = useState<Any | null>(weldment || null);
  const [name, setName] = useState<string>(weldment?.name || '');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<{ title: string; text: string; go: () => void } | null>(null);
  const [seams, setSeams] = useState<Seam[] | null>(null);
  const [bodies, setBodies] = useState<SceneBody[] | null>(null);
  const [message, setMessage] = useState('');
  const [searching, setSearching] = useState('');
  const [welds, setWelds] = useState<Any[]>(() => joints.filter(j => j.kind === 'weld' && (j.data.parts || []).every((p: string) => partIds.includes(p))));
  const [mode, setMode] = useState<Mode>('full');
  const [side, setSide] = useState<Side>('all');
  const [stitchLen, setStitchLen] = useState(25);
  const [gap, setGap] = useState(50);
  const [fullPattern, setFullPattern] = useState(false);
  const [process, setProcess] = useState('MIG/MAG (135)');
  const [hover, setHover] = useState<{ cand?: Candidate; weld?: string; merge?: string[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ seam: Seam; a: number; b: number } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const changed = useRef(false);
  const scene = useRef<SceneApi | null>(null);
  const layer = useRef<{ seams: THREE.Group; welds: THREE.Group; preview: THREE.Group } | null>(null);
  const matrices = useRef<Map<string, THREE.Matrix4>>(new Map());
  const names = useMemo(() => Object.fromEntries(parts.map(p => [p.id, p.name])), [parts]);
  const [hotPart, setHotPart] = useState<string | null>(null);
  const short = (pid: string) => { const p = parts.find(x => x.id === pid); if (!p) return pid; if (p.alias) return p.alias; const n = String(p.name); return n.includes(',') ? n.slice(n.lastIndexOf(',') + 1).trim() || n : n; };

  // ---------------------------------------------------------------- seams + placements
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const inst = await assetJson(`/revisions/${revision}/assets/instances.json`).catch(() => ({}));
        if (!live) return;
        let shown = false;
        const show = (r: Any, final: boolean) => {
        const keyOf = (p: string, o: number) => `${p}|${o}`;
        const used = new Map<string, SceneBody>();
        const add = (p: string, o = 0) => { const k = keyOf(p, o); if (!used.has(k)) used.set(k, { part: p, occurrence: o, matrix: inst?.[p]?.[o]?.matrix }); };
        for (const s of r.seams || []) { add(s.part, s.occurrence || 0); add(s.other_part, s.other_occurrence || 0); }
        for (const w of welds) for (const f of w.data.faces || []) add(f.part, f.occurrence || 0);
        for (const p of partIds) if (![...used.values()].some(b => b.part === p)) add(p, 0);
        // one part on its own: draw it at its own coordinates (no assembly placement needed)
        const list = [...used.values()];
        if (partIds.length === 1 && list.every(b => b.part === partIds[0] && (b.occurrence || 0) === (list[0].occurrence || 0))) list.forEach(b => { b.matrix = undefined; });
        matrices.current = new Map(list.map(b => [keyOf(b.part, b.occurrence || 0), m4(b.matrix)]));
        const ws: Seam[] = (r.seams || []).map((s: Any) => {
          const t = matrices.current.get(keyOf(s.part, s.occurrence || 0)) || new THREE.Matrix4();
          const world = (s.boundaries?.[0] || [s.start, s.end]).map((p: number[]) => new THREE.Vector3(...p).applyMatrix4(t));
          const air = s.access_local ? new THREE.Vector3(...s.access_local).transformDirection(t)   // where the welder works from
            : s.legs?.length === 2 ? new THREE.Vector3(...s.legs[0]).add(new THREE.Vector3(...s.legs[1])).normalize().transformDirection(t) : null;
          return { ...s, world, len: pathLength(world), air };
        }).filter((s: Seam) => s.len > 0.5);
        // while searching keep the first scene (a new body list reloads every model); the final list adds the rest
        if (final || !shown) setBodies(list);
        shown = true; setSeams(ws);
        setSearching(final ? '' : `Searching seams… ${r.searched} of ${r.total} component pairs`);
        setMessage(final ? (r.message || (ws.length ? '' : 'No weldable seams were found.')) : '');
        };
        show(await findAllSeams(revision, partIds, p => live && show(p, false), () => live), true);
      } catch (e: Any) { if (live) { setSearching(''); setSeams([]); setBodies(partIds.map(p => ({ part: p }))); setMessage(e.message); } }
    })();
    return () => { live = false; };
  }, [revision, partIds.join()]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(changed.current); } };
    window.addEventListener('keydown', key, true); return () => window.removeEventListener('keydown', key, true);
  }, []);

  // world path of a saved weld face
  const weldPaths = (w: Any) => (w.data.faces || []).filter((f: Any) => f.selection === 'edge').map((f: Any) => {
    const t = matrices.current.get(`${f.part}|${f.occurrence || 0}`) || new THREE.Matrix4();
    const path = (f.boundaries?.[0] || []).map((p: number[]) => new THREE.Vector3(...p).applyMatrix4(t));
    return { face: f, path, len: pathLength(path) };
  }).filter((x: Any) => x.path.length >= 2);

  // ---------------------------------------------------------------- drawing
  const tube = (path: THREE.Vector3[], r: number, color: number, opacity = 1) => {
    if (path.length < 2 || pathLength(path) < 0.01) return null;
    const curve = new THREE.CurvePath<THREE.Vector3>(); for (let i = 1; i < path.length; i++) if (path[i].distanceTo(path[i - 1]) > 1e-6) curve.add(new THREE.LineCurve3(path[i - 1], path[i]));
    if (!curve.curves.length) return null;
    const m = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.min(400, curve.curves.length * 6 + 8), r, 10, false), new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: opacity < 1, opacity, depthTest: true }));
    m.renderOrder = 12; return m;
  };
  const ball = (p: THREE.Vector3, r: number, color: number, opacity = 1) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: opacity < 1, opacity })); m.position.copy(p); m.renderOrder = 12; return m; };
  /** beads of one weld-like spec along a path */
  const beads = (g: THREE.Group, path: THREE.Vector3[], type: string, range: number[] | undefined, pitch: number, seg: number, r: number, color: number, opacity = 1) => {
    const L = pathLength(path); const [a, b] = range ? [Math.max(0, range[0]), Math.min(L, range[1])] : [0, L];
    if (type === 'tack') { for (let s = a; s <= b + 0.01; s += Math.max(1, pitch)) { g.add(ball(pointAt(path, s), r * 1.7, color, opacity)); if (b - a < 0.01) break; } return; }
    if (type === 'stitch') { for (let s = a; s < b - 0.01; s += Math.max(1, pitch)) { const m = tube(pathSection(path, s, Math.min(b, s + seg)), r, color, opacity); if (m) g.add(m); } return; }
    const m = tube(a > 0.01 || b < L - 0.01 ? pathSection(path, a, b) : path, r, color, opacity); if (m) g.add(m);
  };
  const radius = () => { const s = scene.current; return s ? Math.max(0.3, s.radius * 0.0045) : 1; };
  /** a seam / bead path lifted off the metal on its air side, so an inside corner never shows through to the outside */
  const lifted = (path: THREE.Vector3[], air: THREE.Vector3 | null | undefined, r: number) => air ? path.map(p => p.clone().addScaledVector(air, r * 1.15)) : path;
  /** air side of a seam or saved weld: stored with it, else (older welds) the bisector of its fillet legs */
  const airOf = (f: Any) => {
    const t = matrices.current.get(`${f.part}|${f.occurrence || 0}`) || new THREE.Matrix4();
    if (f.access_local) return new THREE.Vector3(...f.access_local).transformDirection(t);
    if (f.legs?.length === 2) { const v = new THREE.Vector3(...f.legs[0]).add(new THREE.Vector3(...f.legs[1])); return v.lengthSq() > 1e-9 ? v.transformDirection(t) : null; }
    if (f.normal) return new THREE.Vector3(...f.normal).transformDirection(t);
    return null;
  };
  const thick = useMemo(() => Object.fromEntries(parts.map(p => [p.id, Number(p.geometry?.thickness) || 0])), [parts]);
  /** draw radius for a seam / bead, by sheet thickness: lifted to its air side it may be about as thick as the
   *  sheet; without a known side it stays thinner than half the sheet, so it can never poke through */
  const rOf = (f: Any, air?: THREE.Vector3 | null) => {
    const t = Math.min(...[thick[f.part], thick[f.other_part], Number(f.thickness)].filter(x => x > 0));
    return isFinite(t) ? Math.min(radius(), Math.max(0.3, (air ? 0.9 : 0.42) * t)) : radius();
  };
  const visible = (sm: Seam) => side === 'all' || !sm.side || sm.side === side;
  const clear = (g: THREE.Group) => { g.children.slice().forEach(c => { g.remove(c); c.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material | undefined)?.dispose?.(); }); }); };

  const drawAll = () => {
    const L = layer.current, s = scene.current; if (!L || !s) return;
    clear(L.seams); clear(L.welds); clear(L.preview);
    const r = radius();
    for (const seam of seams || []) {
      if (!visible(seam)) continue;
      const rs = rOf(seam, seam.air) * 0.6;
      const m = tube(lifted(seam.world, seam.air, rs), rs, seam.side === 'inside' ? COL.inside : COL.outside, 0.9); if (m) { m.renderOrder = 9; L.seams.add(m); }
    }
    for (const w of welds) {
      const color = hover?.weld === w.id || hover?.merge?.includes(w.id) ? COL.remove : focus === w.id || picked.has(w.id) || (hotPart && (w.data.parts || []).includes(hotPart)) ? COL.focus : COL.weld;
      const wd = w.data.weld || {};
      for (const { face, path } of weldPaths(w)) { const air = airOf(face), rw = rOf(face, air); beads(L.welds, lifted(path, air, rw), wd.type || 'linear', face.range, Number(wd.pitch || 50), Number(wd.length || 25), rw, color); }
    }
    const c = hover?.cand;
    if (c && !hover?.weld) { const rp = rOf(c.seam, c.seam.air) * 1.1; beads(L.preview, lifted(c.seam.world, c.seam.air, rp), c.type, c.range, c.pitch || 0, c.length || 0, rp, COL.preview, 0.85); }
    if (drag) { const rp = rOf(drag.seam, drag.seam.air) * 1.1; beads(L.preview, lifted(drag.seam.world, drag.seam.air, rp), 'linear', [Math.min(drag.a, drag.b), Math.max(drag.a, drag.b)], 0, 0, rp, COL.preview, 0.9); }
    s.invalidate();
  };
  useEffect(drawAll, [seams, welds, hover, focus, drag, side, picked, hotPart]);

  // ---------------------------------------------------------------- picking
  const seamAt = (e: PointerEvent, s: SceneApi, only?: Seam): Hit | null => {
    const rect = s.dom.getBoundingClientRect();
    const scr = (p: THREE.Vector3) => { const q = p.clone().project(s.camera); return new THREE.Vector2((q.x + 1) / 2 * rect.width + rect.left, (1 - q.y) / 2 * rect.height + rect.top); };
    const m = new THREE.Vector2(e.clientX, e.clientY);
    const model = only ? null : s.hitModel(e.clientX, e.clientY);
    let best: Hit | null = null;
    const lift = radius() * 0.3;
    for (const seam of only ? [only] : (seams || []).filter(visible)) {
      let run = 0;
      for (let i = 1; i < seam.world.length; i++) {
        const A = seam.world[i - 1], B = seam.world[i], segLen = A.distanceTo(B);
        // a seam is only picked from its own (air) side: the inside corner cannot be clicked through the sheet
        if (!only && seam.air && seam.air.dot(s.camera.position.clone().sub(A)) <= 0) { run += segLen; continue; }
        const a = scr(A), b = scr(B), ab = b.clone().sub(a), t = Math.max(0, Math.min(1, ab.lengthSq() ? m.clone().sub(a).dot(ab) / ab.lengthSq() : 0));
        const px = a.clone().addScaledVector(ab, t).distanceTo(m);
        const P = A.clone().lerp(B, t);
        if (seam.air) P.addScaledVector(seam.air, lift);
        if ((only || px < 14) && (!best || px < best.px)) {
          // hidden behind the part? (lifted to its air side, so only a small allowance is needed)
          const occluded = model && model.distance < s.camera.position.distanceTo(P) - (seam.air ? Math.max(.3, 2 / s.pxPerMm(P)) : Math.max(1.5, 6 / s.pxPerMm(P)));
          if (!occluded || only) best = { seam, s: run + segLen * t, px };
        }
        run += segLen;
      }
    }
    return best;
  };
  const weldAt = (e: PointerEvent, s: SceneApi, near?: Hit | null): string | null => {
    // a saved weld under the cursor: on the hovered seam within its range (tacks: within a few mm)
    if (!near) return null;
    const id = seamId(near.seam);
    for (const w of welds) {
      const wd = w.data.weld || {};
      for (const f of w.data.faces || []) {
        if (f.selection !== 'edge' || seamId(f) !== id) continue;
        const [a, b] = f.range || [0, near.seam.len];
        const tol = Math.max(1.5, 8 / s.pxPerMm(pointAt(near.seam.world, near.s)));
        if (wd.type === 'tack') {
          const pitch = Math.max(1, Number(wd.pitch || 50));
          for (let x = a; x <= b + 0.01; x += pitch) { if (Math.abs(near.s - x) < tol) return w.id; if (b - a < 0.01) break; }
        } else if (near.s >= a - tol * 0.3 && near.s <= b + tol * 0.3) return w.id;
      }
    }
    return null;
  };
  const candidate = (h: Hit): Candidate => {
    const L = h.seam.len;
    if (mode === 'full' || mode === 'manual') return { seam: h.seam, type: 'linear', range: [0, L], pattern: mode === 'manual' ? 'manual' : 'full' };
    if (mode === 'stitch') {
      if (fullPattern) { const [a, b, p] = pattern(L, stitchLen, gap); return { seam: h.seam, type: 'stitch', range: [a, b], pitch: p, length: stitchLen, pattern: 'full' }; }
      const len = Math.min(stitchLen, L); const a = Math.max(0, Math.min(L - len, h.s - len / 2));
      return { seam: h.seam, type: 'stitch', range: [a, a + len], pitch: len, length: len, pattern: 'single' };
    }
    if (fullPattern) { const [a, b, p] = pattern(L, 0, gap); return { seam: h.seam, type: 'tack', range: [a, b], pitch: p, pattern: 'full' }; }
    return { seam: h.seam, type: 'tack', range: [h.s, h.s], pitch: 1, pattern: 'single' };
  };
  /** welds of the same kind on the same seam that a new one would overlap → merged into one */
  const overlaps = (c: Candidate) => c.type === 'tack' ? [] : welds.filter(w => {
    const wd = w.data.weld || {}; if ((wd.type || 'linear') !== c.type || (c.type === 'stitch' && Number(wd.length) !== Number(c.length || 0) && wd.pattern !== 'single')) return false;
    return (w.data.faces || []).some((f: Any) => f.selection === 'edge' && seamId(f) === seamId(c.seam) && (f.range || [0, c.seam.len])[0] <= c.range[1] + 0.01 && (f.range || [0, c.seam.len])[1] >= c.range[0] - 0.01);
  }).map(w => w.id);

  // ---------------------------------------------------------------- saving
  const payload = (c: Candidate, range: [number, number]) => {
    const s = c.seam;
    return {
      kind: 'weld', parts: [...new Set([s.part, s.other_part].filter(Boolean))], name: '', sequence: 0,
      faces: [{ ...seamSelection(s), range: [Math.max(0, range[0]), Math.min(s.length || s.len, range[1])] }],
      weld: { process, type: c.type, size: String(s.size || 3), thickness: String(s.size || 3), sides: 'one', length: c.type === 'stitch' ? String(c.length) : '', pitch: c.pitch ? String(c.pitch) : '', ground: false, pattern: c.pattern },
    };
  };
  const reload = async () => {
    const all = await api(`/revisions/${revision}/joints`);
    setWelds(all.filter((j: Any) => j.kind === 'weld' && (j.data.parts || []).every((p: string) => partIds.includes(p))));
  };
  const run = async (fn: () => Promise<void>) => { if (!editable) return; setBusy(true); setError(''); try { await fn(); changed.current = true; await reload(); } catch (e: Any) { setError(e.message); } finally { setBusy(false); } };
  const addCandidate = (c: Candidate) => run(async () => {
    const merge = overlaps(c);
    if (!merge.length) { await api(`/revisions/${revision}/joints`, 'POST', payload(c, c.range)); return; }
    let [a, b] = c.range;
    for (const id of merge) for (const f of welds.find(w => w.id === id)!.data.faces) if (seamId(f) === seamId(c.seam)) { const r = f.range || [0, c.seam.len]; a = Math.min(a, r[0]); b = Math.max(b, r[1]); }
    const keep = welds.find(w => w.id === merge[0])!;
    const body = payload(c, [a, b]); body.weld = { ...keep.data.weld, ...body.weld, ground: !!keep.data.weld?.ground, pattern: c.pattern === 'full' || (a <= 0.01 && b >= c.seam.len - 0.01) ? 'full' : 'manual' };
    await api(`/joints/${keep.id}`, 'PUT', body);
    for (const id of merge.slice(1)) await api(`/joints/${id}`, 'DELETE');
  });
  const remove = (id: string) => run(async () => { await api(`/joints/${id}`, 'DELETE'); });
  const removeMany = (ids: string[]) => setConfirm({
    title: ids.length === welds.length ? `Clear all ${ids.length} welds?` : `Delete ${ids.length} weld${ids.length === 1 ? '' : 's'}?`,
    text: 'They are removed from the assembly, its drawing and new job orders.',
    go: () => run(async () => { await api(`/revisions/${revision}/welds/delete`, 'POST', { ids }); setPicked(new Set()); }),
  });
  const saveName = async () => {
    if (!asm || !editable || name.trim() === asm.name) return;
    try { const w = await api(`/weldments/${asm.id}`, 'PUT', { name: name.trim() }); setAsm(w); setName(w.name); changed.current = true; }
    catch (e: Any) { setError(e.message); setName(asm.name); }
  };
  /** take a part out of the weld assembly; its welds go with it */
  const removePart = (pid: string) => {
    if (!asm || !editable) return;
    const hit = welds.filter(w => (w.data.parts || []).includes(pid)).length;
    const left = partIds.filter(p => p !== pid);
    const go = () => run(async () => {
      if (!left.length) { await api(`/weldments/${asm.id}`, 'DELETE'); changed.current = true; close(true); return; }
      const w = await api(`/weldments/${asm.id}`, 'PUT', { parts: left }); setAsm(w); setPartIds(w.parts); setSeams(null); setBodies(null);
    });
    if (!hit && left.length) { go(); return; }
    setConfirm({ title: `Remove ${names[pid] || 'this part'}?`, text: left.length ? `It leaves ${asm.name}${hit ? ` with its ${hit} weld${hit === 1 ? '' : 's'}` : ''}.` : `It is the last part: ${asm.name} is deleted${hit ? ` with its ${hit} weld${hit === 1 ? '' : 's'}` : ''}.`, go });
  };
  /** closing a weld assembly that never got a weld drops it (it was only opened) */
  const finish = async () => {
    if (asm && editable && !welds.length) { try { await api(`/weldments/${asm.id}`, 'DELETE'); } catch { /* ignore */ } }
    close(changed.current);
  };
  const setGround = (w: Any, v: boolean) => run(async () => { await api(`/joints/${w.id}`, 'PUT', { kind: 'weld', parts: w.data.parts, faces: w.data.faces, name: w.data.name || '', sequence: w.data.sequence || 0, notes: w.data.notes || '', weld: { ...w.data.weld, ground: v } }); });

  // ---------------------------------------------------------------- pointer
  const onHover = (e: PointerEvent, s: SceneApi) => {
    if (busy) return;
    const h = seamAt(e, s);
    if (!h) { setHover(null); return; }
    const existing = weldAt(e, s, h);
    if (existing) { setHover({ weld: existing }); return; }
    const c = candidate(h);
    const merge = overlaps(c);
    setHover({ cand: c, merge: merge.length ? merge : undefined });
  };
  const onClick = (e: PointerEvent, s: SceneApi) => {
    if (!editable || busy || mode === 'manual') return;
    const h = seamAt(e, s); if (!h) return;
    const existing = weldAt(e, s, h);
    if (existing) { remove(existing); setHover(null); return; }
    addCandidate(candidate(h)); setHover(null);
  };
  const onPress = (e: PointerEvent, s: SceneApi) => {
    if (!editable || busy || mode !== 'manual') return false;
    const h = seamAt(e, s); if (!h || weldAt(e, s, h)) return false;
    setDrag({ seam: h.seam, a: h.s, b: h.s }); setHover(null); return true;
  };
  const onDrag = (e: PointerEvent, s: SceneApi) => { setDrag(d => { if (!d) return d; const h = seamAt(e, s, d.seam); return h ? { ...d, b: h.s } : d; }); };
  const onRelease = () => {
    setDrag(d => {
      if (d) {
        const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
        if (b - a > 0.5) addCandidate({ seam: d.seam, type: 'linear', range: [a, b], pattern: 'manual' });
      }
      return null;
    });
  };
  // clicking a weld in manual mode removes it too
  const onClickManual = (e: PointerEvent, s: SceneApi) => { if (mode !== 'manual') return onClick(e, s); const h = seamAt(e, s); const w = h && weldAt(e, s, h); if (w) remove(w); };

  // ---------------------------------------------------------------- list
  const describe = (w: Any) => {
    const wd = w.data.weld || {}; const faces = (w.data.faces || []).filter((f: Any) => f.selection === 'edge');
    const spans = faces.map((f: Any) => { const r = f.range; return r ? r[1] - r[0] : Number(f.length || 0); });
    const total = spans.reduce((a: number, b: number) => a + b, 0);
    if (wd.type === 'tack') { const n = faces.reduce((k: number, f: Any) => k + (f.range ? Math.floor((f.range[1] - f.range[0]) / Math.max(1, Number(wd.pitch || 50)) + 1e-6) + 1 : 1), 0); return n > 1 ? `${n} tacks · ${fmt(Number(wd.pitch))} apart` : 'Tack'; }
    if (wd.type === 'stitch') { const seg = Number(wd.length || 25), pitch = Number(wd.pitch || 50); const n = Math.max(1, Math.round((total - seg) / Math.max(1, pitch)) + 1); return n > 1 ? `Stitch ${n} × ${fmt(seg)} · ${fmt(pitch - seg)} gap` : `Stitch · ${fmt(seg)}`; }
    if (wd.type === 'patch') return 'Patch (area)';
    return `Length: ${fmt(total)}`;
  };
  const chip = drag ? { cls: 'warn', text: 'Release to finish weld' }
    : hover?.weld ? { cls: 'danger', text: 'Click to remove weld' }
    : hover?.merge ? { cls: 'danger', text: 'Click to merge welds' }
    : hover?.cand ? { cls: 'warn', text: (mode === 'manual' ? 'Hold and drag to weld' : 'Click to weld') + (hover.cand.seam.side ? ` · ${SIDE_LABEL[hover.cand.seam.side]} seam` : '') + (hover.cand.seam.pieces ? ` · ${fmt(hover.cand.seam.len)} curve` : '') }
    : { cls: '', text: seams === null ? 'Finding seams…' : !seams.length ? 'No seams to weld' : mode === 'manual' ? 'Hold and drag along a seam' : 'Click to weld' };
  const selParts = partIds.map(id => names[id] || id);

  return (
    <div data-forge-config="weld" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-[2vw] py-[2.5vh]" onMouseDown={e => { if (e.target === e.currentTarget) finish(); }}>
      <section className="flex h-[min(980px,95vh)] w-[min(1680px,96vw)] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-pop" role="dialog" aria-modal="true" aria-label="Weld configuration">
        <header className="flex min-h-14 items-center gap-4 border-b py-2.5 pr-3 pl-4">
          <div className="mr-auto flex min-w-0 flex-col"><span className="truncate text-base font-semibold">Weld configuration{asm ? <> · <span className="text-pink-700 dark:text-pink-400">{asm.name}</span></> : null}</span><small className="truncate text-xs text-muted-foreground" title={selParts.join(', ')}>{selParts.length === 1 ? selParts[0] : `${selParts.length} parts · ${selParts.slice(0, 3).join(', ')}${selParts.length > 3 ? '…' : ''}`}</small></div>
          {asm && canJobOrder && onJobOrder && <Button type="button" variant="outline" disabled={busy} onClick={() => onJobOrder(asm)}><ClipboardList />Job order</Button>}
          <Button type="button" variant="ghost" size="icon" aria-label="Close" onClick={finish}><X /></Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_380px] gap-3.5 p-3.5 min-[1100px]:grid-cols-[minmax(0,1fr)_470px]">
          {bodies ? <PartScene revision={revision} bodies={bodies} navStyle={navStyle} cursor={hover?.weld || hover?.cand ? 'pointer' : undefined}
            onReady={s => { scene.current = s; const g = { seams: new THREE.Group(), welds: new THREE.Group(), preview: new THREE.Group() }; s.overlay.add(g.seams, g.welds, g.preview); layer.current = g; drawAll(); }}
            onHover={onHover} onClick={onClickManual} onPress={onPress} onDrag={onDrag} onRelease={onRelease}>
            <div className={cn('absolute top-3.5 right-3.5 z-[3] flex max-w-[calc(100%-120px)] items-center gap-2.5 rounded-lg px-3 py-2 transition-colors',
              chip.cls === 'warn' ? 'border border-warning/40 bg-warning-soft text-warning shadow-pop' : chip.cls === 'danger' ? 'border border-destructive/30 bg-danger-soft text-destructive shadow-pop' : 'glass text-foreground [&>svg]:text-faint')}>
              {seams === null ? <LoaderCircle className="animate-spin" /> : <Crosshair />}<span className="flex min-w-0 flex-col"><span className="truncate text-sm font-medium">{chip.text}</span></span></div>
            {(searching || message) && <div className="pointer-events-none absolute right-3.5 bottom-3.5 left-[170px] z-[3] grid gap-1.5">
              {searching && <div className={msgCls}><LoaderCircle className="size-3.5 animate-spin" /> {searching}</div>}
              {message && <div className={msgCls}>{message}</div>}
            </div>}
          </PartScene> : <div className="relative min-h-0 min-w-0 overflow-hidden rounded-xl border bg-viewer"><div className="absolute inset-0 flex items-center justify-center gap-2.5 text-sm text-muted-foreground"><LoaderCircle className="animate-spin text-primary" />Finding seams…</div></div>}
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {asm && <section className={cardCls}>
              <h4 className="flex items-center gap-2 text-sm font-semibold"><Layers className="size-4 text-[#e0479e]" />Weld assembly</h4>
              <Input className="font-medium" aria-label="Weld assembly name" value={name} disabled={!editable} placeholder="Name — left empty, Forge names it" maxLength={120}
                onChange={e => setName(e.target.value)} onBlur={saveName} onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setName(asm.name); }} />
              <div className="flex flex-wrap gap-1.5">{partIds.map(pid => {
                const n = welds.filter(w => (w.data.parts || []).includes(pid)).length;
                return <span key={pid} className={cn('inline-flex max-w-full items-center gap-1 rounded-full border bg-subtle py-0.5 pr-0.5 pl-2.5 text-xs', !editable && 'pr-2.5', hotPart === pid && 'border-primary/40 bg-selection')} title={names[pid] || pid} onMouseEnter={() => setHotPart(pid)} onMouseLeave={() => setHotPart(null)}>
                  <span className="max-w-[180px] truncate">{short(pid)}</span>{n > 0 && <small className="min-w-[18px] rounded-full bg-[#e0479e]/10 px-1.5 text-center text-2xs font-medium text-pink-700 dark:text-pink-300">{n}</small>}
                  {editable && <Button type="button" variant="ghost" size="icon-xs" className="size-5 rounded-full text-faint hover:bg-danger-soft hover:text-destructive dark:hover:bg-danger-soft" aria-label={`Remove ${names[pid] || 'part'} from the weld assembly`} title="Remove from the weld assembly" disabled={busy} onClick={() => removePart(pid)}><X /></Button>}
                </span>;
              })}</div>
            </section>}
            <section className={cardCls}>
              <h4 className="text-sm font-semibold">Weld type</h4>
              <div className={segCls} role="tablist">{([['full', 'Full'], ['stitch', 'Stitch'], ['tack', 'Tack'], ['manual', 'Manual']] as [Mode, string][]).map(([m, l]) => <Button key={m} type="button" variant="ghost" size="sm" role="tab" aria-selected={mode === m} className={segItem(mode === m)} onClick={() => { setMode(m); setHover(null); }}>{l}</Button>)}</div>
              {mode === 'full' && <p className="text-xs text-muted-foreground">Click a seam to weld its whole length.</p>}
              {mode === 'manual' && <p className="text-xs text-muted-foreground">Hold and drag along a seam. Release to finish the weld.</p>}
              {(mode === 'stitch' || mode === 'tack') && <div className="flex flex-wrap gap-x-5 gap-y-3">
                {mode === 'stitch' && <Field label="Length"><MmInput min={2} max={500} step={1} value={stitchLen} onChange={e => setStitchLen(Math.max(1, Number(e.target.value) || 1))} /></Field>}
                <Field label="Pattern"><span className="flex h-8 items-center gap-2.5"><Switch checked={fullPattern} onCheckedChange={setFullPattern} /><span className="font-normal text-foreground">Full length</span></span></Field>
                {fullPattern && <Field label="Gap"><MmInput min={2} max={1000} step={1} value={gap} onChange={e => setGap(Math.max(1, Number(e.target.value) || 1))} /></Field>}
              </div>}
              {(seams || []).some(x => x.side === 'inside') && (seams || []).some(x => x.side === 'outside') && <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Seams</span>
                <ToggleGroup type="single" spacing={1} value={side} className={cn(segCls, 'flex-1')}>{([['all', 'Both'], ['inside', 'Inside'], ['outside', 'Outside']] as [Side, string][]).map(([v, l]) => <ToggleGroupItem key={v} value={v} size="sm" className={segToggle} onClick={() => { setSide(v); setHover(null); }}>{v !== 'all' && <i className={cn(dotCls, DOT[v])} />}{l} <small className="tabular-nums text-faint">{v === 'all' ? (seams || []).length : (seams || []).filter(x => x.side === v).length}</small></ToggleGroupItem>)}</ToggleGroup>
              </div>}
              <p className="text-2xs leading-relaxed text-muted-foreground"><i className={cn(dotCls, 'mr-1', DOT.inside)} />inside seam <i className={cn(dotCls, 'mr-1 ml-2', DOT.outside)} />outside seam <i className={cn(dotCls, 'mr-1 ml-2', DOT.weld)} />weld — a seam is picked from its own side only</p>
              <Label className="justify-between text-xs font-normal text-muted-foreground">Process<Select size="sm" className="w-[150px]" value={process} onChange={setProcess} options={PROCESSES.map(([v, l]) => ({ value: v, label: l }))} /></Label>
            </section>
            {error && <div className="rounded-md bg-danger-soft px-3 py-2 text-xs text-destructive">{error}</div>}
            {confirm && <div className="grid gap-1.5 rounded-lg border border-destructive/30 bg-danger-soft px-3.5 py-3"><span className="text-sm font-medium text-destructive">{confirm.title}</span><small className="text-xs text-destructive/80">{confirm.text}</small><div className="mt-1 flex justify-end gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setConfirm(null)}>Cancel</Button><Button type="button" variant="destructive" size="sm" onClick={() => { const go = confirm.go; setConfirm(null); go(); }}>Remove</Button></div></div>}
            {!welds.length ? <div className="flex min-h-[260px] flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border bg-subtle text-center text-faint"><Flame className="size-8" /><span className="text-sm font-medium text-muted-foreground">No welds added yet</span><small className="text-xs">Click on the 3D model to add weld points</small></div>
              : <div className="grid gap-2">
                <div className="flex items-center gap-2.5 px-1 py-0.5 text-sm text-muted-foreground">
                  {editable && <Label className="inline-flex" title="Select all"><Checkbox checked={picked.size > 0 && welds.every(w => picked.has(w.id)) ? true : picked.size > 0 ? 'indeterminate' : false} onCheckedChange={v => setPicked(v === true ? new Set(welds.map(w => w.id)) : new Set())} /></Label>}
                  <span className="mr-auto font-medium text-foreground">{welds.length} weld{welds.length === 1 ? '' : 's'}</span>
                  {editable && picked.size > 0 && <Button type="button" variant="outline" size="xs" className="text-destructive hover:text-destructive" disabled={busy} onClick={() => removeMany([...picked])}><Trash2 />Delete {picked.size}</Button>}
                  {editable && !picked.size && <Button type="button" variant="outline" size="xs" disabled={busy} onClick={() => removeMany(welds.map(w => w.id))}><Trash2 />Clear all</Button>}
                </div>
                {welds.map((w, i) => (
                <div key={w.id} className={cn('grid items-center gap-2.5 rounded-lg border bg-card px-3.5 py-2.5', editable ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto]' : 'grid-cols-[minmax(0,1fr)_auto_auto]', (focus === w.id || picked.has(w.id)) && 'border-primary/40 bg-selection/60')} onMouseEnter={() => setFocus(w.id)} onMouseLeave={() => setFocus(null)}>
                  {editable && <Checkbox aria-label={`Select weld ${i + 1}`} checked={picked.has(w.id)} onCheckedChange={v => setPicked(p => { const n = new Set(p); v === true ? n.add(w.id) : n.delete(w.id); return n; })} />}
                  <span className="flex min-w-0 flex-col"><span className="text-sm font-medium">Weld #{i + 1}{(() => { const sd = (w.data.faces || []).find((f: Any) => f.side)?.side; return sd ? <span className={cn('ml-1.5 rounded px-1.5 text-2xs font-medium tracking-wide uppercase', SIDE_TAG[sd])}>{sd}</span> : null; })()}</span><small className="truncate text-xs text-muted-foreground">{describe(w)}{(w.data.parts || []).length > 1 ? ` · ${(w.data.parts || []).map((p: string) => names[p] || p).join(' + ')}` : ''}</small></span>
                  <Label className="text-sm font-normal"><Checkbox checked={!!w.data.weld?.ground} disabled={!editable || busy} onCheckedChange={v => setGround(w, v === true)} />Ground</Label>
                  <Button type="button" variant="ghost" size="icon-sm" className="text-destructive hover:bg-danger-soft hover:text-destructive dark:hover:bg-danger-soft" title="Delete weld" disabled={!editable || busy} onClick={() => remove(w.id)}><Trash2 /></Button>
                </div>))}</div>}
          </aside>
        </div>
      </section>
    </div>
  );
}

/** Weld assemblies of a revision (Assembly tab): name, parts, welds; open, job order, delete. */
export function WeldAssemblies({ weldments, parts, editable, canJobOrder, onOpen, onJobOrder, onSelect, onDelete }: {
  weldments: Any[]; parts: Any[]; editable: boolean; canJobOrder: boolean; onOpen: (w: Any) => void; onJobOrder: (w: Any) => void; onSelect: (w: Any) => void; onDelete: (w: Any) => void;
}) {
  const byId = new Map(parts.map(p => [p.id, p]));
  if (!weldments.length) return <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed px-4 py-12 text-center text-faint"><Flame className="size-7" /><span className="text-sm font-medium text-muted-foreground">No weld assemblies yet</span><small className="text-xs">Select the parts to weld in the model (Ctrl/⌘-click for several) and press Weld.</small></div>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3.5">{weldments.map(w => (
      <article key={w.id} className="flex flex-col gap-2.5 rounded-lg border bg-card p-4">
        <header className="grid grid-cols-[auto_1fr] items-center gap-x-2"><Flame className="size-4 text-[#e0479e]" /><span className="truncate text-sm font-medium">{w.name}</span><small className="col-start-2 text-xs text-muted-foreground">{w.parts.length} part{w.parts.length === 1 ? '' : 's'} · {(w.welds || []).length} weld{(w.welds || []).length === 1 ? '' : 's'}</small></header>
        <ul className="grid gap-0.5 text-xs">{w.parts.slice(0, 8).map((pid: string) => { const p = byId.get(pid); return <li key={pid} className="truncate" title={p?.name}>{p?.alias ? <span className="mr-1.5 inline-block rounded bg-selection px-1.5 text-2xs leading-[17px] font-medium text-selection-foreground">{p.alias}</span> : null}{p?.name || pid}</li>; })}{w.parts.length > 8 && <li className="text-muted-foreground">+ {w.parts.length - 8} more</li>}</ul>
        <footer className="mt-auto flex flex-wrap items-center gap-1.5">
          <Button type="button" size="sm" onClick={() => onOpen(w)}><Flame />Weld configuration</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onSelect(w)}><Target />Show in model</Button>
          {canJobOrder && <Button type="button" variant="outline" size="sm" onClick={() => onJobOrder(w)}><ClipboardList />Job order</Button>}
          {editable && <Button type="button" variant="ghost" size="icon-sm" className="ml-auto text-destructive hover:bg-danger-soft hover:text-destructive dark:hover:bg-danger-soft" title="Delete the weld assembly and its welds" onClick={() => onDelete(w)}><Trash2 /></Button>}
        </footer>
      </article>))}
    </div>
  );
}
