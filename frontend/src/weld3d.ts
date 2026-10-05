import * as THREE from 'three';

/** Saved or draft weld as the viewer draws it. Geometry is in each part's definition coordinates. */
export type WeldSelection = {
  part: string; occurrence?: number; selection?: 'face' | 'edge'; type?: string; index?: number;
  point?: number[]; normal?: number[]; start?: number[]; end?: number[]; length?: number;
  boundaries?: number[][][]; preview_mesh?: { vertices: number[][]; triangles: number[][] };
  joint?: 'fillet' | 'corner' | 'butt' | 'gap'; legs?: number[][]; range?: number[]; opening?: number[]; gap?: number | null; other_part?: string; other_occurrence?: number;
};
export type WeldShape = { id: string; label?: string; faces: WeldSelection[]; weld?: Record<string, unknown>; active?: boolean };

export const WELD_COLORS = { mig: 0xd99a2b, laser: 0xdfe7ef, tig: 0xc8cdd3, draft: 0xffb21a };

export function pathLength(path: THREE.Vector3[]) { return path.slice(1).reduce((sum, point, i) => sum + point.distanceTo(path[i]), 0); }
export function pointAt(path: THREE.Vector3[], distance: number) {
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    const length = path[i].distanceTo(path[i - 1]);
    if (travelled + length >= distance) return path[i - 1].clone().lerp(path[i], length ? (distance - travelled) / length : 0);
    travelled += length;
  }
  return path[path.length - 1].clone();
}
export function pathSection(path: THREE.Vector3[], start: number, end: number) {
  const section = [pointAt(path, start)];
  let travelled = 0;
  for (let i = 1; i < path.length; i++) {
    travelled += path[i].distanceTo(path[i - 1]);
    if (travelled > start && travelled < end) section.push(path[i].clone());
  }
  section.push(pointAt(path, end));
  return section;
}
/** Resample a polyline so ripples and profiles are evenly spaced. */
export function resample(path: THREE.Vector3[], step: number) {
  const total = pathLength(path);
  if (total < 1e-6) return path;
  const n = Math.max(2, Math.min(600, Math.ceil(total / step) + 1));
  return Array.from({ length: n }, (_, i) => pointAt(path, total * i / (n - 1)));
}

/**
 * A weld bead swept along a seam. The cross-section follows the joint:
 *  - fillet: a crowned triangle filling the inside corner between the two faces (legs u, v)
 *  - butt:   a low crowned strip lying on the flush surface (normal n)
 *  - other:  a round bead centred on the seam
 * `size` is the throat a (mm); `minVisible` keeps the bead readable at assembly zoom.
 */
export function beadGeometry(path: THREE.Vector3[], opts: { joint?: string; legs?: [THREE.Vector3, THREE.Vector3] | null; normal?: THREE.Vector3 | null; size: number; minVisible: number; ripple?: boolean }) {
  const a = Math.max(opts.size, opts.minVisible);
  const pts = resample(path, Math.max(a * 0.45, pathLength(path) / 500));
  const n = pts.length;
  let profile: (i: number, t: THREE.Vector3) => THREE.Vector3[];
  if (opts.joint !== 'butt' && opts.legs) {
    const [u, v] = opts.legs;
    const z = a * Math.SQRT2; // leg length for throat a
    profile = () => [new THREE.Vector3(), u.clone().multiplyScalar(z), u.clone().add(v).multiplyScalar(z * 0.58), v.clone().multiplyScalar(z)];
  } else if (opts.joint === 'butt' && opts.normal) {
    const nn = opts.normal.clone().normalize();
    const w = Math.max(a * 1.7, opts.minVisible * 1.5);
    profile = (_i, t) => {
      const s = t.clone().cross(nn).normalize();
      const at = (k: number, h: number) => s.clone().multiplyScalar(k * w / 2).addScaledVector(nn, h * a);
      return [at(-1, 0.02), at(-0.6, 0.22), at(0, 0.34), at(0.6, 0.22), at(1, 0.02), at(0, -0.05)];
    };
  } else {
    const r = a * 0.6;
    profile = (_i, t) => {
      const ref = Math.abs(t.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
      const s = t.clone().cross(ref).normalize(), q = t.clone().cross(s).normalize();
      return Array.from({ length: 10 }, (_, k) => s.clone().multiplyScalar(Math.cos(k / 10 * Math.PI * 2) * r).addScaledVector(q, Math.sin(k / 10 * Math.PI * 2) * r));
    };
  }
  const positions: number[] = [];
  const rings: number[] = [];
  let m = 0;
  for (let i = 0; i < n; i++) {
    const t = pts[Math.min(n - 1, i + 1)].clone().sub(pts[Math.max(0, i - 1)]).normalize();
    const ring = profile(i, t);
    m = ring.length;
    // scaly MIG look: a gentle periodic swell along the bead
    const swell = opts.ripple ? 1 + 0.09 * Math.abs(Math.sin(i * 1.15)) : 1;
    for (const p of ring) { const q = pts[i].clone().addScaledVector(p, swell); positions.push(q.x, q.y, q.z); }
    rings.push(i * m);
  }
  const index: number[] = [];
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < m; k++) {
    const a0 = i * m + k, a1 = i * m + (k + 1) % m, b0 = a0 + m, b1 = a1 + m;
    index.push(a0, b0, a1, a1, b0, b1);
  }
  // end caps (fan around the ring centroid)
  for (const [start, flip] of [[0, true], [(n - 1) * m, false]] as const) {
    const c = new THREE.Vector3();
    for (let k = 0; k < m; k++) c.add(new THREE.Vector3(positions[(start + k) * 3], positions[(start + k) * 3 + 1], positions[(start + k) * 3 + 2]));
    c.multiplyScalar(1 / m);
    const ci = positions.length / 3; positions.push(c.x, c.y, c.z);
    for (let k = 0; k < m; k++) flip ? index.push(ci, start + (k + 1) % m, start + k) : index.push(ci, start + k, start + (k + 1) % m);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

export function beadMaterial(process: unknown, draft = false) {
  const p = String(process || '');
  const color = draft ? WELD_COLORS.draft : p.startsWith('Laser') ? WELD_COLORS.laser : p.startsWith('TIG') ? WELD_COLORS.tig : WELD_COLORS.mig;
  return new THREE.MeshStandardMaterial({ color, metalness: 0.55, roughness: 0.38, emissive: new THREE.Color(color).multiplyScalar(draft ? 0.35 : 0.18), side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
}

/** Small always-facing, constant-screen-size text label (e.g. "W3 · a4") drawn on a canvas sprite. */
export function labelSprite(text: string, screenHeight = 0.032, accent = '#b45309', occlude = false) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = '600 44px Inter, system-ui, sans-serif';
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 36, h = 64;
  canvas.width = w; canvas.height = h;
  ctx.font = font;
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.strokeStyle = accent; ctx.lineWidth = 4;
  const r = 14;
  ctx.beginPath(); ctx.moveTo(r, 2); ctx.arcTo(w - 2, 2, w - 2, h - 2, r); ctx.arcTo(w - 2, h - 2, 2, h - 2, r); ctx.arcTo(2, h - 2, 2, 2, r); ctx.arcTo(2, 2, w - 2, 2, r); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#1f2937'; ctx.textBaseline = 'middle'; ctx.fillText(text, 18, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: occlude, depthWrite: false, transparent: true, sizeAttenuation: false }));
  sprite.scale.set(screenHeight * w / h, screenHeight, 1);
  sprite.renderOrder = 40;
  return sprite;
}
