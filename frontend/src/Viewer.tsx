import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Box, Layers, Maximize, Scissors, Ruler, Focus, Eye, EyeOff } from 'lucide-react';
import { headers } from './api';

export type PartAppearance = { color: string; category: string; name?: string };

type Props = {
  url: string;
  selected?: string | null;
  onPick?: (id: string) => void;
  onIsolateToggle?: () => void;
  isolated?: boolean;
  flat?: boolean;
  appearance?: Record<string, PartAppearance>;
  /** Part ids hidden from the scene (small bought-in items etc.). A hidden part still shows while selected. */
  hidden?: string[];
  /** Additional selected part ids (multi-select); highlighted and framed together with `selected`. */
  multi?: string[];
  /** Feature to highlight in the scene (hovered in the sidebar): a bore or a bend in part-definition coordinates. */
  feature?: { kind: 'hole' | 'bend'; partId: string; center: number[]; axis: number[]; diameter?: number; depth?: number; length?: number; radius?: number; id: string } | null;
};

const BACKGROUND = '#eaecef';
const DEFAULT_COLOR = '#aeb4bc';
const SELECT_COLOR = new THREE.Color('#ff6a1f');
const HOVER_EMISSIVE = new THREE.Color('#2a2f36');
const GHOST_OPACITY = 0.14;
const EXPLODE_SPREAD = 0.9; // multiple of assembly radius at 100 % explode

type Engine = {
  scene: THREE.Scene;
  meshes: THREE.Mesh[];
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  plane: THREE.Plane;
  center: THREE.Vector3;
  radius: number;
  minZ: number;
  maxZ: number;
  explodeCurrent: number;
  explodeTarget: number;
  fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; duration: number } | null;
  hovered: THREE.Mesh | null;
  grid: THREE.GridHelper | null;
  featureGroup: THREE.Group | null;
  fit: (dir?: number[], ids?: string[] | null, animate?: boolean) => void;
  applyExplode: () => void;
  refresh?: () => void;
  loaded: boolean;
};

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

