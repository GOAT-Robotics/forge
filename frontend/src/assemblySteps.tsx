import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  X, Plus, Trash2, Loader2, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Play, Pause, RotateCcw, FileDown, Pencil, Eye, Crosshair, Search, Wrench, ListOrdered, Check, Boxes, Package, Camera, RefreshCw,
} from 'lucide-react';
import PartScene, { type SceneApi, type SceneBody } from './partScene';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, Combo } from './controls';
import { api, assetJson, download, vendorId } from './api';
import { ask } from './components';
import type { Any } from './constants';
import type { NavStyle } from './cadControls';

type Occ = { part: string; occurrences: number[] };
type HoleRef = { part: string; occurrence: number; hole: string };
type Fastener = { kind: string; standard?: string; size?: string; length?: number; item?: string; name?: string; pn?: string; qty: number; torque?: string; threadlock?: string; note?: string; holes: HoleRef[]; designation?: string; _qtyManual?: boolean };
/** A saved camera angle of a step (assembly mm); the instructions PDF draws the step from every shot, in order. */
type Shot = { id: string; name: string; position: number[]; target: number[]; up: number[]; fov: number; aspect: number };
export type Step = { id: string; seq: number; group: string; subs: string[]; title: string; parts: Occ[]; method: string; fasteners: Fastener[]; welds: string[]; notes: string; tools: string; check: string; approach: string; shots?: Shot[] };
type Group = { id: string; name: string; seq: number; notes?: string };
type State = Map<string, 'new' | 'done'>;

/** What is on the bench at every step: a sub-assembly step shows only that sub-assembly; a step that fits a
 * sub-assembly brings all of its parts in as one unit (same rule as the PDF, backend assembly.build_states). */
function buildStates(steps: Step[]) {
  const own = new Map<string, Step[]>();
  steps.forEach(s => { const g = s.group || ''; if (!own.has(g)) own.set(g, []); own.get(g)!.push(s); });
  const allOf = (g: string, seen: string[]): string[] => (own.get(g) || []).flatMap(s => [
    ...s.parts.flatMap(e => e.occurrences.map(o => occKey(e.part, o))),
    ...(s.subs || []).filter(x => !seen.includes(x)).flatMap(x => allOf(x, [...seen, g])),
  ]);
  const units: Map<string, string>[] = [];   // per step: occKey -> sub-assembly fitted as one unit in that step
  const states: State[] = steps.map(s => {
    const g = s.group || ''; const st: State = new Map(); const unit = new Map<string, string>();
    for (const p of own.get(g) || []) {
      const isNew = p === s;
      const items = p.parts.flatMap(e => e.occurrences.map(o => occKey(e.part, o)));
      for (const k of items) if (isNew || !st.has(k)) st.set(k, isNew ? 'new' : 'done');
      for (const x of p.subs || []) for (const k of allOf(x, [g])) { if (isNew || !st.has(k)) st.set(k, isNew ? 'new' : 'done'); if (isNew) unit.set(k, x); }
      if (isNew) break;
    }
    units.push(unit);
    return st;
  });
  return { states, units };
}
type Config = { methods: Record<string, string>; fasteners: Record<string, { standard: string; name: string }[]>; threadlock: string[]; approach: string[]; hardware: { id: string; name: string; type: string; pn: string }[] };

const KINDS: [string, string][] = [['screw', 'Screw'], ['bolt', 'Bolt'], ['nut', 'Nut'], ['washer', 'Washer'], ['rivet', 'Rivet'], ['pin', 'Pin'], ['insert', 'Hardware'], ['custom', 'Custom']];
const SIZES = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20'];
// shared class sets
const EYEBROW = 'mb-1.5 text-2xs font-medium tracking-wider text-muted-foreground uppercase';
const EYEBROW_INLINE = 'inline-flex items-center gap-1 text-2xs font-medium tracking-wider text-muted-foreground uppercase';
const FIELD = 'flex flex-col items-stretch gap-1.5 text-sm leading-normal font-normal select-auto';
const FGRID_LABEL = 'min-w-0 flex-col items-stretch gap-0.5 text-2xs leading-normal font-normal text-muted-foreground select-auto';
const AS_EMPTY = 'flex flex-col items-start gap-1.5 px-3.5 py-4 text-xs text-muted-foreground';
const AS_SEC_EMPTY = 'block pt-0.5 pr-2 pb-2 pl-7 text-xs text-muted-foreground';
const FIT_BTN = 'mb-1.5 ml-7 max-w-[calc(100%-40px)] justify-start truncate font-normal';
const SUB_TINT = 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300';
const DANGER = 'text-destructive hover:text-destructive';
const CHOSEN = 'border-primary/40 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground';
const COMP_ROW = 'flex items-center gap-2 rounded-lg border px-2 py-1.5';
const CARD_ROW = 'flex items-start gap-2 py-1 text-sm';
const CARD_P = 'm-0 text-sm leading-relaxed';
const SWATCH = 'mt-1 size-[11px] shrink-0 rounded-[3px]';
const SCENE_TOGGLE = 'absolute top-3 z-[2] h-[30px] bg-card/90 font-normal shadow-pop';
const SCENE_TOGGLE_ON = 'border-primary/40 bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground';
const FCOL = ['#ef4444', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'];
const NEW_COLOR = 0x4f8ff7, DONE_COLOR = 0xd4d7dc;
const FLY = 1.3, FASTEN = 1.2, HOLD = 2.2;           // seconds: parts fly in, fasteners go in, hold
const STEP_TIME = FLY + FASTEN + HOLD;
const ease = (x: number) => x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3);
let configCache: Promise<Config> | null = null;
const occKey = (p: string, o: number) => `${p}#${o}`;
const label = (f: Fastener) => f.designation || (f.kind === 'custom' ? f.name : `${f.standard || ''} ${f.size || ''}${f.length ? '×' + f.length : ''}`) || 'Fastener';

/**
 * Assembly steps: the designer writes the build order — which components, how they are joined, which fasteners go
 * into which holes, torque, thread locker, tools and notes — and the shop floor plays it back step by step: the new
 * components fly in onto what is already built, fasteners drop into their holes, the instruction card says the rest.
 */
