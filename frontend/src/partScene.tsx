import React, { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box, Maximize } from 'lucide-react';
import { CadControls, upFor, type NavStyle } from './cadControls';
import { loadSecureModel } from './api';

/** One body in a configuration scene: a part's mesh at an assembly placement (row-major 4×4, mm). */
export type SceneBody = { part: string; occurrence?: number; matrix?: number[][] };

export type SceneApi = {
  scene: THREE.Scene; camera: THREE.PerspectiveCamera; dom: HTMLCanvasElement; overlay: THREE.Group;
  controls: CadControls; radius: number; center: THREE.Vector3;
  bodies: { body: SceneBody; mesh: THREE.Mesh; matrix: THREE.Matrix4; edges: THREE.LineSegments }[];
  /** world → part coordinates of a body */
  toPart: (b: SceneBody) => THREE.Matrix4 | null;
  toWorld: (b: SceneBody) => THREE.Matrix4 | null;
  ndc: (clientX: number, clientY: number) => THREE.Vector2;
  /** nearest model surface hit under the pointer */
  hitModel: (clientX: number, clientY: number) => THREE.Intersection | null;
  /** screen-space pixel distance of a world point from the pointer */
  screenDistance: (p: THREE.Vector3, clientX: number, clientY: number) => number;
  /** pixel size of 1 mm at a world point (for picking tolerances) */
  pxPerMm: (p: THREE.Vector3) => number;
  fit: (dir?: THREE.Vector3) => void;
  /** redraw on the next frame (after changing overlays or materials) */
  invalidate: () => void;
};

