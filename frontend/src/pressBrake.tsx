import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { Pause, Play, RotateCcw, X, Maximize, Wrench, ListOrdered, ArrowUp, ArrowDown, AlertTriangle } from 'lucide-react';
import { CadControls, type NavStyle } from './cadControls';
import { api, loadSecureModel } from './api';

/** Server data (backend/app/bendsim.py): developed blank split into flanges and curling bend strips. */
type SimBend = { id: string; L: number[]; u: number[]; v: number[]; n: number[]; w: number; angle: number; radius: number; s: number; length: number; twin: number | null; stroke?: { center: number; span: number; ids: string[] } };
/** One press stroke of the collision-checked plan (backend/app/bendplan.py). Segments: X ranges of the sectional
 * punch and die along the bend line, from the stroke centre. */
type PlanStep = { bend: number; punch: string; mirror: boolean; die: string; segments: number[][]; clash: Record<string, number>; unchecked?: boolean };
type Tool = { profile: number[][]; height: number; upper?: number[][][]; lower?: number[][][] };
type Tooling = { k: number; W: number; vdepth: number; die_name: string; punches: Record<string, Tool>; dies: Record<string, Tool> };
export type BendSim = {
  thickness: number; bends: SimBend[]; regions: { chain: number[]; strip: number | null }[]; order: number[];
  plan: PlanStep[]; tooling: Tooling; sequence?: 'planned' | 'custom';
  vertices: number[]; region: number[]; triangles: number[]; edges: number[];
  part?: { name: string; material?: string; thickness?: number };
};

type V3 = [number, number, number];
const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Per-frame fold operator of one bend (see bendsim.py for the formulas). */
type Fold = { L: V3; u: V3; v: V3; n: V3; w: number; s: number; a: number; rho: number; C: V3; E: V3; T: V3; N: V3 };
function makeFold(b: SimBend, a: number): Fold | null {
  if (a < 1e-6) return null;
  const L = b.L as V3, u = b.u as V3, v = b.v as V3, n = b.n as V3, w = b.w, s = b.s;
  const rho = 2 * w / a;
  const S = add(L, v, -w);
  const C = add(S, n, s * rho);
  const E = add(add(C, v, rho * Math.sin(a)), n, -s * rho * Math.cos(a));
  const T = add([0, 0, 0], v, Math.cos(a)); const T2 = add(T, n, s * Math.sin(a));
  const N = add(add([0, 0, 0], v, -s * Math.sin(a)), n, Math.cos(a));
  return { L, u, v, n, w, s, a, rho, C, E, T: T2, N };
}
function applyFold(p: V3, f: Fold, strip: boolean): V3 {
  const r: V3 = [p[0] - f.L[0], p[1] - f.L[1], p[2] - f.L[2]];
  const du = dot(r, f.u), d = dot(r, f.v), h = dot(r, f.n);
  if (strip) {
    const phi = Math.min(Math.max((d + f.w) / f.rho, 0), f.a);
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const N: V3 = [-f.s * sp * f.v[0] + cp * f.n[0], -f.s * sp * f.v[1] + cp * f.n[1], -f.s * sp * f.v[2] + cp * f.n[2]];
    let q = add(f.C, f.v, f.rho * sp); q = add(q, f.n, -f.s * f.rho * cp); q = add(q, N, h); return add(q, f.u, du);
  }
  let q = add(f.E, f.T, d - f.w); q = add(q, f.N, h); return add(q, f.u, du);
}
/** fold a flat point through its region's chain (own strip first, then rigid ancestor folds) */
function foldPoint(p: V3, chain: number[], strip: number | null, folds: (Fold | null)[]): V3 {
  let q = p;
  for (let k = chain.length - 1; k >= 0; k--) {
    const bi = chain[k]; const f = folds[bi];
    if (!f) continue;
    q = applyFold(q, f, strip === bi && k === chain.length - 1);
  }
  return q;
}

const PER_BEND = 3.4;  // seconds per bend at 1×
const PHASES = { move: 0.3, press: 0.42, bend: 0.84 };  // fractions of a bend segment
const ease = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);