export default function AssemblySteps({ revision, parts, editable, navStyle, addParts, addKey, page, close }: {
  revision: string; parts: Any[]; editable: boolean; navStyle?: NavStyle;
  /** shown as a project page (top tab) instead of a dialog */
  page?: boolean; addKey?: number;
  /** parts selected in the 3D view when the dialog was opened from "Add step" */
  addParts?: string[];
  close: () => void;
}) {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [inst, setInst] = useState<Record<string, { matrix: number[][] }[]>>({});
  const [cur, setCur] = useState(0);
  const [edit, setEdit] = useState(editable);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<number | null>(null);            // fastener index whose holes are being picked
  const [hoverHole, setHoverHole] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [ghost, setGhost] = useState(false);   // see through what is already built
  const [autoCam, setAutoCamState] = useState(() => { try { return localStorage.getItem('forge-steps-autocam') !== 'off'; } catch { return true; } });
  const setAutoCam = (v: boolean) => { setAutoCamState(v); try { localStorage.setItem('forge-steps-autocam', v ? 'on' : 'off'); } catch { /* ignore */ } };
  const scene = useRef<SceneApi | null>(null);
  const [ready, setReady] = useState(0);
  const dirs = useRef(new Map<string, THREE.Vector3>());
  const anim = useRef({ t0: performance.now(), playing: false });
  const byId = useMemo(() => Object.fromEntries(parts.map(p => [p.id, p])), [parts]);
  const handled = useRef<number | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [shotAt, setShotAt] = useState<number | null>(null);   // saved camera shot currently shown
  const framedKey = useRef('');

  // ------------------------------------------------------------------ load
  const reload = async () => {
    const [s, g] = await Promise.all([api(`/revisions/${revision}/assembly-steps`), api(`/revisions/${revision}/assembly-groups`)]);
    setGroups(g); setSteps(s); return s as Step[];
  };
  useEffect(() => {
    configCache = configCache || api('/assembly-config');
    Promise.all([configCache, reload(), assetJson(`/revisions/${revision}/assets/instances.json`).catch(() => ({}))])
      .then(async ([c, s, i]) => {
        setCfg(c); setInst(i); setLoaded(true);
        if (!(addParts?.length && editable && addKey && handled.current !== addKey)) setCur(0);
      }).catch(e => setError(e.message));
  }, [revision]);

  // parts chosen in the 3D view ("Add step") become the next step
  useEffect(() => {
    if (!loaded || !steps || !addParts?.length || !editable || !addKey || handled.current === addKey) return;
    handled.current = addKey;
    const used = new Set(steps.flatMap(x => x.parts.flatMap(e => e.occurrences.map(o => occKey(e.part, o)))));
    const list: Occ[] = addParts.map(pid => {
      const n = Math.max(inst[pid]?.length || 0, byId[pid]?.quantity || 1, 1);
      const free = Array.from({ length: n }, (_, k) => k).filter(k => !used.has(occKey(pid, k)));
      return { part: pid, occurrences: free.length ? free : [0] };
    });
    const first = byId[addParts[0]];
    api(`/revisions/${revision}/assembly-steps`, 'POST', { title: addParts.length === 1 ? `Fit ${first?.name || 'component'}` : `Fit ${addParts.length} components`, parts: list, method: 'place', group: steps[cur]?.group || '' })
      .then(async made => { const all = await reload(); setCur(Math.max(0, all.findIndex(x => x.id === made.id))); setEdit(true); })
      .catch(e => setError(e.message));
  }, [loaded, addKey]);

  const step = steps?.[cur] || null;
  const placedBefore = useMemo(() => {
    const m = new Map<string, number>();
    (steps || []).forEach((s, i) => s.parts.forEach(e => e.occurrences.forEach(o => { const k = occKey(e.part, o); if (!m.has(k)) m.set(k, i); })));
    return m;
  }, [steps]);

  const { states, units } = useMemo(() => buildStates(steps || []), [steps]);
  const stateAt = (i: number): State => states[i] || new Map();
  const groupName = (g: string) => g ? (groups.find(x => x.id === g)?.name || 'Sub-assembly') : 'Main assembly';

  // bodies: every occurrence used by any step (stable key so editing text does not reload the scene)
  const bodies: SceneBody[] = useMemo(() => [...placedBefore.keys()].sort().map(k => {
    const [part, o] = k.split('#'); const occ = Number(o);
    return { part, occurrence: occ, matrix: inst[part]?.[occ]?.matrix };
  }), [placedBefore, inst]);

  // ------------------------------------------------------------------ 3D state per frame
  const fastenerGroup = useRef<THREE.Group | null>(null);
  const holeGroup = useRef<THREE.Group | null>(null);
  const restart = () => { anim.current.t0 = performance.now(); };
  useEffect(() => { restart(); setPick(null); }, [cur]);
  useEffect(() => { anim.current.playing = playing; if (playing) restart(); }, [playing]);

  const worldHole = (r: HoleRef) => {
    const s = scene.current; if (!s) return null;
    const b = s.bodies.find(x => x.body.part === r.part && (x.body.occurrence || 0) === (r.occurrence || 0)); if (!b) return null;
    const h = (byId[r.part]?.geometry?.holes || []).find((x: Any) => x.id === r.hole); if (!h) return null;
    const ax = new THREE.Vector3(...h.axis as [number, number, number]);
    const o = new THREE.Vector3(...h.origin as [number, number, number]);
    const a = o.clone().addScaledVector(ax, h.start).applyMatrix4(b.matrix), z = o.clone().addScaledVector(ax, h.end).applyMatrix4(b.matrix);
    return { a, z, d: h.diameter as number, body: b };
  };

  /** a body's box at its assembled position (independent of the fly-in offset) */
  const homeBox = (b: SceneApi['bodies'][number]) => { const g = b.mesh.geometry; if (!g.boundingBox) g.computeBoundingBox(); return g.boundingBox!.clone().applyMatrix4(b.matrix); };
  /** scene centre of the bodies on the bench at step i (only those already fitted when `doneOnly`) */
  const builtCenter = (i: number, doneOnly = false) => {
    const s = scene.current; const box = new THREE.Box3(); const st = stateAt(i);
    s?.bodies.forEach(b => { const v = st.get(occKey(b.body.part, b.body.occurrence || 0)); if (v && (!doneOnly || v === 'done')) box.union(homeBox(b)); });
    return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
  };

  const approachDir = (b: SceneApi['bodies'][number], i: number, st: Step) => {
    const map: Record<string, number[]> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
    if (map[st.approach]) return new THREE.Vector3(...map[st.approach]);
    const c = builtCenter(i, true) || new THREE.Vector3();
    // a sub-assembly fitted in this step moves as one unit: one direction for all its parts
    const unit = units[i]?.get(occKey(b.body.part, b.body.occurrence || 0));
    let own = homeBox(b).getCenter(new THREE.Vector3());
    if (unit && scene.current) { const ub = new THREE.Box3(); scene.current.bodies.forEach(x => { if (units[i].get(occKey(x.body.part, x.body.occurrence || 0)) === unit) ub.union(homeBox(x)); }); if (!ub.isEmpty()) own = ub.getCenter(new THREE.Vector3()); }
    if (!builtCenter(i, true)) return new THREE.Vector3(0, 0, 1);
    const d = own.sub(c); d.z = Math.max(d.z, d.length() * 0.35);
    return d.lengthSq() < 1e-6 ? new THREE.Vector3(0, 0, 1) : d.normalize();
  };

  // rebuild fastener glyphs + hole rings when the step or its fasteners change
  const glyphKey = step ? JSON.stringify(step.fasteners.map(f => [f.holes, f.length, f.kind, f.size])) + cur : '';
  useEffect(() => {
    const s = scene.current; if (!s || !step) return;
    for (const g of [fastenerGroup.current, holeGroup.current]) if (g) { s.overlay.remove(g); g.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); (m.material as THREE.Material | undefined)?.dispose?.(); }); }
    const fg = new THREE.Group(), hg = new THREE.Group();
    const center = builtCenter(cur) || new THREE.Vector3();
    step.fasteners.forEach((f, fi) => {
      const col = new THREE.Color(FCOL[fi % FCOL.length]);
      for (const r of f.holes) {
        const w = worldHole(r); if (!w) continue;
        // enters from the more exposed end (farther from what is built)
        const entry = w.a.distanceTo(center) >= w.z.distanceTo(center) ? w.a : w.z;
        const other = entry === w.a ? w.z : w.a;
        const out = entry.clone().sub(other).normalize(); if (!isFinite(out.x)) out.set(0, 0, 1);
        const dia = Math.max(1, w.d * 0.86); const len = Math.max(w.a.distanceTo(w.z) + dia, f.length || dia * 3);
        const glyph = new THREE.Group();
        const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.4, metalness: 0.5 });
        const shank = new THREE.Mesh(new THREE.CylinderGeometry(dia / 2, dia / 2, len, 16), mat); shank.position.y = -len / 2;
        glyph.add(shank);
        if (['screw', 'bolt', 'rivet', 'pin', 'custom', 'insert'].includes(f.kind)) {
          const head = new THREE.Mesh(f.kind === 'bolt' ? new THREE.CylinderGeometry(dia * 0.95, dia * 0.95, dia * 0.65, 6) : new THREE.CylinderGeometry(dia * 0.8, dia * 0.8, dia * 0.7, 20), mat);
          head.position.y = dia * 0.35; glyph.add(head);
        } else {
          // nut / washer: a ring on the exposed side
          const ring = new THREE.Mesh(f.kind === 'nut' ? new THREE.CylinderGeometry(dia * 0.95, dia * 0.95, dia * 0.8, 6) : new THREE.CylinderGeometry(dia * 1.05, dia * 1.05, dia * 0.18, 24), mat);
          ring.position.y = f.kind === 'nut' ? dia * 0.4 : dia * 0.09; glyph.clear(); glyph.add(ring);
        }
        glyph.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
        glyph.userData = { seat: entry.clone(), out: out.clone(), travel: len * 2.2 + dia * 4 };
        glyph.position.copy(entry);
        fg.add(glyph);
        const ringM = new THREE.Mesh(new THREE.TorusGeometry(Math.max(w.d * 0.75, 1.2), Math.max(w.d * 0.09, 0.25), 8, 32), new THREE.MeshBasicMaterial({ color: col, depthTest: false, transparent: true, opacity: 0.9 }));
        ringM.position.copy(entry); ringM.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), out); ringM.renderOrder = 20;
        hg.add(ringM);
      }
    });
    s.overlay.add(fg, hg); fastenerGroup.current = fg; holeGroup.current = hg; s.invalidate();
  }, [glyphKey, ready]);

  // pick discs for every hole of the bodies visible in this step
  const discGroup = useRef<THREE.Group | null>(null);
  useEffect(() => {
    const s = scene.current; if (!s) return;
    if (discGroup.current) { s.overlay.remove(discGroup.current); discGroup.current = null; }
    if (pick === null || !step) { s.invalidate(); return; }
    const g = new THREE.Group();
    for (const b of s.bodies) {
      if (!stateAt(cur).has(occKey(b.body.part, b.body.occurrence || 0))) continue;
      for (const h of byId[b.body.part]?.geometry?.holes || []) {
        const r: HoleRef = { part: b.body.part, occurrence: b.body.occurrence || 0, hole: h.id };
        const w = worldHole(r); if (!w) continue;
        const ax = w.z.clone().sub(w.a).normalize();
        for (const p of [w.a, w.z]) {
          const d = new THREE.Mesh(new THREE.CircleGeometry(w.d / 2 * 1.05, 24), new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false }));
          d.position.copy(p); d.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), ax); d.userData = r; d.renderOrder = 15;
          g.add(d);
        }
      }
    }
    s.overlay.add(g); discGroup.current = g; s.invalidate();
  }, [pick, cur, ready]);
  useEffect(() => {
    const g = discGroup.current; if (!g || pick === null || !step) return;
    const chosen = new Set(step.fasteners[pick]?.holes.map(h => `${h.part}#${h.occurrence}#${h.hole}`) || []);
    g.children.forEach(o => { const m = o as THREE.Mesh; const r = m.userData as HoleRef; const k = `${r.part}#${r.occurrence}#${r.hole}`; const mat = m.material as THREE.MeshBasicMaterial; mat.color.set(chosen.has(k) ? FCOL[pick % FCOL.length] : hoverHole === k ? 0xf6d34a : 0x2563eb); mat.opacity = chosen.has(k) ? 0.95 : 0.4; });
    scene.current?.invalidate();
  });

  // fly-in direction of every component of the current step (computed once per step)
  useEffect(() => {
    const s = scene.current; const st = steps?.[cur]; dirs.current.clear();
    if (!s || !st) return;
    for (const b of s.bodies) if (stateAt(cur).get(occKey(b.body.part, b.body.occurrence || 0)) === 'new') dirs.current.set(occKey(b.body.part, b.body.occurrence || 0), approachDir(b, cur, st));
  }, [cur, steps, ready, states]);
  // ------------------------------------------------------------------ camera shots
  const applyShot = (sh: Shot) => {
    const s = scene.current; if (!s) return;
    s.camera.position.set(sh.position[0], sh.position[1], sh.position[2]);
    s.camera.up.set(sh.up[0], sh.up[1], sh.up[2]);
    s.controls.target.set(sh.target[0], sh.target[1], sh.target[2]);
    if (sh.fov && Math.abs(s.camera.fov - sh.fov) > 0.01) { s.camera.fov = sh.fov; s.camera.updateProjectionMatrix(); }
    s.controls.update(); s.invalidate();
  };
  const currentShot = (name: string, id?: string): Shot | null => {
    const s = scene.current; if (!s) return null;
    const r = s.dom.getBoundingClientRect();
    const v = (x: THREE.Vector3) => [x.x, x.y, x.z].map(n => Math.round(n * 1e4) / 1e4);
    return { id: id || Math.random().toString(36).slice(2, 10), name, position: v(s.camera.position), target: v(s.controls.target), up: v(s.camera.up), fov: s.camera.fov, aspect: Math.round(Math.max(r.width, 1) / Math.max(r.height, 1) * 1000) / 1000 };
  };
  const saveShot = () => {
    if (!step) return;
    const list = step.shots || [];
    const sh = currentShot(list.length ? `View ${list.length + 1}` : 'Main view'); if (!sh) return;
    change({ shots: [...list, sh] }, true); setShotAt(list.length);
  };
  const updateShot = (i: number) => { if (!step) return; const list = step.shots || []; const sh = currentShot(list[i].name, list[i].id); if (sh) change({ shots: list.map((x, k) => k === i ? sh : x) }, true); };
  const moveShot = (i: number, d: number) => { if (!step) return; const list = [...(step.shots || [])]; const j = i + d; if (j < 0 || j >= list.length) return; [list[i], list[j]] = [list[j], list[i]]; change({ shots: list }, true); setShotAt(j); };

  // frame what is built so far (this step included), keeping the reader's viewing direction
  useEffect(() => {
    const s = scene.current; if (!s || !steps?.length) return;
    const box = new THREE.Box3();
    s.bodies.forEach(b => { if (stateAt(cur).has(occKey(b.body.part, b.body.occurrence || 0))) box.union(homeBox(b)); });
    if (box.isEmpty()) return;
    const sph = box.getBoundingSphere(new THREE.Sphere());
    s.center.copy(sph.center); s.radius = Math.max(sph.radius, 1);
    let dir = s.camera.position.clone().sub(s.controls.target).normalize();
    if (autoCam) {
      // look from the side the new components come from (they are never hidden behind the build)
      const sum = new THREE.Vector3(); dirs.current.forEach(d => sum.add(d));
      if (sum.lengthSq() > 1e-6) {
        const d = sum.normalize(); const side = new THREE.Vector3(0, 0, 1).cross(d);
        dir = d.clone().addScaledVector(side, 0.55).add(new THREE.Vector3(0, 0, 0.45)).normalize();
      }
    }
    const shots = steps[cur]?.shots || [];
    // a step with saved shots opens on its first shot; editing the step (names, order) does not move the camera
    const key = `${cur}|${ready}`;
    if (shots.length) { if (framedKey.current !== key) { applyShot(shots[0]); setShotAt(0); } framedKey.current = key; return; }
    framedKey.current = key;
    setShotAt(null);
    s.fit(dir.lengthSq() > 0.5 ? dir : undefined); s.invalidate();
  }, [cur, ready, states, autoCam]);

  // animation loop: body visibility / colour / fly-in, fasteners dropping in, auto-advance while playing
  useEffect(() => {
    let raf = 0, first = 2;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const s = scene.current; if (!s || !steps) return;
      const t = (performance.now() - anim.current.t0) / 1000;
      if (anim.current.playing && t > STEP_TIME) {
        if (cur < steps.length - 1) { setCur(c => c + 1); return; }
        setPlaying(false);
      }
      const fly = ease(t / FLY), fasten = ease((t - FLY) / FASTEN);
      const st = steps[cur];
      for (const b of s.bodies) {
        const state = stateAt(cur).get(occKey(b.body.part, b.body.occurrence || 0));
        b.mesh.visible = !!state;
        if (!state || !st) continue;
        const mat = b.mesh.material as THREE.MeshStandardMaterial;
        if (state === 'new') {
          mat.color.setHex(NEW_COLOR);
          const d = (dirs.current.get(occKey(b.body.part, b.body.occurrence || 0)) || new THREE.Vector3(0, 0, 1)).clone().multiplyScalar(s.radius * 0.6 * (1 - fly));
          b.mesh.matrix.copy(b.matrix).premultiply(new THREE.Matrix4().makeTranslation(d.x, d.y, d.z));
          mat.transparent = fly < 1; mat.opacity = 0.35 + 0.65 * fly;
        } else { mat.color.setHex(DONE_COLOR); b.mesh.matrix.copy(b.matrix); mat.transparent = ghost; mat.opacity = ghost ? 0.22 : 1; mat.depthWrite = !ghost; }
        b.mesh.matrixWorldNeedsUpdate = true;
      }
      fastenerGroup.current?.children.forEach(g => { const u = g.userData; g.position.copy(u.seat).addScaledVector(u.out, u.travel * (1 - fasten)); g.visible = t > FLY * 0.6 || pick !== null; });
      if (holeGroup.current) holeGroup.current.visible = pick === null;
      if (t < FLY + FASTEN + 0.1 || anim.current.playing || first-- > 0) s.invalidate();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [steps, cur, states, pick, ready, ghost]);

  // ------------------------------------------------------------------ editing
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Step | null>(null);
  const flush = async () => {
    const s = pending.current; pending.current = null; window.clearTimeout(timer.current);
    if (!s) return;
    setSaving(true);
    try {
      const body = { title: s.title, parts: s.parts, method: s.method, fasteners: s.fasteners.map(({ designation: _d, _qtyManual: _q, ...f }) => f), welds: s.welds, notes: s.notes, tools: s.tools, check: s.check, approach: s.approach, subs: s.subs || [], shots: s.shots || [] };
      const saved = await api(`/assembly-steps/${s.id}`, 'PUT', body);
      setSteps(list => list ? list.map(x => x.id === s.id ? { ...x, fasteners: saved.fasteners.map((f: Fastener, i: number) => ({ ...f, _qtyManual: s.fasteners[i]?._qtyManual })) } : x) : list);
      setError('');
    } catch (e: unknown) { setError((e as Error).message); } finally { setSaving(false); }
  };
  useEffect(() => () => { void flush(); }, []);
  const change = (patch: Partial<Step>, now = false) => {
    if (!step) return;
    const next = { ...step, ...patch };
    setSteps(list => list ? list.map(x => x.id === step.id ? next : x) : list);
    pending.current = next; window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, now ? 0 : 700);
  };
  const setFastener = (i: number, patch: Partial<Fastener>) => {
    if (!step) return;
    const list = step.fasteners.map((f, k) => {
      if (k !== i) return f;
      const n = { ...f, ...patch };
      if (patch.holes && !n._qtyManual) n.qty = Math.max(1, patch.holes.length);
      if (patch.qty !== undefined) n._qtyManual = true;
      return n;
    });
    change({ fasteners: list }, !!patch.holes);
  };
  const addFastener = (kind: string) => {
    if (!step || !cfg) return;
    const std = cfg.fasteners[kind]?.[0]?.standard;
    const f: Fastener = kind === 'insert' ? { kind, item: cfg.hardware[0]?.id, qty: 1, holes: [] } : kind === 'custom' ? { kind, name: '', pn: '', qty: 1, holes: [] } : { kind, standard: std, size: 'M5', length: ['screw', 'bolt', 'rivet', 'pin'].includes(kind) ? 12 : undefined, qty: 1, holes: [] };
    if (kind === 'custom') { setSteps(list => list ? list.map(x => x.id === step.id ? { ...x, fasteners: [...x.fasteners, f] } : x) : list); setPick(null); return; }  // saved once it has a name
    change({ fasteners: [...step.fasteners, f] }, true); setPick(step.fasteners.length);
  };
  const run = async (fn: () => Promise<void>) => { try { await flush(); await fn(); setError(''); } catch (e: unknown) { setError((e as Error).message); } };
  const newStep = (group = '') => run(async () => {
    const made = await api(`/revisions/${revision}/assembly-steps`, 'POST', { title: '', parts: [], method: 'place', group });
    const all = await reload(); setCur(all.findIndex(x => x.id === made.id)); setEdit(true);
  });
  const removeStep = (s: Step) => run(async () => {
    if (await ask({ title: `Delete step ${(steps || []).indexOf(s) + 1}?`, message: s.title ? `“${s.title}” and its fasteners and notes are removed.` : 'Its components, fasteners and notes are removed.', confirm: 'Delete step', danger: true }) === null) return;
    await api(`/assembly-steps/${s.id}`, 'DELETE'); const all = await reload(); setCur(c => Math.max(0, Math.min(c, all.length - 1)));
  });
  const move = (i: number, d: number) => run(async () => {
    if (!steps) return; const j = i + d; if (j < 0 || j >= steps.length || steps[j].group !== steps[i].group) return;
    const g = steps[i].group; const moved = steps[i].id;
    const list = steps.filter(x => x.group === g).map(x => x.id); const a = list.indexOf(steps[i].id), b = list.indexOf(steps[j].id); [list[a], list[b]] = [list[b], list[a]];
    await api(`/revisions/${revision}/assembly-steps/order`, 'POST', { ids: list, group: g }); const all = await reload(); setCur(all.findIndex(x => x.id === moved));
  });
  const newGroup = () => run(async () => {
    const name = await ask({ title: 'New sub-assembly', message: 'A unit built on its own — for example a door with its hinges — and fitted into the main assembly as one piece.', confirm: 'Create', input: { label: 'Name', placeholder: 'e.g. Front door unit', required: true } }); if (!name?.trim()) return;
    const g = await api(`/revisions/${revision}/assembly-groups`, 'POST', { name: name.trim() });
    const made = await api(`/revisions/${revision}/assembly-steps`, 'POST', { title: '', parts: [], method: 'place', group: g.id });
    const all = await reload(); setCur(all.findIndex(x => x.id === made.id)); setEdit(true);
  });
  const fitIntoMain = (gid: string) => run(async () => {
    const made = await api(`/revisions/${revision}/assembly-steps`, 'POST', { title: `Fit ${groupName(gid)}`, parts: [], method: 'screw', group: '', subs: [gid] });
    const all = await reload(); setCur(all.findIndex(x => x.id === made.id)); setEdit(true);
  });
  const renameGroup = (g: Group) => run(async () => {
    const name = await ask({ title: 'Rename sub-assembly', confirm: 'Rename', input: { label: 'Name', initial: g.name, required: true } }); if (!name?.trim() || name.trim() === g.name) return;
    await api(`/assembly-groups/${g.id}`, 'PUT', { name: name.trim(), notes: g.notes || '' }); await reload();
  });
  const removeGroup = (g: Group) => run(async () => {
    if (await ask({ title: `Delete “${g.name}”?`, message: 'The sub-assembly and all of its steps are deleted. A main-assembly step that fitted it keeps its other contents.', confirm: 'Delete sub-assembly', danger: true }) === null) return;
    await api(`/assembly-groups/${g.id}`, 'DELETE'); const all = await reload(); setCur(c => Math.max(0, Math.min(c, all.length - 1)));
  });

  // ------------------------------------------------------------------ 3D picking of holes
  const nearestDisc = (e: PointerEvent, s: SceneApi) => {
    const g = discGroup.current; if (!g) return null;
    const ray = new THREE.Raycaster(); ray.setFromCamera(s.ndc(e.clientX, e.clientY), s.camera);
    const hit = ray.intersectObjects(g.children, false)[0];
    return hit ? hit.object.userData as HoleRef : null;
  };
  const onHover = (e: PointerEvent, s: SceneApi) => {
    if (pick === null) return;
    const r = nearestDisc(e, s); const k = r ? `${r.part}#${r.occurrence}#${r.hole}` : null;
    if (k !== hoverHole) setHoverHole(k);
  };
  const onClick = (e: PointerEvent, s: SceneApi) => {
    if (pick === null || !step) return;
    const r = nearestDisc(e, s); if (!r) return;
    const f = step.fasteners[pick]; const k = `${r.part}#${r.occurrence}#${r.hole}`;
    const has = f.holes.some(h => `${h.part}#${h.occurrence}#${h.hole}` === k);
    setFastener(pick, { holes: has ? f.holes.filter(h => `${h.part}#${h.occurrence}#${h.hole}` !== k) : [...f.holes, r] });
  };

  // keyboard: ← → steps, space plays, Esc closes (or leaves hole picking)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select, [role="combobox"], [data-slot="select-content"]')) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
      if (e.key === 'Escape') { if (pick !== null) { e.stopPropagation(); setPick(null); } else if (!page) { e.stopPropagation(); void flush(); close(); } }
      else if (e.key === 'ArrowRight') setCur(c => Math.min((steps?.length || 1) - 1, c + 1));
      else if (e.key === 'ArrowLeft') setCur(c => Math.max(0, c - 1));
      else if (e.key === ' ') { e.preventDefault(); setPlaying(p => !p); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const total = steps?.length || 0;
  // work-instruction PDF: rendered by the worker (large assemblies take a while); any step change makes it stale
  const [pdf, setPdf] = useState<{ state: string; progress?: number; message?: string; error?: string }>({ state: 'missing' });
  const canGenerate = !vendorId;
  const pdfStatus = () => api(`/revisions/${revision}/assembly-instructions`).then(setPdf).catch(() => { /* offline: keep the last state */ });
  useEffect(() => { void pdfStatus(); }, [revision, steps, saving]);
  useEffect(() => {
    if (pdf.state !== 'generating') return;
    const t = window.setInterval(pdfStatus, 2000);
    return () => window.clearInterval(t);
  }, [pdf.state]);
  const pdfAction = () => run(async () => {
    if (pdf.state === 'ready') { await download(`/revisions/${revision}/assembly-instructions.pdf`, 'assembly-instructions.pdf'); return; }
    await api(`/revisions/${revision}/assembly-instructions`, 'POST'); setPdf({ state: 'generating', progress: 0 });
  });
  const unusedParts = useMemo(() => parts.filter(p => !p.excluded), [parts]);

  return (
    <div data-forge-config="" className={page ? 'box-border flex h-[calc(100vh-48px)] min-h-0 p-3' : 'fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-[2vw] py-[2.5vh] backdrop-blur-[3px]'} role={page ? 'region' : 'dialog'} aria-label="Assembly steps" onMouseDown={e => { if (!page && e.target === e.currentTarget) { void flush(); close(); } }}>
      <div data-slot={page ? undefined : 'dialog-content'} className={page ? 'flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground' : 'flex h-[min(980px,95vh)] w-[min(1680px,96vw)] flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-pop'}>
        <header className="flex min-h-14 items-center gap-3 border-b py-2.5 pr-3 pl-4">
          <div className="mr-auto flex min-w-0 flex-col"><span className="truncate text-lg font-semibold">Assembly steps</span><small className="truncate text-xs text-muted-foreground">{editable && step ? `“Add step” in the Model view adds to: ${groupName(step.group)} · ` : editable ? 'Select parts in the Model view and use “Add step”, or add components here · ' : ''}{total ? `${total} step${total === 1 ? '' : 's'}` : 'No steps yet'}{saving ? ' · saving…' : ''}</small></div>
          {editable && <Tabs className="order-2" value={edit ? 'build' : 'view'} onValueChange={v => { if (v === 'build') setEdit(true); else { void flush(); setEdit(false); setPick(null); } }}>
            <TabsList>
              <TabsTrigger value="build" className="px-3 font-normal"><Pencil className="size-3.5" />Build</TabsTrigger>
              <TabsTrigger value="view" className="px-3 font-normal"><Eye className="size-3.5" />Shop floor view</TabsTrigger>
            </TabsList>
          </Tabs>}
          <Button type="button" variant="outline" className={cn('order-2', pdf.state === 'generating' && 'opacity-85')} disabled={!total || pdf.state === 'generating' || (pdf.state === 'missing' && !canGenerate)}
            title={pdf.state === 'ready' ? 'Download the work instructions (one page per step)' : pdf.state === 'generating' ? (pdf.message || 'Generating…') : pdf.state === 'failed' ? 'Generation failed: ' + (pdf.error || '') + ' — click to try again' : 'Render the work instructions PDF (one page per step)'}
            onClick={pdfAction}>{pdf.state === 'generating' ? <><Loader2 className="size-3.5 animate-spin" />{pdf.progress ? `PDF ${pdf.progress}%` : 'Preparing PDF…'}</> : <><FileDown />{pdf.state === 'ready' ? 'Download PDF' : pdf.state === 'failed' ? 'Retry PDF' : 'Create PDF'}</>}</Button>
          {!page && <Button type="button" variant="ghost" size="icon" className="order-3" aria-label="Close" onClick={() => { void flush(); close(); }}><X /></Button>}
        </header>
        <div className={cn('grid min-h-0 flex-1 gap-3 p-3', edit ? 'grid-cols-[250px_minmax(0,1fr)_420px] max-[1280px]:grid-cols-[210px_minmax(0,1fr)_360px]' : 'grid-cols-[250px_minmax(0,1fr)]')}>
          <aside className="min-h-0 overflow-auto rounded-xl border bg-card">
            <div className="sticky top-0 z-[1] flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b bg-card px-3 py-2.5 text-sm"><ListOrdered className="size-4 text-muted-foreground" /><span className="font-medium whitespace-nowrap">Build order</span>{editable && edit && <span className="ml-auto flex gap-1"><Button type="button" variant="outline" size="xs" title="A unit built on its own (e.g. a door with its hinges), fitted later as one piece" onClick={newGroup}><Package />Sub-assembly</Button><Button type="button" variant="outline" size="xs" onClick={() => newStep(step?.group || '')}><Plus />Step</Button></span>}</div>
            {!total && <div className={AS_EMPTY}><span className="text-sm font-medium text-foreground">No steps yet</span><small>{editable ? 'Select components in the 3D view and use “Add step”, or add an empty step here.' : 'The designer has not written the assembly steps yet.'}</small></div>}
            {[...groups.map(g => g.id), ''].map((gid, gi) => {
              const g = groups.find(x => x.id === gid);
              const list = (steps || []).map((s, i) => ({ s, i })).filter(x => (x.s.group || '') === gid);
              if (!gid && !list.length && !groups.length) return null;
              return (
                <div key={gid || 'main'} className={cn('px-1.5 pt-1 pb-0.5', gi > 0 && 'border-t')}>
                  <div className="flex items-center gap-1.5 px-1.5 pt-1.5 pb-0.5 text-xs text-muted-foreground">
                    {gid ? <Package className="size-3.5 shrink-0 text-violet-500" /> : <Boxes className="size-3.5 shrink-0 text-primary" />}
                    <span className="min-w-0 truncate font-medium text-foreground" title={gid ? 'Sub-assembly: built on its own, then fitted into another assembly' : 'Main assembly'}>{gid ? g?.name : 'Main assembly'}</span>
                    {editable && edit && <span className="ml-auto flex shrink-0 gap-px">
                      <Button type="button" variant="ghost" size="icon-xs" title={gid ? 'Add a step to this sub-assembly' : 'Add a step to the main assembly'} onClick={() => newStep(gid)}><Plus /></Button>
                      {g && <Button type="button" variant="ghost" size="icon-xs" title="Rename" onClick={() => renameGroup(g)}><Pencil /></Button>}
                      {g && <Button type="button" variant="ghost" size="icon-xs" className={DANGER} title="Delete the sub-assembly and its steps" onClick={() => removeGroup(g)}><Trash2 /></Button>}
                    </span>}
                  </div>
                  {gid && (() => {
                    const at = (steps || []).findIndex(x => (x.subs || []).includes(gid));
                    return at >= 0
                      ? <Button type="button" variant="ghost" size="xs" className={cn(FIT_BTN, 'bg-success-soft text-success hover:bg-success-soft hover:text-success')} onClick={() => { void flush(); setCur(at); }} title="Open the step that fits this sub-assembly"><Check />Fitted into {groupName(steps![at].group)} · step {at + 1}</Button>
                      : editable && edit ? <Button type="button" variant="outline" size="xs" className={cn(FIT_BTN, SUB_TINT, 'shadow-none hover:bg-violet-500/15')} disabled={!list.length} title={list.length ? 'Add a main-assembly step that fits this whole sub-assembly as one unit' : 'Add its steps first'} onClick={() => fitIntoMain(gid)}><Boxes />Fit into main assembly</Button>
                      : <small className={AS_SEC_EMPTY}>Not fitted into an assembly yet</small>;
                  })()}
                  {!list.length && <small className={AS_SEC_EMPTY}>No steps yet</small>}
                  <ol className="m-0 list-none pt-0.5 pb-1">
                    {list.map(({ s, i }, n) => (
                      <li key={s.id} className={cn('relative flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-accent', i === cur && 'bg-selection ring-1 ring-primary/20 ring-inset hover:bg-selection')} onClick={() => { void flush(); setCur(i); setPlaying(false); }}>
                        <span className={cn('grid size-[22px] shrink-0 place-items-center rounded-full text-2xs font-medium tabular-nums', i === cur ? 'bg-primary text-primary-foreground' : i < cur ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground')}>{i < cur ? <Check className="size-3" /> : n + 1}</span>
                        <span className="flex min-w-0 flex-1 flex-col"><span className="truncate text-sm font-medium">{s.title || cfg?.methods[s.method] || 'Step'}</span><small className="truncate text-2xs text-muted-foreground">{cfg?.methods[s.method]}{(s.subs || []).length ? ` · fits ${(s.subs || []).map(x => groups.find(g2 => g2.id === x)?.name || 'sub-assembly').join(', ')}` : ''} · {s.parts.reduce((t, e) => t + e.occurrences.length, 0)} comp.{s.fasteners.length ? ` · ${s.fasteners.reduce((t, f) => t + (f.qty || 0), 0)} fasteners` : ''}</small></span>
                        {editable && edit && i === cur && <span className="flex shrink-0 gap-px" onClick={e => e.stopPropagation()}>
                          <Button type="button" variant="ghost" size="icon-xs" title="Move up" disabled={n === 0} onClick={() => move(i, -1)}><ChevronUp /></Button>
                          <Button type="button" variant="ghost" size="icon-xs" title="Move down" disabled={n === list.length - 1} onClick={() => move(i, 1)}><ChevronDown /></Button>
                          <Button type="button" variant="ghost" size="icon-xs" className={DANGER} title="Delete step" onClick={() => removeStep(s)}><Trash2 /></Button>
                        </span>}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </aside>

          <section className={cn('relative min-h-0 min-w-0', edit ? 'flex flex-col gap-2' : 'grid grid-cols-[minmax(0,1fr)_minmax(300px,380px)] grid-rows-[minmax(0,1fr)_auto] gap-2.5')}>
            {bodies.length > 0 ? <PartScene className={edit ? 'flex-1' : 'col-start-1 row-start-1'} revision={revision} bodies={bodies} navStyle={navStyle} onReady={a => { scene.current = a; restart(); setReady(r => r + 1); }}
              onHover={onHover} onClick={onClick} cursor={pick !== null && hoverHole ? 'pointer' : undefined}>
              <Button type="button" variant="outline" size="sm" className={cn(SCENE_TOGGLE, 'left-[84px]', autoCam && SCENE_TOGGLE_ON)} title="Turn the view to the side each step's components are fitted from" onClick={() => setAutoCam(!autoCam)}><Crosshair className="size-3.5" />Auto camera</Button>
              <Button type="button" variant="outline" size="sm" className={cn(SCENE_TOGGLE, 'left-[214px]', ghost && SCENE_TOGGLE_ON)} title="See through the parts already assembled" onClick={() => { setGhost(g => !g); scene.current?.invalidate(); }}><Eye className="size-3.5" />X-ray built parts</Button>
              {step && ((step.shots || []).length > 0 || (edit && editable)) && <div className="absolute top-3 right-3 z-[2] flex max-w-[55%] flex-wrap items-center justify-end gap-1 rounded-lg border bg-card/90 p-1 shadow-pop" title="Camera shots: the PDF shows this step from each of them">
                <Camera className="mx-1 size-3.5 shrink-0 text-muted-foreground" />
                {(step.shots || []).map((sh, i) => <Button key={sh.id} type="button" variant="ghost" size="xs" className={cn('h-6 max-w-[140px] px-2 font-normal', shotAt === i && 'bg-selection text-selection-foreground hover:bg-selection')} onClick={() => { applyShot(sh); setShotAt(i); }}><span className="truncate">{sh.name}</span></Button>)}
                {edit && editable && <Button type="button" variant="outline" size="xs" className="h-6 px-2" onClick={saveShot} title="Save the current camera as a shot of this step"><Plus />Save view</Button>}
              </div>}
              {pick !== null && step && <div className="absolute top-3 left-1/2 z-[3] flex max-w-[calc(100%-120px)] -translate-x-1/2 items-center gap-2 rounded-xl border border-warning/40 bg-warning-soft px-3 py-2 text-sm whitespace-nowrap text-warning shadow-pop"><Crosshair className="size-3.5 shrink-0" />Click holes for <span className="min-w-0 truncate font-medium">{label(step.fasteners[pick])}</span> · {step.fasteners[pick]?.holes.length || 0} picked<Button type="button" variant="outline" size="xs" className="shrink-0" onClick={() => setPick(null)}>Done</Button></div>}
            </PartScene> : <div className={cn('flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed text-sm text-muted-foreground', !edit && 'col-start-1 row-start-1')}>{steps === null ? <><Loader2 className="size-4 animate-spin text-primary" />Loading…</> : 'Add components to a step to see it here.'}</div>}
            {step && !edit && <div className="col-start-2 row-start-1 overflow-auto rounded-xl border bg-card px-4.5 py-4">
              <div className="flex items-baseline gap-0.5 text-sm font-medium text-primary">Step {cur + 1}<small className="ml-0.5 font-normal text-faint">/ {total}</small></div>
              <div className={cn('mt-1 mb-0.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium', step.group ? SUB_TINT : 'bg-selection text-selection-foreground')}>{step.group ? <Package className="size-3.5" /> : <Boxes className="size-3.5" />}{step.group ? `Sub-assembly · ${groupName(step.group)}` : 'Main assembly'}</div>
              <h3 className="mt-1 mb-2 text-xl leading-tight font-semibold">{step.title || cfg?.methods[step.method]}</h3>
              <span className="inline-block rounded-full bg-selection px-2 py-0.5 text-xs font-medium text-selection-foreground">{cfg?.methods[step.method]}</span>
              {(step.parts.length > 0 || (step.subs || []).length > 0) && <div className="mt-3.5"><h5 className={EYEBROW}>Components</h5>
                {(step.subs || []).map(x => <div key={x} className={CARD_ROW}><Package className="mt-0.5 size-3.5 shrink-0 text-violet-500" /><span>Sub-assembly <span className="font-medium">{groupName(x)}</span></span></div>)}
                {step.parts.map(e => <div key={e.part} className={CARD_ROW}><i className={SWATCH} style={{ background: '#4f8ff7' }} />{byId[e.part]?.name || e.part}<span className="ml-auto text-muted-foreground tabular-nums">×{e.occurrences.length}</span></div>)}</div>}
              {step.fasteners.length > 0 && <div className="mt-3.5"><h5 className={EYEBROW}>Fasteners</h5>{step.fasteners.map((f, i) => <div key={i} className={CARD_ROW}><i className={SWATCH} style={{ background: FCOL[i % FCOL.length] }} /><span className="flex flex-col"><span className="font-medium">{f.qty} × {label(f)}</span>{(f.torque || f.threadlock || f.note) && <small className="text-xs text-muted-foreground">{[f.torque && 'Torque ' + f.torque, f.threadlock, f.note].filter(Boolean).join(' · ')}</small>}</span></div>)}</div>}
              {step.tools && <div className="mt-3.5"><h5 className={EYEBROW}>Tools</h5><p className={CARD_P}>{step.tools}</p></div>}
              {step.notes && <div className="mt-3.5"><h5 className={EYEBROW}>Instructions</h5><p className={cn(CARD_P, 'whitespace-pre-wrap')}>{step.notes}</p></div>}
              {step.check && <div className="mt-3.5 rounded-lg border border-success/25 bg-success-soft px-3 py-2"><h5 className={EYEBROW}>Check</h5><p className={CARD_P}>{step.check}</p></div>}
            </div>}
            <footer className={cn('flex items-center gap-1.5 rounded-xl border bg-card px-2.5 py-1.5', !edit && 'col-span-full row-start-2')}>
              <Button type="button" variant="ghost" size="icon" title="Previous step (←)" disabled={cur === 0} onClick={() => { setPlaying(false); setCur(c => Math.max(0, c - 1)); }}><ChevronLeft /></Button>
              <Button type="button" variant="outline" size="icon" className="rounded-full" title={playing ? 'Pause (Space)' : 'Play all steps (Space)'} disabled={!total} onClick={() => { if (!playing && cur >= total - 1) setCur(0); setPlaying(p => !p); }}>{playing ? <Pause /> : <Play />}</Button>
              <Button type="button" variant="ghost" size="icon" title="Next step (→)" disabled={cur >= total - 1} onClick={() => { setPlaying(false); setCur(c => Math.min(total - 1, c + 1)); }}><ChevronRight /></Button>
              <Button type="button" variant="ghost" size="icon" title="Replay this step" disabled={!total} onClick={restart}><RotateCcw /></Button>
              <div className="flex flex-1 gap-[3px] overflow-x-auto py-0.5 pl-1.5">{(steps || []).map((s, i) => <Button type="button" variant="ghost" size="xs" key={s.id} className={cn('h-[26px] max-w-20 flex-[1_0_28px] px-0 tabular-nums', i < cur ? 'bg-success-soft text-success hover:bg-success-soft hover:text-success' : i === cur ? 'bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground' : 'bg-muted text-muted-foreground')} title={`${i + 1}. ${s.title || cfg?.methods[s.method] || ''}`} onClick={() => { setPlaying(false); setCur(i); }}>{i + 1}</Button>)}</div>
            </footer>
          </section>

          {edit && editable && <aside className="flex min-h-0 flex-col gap-3.5 overflow-auto rounded-xl border bg-card px-3.5 py-3">
            {error && <div className="rounded-md bg-danger-soft px-2.5 py-2 text-xs text-destructive">{error}</div>}
            {!step ? <div className={AS_EMPTY}><span className="text-sm font-medium text-foreground">Start the build order</span><small>Select components in the 3D view and use “Add step”, or add an empty step.</small><Button type="button" onClick={() => newStep()}><Plus />Add step</Button></div> : <>
              <div className={cn('inline-flex items-center gap-1 self-start rounded-full px-2 py-0.5 text-2xs font-medium', step.group ? SUB_TINT : 'bg-selection text-selection-foreground')}>{step.group ? <Package className="size-3.5" /> : <Boxes className="size-3.5" />}{groupName(step.group)}</div>
              <Label className={FIELD}><span className={EYEBROW_INLINE}>Step {cur + 1} title</span><Input value={step.title} placeholder={`e.g. Fit ${byId[step.parts[0]?.part]?.name || 'the bracket'} to the frame`} maxLength={160} onChange={e => change({ title: e.target.value })} /></Label>

              <div className={FIELD}><span className={EYEBROW_INLINE}>How is it joined?</span>
                <div className="flex flex-wrap gap-1">{cfg && Object.entries(cfg.methods).filter(([k]) => k !== 'weld' || step.method === 'weld').map(([k, v]) => <Button type="button" variant="outline" size="xs" key={k} className={cn('rounded-full font-normal shadow-none', step.method === k && CHOSEN)} onClick={() => change({ method: k }, true)}>{v}</Button>)}</div></div>

              <div className={FIELD}><span className={EYEBROW_INLINE}>Components in this step</span>
                {step.parts.map(e => { const p = byId[e.part]; const n = Math.max(inst[e.part]?.length || 0, p?.quantity || 1, 1); return (
                  <div key={e.part} className={COMP_ROW}>
                    <i className={SWATCH} style={{ background: '#4f8ff7' }} /><span className="min-w-0 flex-1 truncate" title={p?.name}>{p?.name || e.part}</span>
                    {n > 1 && <span className="flex max-w-[46%] flex-wrap gap-[3px]">{Array.from({ length: n }, (_, k) => { const elsewhere = placedBefore.get(occKey(e.part, k)); const taken = elsewhere !== undefined && elsewhere !== cur; return <Button type="button" variant="outline" size="icon-xs" key={k} disabled={taken} title={taken ? `Fitted in step ${elsewhere! + 1}` : `Instance ${k + 1}`} className={cn('text-2xs font-normal tabular-nums shadow-none', e.occurrences.includes(k) && CHOSEN)} onClick={() => { const occ = e.occurrences.includes(k) ? e.occurrences.filter(x => x !== k) : [...e.occurrences, k].sort((a, b) => a - b); if (occ.length) change({ parts: step.parts.map(x => x.part === e.part ? { ...x, occurrences: occ } : x) }, true); }}>{k + 1}</Button>; })}</span>}
                    <Button type="button" variant="ghost" size="icon-xs" title="Remove from step" onClick={() => change({ parts: step.parts.filter(x => x.part !== e.part) }, true)}><X /></Button>
                  </div>); })}
                <PartPicker open={addOpen} setOpen={setAddOpen} parts={unusedParts} used={new Set(step.parts.map(e => e.part))} placed={placedBefore}
                  onPick={pid => { const n = Math.max(inst[pid]?.length || 0, byId[pid]?.quantity || 1, 1); const free = Array.from({ length: n }, (_, k) => k).filter(k => !placedBefore.has(occKey(pid, k))); change({ parts: [...step.parts, { part: pid, occurrences: free.length ? free : [0] }] }, true); }} />
              </div>

              {groups.length > 0 && <div className={FIELD}><span className={EYEBROW_INLINE}>Sub-assemblies fitted in this step</span>
                {(step.subs || []).map(x => <div key={x} className={COMP_ROW}><Package className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate">{groupName(x)}</span><Button type="button" variant="ghost" size="icon-xs" title="Remove" onClick={() => change({ subs: (step.subs || []).filter(y => y !== x) }, true)}><X /></Button></div>)}
                {(() => {
                  const fittedElsewhere = new Set((steps || []).filter(x => x.id !== step.id).flatMap(x => x.subs || []));
                  const inside = (g: string, seen: string[] = []): string[] => (steps || []).filter(x => x.group === g).flatMap(x => (x.subs || []).filter(y => !seen.includes(y)).flatMap(y => [y, ...inside(y, [...seen, y])]));
                  const options = groups.filter(g => g.id !== step.group && !(step.subs || []).includes(g.id) && !fittedElsewhere.has(g.id) && !inside(g.id).includes(step.group));
                  return options.length ? <Select key={step.id + ':' + (step.subs || []).join()} value="" placeholder="Fit a finished sub-assembly…" onChange={v => { if (v) change({ subs: [...(step.subs || []), v] }, true); }} options={options.map(g => ({ value: g.id, label: g.name }))} />
                    : !(step.subs || []).length ? <small className="text-xs text-muted-foreground">{step.group ? 'Other sub-assemblies can be fitted here once they exist and are not fitted elsewhere.' : 'Every sub-assembly is already fitted in a step.'}</small> : null;
                })()}
              </div>}

              <div className={FIELD}><span className={EYEBROW_INLINE}>Fasteners</span>
                {cfg && step.fasteners.map((f, i) => <FastenerCard key={i} f={f} i={i} cfg={cfg} picking={pick === i} onPick={() => setPick(pick === i ? null : i)} set={p => setFastener(i, p)} remove={() => { change({ fasteners: step.fasteners.filter((_, k) => k !== i) }, true); setPick(null); }} />)}
                <div className="flex flex-wrap gap-1">{KINDS.map(([k, v]) => <Button type="button" variant="outline" size="xs" key={k} className="shadow-none" onClick={() => addFastener(k)}><Plus />{v}</Button>)}</div>
              </div>


              <Label className={FIELD}><span className={EYEBROW_INLINE}><Wrench className="size-3" /> Tools</span><Input value={step.tools} placeholder="e.g. 4 mm hex key, torque wrench 2–10 N·m" maxLength={300} onChange={e => change({ tools: e.target.value })} /></Label>
              <Label className={FIELD}><span className={EYEBROW_INLINE}>Instructions for the shop floor</span><Textarea rows={5} value={step.notes} maxLength={4000} placeholder="How to hold, align and fit it; order of tightening; anything that is easy to get wrong." onChange={e => change({ notes: e.target.value })} /></Label>
              <Label className={FIELD}><span className={EYEBROW_INLINE}>Check before moving on</span><Input value={step.check} maxLength={600} placeholder="e.g. Bracket flush with frame edge; all screws torque-marked" onChange={e => change({ check: e.target.value })} /></Label>
              <Label className={cn(FIELD, 'flex-row items-center justify-between')}><span className={EYEBROW_INLINE}>Animate from</span>
                <Select className="w-auto max-w-[230px]" value={step.approach} onChange={v => change({ approach: v }, true)} options={(cfg?.approach || []).map(a => ({ value: a, label: a === 'auto' ? 'Automatic (away from the build)' : a.toUpperCase() }))} /></Label>

              <div className={FIELD}><span className={EYEBROW_INLINE}><Camera className="size-3" /> Camera shots for the PDF</span>
                {(step.shots || []).length === 0 && <small className="text-xs text-muted-foreground">No shots yet — the PDF picks a view automatically. Set up the view in 3D and save it; add more shots for other angles.</small>}
                {(step.shots || []).map((sh, i, list) => (
                  <div key={sh.id} className={cn(COMP_ROW, shotAt === i && 'border-primary/40 bg-selection/50')}>
                    <span className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-2xs font-medium tabular-nums">{i + 1}</span>
                    <Input className="h-7 min-w-0 flex-1 px-2 text-sm" value={sh.name} maxLength={60} aria-label={`Shot ${i + 1} name`} onFocus={() => { applyShot(sh); setShotAt(i); }} onChange={e => change({ shots: list.map((x, k) => k === i ? { ...x, name: e.target.value } : x) })} />
                    <Button type="button" variant="ghost" size="icon-xs" title="Show this shot" onClick={() => { applyShot(sh); setShotAt(i); }}><Eye /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" title="Replace with the current view" onClick={() => updateShot(i)}><RefreshCw /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" title="Earlier in the PDF" disabled={i === 0} onClick={() => moveShot(i, -1)}><ChevronUp /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" title="Later in the PDF" disabled={i === list.length - 1} onClick={() => moveShot(i, 1)}><ChevronDown /></Button>
                    <Button type="button" variant="ghost" size="icon-xs" className={DANGER} title="Delete shot" onClick={() => { change({ shots: list.filter((_, k) => k !== i) }, true); setShotAt(null); }}><Trash2 /></Button>
                  </div>))}
                <Button type="button" variant="outline" size="sm" className="self-start" disabled={!scene.current || (step.shots || []).length >= 12} onClick={saveShot}><Camera />Save current view{(step.shots || []).length ? ' as another shot' : ''}</Button>
                {(step.shots || []).length > 0 && <small className="text-xs text-muted-foreground">The PDF shows {(step.shots || []).length === 1 ? 'this shot' : `all ${(step.shots || []).length} shots, in this order`} (up to 4 per page).</small>}
              </div>
            </>}
          </aside>}
        </div>
      </div>
    </div>
  );
}

function FastenerCard({ f, i, cfg, picking, onPick, set, remove }: { f: Fastener; i: number; cfg: Config; picking: boolean; onPick: () => void; set: (p: Partial<Fastener>) => void; remove: () => void }) {
  const long = ['screw', 'bolt', 'rivet', 'pin'].includes(f.kind);
  return (
    <div className={cn('flex flex-col gap-2 rounded-lg border px-2.5 py-2', picking && 'border-warning ring-3 ring-warning/15')}>
      <div className="flex min-w-0 items-center gap-1.5 text-sm"><i className={cn(SWATCH, 'mt-0')} style={{ background: FCOL[i % FCOL.length] }} /><span className="font-medium">{KINDS.find(k => k[0] === f.kind)?.[1]}</span><small className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{f.designation || ''}</small>
        <Button type="button" variant="ghost" size="icon-xs" className={cn(DANGER, 'ml-auto')} title="Remove fastener" onClick={remove}><Trash2 /></Button></div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        {f.kind === 'insert' ? <Label className={cn(FGRID_LABEL, 'col-span-full')}><span>Hardware</span><Select value={f.item} onChange={v => set({ item: v })} options={cfg.hardware.map(h => ({ value: h.id, label: h.name + (h.pn ? ' · ' + h.pn : '') }))} /></Label>
          : f.kind === 'custom' ? <><Label className={FGRID_LABEL}><span>Name</span><Input value={f.name || ''} placeholder="e.g. Quarter-turn fastener" onChange={e => set({ name: e.target.value })} /></Label><Label className={FGRID_LABEL}><span>Part no.</span><Input value={f.pn || ''} onChange={e => set({ pn: e.target.value })} /></Label></>
          : <>
            <Label className={cn(FGRID_LABEL, 'col-span-full')}><span>Standard</span><Select value={f.standard} onChange={v => set({ standard: v })} options={(cfg.fasteners[f.kind] || []).map(s => ({ value: s.standard, label: `${s.standard} — ${s.name}` }))} /></Label>
            <Label className={FGRID_LABEL}><span>Size</span><Combo value={f.size || ''} onChange={v => set({ size: v })} suggestions={SIZES} /></Label>
            {long && <Label className={FGRID_LABEL}><span>Length</span><span className="relative block"><Input type="number" className="pr-9" min={1} max={1000} step={1} value={f.length ?? ''} onChange={e => set({ length: Number(e.target.value) || undefined })} /><span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-xs text-faint">mm</span></span></Label>}
          </>}
        <Label className={FGRID_LABEL}><span>Qty</span><Input type="number" min={1} max={999} value={f.qty} onChange={e => set({ qty: Math.max(1, Number(e.target.value) || 1) })} /></Label>
        <Label className={FGRID_LABEL}><span>Torque</span><Input value={f.torque || ''} placeholder="e.g. 6 N·m" maxLength={40} onChange={e => set({ torque: e.target.value })} /></Label>
        <Label className={cn(FGRID_LABEL, 'col-span-full')}><span>Thread locker</span><Select value={f.threadlock || ''} onChange={v => set({ threadlock: v })} options={cfg.threadlock.map(t => ({ value: t, label: t || 'None' }))} /></Label>
        <Label className={cn(FGRID_LABEL, 'col-span-full')}><span>Note</span><Input value={f.note || ''} maxLength={200} placeholder="e.g. washer under the head" onChange={e => set({ note: e.target.value })} /></Label>
      </div>
      <Button type="button" variant="outline" size="sm" className={cn('shadow-none', picking && 'border-warning bg-warning-soft text-warning hover:bg-warning-soft hover:text-warning')} onClick={onPick}><Crosshair className="size-3.5" />{picking ? 'Done picking holes' : f.holes.length ? `${f.holes.length} hole${f.holes.length === 1 ? '' : 's'} — change` : 'Pick holes in 3D'}</Button>
    </div>
  );
}

function PartPicker({ open, setOpen, parts, used, placed, onPick }: { open: boolean; setOpen: (v: boolean) => void; parts: Any[]; used: Set<string>; placed: Map<string, number>; onPick: (pid: string) => void }) {
  const [q, setQ] = useState('');
  const list = parts.filter(p => !used.has(p.id) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))).slice(0, 60);
  const fittedOf = (pid: string) => [...placed.keys()].filter(k => k.startsWith(pid + '#')).length;
  if (!open) return <Button type="button" variant="outline" size="xs" className="self-start shadow-none" onClick={() => setOpen(true)}><Plus />Add component</Button>;
  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="flex items-center gap-1.5 border-b px-2 py-1 text-muted-foreground"><Search className="size-3.5 shrink-0" /><Input autoFocus className="h-7 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 dark:bg-transparent" value={q} placeholder="Find a component…" onChange={e => setQ(e.target.value)} /><Button type="button" variant="ghost" size="icon-xs" onClick={() => setOpen(false)}><X /></Button></div>
      <div className="flex max-h-60 flex-col overflow-auto p-1">{list.map(p => { const fitted = fittedOf(p.id); return <Button type="button" variant="ghost" key={p.id} className="h-auto flex-col items-start gap-px px-2 py-1.5 text-left font-normal" onClick={() => { onPick(p.id); setOpen(false); setQ(''); }}><span className="max-w-full truncate text-sm">{p.name}</span><small className="text-2xs text-muted-foreground">{p.category?.replace('_', ' ')} · qty {p.quantity}{fitted ? ` · ${fitted} fitted` : ''}</small></Button>; })}
        {!list.length && <small className="px-2 py-1.5 text-xs text-muted-foreground">No matching components</small>}</div>
    </div>
  );
}