export default function Viewer({ url, selected, onPick, onIsolateToggle, isolated = false, flat = false, appearance = {}, hidden = [], multi = [], feature = null }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const isolateRef = useRef(onIsolateToggle);
  isolateRef.current = onIsolateToggle;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [count, setCount] = useState(0);
  const [explode, setExplode] = useState(0);
  const [section, setSection] = useState(100);
  const [measure, setMeasure] = useState(false);
  const [ghost, setGhost] = useState(true);
  const [distance, setDistance] = useState<number | null>(null);
  const [hoverName, setHoverName] = useState('');
  const measuring = useRef(false);
  measuring.current = measure;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;

  // ---- Scene lifecycle: one renderer per URL --------------------------------------------------
  useEffect(() => {
    if (!host.current) return;
    let cancelled = false;
    let raf = 0;
    setLoading(true);
    setError('');
    setCount(0);
    setDistance(null);
    setHoverName('');
    const container = host.current;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.localClippingEnabled = true;
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(300, -500, 800);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xdfe6f0, 1.2);
    fill.position.set(-400, 300, 100);
    scene.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(100, 600, -300);
    scene.add(rim);

    const plane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 1e9);
    const meshes: THREE.Mesh[] = [];
    let point: THREE.Vector3 | null = null;
    const marker = new THREE.Group();
    scene.add(marker);

    const e: Engine = {
      scene, meshes, renderer, camera, controls, plane,
      center: new THREE.Vector3(), radius: 100, minZ: 0, maxZ: 100,
      explodeCurrent: 0, explodeTarget: 0, fly: null, hovered: null, grid: null, featureGroup: null, loaded: false,
      fit: () => {}, applyExplode: () => {},
    };
    engine.current = e;

    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const obs = new ResizeObserver(resize);
    obs.observe(container);

    /** Frame the whole model, or a set of part ids, optionally with a camera fly-to. */
    e.fit = (dir?: number[], ids: string[] | null = null, animate = true) => {
      let box = new THREE.Box3();
      const targets = ids ? meshes.filter(m => ids.includes(m.userData.partId) && m.visible) : meshes.filter(m => m.visible);
      for (const m of targets) box.expandByObject(m);
      if (box.isEmpty()) { box = new THREE.Box3().setFromCenterAndSize(e.center, new THREE.Vector3(1, 1, 1).multiplyScalar(e.radius * 2)); }
      const c = box.getCenter(new THREE.Vector3());
      const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, e.radius * 0.02);
      const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2) * 1.05;
      const direction = dir
        ? new THREE.Vector3(...dir).normalize()
        : camera.position.clone().sub(controls.target).normalize();
      if (!dir && direction.lengthSq() < 1e-6) direction.set(1, -1, 0.85).normalize();
      const to = c.clone().add(direction.multiplyScalar(dist));
      camera.near = Math.max(e.radius / 2000, 0.01);
      camera.far = e.radius * 200;
      camera.updateProjectionMatrix();
      if (animate) {
        e.fly = { from: camera.position.clone(), to, tFrom: controls.target.clone(), tTo: c, start: performance.now(), duration: 650 };
      } else {
        camera.position.copy(to);
        controls.target.copy(c);
        controls.update();
      }
    };

    /** Position every mesh / instance for the current explode value. */
    e.applyExplode = () => {
      const k = e.explodeCurrent / 100;
      for (const mesh of meshes) {
        if (mesh instanceof THREE.InstancedMesh) {
          const gc = mesh.geometry.boundingBox?.getCenter(new THREE.Vector3()) || new THREE.Vector3();
          mesh.userData.matrices.forEach((base: THREE.Matrix4, i: number) => {
            const t = base.clone();
            if (k > 0) {
              const d = gc.clone().applyMatrix4(base).sub(e.center);
              if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
              d.normalize().multiplyScalar(e.radius * EXPLODE_SPREAD * k);
              t.elements[12] += d.x; t.elements[13] += d.y; t.elements[14] += d.z;
            }
            mesh.setMatrixAt(i, t);
          });
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingSphere();
        } else {
          mesh.position.copy(mesh.userData.base);
          if (k > 0 && mesh.userData.explode) mesh.position.addScaledVector(mesh.userData.explode, EXPLODE_SPREAD * k);
        }
      }
      // Keep the ground grid under the lowest exploded body.
      if (e.grid) e.grid.position.z = e.minZ - e.radius * (0.04 + EXPLODE_SPREAD * k);
    };

    // ---- Picking ------------------------------------------------------------------------------
    const ray = new THREE.Raycaster();
    const hitAt = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(mouse, camera);
      const hits = ray.intersectObjects(meshes.filter(m => m.visible && (m.material as THREE.MeshStandardMaterial).opacity > 0.5), false);
      // Ignore surfaces cut away by the section plane so clicks land on what the user sees.
      return hits.find(h => plane.distanceToPoint(h.point) >= -1e-6) || hits[0];
    };
    let downAt: [number, number] | null = null;
    let lastClick = 0;
    const onDown = (ev: PointerEvent) => { downAt = [ev.clientX, ev.clientY]; };
    const onUp = (ev: PointerEvent) => {
      if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 5 || ev.button !== 0) return;
      const hit = hitAt(ev.clientX, ev.clientY);
      if (measuring.current) {
        if (!hit) return;
        if (point) {
          setDistance(point.distanceTo(hit.point));
          const geo = new THREE.BufferGeometry().setFromPoints([point, hit.point]);
          marker.add(new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xff6a1f })));
          const dot = new THREE.Mesh(new THREE.SphereGeometry(e.radius * 0.004), new THREE.MeshBasicMaterial({ color: 0xff6a1f }));
          dot.position.copy(hit.point); marker.add(dot);
          point = null;
        } else {
          marker.clear();
          point = hit.point.clone();
          const dot = new THREE.Mesh(new THREE.SphereGeometry(e.radius * 0.004), new THREE.MeshBasicMaterial({ color: 0xff6a1f }));
          dot.position.copy(point); marker.add(dot);
          setDistance(null);
        }
        return;
      }
      const id = hit ? String(hit.object.userData.partId || '') : '';
      const now = performance.now();
      const dbl = now - lastClick < 320 && id && id === selectedRef.current;
      lastClick = now;
      if (dbl) { isolateRef.current?.(); return; }
      pick.current?.(id);
    };
    let moveRaf = 0;
    const onMove = (ev: PointerEvent) => {
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!e.loaded) return;
        const hit = hitAt(ev.clientX, ev.clientY);
        const mesh = (hit?.object as THREE.Mesh) || null;
        if (mesh !== e.hovered) {
          e.hovered = mesh;
          renderer.domElement.style.cursor = mesh ? 'pointer' : '';
          const id = mesh?.userData.partId || '';
          setHoverName(id ? appearanceRef.current[id]?.name || id : '');
          e.refresh?.();
        }
      });
    };
    const onLeave = () => { e.hovered = null; renderer.domElement.style.cursor = ''; setHoverName(''); e.refresh?.(); };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    // ---- Load -------------------------------------------------------------------------------
    const abort = new AbortController();
    fetch('/api' + url, { headers: headers(), signal: abort.signal })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({ detail: '3D mesh is not available yet' }));
          throw new Error(body.detail || '3D mesh is not available yet');
        }
        return r.arrayBuffer();
      })
      .then(b => new GLTFLoader().parseAsync(b, ''))
      .then(gltf => {
        if (cancelled) return;
        const source = gltf.scene;
        source.updateMatrixWorld(true);
        const grouped = new Map<string, { geometry: THREE.BufferGeometry; id: string; matrices: THREE.Matrix4[] }>();
        source.traverse(o => {
          if (!(o as THREE.Mesh).isMesh) return;
          const m = o as THREE.Mesh;
          let parent: THREE.Object3D | null = o;
          let id = '';
          while (parent && !id) {
            // GLTFLoader sanitises node names (strips ':' etc.), so read the original name it keeps in userData.
            const raw = String(parent.userData?.name || parent.name || '');
            id = raw.match(/^([a-f0-9]{10}_\d+_\d+)(?:::|$)/)?.[1] || '';
            parent = parent.parent;
          }
          const k = m.geometry.uuid + '|' + id;
          const group = grouped.get(k) || { geometry: m.geometry, id, matrices: [] };
          group.matrices.push(m.matrixWorld.clone());
          grouped.set(k, group);
        });
        const model = new THREE.Group();
        for (const g of grouped.values()) {
          if (!g.geometry.attributes.normal) g.geometry.computeVertexNormals();
          g.geometry.computeBoundingBox();
          const material = new THREE.MeshStandardMaterial({
            color: DEFAULT_COLOR, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
            clippingPlanes: [plane], transparent: true, opacity: 1,
          });
          let m: THREE.Mesh;
          if (g.matrices.length > 1) {
            const im = new THREE.InstancedMesh(g.geometry, material, g.matrices.length);
            g.matrices.forEach((t, i) => im.setMatrixAt(i, t));
            im.userData.matrices = g.matrices;
            im.computeBoundingBox();
            im.computeBoundingSphere();
            m = im;
          } else {
            m = new THREE.Mesh(g.geometry, material);
            g.matrices[0].decompose(m.position, m.quaternion, m.scale);
          }
          m.userData.partId = g.id;
          m.userData.base = m.position.clone();
          meshes.push(m);
          model.add(m);
        }
        scene.add(model);
        const bounds = new THREE.Box3().setFromObject(model);
        e.center = bounds.getCenter(new THREE.Vector3());
        e.radius = bounds.getSize(new THREE.Vector3()).length() / 2 || 100;
        e.minZ = bounds.min.z;
        e.maxZ = bounds.max.z;
        for (const m of meshes) {
          const b = new THREE.Box3().setFromObject(m);
          const d = b.getCenter(new THREE.Vector3()).sub(e.center);
          if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
          m.userData.explode = d.normalize().multiplyScalar(e.radius);
        }
        const grid = new THREE.GridHelper(e.radius * 3.5, 24, 0xc3c7cc, 0xd9dce0);
        grid.rotation.x = Math.PI / 2;
        grid.position.set(e.center.x, e.center.y, e.minZ - e.radius * 0.04);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = 0.7;
        scene.add(grid);
        e.grid = grid;
        setCount(meshes.reduce((n, m) => n + (m.geometry.index?.count || m.geometry.attributes.position.count) / 3 * (m instanceof THREE.InstancedMesh ? m.count : 1), 0));
        e.loaded = true;
        e.fit([1, -1, 0.85], null, false);
        setLoading(false);
        e.refresh?.();
        // If a part was already selected when the model loaded, fly to it.
        if (selectedRef.current && meshes.some(m => m.userData.partId === selectedRef.current)) e.fit(undefined, [selectedRef.current], true);
      })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });

    // ---- Render loop --------------------------------------------------------------------------
    let frames = 0, last = performance.now(), slow = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (e.fly) {
        const t = Math.min(1, (now - e.fly.start) / e.fly.duration);
        const k = ease(t);
        camera.position.lerpVectors(e.fly.from, e.fly.to, k);
        controls.target.lerpVectors(e.fly.tFrom, e.fly.tTo, k);
        if (t >= 1) e.fly = null;
      }
      if (Math.abs(e.explodeTarget - e.explodeCurrent) > 0.05) {
        e.explodeCurrent += (e.explodeTarget - e.explodeCurrent) * 0.14;
        if (Math.abs(e.explodeTarget - e.explodeCurrent) <= 0.05) e.explodeCurrent = e.explodeTarget;
        e.applyExplode();
      }
      controls.update();
      renderer.render(scene, camera);
      frames++;
      if (now - last > 800) {
        const rate = frames * 1000 / (now - last);
        if (rate < 40 && ++slow >= 3 && renderer.getPixelRatio() > 1) { renderer.setPixelRatio(1); resize(); slow = 0; }
        frames = 0; last = now;
      }
    };
    resize();
    loop();

    return () => {
      cancelled = true;
      abort.abort();
      cancelAnimationFrame(raf);
      cancelAnimationFrame(moveRaf);
      obs.disconnect();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerleave', onLeave);
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(a => a.dispose());
      });
      renderer.dispose();
      renderer.domElement.remove();
      engine.current = null;
    };
  }, [url]);

  // ---- Appearance: colours, selection, ghosting, isolation, section ----------------------------
  useEffect(() => {
    const hiddenSet = new Set(hidden);
    const multiSet = new Set(multi);
    const refresh = () => {
      const e = engine.current;
      if (!e) return;
      for (const mesh of e.meshes) {
        const id = mesh.userData.partId as string;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const active = (!!selected && id === selected) || multiSet.has(id);
        const hovered = e.hovered === mesh && !active;
        const look = appearance[id];
        mesh.visible = (!isolated || !selected || active) && (active || !hiddenSet.has(id));
        const base = new THREE.Color(look?.color || DEFAULT_COLOR);
        if (active) {
          // Keep the part's own (coating) colour and add a warm accent glow so the selection reads on any colour.
          mat.color.copy(base);
          mat.emissive.copy(SELECT_COLOR); mat.emissiveIntensity = 0.18;
          mat.opacity = 1; mat.depthWrite = true;
        } else {
          mat.color.copy(base);
          mat.emissiveIntensity = 1;
          mat.emissive.copy(hovered ? HOVER_EMISSIVE : new THREE.Color(0x000000));
          const ghosted = ghost && !!selected && !isolated;
          mat.opacity = ghosted ? GHOST_OPACITY : 1;
          mat.depthWrite = !ghosted;
        }
        mesh.renderOrder = active ? 2 : mat.opacity < 1 ? 1 : 0;
        mat.needsUpdate = false;
      }
      e.plane.constant = section >= 100 ? 1e9 : e.minZ + (e.maxZ - e.minZ) * section / 100;
    };
    if (engine.current) engine.current.refresh = refresh;
    refresh();
  }, [selected, isolated, ghost, section, loading, appearance, hidden.join('|'), multi.join('|')]);

  // Fly the camera to a newly selected part (or the whole multi-selection); re-frame everything when cleared.
  const previousSelection = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    const ids = multi.length > 1 ? multi : selected ? [selected] : [];
    if (ids.length && e.meshes.some(m => ids.includes(m.userData.partId))) { if (selected !== previousSelection.current || multi.length > 1) e.fit(undefined, ids, true); }
    else if (!selected && previousSelection.current) e.fit(undefined, null, true);
    previousSelection.current = selected;
  }, [selected, loading, multi.join('|')]);

  // Isolation changes what is visible, so re-frame the remaining bodies.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded || !selected) return;
    e.fit(undefined, isolated ? [selected] : [selected], true);
  }, [isolated]);

  // Feature highlight: a ring (bore) or an axis line (bend) placed at every instance of the part.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.featureGroup) { e.scene.remove(e.featureGroup); e.featureGroup.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material)?.dispose?.(); }); e.featureGroup = null; }
    if (!feature) return;
    const group = new THREE.Group();
    const material = new THREE.MeshBasicMaterial({ color: 0x0ea5e9, depthTest: false, transparent: true, opacity: 0.95 });
    const center = new THREE.Vector3(...feature.center);
    const axis = new THREE.Vector3(...feature.axis).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const local = new THREE.Group();
    if (feature.kind === 'hole') {
      const r = (feature.diameter || 1) / 2, depth = feature.depth || r;
      const tube = Math.max(r * 0.16, e.radius * 0.004);
      for (const z of [-depth / 2, depth / 2]) { const ring = new THREE.Mesh(new THREE.TorusGeometry(r + tube, tube, 10, 48), material); ring.position.z = z; local.add(ring); }
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(tube * 0.6, tube * 0.6, depth * 1.3, 8), material); bar.rotation.x = Math.PI / 2; local.add(bar);
    } else {
      const len = feature.length || e.radius * 0.2, t = Math.max(e.radius * 0.003, 0.4);
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(t, t, len * 1.05, 10), material); bar.rotation.x = Math.PI / 2; local.add(bar);
      const r = (feature.radius || 1) + t * 2;
      for (const z of [-len / 2, len / 2]) { const ring = new THREE.Mesh(new THREE.TorusGeometry(r, t * 0.8, 8, 40), material); ring.position.z = z; local.add(ring); }
    }
    local.position.copy(center); local.quaternion.copy(quat);
    // Place a copy at each placement of the part (instanced parts may occur many times), following the explode offsets.
    const placements: THREE.Matrix4[] = [];
    for (const m of e.meshes) {
      if (m.userData.partId !== feature.partId) continue;
      if (m instanceof THREE.InstancedMesh) { for (let i = 0; i < m.count; i++) { const t = new THREE.Matrix4(); m.getMatrixAt(i, t); placements.push(t); } }
      else { m.updateMatrixWorld(true); placements.push(m.matrixWorld.clone()); }
    }
    for (const t of placements) { const copy = local.clone(); const holder = new THREE.Group(); holder.applyMatrix4(t); holder.add(copy); group.add(holder); }
    group.traverse(o => { o.renderOrder = 10; });
    e.scene.add(group); e.featureGroup = group;
  }, [feature, loading, explode]);

  // Explode tweens in the render loop; the camera flies at the same time to the exploded bounds.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.explodeTarget = explode;
    if (!e.loaded) return;
    const current = e.explodeCurrent;
    e.explodeCurrent = explode; e.applyExplode();
    e.fit(undefined, null, true);
    e.explodeCurrent = current; e.applyExplode();
  }, [explode]);

  const hasSelection = !!selected;
  return (
    <div className="viewer">
      <div ref={host} className="canvas" />
      <div className="view-label">
        <span className="live-dot" />
        {flat ? 'DEVELOPED SHEET' : 'CAD WORKSPACE'}
        <span>{loading ? 'Preparing geometry' : `${count.toLocaleString()} triangles`}</span>
        {hoverName && <em>{hoverName}</em>}
      </div>
      <div className="view-tools">
        <button title="Isometric" onClick={() => engine.current?.fit([1, -1, 0.85], null)}><Box size={18} /></button>
        <button title="Top (Z)" onClick={() => engine.current?.fit([0, 0, 1], null)}>Z</button>
        <button title="Front (−Y)" onClick={() => engine.current?.fit([0, -1, 0], null)}>Y</button>
        <button title="Right (X)" onClick={() => engine.current?.fit([1, 0, 0], null)}>X</button>
        <button title="Fit everything" onClick={() => engine.current?.fit(undefined, null)}><Maximize size={18} /></button>
        <button title="Fit selected part" disabled={!hasSelection} onClick={() => selected && engine.current?.fit(undefined, [selected])}><Focus size={18} /></button>
        <button className={ghost ? 'selected' : ''} title={ghost ? 'Other parts are ghosted while a part is selected' : 'Other parts stay solid while a part is selected'} onClick={() => setGhost(!ghost)}>{ghost ? <EyeOff size={18} /> : <Eye size={18} />}</button>
        <button className={measure ? 'selected' : ''} title="Measure two surface points" onClick={() => { setMeasure(!measure); setDistance(null); }}><Ruler size={18} /></button>
      </div>
      {loading && <div className="viewer-state"><span className="spinner" />Preparing lightweight 3D geometry…</div>}
      {error && <div className="viewer-state">{error}</div>}
      <div className="view-bottom">
        <label>
          <Layers size={15} />Explode
          <input aria-label="Explode assembly" type="range" min="0" max="100" value={explode} onChange={ev => setExplode(+ev.target.value)} />
          <button type="button" className="mini" onClick={() => setExplode(explode > 0 ? 0 : 100)}>{explode > 0 ? 'Collapse' : 'Explode'}</button>
        </label>
        <label>
          <Scissors size={15} />Section
          <input aria-label="Section plane" type="range" min="0" max="100" value={section} onChange={ev => setSection(+ev.target.value)} />
        </label>
      </div>
      {measure && (
        <div className="measurement">
          {distance === null ? 'Pick two visible surface points' : `${distance.toFixed(3)} mm · mesh measurement`}
          <small>Approximate; use CAD feature dimensions for QC.</small>
        </div>
      )}
    </div>
  );
}