/**
 * Press-brake simulation: the blank is loaded on a V-die, the punch comes down and the flange folds, one bend
 * after another in the bending order. Tooling is illustrative (generic punch and V-die sized from the sheet
 * thickness), the folding is the part's real developed geometry and bend data.
 */
const CLASH: Record<string, string> = { punch: 'punch', die: 'die', beam: 'upper beam', bed: 'lower beam' };
const toolLabel = (st: PlanStep, tl: Tooling) => [
  (st.punch.startsWith('tall-') ? 'Tall ' : '') + (st.punch.endsWith('goose') ? 'gooseneck punch' : 'straight punch'),
  `${st.die.startsWith('tall-') ? 'tall ' : ''}V${+tl.W.toFixed(1)} die`,
].join(' · ').replace(/^t/, 'T').replace(/^s/, 'S').replace(/^g/, 'G');
const strokeName = (b: SimBend) => b.stroke ? b.stroke.ids.join(' + ') : b.id;

export default function PressBrake({ revision, part, name, navStyle = 'forge', canEdit = false, close }: {
  revision: string; part: string; name: string; navStyle?: NavStyle; canEdit?: boolean; close: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [sim, setSim] = useState<BendSim | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [time, setTime] = useState(0);
  const [tooling, setTooling] = useState(true);
  const [reload, setReload] = useState(0);
  const [seqOpen, setSeqOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const state = useRef({ time: 0, playing: true, speed: 1, tooling: true, fit: () => { /* set by scene */ } });
  state.current.playing = playing; state.current.speed = speed; state.current.tooling = tooling;

  useEffect(() => {
    const abort = new AbortController();
    setSim(null); setError('');
    loadSecureModel(`${revision}:bend-sim.json:${part}`, abort.signal)
      .then(buf => { state.current.time = 0; setTime(0); setPlaying(true); setSim(JSON.parse(new TextDecoder().decode(buf))); })
      .catch(e => { if (!abort.signal.aborted) setError(e.message || 'Bending simulation unavailable'); });
    return () => abort.abort();
  }, [revision, part, reload]);

  const seq = useMemo(() => sim ? sim.plan.map(s => s.bend) : [], [sim]);
  const total = seq.length * PER_BEND + 1.6;

  useEffect(() => {
    const el = host.current; if (!el || !sim) return;
    const t = sim.thickness;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xffffff, 1);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 1, 100000); camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfd5dc, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(-0.5, -1, 1.4); scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(1, 0.6, 0.4); scene.add(fill);
    const controls = new CadControls(camera, renderer.domElement); controls.style = navStyle;

    // ---------------------------------------------------------------- blank (flat coordinates → folded per frame)
    const P = sim.vertices; const nv = P.length / 3;
    const flat: V3[] = []; for (let i = 0; i < nv; i++) flat.push([P[3 * i], P[3 * i + 1], P[3 * i + 2]]);
    const folded = new Float32Array(nv * 3);
    const tri = sim.triangles;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(tri.length * 3);
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const partMat = new THREE.MeshStandardMaterial({ color: 0xe4e8ec, roughness: 0.4, metalness: 0.3, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    const partMesh = new THREE.Mesh(geo, partMat);
    const eg = new THREE.BufferGeometry(); const epos = new Float32Array(sim.edges.length * 3); eg.setAttribute('position', new THREE.BufferAttribute(epos, 3));
    const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x4b5563, transparent: true, opacity: 0.7 }));
    const partGroup = new THREE.Group(); partGroup.add(partMesh, edges); partGroup.matrixAutoUpdate = false; scene.add(partGroup);

    const extent = (() => { let lo = [1e9, 1e9], hi = [-1e9, -1e9]; for (const p of flat) { lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1])]; hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1])]; } return Math.hypot(hi[0] - lo[0], hi[1] - lo[1]); })();
    const maxLen = Math.max(...sim.bends.map(b => Math.max(b.length, b.stroke?.span || 0)), 40);

    // ---------------------------------------------------------------- tooling (generic, scaled to the sheet; chosen per stroke)
    const TL = sim.tooling, k = TL.k, W = TL.W, vDepth = TL.vdepth;
    const beamLen = Math.max(extent * 1.3, maxLen + 200 * k);
    const steel = new THREE.MeshStandardMaterial({ color: 0x7d8996, roughness: 0.55, metalness: 0.45 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xb4bdc7, roughness: 0.55, metalness: 0.45 });
    const clashMat = new THREE.MeshStandardMaterial({ color: 0xdc4c4c, roughness: 0.5, metalness: 0.2, transparent: true, opacity: 0.85 });
    const ghost = new THREE.MeshStandardMaterial({ color: 0xc7ced6, roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0.16, depthWrite: false });
    const ghostClash = new THREE.MeshStandardMaterial({ color: 0xdc4c4c, roughness: 0.6, metalness: 0.2, transparent: true, opacity: 0.3, depthWrite: false });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x2f3640, transparent: true, opacity: 0.35 });
    const ghostEdge = new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.18 });
    /** profile (Y, Z) extruded along X from x0 to x1 */
    const prism = (pts: number[][], x0: number, x1: number, mat: THREE.Material, mirror = false) => {
      const sh = new THREE.Shape(pts.map(([y, z]) => new THREE.Vector2(mirror ? -y : y, z)));
      const len = Math.max(x1 - x0, 0.5);
      const g = new THREE.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false });
      g.applyMatrix4(new THREE.Matrix4().set(0, 0, 1, x0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1));
      const grp = new THREE.Group(); grp.add(new THREE.Mesh(g, mat), new THREE.LineSegments(new THREE.EdgesGeometry(g, 30), mat.depthWrite ? edgeMat : ghostEdge)); return grp;
    };
    // one set of tools per stroke: sectional punch and die as long as the bend line, beams full length
    const stepTools = sim.plan.map(st => {
      const P = TL.punches[st.punch] || TL.punches.straight, D = TL.dies[st.die] || TL.dies.die;
      const c = st.clash || {};
      const upper = new THREE.Group(), lower = new THREE.Group();
      for (const [x0, x1] of st.segments) {
        upper.add(prism(P.profile, x0, x1, c.punch ? clashMat : steel, st.mirror));
        lower.add(prism(D.profile, x0, x1, c.die ? clashMat : steel));
      }
      // clamp / die rail solid, the machine beams as a ghost so the part stays in view
      (P.upper || []).forEach((q, j) => upper.add(prism(q, -beamLen / 2, beamLen / 2, c.beam ? (j ? ghostClash : clashMat) : j ? ghost : frameMat, st.mirror)));
      (D.lower || []).forEach((q, j) => lower.add(prism(q, -beamLen / 2, beamLen / 2, c.bed ? (j ? ghostClash : clashMat) : j ? ghost : frameMat)));
      upper.visible = lower.visible = false; scene.add(upper, lower);
      return { upper, lower };
    });

    // ---------------------------------------------------------------- kinematics
    const fullAngle = sim.bends.map(b => THREE.MathUtils.degToRad(b.angle));
    const anglesAt = (step: number, frac: number) => {
      const a = sim.bends.map(() => 0);
      seq.forEach((bi, i) => { a[bi] = i < step ? fullAngle[bi] : i === step ? fullAngle[bi] * frac : 0; });
      sim.bends.forEach((b, i) => { if (b.twin != null) a[i] = a[b.twin]; });
      return a;
    };
    const foldsFor = (angles: number[]) => sim.bends.map((b, i) => makeFold(b, angles[i]));
    /** tool frame of a bend in the current fold state: contact point on the die and its axes */
    const bendFrame = (bi: number, folds: (Fold | null)[], a: number) => {
      const b = sim.bends[bi]; if (!b) return new THREE.Matrix4();
      const chain = sim.regions.find(r => r.strip === bi)?.chain || [bi];
      const anc = chain.slice(0, -1);
      // mid-arc point and normal of the bend itself
      // a combined stroke (one line, several segments) is centred on the whole line
      let mid: V3 = add(b.L as V3, b.u as V3, b.stroke?.center || 0); let N: V3 = b.n as V3;
      const f = folds[bi];
      if (f && a > 1e-6) { mid = applyFold(mid, f, true); const ph = a / 2; N = add(add([0, 0, 0], b.v as V3, -b.s * Math.sin(ph)), b.n as V3, Math.cos(ph)); }
      const map = (p: V3) => foldPoint(p, anc, null, folds);
      const P0 = map(mid); const dirOf = (d: V3) => { const q = map(add(mid, d)); return [q[0] - P0[0], q[1] - P0[1], q[2] - P0[2]] as V3; };
      const X = new THREE.Vector3(...dirOf(b.u as V3)).normalize();
      const Z = new THREE.Vector3(...dirOf(N)).multiplyScalar(b.s).normalize();
      const Y = new THREE.Vector3().crossVectors(Z, X).normalize();
      const contact = new THREE.Vector3(...P0).addScaledVector(Z, -t / 2);
      // part → world: rows are the world axes expressed in part coordinates
      const R = new THREE.Matrix4().makeBasis(X, Y, Z).transpose();
      const M = R.clone().multiply(new THREE.Matrix4().makeTranslation(-contact.x, -contact.y, -contact.z));
      return M;
    };
    const sink = (a: number) => Math.min(W / 2 * Math.tan(a / 2) * 0.55, vDepth - t);

    const writeGeometry = (folds: (Fold | null)[]) => {
      for (let i = 0; i < nv; i++) {
        const reg = sim.regions[sim.region[i]];
        const q = foldPoint(flat[i], reg.chain, reg.strip, folds);
        folded[3 * i] = q[0]; folded[3 * i + 1] = q[1]; folded[3 * i + 2] = q[2];
      }
      for (let i = 0; i < tri.length; i++) { const v = tri[i]; pos[3 * i] = folded[3 * v]; pos[3 * i + 1] = folded[3 * v + 1]; pos[3 * i + 2] = folded[3 * v + 2]; }
      geo.attributes.position.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
      for (let i = 0; i < sim.edges.length; i++) { const v = sim.edges[i]; epos[3 * i] = folded[3 * v]; epos[3 * i + 1] = folded[3 * v + 1]; epos[3 * i + 2] = folded[3 * v + 2]; }
      eg.attributes.position.needsUpdate = true; eg.computeBoundingSphere();
    };

    const lift = Math.max(60, extent * 0.35), pull = Math.max(80, extent * 0.6);
    const poseAt = (time: number) => {
      const n = seq.length;
      if (!n) return;
      if (!isFinite(time)) time = 0;
      const step = Math.max(0, Math.min(n - 1, Math.floor(time / PER_BEND)));
      const local = time >= n * PER_BEND ? 1 + (time - n * PER_BEND) / 1.6 : (time - step * PER_BEND) / PER_BEND;
      const bi = seq[step];
      const bendFrac = local > 1 ? 1 : ease((local - PHASES.press) / (PHASES.bend - PHASES.press));
      const angles = anglesAt(step, bendFrac);
      const folds = foldsFor(angles);
      writeGeometry(folds);
      const a = angles[bi];
      const target = bendFrame(bi, folds, a);
      const d = sink(a);
      let M = new THREE.Matrix4().makeTranslation(0, 0, -d).multiply(target);
      // moving between bends: from where the previous bend left the part, lifted and pulled toward the operator
      if (local < PHASES.move) {
        const tau = ease(local / PHASES.move);
        let from: THREE.Matrix4;
        if (step === 0) from = new THREE.Matrix4().makeTranslation(0, -pull, lift).multiply(target);
        else {
          const prevAngles = anglesAt(step - 1, 1); const prevFolds = foldsFor(prevAngles);
          from = new THREE.Matrix4().makeTranslation(0, 0, -sink(fullAngle[seq[step - 1]])).multiply(bendFrame(seq[step - 1], prevFolds, fullAngle[seq[step - 1]]));
        }
        M = blend(from, M, tau, lift, pull);
      } else if (local > 1) {
        // done: lift the finished part out toward the operator
        const tau = ease(local - 1);
        M = blend(M, new THREE.Matrix4().makeTranslation(0, -pull * 0.8, lift * 1.2).multiply(new THREE.Matrix4().makeRotationZ(-tau * 0.6)).multiply(target), tau, 0, 0);
      }
      partGroup.matrix.copy(M); partGroup.matrixWorldNeedsUpdate = true;
      // punch: waits up, comes down to the sheet, follows the bend, goes back up
      const up = 50 * k;
      let z = t + up;
      if (local >= PHASES.move && local < PHASES.press) z = t + up * (1 - ease((local - PHASES.move) / (PHASES.press - PHASES.move)));
      else if (local >= PHASES.press && local <= PHASES.bend) z = t - d;
      else if (local > PHASES.bend && local <= 1) z = t - d + up * ease((local - PHASES.bend) / (1 - PHASES.bend));
      stepTools.forEach((g, i) => { g.upper.visible = g.lower.visible = i === step && state.current.tooling; });
      stepTools[step].upper.position.z = z;
    };

    // ---------------------------------------------------------------- camera / loop
    const R0 = Math.max(extent * 0.62, 70 * k);
    const fit = () => {
      const dir = new THREE.Vector3(-0.5, -1, 0.42).normalize();
      const dist = R0 / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.95;
      controls.target.set(0, 0, 10 * k); camera.position.copy(controls.target).addScaledVector(dir, dist);
      camera.up.set(0, 0, 1); camera.near = dist / 300; camera.far = dist * 30; camera.updateProjectionMatrix(); controls.update();
    };
    state.current.fit = fit;
    controls.minDistance = R0 * 0.05; controls.maxDistance = R0 * 30;
    const resize = () => { const w = el.clientWidth || 1, h = el.clientHeight || 1; renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize(); fit();
    let raf = 0, last = performance.now(), shown = -1, lastKey = '';
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - last) / 1000); last = now;
      const st = state.current;
      if (st.playing) { st.time = Math.min(total, st.time + dt * st.speed); if (st.time >= total) setPlaying(false); }
      const key = camera.position.toArray().join() + camera.quaternion.toArray().join() + el.clientWidth + st.tooling;
      if (st.time === shown && key === lastKey) return;
      if (st.time !== shown) { poseAt(st.time); if (Math.abs(st.time - shown) > 0.05 || !st.playing) setTime(st.time); }
      shown = st.time; lastKey = key;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); controls.dispose();
      scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | undefined; mat?.dispose?.(); });
      renderer.dispose(); renderer.domElement.remove();
    };
  }, [sim]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const seek = (x: number) => { state.current.time = Math.max(0, Math.min(total, x)); setTime(state.current.time); };
  const togglePlay = () => { if (!playing && state.current.time >= total - 0.01) seek(0); setPlaying(p => !p); };
  const bar = useRef<HTMLDivElement>(null);
  const scrub = (e: React.PointerEvent) => {
    const r = bar.current!.getBoundingClientRect();
    const go = (cx: number) => seek((cx - r.left) / r.width * total);
    go(e.clientX); setPlaying(false);
    const mv = (ev: PointerEvent) => go(ev.clientX);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  };
  const step = Math.min(seq.length - 1, Math.floor(time / PER_BEND));
  const cur = sim && seq.length ? sim.bends[seq[Math.max(0, step)]] : null;
  const curStep = sim && seq.length ? sim.plan[Math.max(0, step)] : null;
  const clashes = sim ? sim.plan.filter(s => Object.keys(s.clash || {}).length).length : 0;
  const saveOrder = async (ids: string[]) => {
    const r = await api(`/revisions/${revision}/parts/${part}/bend-order`, 'PUT', { order: ids });
    setNotice(r?.job ? 'Drawing is being regenerated with this order (bend table: tags B1… in bending order, sequence and tooling).' : 'The flat-pattern drawing lists this order after the next Regenerate documents.');
    setReload(r2 => r2 + 1);
  };

  return (
    <div className="overlay top cfg-overlay" role="dialog" aria-label="Press brake simulation" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="cfg-dialog pb-dialog">
        <header className="cfg-head">
          <div className="cfg-title"><b>Press brake simulation</b><small>{name}{sim?.part?.material ? ' · ' + sim.part.material : ''}{sim ? ` · t ${sim.thickness} mm · ${seq.length} bend${seq.length === 1 ? '' : 's'}${sim.bends.length > seq.length ? ` (${sim.bends.length} bend lines, collinear ones in one stroke)` : ''}` : ''}</small></div>
          <button type="button" className="icon cfg-close" aria-label="Close" title="Close (Esc)" onClick={close}><X size={18} /></button>
        </header>
        <div className="pb-stage">
          <div ref={host} className="pscene-gl" />
          <div className="pscene-tools">
            <button type="button" title="Reset view" onClick={() => state.current.fit()}><Maximize size={15} /></button>
            <button type="button" title={tooling ? 'Hide tooling' : 'Show tooling'} className={tooling ? 'on' : ''} onClick={() => setTooling(v => !v)}><Wrench size={15} /></button>
            <button type="button" title="Bending sequence" className={seqOpen ? 'on' : ''} disabled={!sim} onClick={() => setSeqOpen(v => !v)}><ListOrdered size={15} /></button>
          </div>
          {sim && seqOpen && <Sequence sim={sim} current={step} canEdit={canEdit} notice={notice} go={i => { seek(i * PER_BEND + PER_BEND * PHASES.press); setPlaying(false); }} save={saveOrder} close={() => setSeqOpen(false)} />}
          {!sim && !error && <div className="pscene-state"><span className="spinner" />Preparing simulation…</div>}
          {error && <div className="pscene-state">{error}</div>}
          {cur && <div className="pb-info">
            <b>Bend {Math.min(step + 1, seq.length)} of {seq.length}</b>
            <span>{cur.stroke ? cur.stroke.ids.join(' + ') + ' (one stroke)' : cur.id} · {cur.angle.toFixed(cur.angle % 1 ? 1 : 0)}° {cur.s > 0 ? 'up' : 'down'} · R{cur.radius.toFixed(2)}</span>
            {curStep && <span className="pb-tool">{toolLabel(curStep, sim!.tooling)}</span>}
            {curStep && Object.keys(curStep.clash || {}).length > 0 && <span className="pb-clash"><AlertTriangle size={13} />Hits the {Object.keys(curStep.clash).map(k => CLASH[k] || k).join(' and ')} — needs special tooling or another sequence</span>}
          </div>}
          {sim && !seqOpen && <div className={'pb-plan' + (clashes ? ' bad' : '')} onClick={() => setSeqOpen(true)}>
            {clashes ? <><AlertTriangle size={13} />{clashes} stroke{clashes === 1 ? '' : 's'} with a tool clash</> : <>Collision-checked sequence</>}{sim.sequence === 'custom' ? ' · shop order' : ''}
          </div>}
        </div>
        <footer className="pb-bar">
          <button type="button" className="pb-play" title={playing ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay} disabled={!sim}>
            {playing ? <Pause size={16} /> : time >= total - 0.01 ? <RotateCcw size={16} /> : <Play size={16} />}
          </button>
          <div ref={bar} className="pb-track" onPointerDown={scrub}>
            {seq.map((bi, i) => <div key={bi} className={'pb-seg' + (i < step || time >= total - 1.6 ? ' done' : i === step ? ' cur' : '') + (Object.keys(sim!.plan[i].clash || {}).length ? ' clash' : '')} style={{ left: `${i * PER_BEND / total * 100}%`, width: `${PER_BEND / total * 100}%` }}
              title={`${sim!.bends[bi].stroke?.ids.join(' + ') || sim!.bends[bi].id} · ${sim!.bends[bi].angle}°`}><span>{i + 1}</span></div>)}
            <div className="pb-head" style={{ left: `${time / total * 100}%` }} />
          </div>
          <select className="pb-speed" value={speed} onChange={e => setSpeed(Number(e.target.value))} aria-label="Speed">
            {[0.25, 0.5, 1, 2].map(s => <option key={s} value={s}>{s}×</option>)}
          </select>
        </footer>
      </div>
    </div>
  );
}

