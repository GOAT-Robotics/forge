import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  X, Plus, Trash2, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Play, Pause, RotateCcw, FileDown, Pencil, Eye, Crosshair, Search, Wrench, ListOrdered, Check, Boxes, Package,
} from 'lucide-react';
import PartScene, { type SceneApi, type SceneBody } from './partScene';
import { api, assetJson, download, vendorId } from './api';
import { ask } from './components';
import type { Any } from './constants';
import type { NavStyle } from './cadControls';

type Occ = { part: string; occurrences: number[] };
type HoleRef = { part: string; occurrence: number; hole: string };
type Fastener = { kind: string; standard?: string; size?: string; length?: number; item?: string; name?: string; pn?: string; qty: number; torque?: string; threadlock?: string; note?: string; holes: HoleRef[]; designation?: string; _qtyManual?: boolean };
export type Step = { id: string; seq: number; group: string; subs: string[]; title: string; parts: Occ[]; method: string; fasteners: Fastener[]; welds: string[]; notes: string; tools: string; check: string; approach: string };
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
      const body = { title: s.title, parts: s.parts, method: s.method, fasteners: s.fasteners.map(({ designation: _d, _qtyManual: _q, ...f }) => f), welds: s.welds, notes: s.notes, tools: s.tools, check: s.check, approach: s.approach, subs: s.subs || [] };
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
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) { if (e.key === 'Escape') (e.target as HTMLElement).blur(); return; }
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
    <div className={page ? 'as-page cfg-overlay' : 'overlay top cfg-overlay'} role={page ? 'region' : 'dialog'} aria-label="Assembly steps" onMouseDown={e => { if (!page && e.target === e.currentTarget) { void flush(); close(); } }}>
      <div className={page ? 'as-dialog as-page-inner' : 'cfg-dialog as-dialog'}>
        <header className="cfg-head">
          <div className="cfg-title"><b>Assembly steps</b><small>{editable && step ? `“Add step” in the Model view adds to: ${groupName(step.group)} · ` : editable ? 'Select parts in the Model view and use “Add step”, or add components here · ' : ''}{total ? `${total} step${total === 1 ? '' : 's'}` : 'No steps yet'}{saving ? ' · saving…' : ''}</small></div>
          {editable && <div className="as-mode" role="tablist">
            <button type="button" className={edit ? 'on' : ''} onClick={() => setEdit(true)}><Pencil size={14} />Build</button>
            <button type="button" className={!edit ? 'on' : ''} onClick={() => { void flush(); setEdit(false); setPick(null); }}><Eye size={14} />Shop floor view</button>
          </div>}
          <button type="button" className={'as-pdf' + (pdf.state === 'generating' ? ' busy' : '')} disabled={!total || pdf.state === 'generating' || (pdf.state === 'missing' && !canGenerate)}
            title={pdf.state === 'ready' ? 'Download the work instructions (one page per step)' : pdf.state === 'generating' ? (pdf.message || 'Generating…') : pdf.state === 'failed' ? 'Generation failed: ' + (pdf.error || '') + ' — click to try again' : 'Render the work instructions PDF (one page per step)'}
            onClick={pdfAction}>{pdf.state === 'generating' ? <><span className="spinner" />{pdf.progress ? `PDF ${pdf.progress}%` : 'Preparing PDF…'}</> : <><FileDown size={15} />{pdf.state === 'ready' ? 'Download PDF' : pdf.state === 'failed' ? 'Retry PDF' : 'Create PDF'}</>}</button>
          {!page && <button type="button" className="icon cfg-close" aria-label="Close" onClick={() => { void flush(); close(); }}><X size={18} /></button>}
        </header>
        <div className={'as-body' + (edit ? ' editing' : '')}>
          <aside className="as-list">
            <div className="as-list-head"><ListOrdered size={15} /><b>Build order</b>{editable && edit && <span className="as-list-add"><button type="button" className="mini" title="A unit built on its own (e.g. a door with its hinges), fitted later as one piece" onClick={newGroup}><Package size={13} />Sub-assembly</button><button type="button" className="mini" onClick={() => newStep(step?.group || '')}><Plus size={13} />Step</button></span>}</div>
            {!total && <div className="as-empty"><b>No steps yet</b><small>{editable ? 'Select components in the 3D view and use “Add step”, or add an empty step here.' : 'The designer has not written the assembly steps yet.'}</small></div>}
            {[...groups.map(g => g.id), ''].map(gid => {
              const g = groups.find(x => x.id === gid);
              const list = (steps || []).map((s, i) => ({ s, i })).filter(x => (x.s.group || '') === gid);
              if (!gid && !list.length && !groups.length) return null;
              return (
                <div key={gid || 'main'} className={'as-sec-list' + (gid ? ' sub' : ' main')}>
                  <div className="as-sec-head">
                    {gid ? <Package size={14} /> : <Boxes size={14} />}
                    <b title={gid ? 'Sub-assembly: built on its own, then fitted into another assembly' : 'Main assembly'}>{gid ? g?.name : 'Main assembly'}</b>
                    {editable && edit && <span className="as-sec-tools">
                      <button type="button" className="icon" title={gid ? 'Add a step to this sub-assembly' : 'Add a step to the main assembly'} onClick={() => newStep(gid)}><Plus size={13} /></button>
                      {g && <button type="button" className="icon" title="Rename" onClick={() => renameGroup(g)}><Pencil size={12} /></button>}
                      {g && <button type="button" className="icon danger" title="Delete the sub-assembly and its steps" onClick={() => removeGroup(g)}><Trash2 size={12} /></button>}
                    </span>}
                  </div>
                  {gid && (() => {
                    const at = (steps || []).findIndex(x => (x.subs || []).includes(gid));
                    return at >= 0
                      ? <button type="button" className="as-fitted" onClick={() => { void flush(); setCur(at); }} title="Open the step that fits this sub-assembly"><Check size={12} />Fitted into {groupName(steps![at].group)} · step {at + 1}</button>
                      : editable && edit ? <button type="button" className="as-fit-btn" disabled={!list.length} title={list.length ? 'Add a main-assembly step that fits this whole sub-assembly as one unit' : 'Add its steps first'} onClick={() => fitIntoMain(gid)}><Boxes size={12} />Fit into main assembly</button>
                      : <small className="as-sec-empty">Not fitted into an assembly yet</small>;
                  })()}
                  {!list.length && <small className="as-sec-empty">No steps yet</small>}
                  <ol>
                    {list.map(({ s, i }, n) => (
                      <li key={s.id} className={i === cur ? 'on' : i < cur ? 'done' : ''} onClick={() => { void flush(); setCur(i); setPlaying(false); }}>
                        <span className="as-num">{i < cur ? <Check size={12} /> : n + 1}</span>
                        <span className="as-li-text"><b>{s.title || cfg?.methods[s.method] || 'Step'}</b><small>{cfg?.methods[s.method]}{(s.subs || []).length ? ` · fits ${(s.subs || []).map(x => groups.find(g2 => g2.id === x)?.name || 'sub-assembly').join(', ')}` : ''} · {s.parts.reduce((t, e) => t + e.occurrences.length, 0)} comp.{s.fasteners.length ? ` · ${s.fasteners.reduce((t, f) => t + (f.qty || 0), 0)} fasteners` : ''}</small></span>
                        {editable && edit && i === cur && <span className="as-li-tools" onClick={e => e.stopPropagation()}>
                          <button type="button" className="icon" title="Move up" disabled={n === 0} onClick={() => move(i, -1)}><ChevronUp size={14} /></button>
                          <button type="button" className="icon" title="Move down" disabled={n === list.length - 1} onClick={() => move(i, 1)}><ChevronDown size={14} /></button>
                          <button type="button" className="icon danger" title="Delete step" onClick={() => removeStep(s)}><Trash2 size={14} /></button>
                        </span>}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </aside>

          <section className="as-stage">
            {bodies.length > 0 ? <PartScene revision={revision} bodies={bodies} navStyle={navStyle} onReady={a => { scene.current = a; restart(); setReady(r => r + 1); }}
              onHover={onHover} onClick={onClick} cursor={pick !== null && hoverHole ? 'pointer' : undefined}>
              <button type="button" className={'as-ghost as-autocam' + (autoCam ? ' on' : '')} title="Turn the view to the side each step's components are fitted from" onClick={() => setAutoCam(!autoCam)}><Crosshair size={14} />Auto camera</button>
              <button type="button" className={'as-ghost' + (ghost ? ' on' : '')} title="See through the parts already assembled" onClick={() => { setGhost(g => !g); scene.current?.invalidate(); }}><Eye size={14} />X-ray built parts</button>
              {pick !== null && step && <div className="cfg-chip warn as-pick-chip"><Crosshair size={14} />Click holes for <b>{label(step.fasteners[pick])}</b> · {step.fasteners[pick]?.holes.length || 0} picked<button type="button" className="mini" onClick={() => setPick(null)}>Done</button></div>}
            </PartScene> : <div className="as-stage-empty">{steps === null ? <><span className="spinner" />Loading…</> : 'Add components to a step to see it here.'}</div>}
            {step && !edit && <div className="as-card">
              <div className="as-card-num">Step {cur + 1}<small>/ {total}</small></div>
              <div className={'as-card-asm' + (step.group ? ' sub' : '')}>{step.group ? <Package size={13} /> : <Boxes size={13} />}{step.group ? `Sub-assembly · ${groupName(step.group)}` : 'Main assembly'}</div>
              <h3>{step.title || cfg?.methods[step.method]}</h3>
              <span className="as-method">{cfg?.methods[step.method]}</span>
              {(step.parts.length > 0 || (step.subs || []).length > 0) && <div className="as-sec"><h5>Components</h5>
                {(step.subs || []).map(x => <div key={x} className="as-comp"><Package size={13} className="as-sub-ico" /><span>Sub-assembly <b className="as-subname">{groupName(x)}</b></span></div>)}
                {step.parts.map(e => <div key={e.part} className="as-comp"><i style={{ background: '#4f8ff7' }} />{byId[e.part]?.name || e.part}<b>×{e.occurrences.length}</b></div>)}</div>}
              {step.fasteners.length > 0 && <div className="as-sec"><h5>Fasteners</h5>{step.fasteners.map((f, i) => <div key={i} className="as-fast"><i style={{ background: FCOL[i % FCOL.length] }} /><span><b>{f.qty} × {label(f)}</b>{(f.torque || f.threadlock || f.note) && <small>{[f.torque && 'Torque ' + f.torque, f.threadlock, f.note].filter(Boolean).join(' · ')}</small>}</span></div>)}</div>}
              {step.tools && <div className="as-sec"><h5>Tools</h5><p>{step.tools}</p></div>}
              {step.notes && <div className="as-sec"><h5>Instructions</h5><p className="as-notes">{step.notes}</p></div>}
              {step.check && <div className="as-sec as-check"><h5>Check</h5><p>{step.check}</p></div>}
            </div>}
            <footer className="as-bar">
              <button type="button" className="icon" title="Previous step (←)" disabled={cur === 0} onClick={() => { setPlaying(false); setCur(c => Math.max(0, c - 1)); }}><ChevronLeft size={18} /></button>
              <button type="button" className="as-play" title={playing ? 'Pause (Space)' : 'Play all steps (Space)'} disabled={!total} onClick={() => { if (!playing && cur >= total - 1) setCur(0); setPlaying(p => !p); }}>{playing ? <Pause size={16} /> : <Play size={16} />}</button>
              <button type="button" className="icon" title="Next step (→)" disabled={cur >= total - 1} onClick={() => { setPlaying(false); setCur(c => Math.min(total - 1, c + 1)); }}><ChevronRight size={18} /></button>
              <button type="button" className="icon" title="Replay this step" disabled={!total} onClick={restart}><RotateCcw size={15} /></button>
              <div className="as-track">{(steps || []).map((s, i) => <button type="button" key={s.id} className={i < cur ? 'done' : i === cur ? 'cur' : ''} title={`${i + 1}. ${s.title || cfg?.methods[s.method] || ''}`} onClick={() => { setPlaying(false); setCur(i); }}>{i + 1}</button>)}</div>
            </footer>
          </section>

          {edit && editable && <aside className="as-edit">
            {error && <div className="cfg-error">{error}</div>}
            {!step ? <div className="as-empty"><b>Start the build order</b><small>Select components in the 3D view and use “Add step”, or add an empty step.</small><button type="button" className="primary" onClick={() => newStep()}><Plus size={14} />Add step</button></div> : <>
              <div className={'as-edit-asm' + (step.group ? ' sub' : '')}>{step.group ? <Package size={13} /> : <Boxes size={13} />}{groupName(step.group)}</div>
              <label className="as-field"><span>Step {cur + 1} title</span><input value={step.title} placeholder={`e.g. Fit ${byId[step.parts[0]?.part]?.name || 'the bracket'} to the frame`} maxLength={160} onChange={e => change({ title: e.target.value })} /></label>

              <div className="as-field"><span>How is it joined?</span>
                <div className="as-chips">{cfg && Object.entries(cfg.methods).filter(([k]) => k !== 'weld' || step.method === 'weld').map(([k, v]) => <button type="button" key={k} className={step.method === k ? 'on' : ''} onClick={() => change({ method: k }, true)}>{v}</button>)}</div></div>

              <div className="as-field"><span>Components in this step</span>
                {step.parts.map(e => { const p = byId[e.part]; const n = Math.max(inst[e.part]?.length || 0, p?.quantity || 1, 1); return (
                  <div key={e.part} className="as-comp-edit">
                    <i style={{ background: '#4f8ff7' }} /><span title={p?.name}>{p?.name || e.part}</span>
                    {n > 1 && <span className="as-occ">{Array.from({ length: n }, (_, k) => { const elsewhere = placedBefore.get(occKey(e.part, k)); const taken = elsewhere !== undefined && elsewhere !== cur; return <button type="button" key={k} disabled={taken} title={taken ? `Fitted in step ${elsewhere! + 1}` : `Instance ${k + 1}`} className={e.occurrences.includes(k) ? 'on' : ''} onClick={() => { const occ = e.occurrences.includes(k) ? e.occurrences.filter(x => x !== k) : [...e.occurrences, k].sort((a, b) => a - b); if (occ.length) change({ parts: step.parts.map(x => x.part === e.part ? { ...x, occurrences: occ } : x) }, true); }}>{k + 1}</button>; })}</span>}
                    <button type="button" className="icon" title="Remove from step" onClick={() => change({ parts: step.parts.filter(x => x.part !== e.part) }, true)}><X size={13} /></button>
                  </div>); })}
                <PartPicker open={addOpen} setOpen={setAddOpen} parts={unusedParts} used={new Set(step.parts.map(e => e.part))} placed={placedBefore}
                  onPick={pid => { const n = Math.max(inst[pid]?.length || 0, byId[pid]?.quantity || 1, 1); const free = Array.from({ length: n }, (_, k) => k).filter(k => !placedBefore.has(occKey(pid, k))); change({ parts: [...step.parts, { part: pid, occurrences: free.length ? free : [0] }] }, true); }} />
              </div>

              {groups.length > 0 && <div className="as-field"><span>Sub-assemblies fitted in this step</span>
                {(step.subs || []).map(x => <div key={x} className="as-comp-edit"><Package size={13} /><span>{groupName(x)}</span><button type="button" className="icon" title="Remove" onClick={() => change({ subs: (step.subs || []).filter(y => y !== x) }, true)}><X size={13} /></button></div>)}
                {(() => {
                  const fittedElsewhere = new Set((steps || []).filter(x => x.id !== step.id).flatMap(x => x.subs || []));
                  const inside = (g: string, seen: string[] = []): string[] => (steps || []).filter(x => x.group === g).flatMap(x => (x.subs || []).filter(y => !seen.includes(y)).flatMap(y => [y, ...inside(y, [...seen, y])]));
                  const options = groups.filter(g => g.id !== step.group && !(step.subs || []).includes(g.id) && !fittedElsewhere.has(g.id) && !inside(g.id).includes(step.group));
                  return options.length ? <select className="as-sub-select" value="" onChange={e => { if (e.target.value) change({ subs: [...(step.subs || []), e.target.value] }, true); }}>
                    <option value="">Fit a finished sub-assembly…</option>{options.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select>
                    : !(step.subs || []).length ? <small className="muted">{step.group ? 'Other sub-assemblies can be fitted here once they exist and are not fitted elsewhere.' : 'Every sub-assembly is already fitted in a step.'}</small> : null;
                })()}
              </div>}

              <div className="as-field"><span>Fasteners</span>
                {cfg && step.fasteners.map((f, i) => <FastenerCard key={i} f={f} i={i} cfg={cfg} picking={pick === i} onPick={() => setPick(pick === i ? null : i)} set={p => setFastener(i, p)} remove={() => { change({ fasteners: step.fasteners.filter((_, k) => k !== i) }, true); setPick(null); }} />)}
                <div className="as-add-fast">{KINDS.map(([k, v]) => <button type="button" key={k} className="mini" onClick={() => addFastener(k)}><Plus size={12} />{v}</button>)}</div>
              </div>


              <label className="as-field"><span><Wrench size={12} /> Tools</span><input value={step.tools} placeholder="e.g. 4 mm hex key, torque wrench 2–10 N·m" maxLength={300} onChange={e => change({ tools: e.target.value })} /></label>
              <label className="as-field"><span>Instructions for the shop floor</span><textarea rows={5} value={step.notes} maxLength={4000} placeholder="How to hold, align and fit it; order of tightening; anything that is easy to get wrong." onChange={e => change({ notes: e.target.value })} /></label>
              <label className="as-field"><span>Check before moving on</span><input value={step.check} maxLength={600} placeholder="e.g. Bracket flush with frame edge; all screws torque-marked" onChange={e => change({ check: e.target.value })} /></label>
              <label className="as-field as-inline"><span>Animate from</span>
                <select value={step.approach} onChange={e => change({ approach: e.target.value }, true)}>{(cfg?.approach || []).map(a => <option key={a} value={a}>{a === 'auto' ? 'Automatic (away from the build)' : a.toUpperCase()}</option>)}</select></label>
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
    <div className={'as-fcard' + (picking ? ' picking' : '')}>
      <div className="as-fcard-head"><i style={{ background: FCOL[i % FCOL.length] }} /><b>{KINDS.find(k => k[0] === f.kind)?.[1]}</b><small>{f.designation || ''}</small>
        <button type="button" className="icon danger" title="Remove fastener" onClick={remove}><Trash2 size={13} /></button></div>
      <div className="as-fgrid">
        {f.kind === 'insert' ? <label className="wide"><span>Hardware</span><select value={f.item} onChange={e => set({ item: e.target.value })}>{cfg.hardware.map(h => <option key={h.id} value={h.id}>{h.name}{h.pn ? ' · ' + h.pn : ''}</option>)}</select></label>
          : f.kind === 'custom' ? <><label><span>Name</span><input value={f.name || ''} placeholder="e.g. Quarter-turn fastener" onChange={e => set({ name: e.target.value })} /></label><label><span>Part no.</span><input value={f.pn || ''} onChange={e => set({ pn: e.target.value })} /></label></>
          : <>
            <label className="wide"><span>Standard</span><select value={f.standard} onChange={e => set({ standard: e.target.value })}>{(cfg.fasteners[f.kind] || []).map(s => <option key={s.standard} value={s.standard}>{s.standard} — {s.name}</option>)}</select></label>
            <label><span>Size</span><input list="as-sizes" value={f.size || ''} onChange={e => set({ size: e.target.value })} /></label>
            {long && <label><span>Length</span><span className="wc-num"><input type="number" min={1} max={1000} step={1} value={f.length ?? ''} onChange={e => set({ length: Number(e.target.value) || undefined })} /><i>mm</i></span></label>}
          </>}
        <label><span>Qty</span><input type="number" min={1} max={999} value={f.qty} onChange={e => set({ qty: Math.max(1, Number(e.target.value) || 1) })} /></label>
        <label><span>Torque</span><input value={f.torque || ''} placeholder="e.g. 6 N·m" maxLength={40} onChange={e => set({ torque: e.target.value })} /></label>
        <label className="wide"><span>Thread locker</span><select value={f.threadlock || ''} onChange={e => set({ threadlock: e.target.value })}>{cfg.threadlock.map(t => <option key={t} value={t}>{t || 'None'}</option>)}</select></label>
        <label className="wide"><span>Note</span><input value={f.note || ''} maxLength={200} placeholder="e.g. washer under the head" onChange={e => set({ note: e.target.value })} /></label>
      </div>
      <button type="button" className={'as-holes-btn' + (picking ? ' on' : '')} onClick={onPick}><Crosshair size={14} />{picking ? 'Done picking holes' : f.holes.length ? `${f.holes.length} hole${f.holes.length === 1 ? '' : 's'} — change` : 'Pick holes in 3D'}</button>
      <datalist id="as-sizes">{SIZES.map(s => <option key={s} value={s} />)}</datalist>
    </div>
  );
}

function PartPicker({ open, setOpen, parts, used, placed, onPick }: { open: boolean; setOpen: (v: boolean) => void; parts: Any[]; used: Set<string>; placed: Map<string, number>; onPick: (pid: string) => void }) {
  const [q, setQ] = useState('');
  const list = parts.filter(p => !used.has(p.id) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))).slice(0, 60);
  const fittedOf = (pid: string) => [...placed.keys()].filter(k => k.startsWith(pid + '#')).length;
  if (!open) return <button type="button" className="mini as-add-comp" onClick={() => setOpen(true)}><Plus size={12} />Add component</button>;
  return (
    <div className="as-picker">
      <div className="as-picker-search"><Search size={14} /><input autoFocus value={q} placeholder="Find a component…" onChange={e => setQ(e.target.value)} /><button type="button" className="icon" onClick={() => setOpen(false)}><X size={13} /></button></div>
      <div className="as-picker-list">{list.map(p => { const fitted = fittedOf(p.id); return <button type="button" key={p.id} onClick={() => { onPick(p.id); setOpen(false); setQ(''); }}><span>{p.name}</span><small>{p.category?.replace('_', ' ')} · qty {p.quantity}{fitted ? ` · ${fitted} fitted` : ''}</small></button>; })}
        {!list.length && <small className="muted">No matching components</small>}</div>
    </div>
  );
}
