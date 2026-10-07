import * as THREE from 'three';

/**
 * Realistic hole hardware for the 3D views: lathe-turned bodies with real thread profiles, knurled clinch
 * collars, hex weld nuts and countersink cones, in plated-steel materials (zinc bright body, yellow-zinc thread)
 * that pick up the scene's environment reflections. Every model is built along +Y from the sheet face (y = 0) on
 * the insertion side; `hardwareModel` turns it onto the hole.
 */

export type HoleLike = { axis: number[]; origin: number[]; start: number; end: number; diameter: number };

const ZINC = () => new THREE.MeshStandardMaterial({ color: 0xd9dee4, metalness: 0.88, roughness: 0.3, envMapIntensity: 1.1 });
const YELLOW = () => new THREE.MeshStandardMaterial({ color: 0xd8b24a, metalness: 0.9, roughness: 0.36, side: THREE.DoubleSide, envMapIntensity: 1.1 });
const DARK = () => new THREE.MeshStandardMaterial({ color: 0x5f6670, metalness: 0.6, roughness: 0.55 });

/** Thread major diameter (mm) from a designation: M5 / M5×0.8 / #10-32 / 1/4-20. */
export function threadDia(t: string) {
  const m = /^M([\d.]+)/.exec(t || ''); if (m) return Number(m[1]);
  const n = /^#(\d+)/.exec(t || ''); if (n) return (0.06 + 0.013 * Number(n[1])) * 25.4;
  const f = /^(\d+)\/(\d+)/.exec(t || ''); if (f) return Number(f[1]) / Number(f[2]) * 25.4;
  return 0;
}
/** ISO coarse pitch for a metric size, else an approximate pitch. */
export function threadPitch(t: string, d: number) {
  const x = /×\s*([\d.]+)|x\s*([\d.]+)/i.exec(t || ''); if (x) return Number(x[1] || x[2]);
  const iso: Record<string, number> = { '2': 0.4, '2.5': 0.45, '3': 0.5, '4': 0.7, '5': 0.8, '6': 1, '8': 1.25, '10': 1.5, '12': 1.75, '16': 2 };
  const m = /^M([\d.]+)/.exec(t || ''); if (m && iso[m[1]]) return iso[m[1]];
  return Math.max(0.35, d * 0.14);
}

const lathe = (pts: [number, number][], seg = 48) => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y)), seg);

/** Internal (or external) thread: a saw-tooth profile turned around Y between y0 and y1. */
function threadMesh(rMinor: number, rMajor: number, pitch: number, y0: number, y1: number, internal: boolean) {
  const pts: [number, number][] = [];
  const n = Math.max(2, Math.round(Math.abs(y1 - y0) / pitch));
  const step = (y1 - y0) / n;
  for (let i = 0; i <= n; i++) {
    const y = y0 + i * step;
    pts.push([internal ? rMajor : rMinor, y]);
    if (i < n) pts.push([internal ? rMinor : rMajor, y + step * 0.5]);
  }
  const g = lathe(pts, 40);
  // a slight helix: shear each vertex along Y by its angle, so it reads as a thread, not as grooves
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const a = Math.atan2(p.getZ(i), p.getX(i));
    p.setY(i, Math.min(Math.max(y0, y1), Math.max(Math.min(y0, y1), p.getY(i) + (a / (2 * Math.PI)) * pitch)));
  }
  g.computeVertexNormals();
  return g;
}

/** Straight knurl: ripple the radius of vertices beyond rFrom. */
function knurl(g: THREE.BufferGeometry, rFrom: number, teeth = 30, depth = 0.05) {
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
    if (r < rFrom) continue;
    const a = Math.atan2(z, x), k = 1 + depth * Math.sign(Math.cos(a * teeth));
    p.setX(i, x * k); p.setZ(i, z * k);
  }
  g.computeVertexNormals();
  return g;
}

function hexPrism(acrossFlats: number, h: number, y0: number, chamfer = 0.12) {
  const R = acrossFlats / 2 / Math.cos(Math.PI / 6), c = Math.min(h * 0.2, R * chamfer);
  const g = lathe([[0, y0], [R - c, y0], [R, y0 + c], [R, y0 + h - c], [R - c, y0 + h], [0, y0 + h]], 6);
  g.rotateY(Math.PI / 6);
  return g;
}