/** Bending sequence: every stroke with its tooling and clashes; engineers can fix the shop's order (re-checked). */
function Sequence({ sim, current, canEdit, notice, go, save, close }: { sim: BendSim; current: number; canEdit: boolean; notice: string; go: (i: number) => void; save: (ids: string[]) => Promise<void>; close: () => void }) {
  const [draft, setDraft] = useState<number[]>(() => sim.plan.map(s => s.bend));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const planned = sim.plan.map(s => s.bend);
  const changed = draft.join() !== planned.join();
  const stepOf = (bi: number) => sim.plan.find(s => s.bend === bi)!;
  const move = (i: number, d: number) => setDraft(x => { const y = [...x]; const j = i + d; if (j < 0 || j >= y.length) return x; [y[i], y[j]] = [y[j], y[i]]; return y; });
  const run = async (ids: string[]) => { setBusy(true); setErr(''); try { await save(ids); } catch (e: unknown) { setErr((e as Error).message); setBusy(false); } };
  return (
    <div className="pb-seq" onMouseDown={e => e.stopPropagation()}>
      <header><b>Bending sequence</b><small>{sim.sequence === 'custom' ? 'Shop order, checked against the tooling' : 'Planned: outer and short flanges first, no tool clashes'}</small>
        <button type="button" className="icon" aria-label="Close" onClick={close}><X size={15} /></button></header>
      <ol>{draft.map((bi, i) => {
        const b = sim.bends[bi], st = stepOf(bi), bad = !changed && Object.keys(st.clash || {}).length > 0;
        return (
          <li key={bi} className={(i === current && !changed ? 'cur ' : '') + (bad ? 'clash' : '')} onClick={() => !changed && go(i)}>
            <span className="n">{i + 1}</span>
            <span className="t"><b>{strokeName(b)}</b><small>{b.angle.toFixed(b.angle % 1 ? 1 : 0)}° {b.s > 0 ? 'up' : 'down'}{!changed ? ' · ' + toolLabel(st, sim.tooling) : ''}</small>
              {bad && <small className="pb-clash"><AlertTriangle size={11} />hits the {Object.keys(st.clash).map(k => CLASH[k] || k).join(' and ')}</small>}</span>
            {canEdit && <span className="mv">
              <button type="button" className="icon" aria-label="Earlier" disabled={i === 0 || busy} onClick={e => { e.stopPropagation(); move(i, -1); }}><ArrowUp size={13} /></button>
              <button type="button" className="icon" aria-label="Later" disabled={i === draft.length - 1 || busy} onClick={e => { e.stopPropagation(); move(i, 1); }}><ArrowDown size={13} /></button>
            </span>}
          </li>);
      })}</ol>
      {err && <div className="cfg-error">{err}</div>}
      {canEdit && <footer>
        {changed && <button type="button" disabled={busy} onClick={() => setDraft(planned)}>Undo</button>}
        {!changed && sim.sequence === 'custom' && <button type="button" disabled={busy} onClick={() => run([])}>Plan automatically</button>}
        {changed && <button type="button" className="primary" disabled={busy} onClick={() => run(draft.map(bi => sim.bends[bi].id))}>{busy ? <span className="spinner" /> : null}Use this order</button>}
      </footer>}
      {changed ? <p className="pb-note">The order is checked against the punch, die and beams when you apply it, and the flat-pattern drawing follows it.</p>
        : notice ? <p className="pb-note">{notice}</p> : <p className="pb-note">Bend B1… on the flat-pattern drawing is stroke 1… here.</p>}
    </div>
  );
}

/** interpolate two rigid poses, arcing the move up (lift) and toward the operator (pull) */
function blend(a: THREE.Matrix4, b: THREE.Matrix4, tau: number, lift: number, pull: number) {
  const pa = new THREE.Vector3(), qa = new THREE.Quaternion(), sa = new THREE.Vector3();
  const pb = new THREE.Vector3(), qb = new THREE.Quaternion(), sb = new THREE.Vector3();
  a.decompose(pa, qa, sa); b.decompose(pb, qb, sb);
  // positions are of the part origin; arc through the air so the part clears the tooling
  const p = pa.clone().lerp(pb, tau); const arc = Math.sin(Math.PI * tau);
  p.z += lift * arc; p.y -= pull * arc;
  return new THREE.Matrix4().compose(p, qa.clone().slerp(qb, tau), new THREE.Vector3(1, 1, 1));
}