const m4 = (m?: number[][]) => {
  const t = new THREE.Matrix4();
  if (m && m.length === 4) t.set(...(m.flat() as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
  return t;
};
const ISO = new THREE.Vector3(1, -1.25, 0.9).normalize();

/**
 * Focused 3D scene for the hole and weld configuration dialogs: just the parts being configured, CAD-style
 * shading with crisp edges, free CAD navigation. Pointer handlers get the scene API; a click is a press +
 * release without dragging (a drag rotates). `capture` lets a handler take the pointer instead of the camera
 * (press-and-drag welding).
 */
export default function PartScene({ revision, bodies, navStyle = 'forge', onReady, onHover, onClick, onPress, onDrag, onRelease, cursor, children }: {
  revision: string; bodies: SceneBody[]; navStyle?: NavStyle;
  onReady?: (api: SceneApi) => void;
  onHover?: (e: PointerEvent, api: SceneApi) => void;
  onClick?: (e: PointerEvent, api: SceneApi) => void;
  /** return true to take this press (camera does not rotate) */
  onPress?: (e: PointerEvent, api: SceneApi) => boolean;
  onDrag?: (e: PointerEvent, api: SceneApi) => void;
  onRelease?: (e: PointerEvent, api: SceneApi) => void;
  cursor?: string; children?: React.ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const apiRef = useRef<SceneApi | null>(null);
  const handlers = useRef({ onHover, onClick, onPress, onDrag, onRelease, onReady });
  handlers.current = { onHover, onClick, onPress, onDrag, onRelease, onReady };
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');
  const key = bodies.map(b => `${b.part}:${b.occurrence || 0}:${JSON.stringify(b.matrix || '')}`).join('|');

  useEffect(() => {
    const el = host.current; if (!el) return;
    let live = true; const abort = new AbortController();
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0xffffff, 1);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100000); camera.up.set(0, 0, 1);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8dde4, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5); camera.add(sun); sun.position.set(0.4, 0.8, 0.3); scene.add(camera);
    const overlay = new THREE.Group(); overlay.renderOrder = 10; scene.add(overlay);
    const controls = new CadControls(camera, renderer.domElement); controls.style = navStyle;
    const ray = new THREE.Raycaster();
    const list: SceneApi['bodies'] = [];
    let dirty = true;
    const resize = () => { dirty = true; const w = el.clientWidth || 1, h = el.clientHeight || 1; renderer.setSize(w, h, false); renderer.domElement.style.width = '100%'; renderer.domElement.style.height = '100%'; camera.aspect = w / h; camera.updateProjectionMatrix(); };
    const ro = new ResizeObserver(resize); ro.observe(el); resize();
    // draw only when something changed: the camera moved, the canvas resized, or a dialog invalidated overlays
    let frame = 0, last = '';
    const loop = () => {
      frame = requestAnimationFrame(loop);
      const k = camera.position.toArray().map(v => v.toFixed(4)).join() + camera.quaternion.toArray().map(v => v.toFixed(5)).join() + el.clientWidth + 'x' + el.clientHeight;
      if (!dirty && k === last) return;
      dirty = false; last = k; renderer.render(scene, camera);
    };
    loop();
    const ndc = (x: number, y: number) => { const r = renderer.domElement.getBoundingClientRect(); return new THREE.Vector2((x - r.left) / r.width * 2 - 1, -(y - r.top) / r.height * 2 + 1); };
    const api: SceneApi = {
      scene, camera, dom: renderer.domElement, overlay, controls, radius: 100, center: new THREE.Vector3(), bodies: list,
      toWorld: b => list.find(x => x.body.part === b.part && (x.body.occurrence || 0) === (b.occurrence || 0))?.matrix.clone() || null,
      toPart: b => { const w = api.toWorld(b); return w ? w.invert() : null; },
      ndc,
      invalidate: () => { dirty = true; },
      hitModel: (x, y) => { ray.setFromCamera(ndc(x, y), camera); return ray.intersectObjects(list.filter(b => b.mesh.visible).map(b => b.mesh), false)[0] || null; },
      screenDistance: (p, x, y) => { const r = renderer.domElement.getBoundingClientRect(); const q = p.clone().project(camera); return Math.hypot((q.x + 1) / 2 * r.width + r.left - x, (1 - q.y) / 2 * r.height + r.top - y); },
      pxPerMm: p => { const r = renderer.domElement.getBoundingClientRect(); const d = camera.position.distanceTo(p); return r.height / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))); },
      fit: (dir = ISO) => {
        const d = dir.clone().normalize(); const dist = api.radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.08;
        controls.target.copy(api.center); camera.position.copy(api.center).addScaledVector(d, dist); camera.up.copy(upFor(d)); camera.near = dist / 200; camera.far = dist * 20; camera.updateProjectionMatrix(); controls.update();
      },
    };
    apiRef.current = api;
    (async () => {
      try {
        const loader = new GLTFLoader();
        const box = new THREE.Box3();
        const meshes = new Map<string, THREE.BufferGeometry>();
        // each distinct part streams once, a few at a time (assemblies can hold hundreds of bodies)
        const unique = [...new Set(bodies.map(b => b.part))];
        let next = 0;
        const worker = async () => {
          while (next < unique.length && live) {
            const part = unique[next++];
            try {
              const buf = await loadSecureModel(`${revision}:model.glb:${part}`, abort.signal);
              const gltf = await loader.parseAsync(buf, '');
              const parts: THREE.BufferGeometry[] = [];
              gltf.scene.updateMatrixWorld(true);
              gltf.scene.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { const g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld); parts.push(g); } });
              const geom = parts.length === 1 ? parts[0] : mergeGeometries(parts);
              geom.computeVertexNormals();
              meshes.set(part, geom);
            } catch (e) { if (bodies.length === 1) throw e; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(6, unique.length) }, worker));
        if (!live) return;
        const edgeCache = new Map<string, THREE.EdgesGeometry>();
        for (const b of bodies) {
          const geom = meshes.get(b.part);
          if (!geom) continue;
          const mat = new THREE.MeshStandardMaterial({ color: 0xd4d7dc, roughness: 0.72, metalness: 0.05, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
          const mesh = new THREE.Mesh(geom, mat);
          const t = m4(b.matrix); mesh.matrixAutoUpdate = false; mesh.matrix.copy(t); mesh.updateMatrixWorld(true);
          mesh.userData = { part: b.part, occurrence: b.occurrence || 0 };
          let eg = edgeCache.get(b.part); if (!eg) { eg = new THREE.EdgesGeometry(geom, 28); edgeCache.set(b.part, eg); }
          const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x5b626c, transparent: true, opacity: 0.55 }));
          mesh.add(edges);  // edges follow the body (assembly-step animation moves bodies)
          scene.add(mesh); list.push({ body: b, mesh, matrix: t, edges });
          box.expandByObject(mesh);
        }
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        api.radius = Math.max(sphere.radius, 1); api.center.copy(sphere.center);
        controls.minDistance = api.radius * 0.02; controls.maxDistance = api.radius * 40;
        api.fit();
        if (!live) return;
        setState('ready'); handlers.current.onReady?.(api);
      } catch (e: unknown) { if (live) setState((e as Error).message || '3D model unavailable'); }
    })();

    // click vs drag; a handler may take the press (drag-to-weld)
    let down: { x: number; y: number; taken: boolean } | null = null;
    const pd = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const taken = !!handlers.current.onPress?.(e, api);
      if (taken) { controls.enabled = false; renderer.domElement.setPointerCapture(e.pointerId); }
      down = { x: e.clientX, y: e.clientY, taken };
    };
    const pm = (e: PointerEvent) => {
      if (down?.taken) { handlers.current.onDrag?.(e, api); return; }
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) handlers.current.onHover?.(e, api);
    };
    const pu = (e: PointerEvent) => {
      const d = down; down = null;
      if (!d) return;
      if (d.taken) { controls.enabled = true; handlers.current.onRelease?.(e, api); return; }
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) handlers.current.onClick?.(e, api);
    };
    el.addEventListener('pointerdown', pd, true);
    el.addEventListener('pointermove', pm);
    window.addEventListener('pointerup', pu);
    return () => {
      live = false; abort.abort(); cancelAnimationFrame(frame); ro.disconnect(); controls.dispose();
      el.removeEventListener('pointerdown', pd, true); el.removeEventListener('pointermove', pm); window.removeEventListener('pointerup', pu);
      scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose?.(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach(x => x.dispose()); });
      renderer.dispose(); renderer.domElement.remove(); apiRef.current = null;
    };
  }, [revision, key]);

  useEffect(() => { if (apiRef.current) apiRef.current.controls.style = navStyle; }, [navStyle]);

  return (
    <div className="pscene" style={{ cursor }}>
      <div ref={host} className="pscene-gl" />
      <div className="pscene-tools">
        <button type="button" title="Fit (F)" onClick={() => apiRef.current?.fit()}><Maximize size={15} /></button>
        <button type="button" title="Isometric" onClick={() => apiRef.current?.fit(ISO)}><Box size={15} /></button>
      </div>
      {state === 'loading' && <div className="pscene-state"><span className="spinner" />Loading model…</div>}
      {state !== 'loading' && state !== 'ready' && <div className="pscene-state">{state}</div>}
      <div className="pscene-help"><span>Rotate</span><b>{navStyle === 'solidworks' ? 'Middle drag' : 'Left drag'}</b><span>Pan</span><b>Right drag</b><span>Zoom</span><b>Scroll</b></div>
      {children}
    </div>
  );
}

function mergeGeometries(list: THREE.BufferGeometry[]) {
  const pos: number[] = [];
  for (const g of list) { const n = g.index ? g.toNonIndexed() : g; const a = n.getAttribute('position'); for (let i = 0; i < a.count; i++) pos.push(a.getX(i), a.getY(i), a.getZ(i)); }
  const out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); return out;
}