/** Model in local space (+Y out of the face on the insertion side, sheet from y = 0 to y = -t). */
export function hardwareLocal(hw: any, holeDia: number, t: number): THREE.Group | null {
  const g = new THREE.Group();
  const d = threadDia(hw.thread || '') || (hw.hole || holeDia) * 0.8;
  const pitch = threadPitch(hw.thread || '', d);
  const hole = hw.hole || holeDia;
  const rMaj = d / 2, rMin = d / 2 - 0.6 * pitch;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material) => { const m = new THREE.Mesh(geo, mat); g.add(m); return m; };
  switch (hw.type) {
    case 'nut': {   // self-clinching nut: knurled collar flush in the sheet, round body standing proud, chamfered top
      const R = Math.max(hole / 2 * 1.02, rMaj * 1.45), Rc = R * 1.22, H = Math.max(1.4, d * 0.95), c = Math.min(0.35, H * 0.18);
      add(lathe([[rMaj, -t], [R * 0.97, -t], [R * 0.97, 0], [R, 0.02], [R, H - c], [R - c, H], [rMaj + 0.2 * pitch, H], [rMaj, H - 0.15]]), ZINC());
      add(knurl(lathe([[R, -0.05], [Rc, -0.05], [Rc, 0.12], [R, 0.22]], 96), R * 1.05, 36, 0.035), ZINC());
      add(threadMesh(rMin, rMaj, pitch, -t, H - 0.15, true), YELLOW());
      break;
    }
    case 'flush_nut': {   // sits flush both sides: only the face ring and the thread show
      const R = Math.max(hole / 2, rMaj * 1.35);
      add(lathe([[rMaj, -t], [R, -t], [R, 0.01], [rMaj + 0.2 * pitch, 0.01], [rMaj, -0.1]]), ZINC());
      add(knurl(lathe([[R * 0.92, 0.012], [R, 0.012]], 96), R * 0.95, 30, 0.04), ZINC());
      add(threadMesh(rMin, rMaj, pitch, -t, -0.1, true), YELLOW());
      break;
    }
    case 'stud': {   // flush head on the insertion face, threaded shank out of the far side
      const L = Number(hw.length || d * 2.5), Rh = Math.max(rMaj * 1.7, hole / 2 * 1.3);
      add(knurl(lathe([[0, 0.02], [Rh, 0.02], [Rh, -0.35], [rMaj, -0.45]], 96), Rh * 0.9, 28, 0.03), ZINC());
      add(lathe([[0, -t - L], [rMin * 0.8, -t - L], [rMin, -t - L + 0.4 * pitch], [rMin, -t - L + pitch]], 36), ZINC());
      add(threadMesh(rMin, rMaj, pitch, -t - L + pitch, -t, false), ZINC());
      break;
    }
    case 'standoff': {   // hex body on the far side, thread inside (blind or through)
      const L = Number(hw.length || d * 3), af = Math.max(d * 1.75, hole * 1.1);
      add(hexPrism(af, L, -t - L), ZINC());
      add(lathe([[hole / 2 * 0.97, -t], [hole / 2 * 0.97, 0.01], [hole / 2 * 1.15, 0.01], [hole / 2 * 1.15, -0.1]], 48), ZINC());
      add(threadMesh(rMin, rMaj, pitch, -t - L + (String(hw.pn || '').startsWith('BSO') ? 1.2 : 0), 0, true), YELLOW());
      break;
    }
    case 'rivnut': {   // flat flange on the face, ribbed sleeve through the sheet and beyond
      const Rb = hole / 2 * 0.98, Rf = Rb * 1.55, L = Math.max(t + d * 1.4, 2 * d);
      add(lathe([[rMaj, 0.65], [Rf - 0.3, 0.65], [Rf, 0.35], [Rf, 0], [Rb, 0], [Rb, 0.4]], 64), ZINC());
      add(knurl(lathe([[Rb, 0], [Rb, -L], [rMaj, -L]], 96), Rb * 0.9, 12, 0.06), ZINC());
      add(threadMesh(rMin, rMaj, pitch, -L, 0.65, true), YELLOW());
      break;
    }
    case 'weld_nut': {   // DIN 929 hex weld nut on the face, pilot in the hole, three weld projections
      const af = d * 1.7 + 1, H = d * 0.85;
      add(hexPrism(af, H, 0.25), ZINC());
      add(lathe([[hole / 2 * 0.97, -t * 0.6], [hole / 2 * 0.97, 0.3], [rMaj, 0.3]], 48), ZINC());
      for (let k = 0; k < 3; k++) {
        const bump = new THREE.Mesh(new THREE.SphereGeometry(af * 0.09, 12, 8), DARK());
        const a = Math.PI / 6 + k * 2 * Math.PI / 3; bump.position.set(Math.cos(a) * af * 0.42, 0.12, Math.sin(a) * af * 0.42); bump.scale.set(1, 0.6, 1); g.add(bump);
      }
      add(threadMesh(rMin, rMaj, pitch, 0.25, 0.25 + H, true), YELLOW());
      break;
    }
    case 'tap': {   // the thread cut in the hole wall
      const r = hole / 2;
      add(threadMesh(r, Math.max(r + 0.5 * pitch, rMaj), pitch, -t, 0, true), YELLOW());
      break;
    }
    case 'countersink': {
      const R = (hw.csk || holeDia * 2) / 2, ang = THREE.MathUtils.degToRad((hw.angle || 90) / 2), depth = Math.min(t, (R - holeDia / 2) / Math.tan(ang));
      const m = add(lathe([[R, 0.01], [holeDia / 2, -depth]], 64), new THREE.MeshStandardMaterial({ color: 0xc4cad1, metalness: 0.9, roughness: 0.22, side: THREE.DoubleSide }));
      m.renderOrder = 2;
      break;
    }
    default: return null;
  }
  return g;
}

/** Hardware placed on a hole (hole axis and extents in model space), on its insertion side (hw.side = ±1). */
export function hardwareModel(h: HoleLike, hw: any): THREE.Object3D | null {
  const a = new THREE.Vector3(...h.axis).normalize(), o = new THREE.Vector3(...h.origin);
  const side = hw.side || 1;
  const top = side > 0 ? Math.max(h.start, h.end) : Math.min(h.start, h.end), bottom = side > 0 ? Math.min(h.start, h.end) : Math.max(h.start, h.end);
  const t = Math.abs(top - bottom) || 1;
  const local = hardwareLocal(hw, h.diameter, t);
  if (!local) return null;
  const out = a.clone().multiplyScalar(side);
  local.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), out);
  local.position.copy(o).addScaledVector(a, top);
  local.traverse(m => { (m as THREE.Mesh).castShadow = false; });
  return local;
}
