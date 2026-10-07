import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { CadControls, upFor, type NavStyle } from './cadControls';
import { Box, Layers, Maximize, Scissors, Ruler, Focus, Eye, EyeOff, ChevronUp, ChevronDown, Crosshair, Flame, CircleDashed, Square, Grid3x3, Shapes, Sparkles, Sun, Palette, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Kbd } from '@/components/ui/kbd';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { loadSecureModel } from './api';
import { beadGeometry, beadMaterial, labelSprite, pathLength, pathSection, pointAt, resample, type WeldShape, type WeldSelection } from './weld3d';

export type SeamCandidate = WeldSelection & { id: string; label?: string; chosen?: boolean; minor?: boolean };

const disposeGroup = (group: THREE.Object3D) => group.traverse(o => {
  const m = o as THREE.Mesh;
  m.geometry?.dispose();
  (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach(mat => { (mat as THREE.SpriteMaterial).map?.dispose(); mat.dispose(); });
});

export type PartAppearance = { color: string; category: string; name?: string; roughness?: number; metalness?: number };

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const loadView = (key?: string): Any => { if (!key) return {}; try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; } };
const saveView = (key: string | undefined, patch: Any) => { if (!key) return; try { localStorage.setItem(key, JSON.stringify({ ...loadView(key), ...patch })); } catch { /* storage off: view just isn't remembered */ } };

type Props = {
  /** "revisionId:file[:partId]" — loaded through a signed, encrypted model stream */
  url: string;
  /** Face-picking mode (joint definition): clicks report the part and the picked point in part coordinates. */
  pickMode?: 'face' | 'edge' | 'point' | null;
  onGeometryPick?: (partId: string, point: number[], selection: 'face' | 'edge' | 'point', occurrence: number) => void;
  onGeometryHover?: (partId: string, point: number[], selection: 'face' | 'edge', occurrence: number) => void;
  hoverGeometry?: AnySelection | null;
  onWeldPreviewStatus?: (valid: boolean, message: string) => void;
  jointPreview?: { faces: AnySelection[]; weld?: Record<string, unknown> } | null;
  selected?: string | null;
  onPick?: (id: string, additive?: boolean, occurrence?: number) => void;
  onIsolateToggle?: (occurrence?: number) => void;
  isolated?: boolean;
  flat?: boolean;
  appearance?: Record<string, PartAppearance>;
  /** Part ids hidden from the scene (small bought-in items etc.). A hidden part still shows while selected. */
  hidden?: string[];
  /** Additional selected part ids (multi-select); highlighted and framed together with `selected`. */
  multi?: string[];
  /** During weld setup, show and frame only the participating component definitions. */
  focusIds?: string[];
  /** In weld setup, show one representative occurrence per focused part definition. */
  representativeOccurrences?: Record<string, number>;
  /** Feature to highlight in the scene (hovered in the sidebar): a bore or a bend in part-definition coordinates. */
  feature?: { kind: 'hole' | 'bend'; partId: string; center: number[]; axis: number[]; diameter?: number; depth?: number; length?: number; radius?: number; id: string } | null;
  /** Configured welds drawn on the model (beads + labels). */
  welds?: WeldShape[];
  onWeldClick?: (id: string) => void;
  /** Detected weld-seam candidates; click toggles one. */
  seamCandidates?: SeamCandidate[];
  hoverSeam?: string | null;
  onSeamToggle?: (id: string, wholeSide?: boolean) => void;
  onSeamHover?: (id: string | null) => void;
  /** Heads-up content (selection / document info) shown top-left over the canvas. */
  hud?: React.ReactNode;
  /** Extra tool buttons placed at the start / end of the floating tool palette. */
  toolbarStart?: React.ReactNode;
  toolbarEnd?: React.ReactNode;
  /** Layout controls (panels, full canvas) in the bottom-right corner, apart from the tools. */
  corner?: React.ReactNode;
  /** Mouse layout: Forge (left rotates) or SolidWorks (middle rotates, Ctrl+middle pans). */
  navStyle?: NavStyle;
  /** Shaded, shaded with edges, or wireframe (all edges, faces see-through). */
  displayMode?: DisplayMode;
  onDisplayMode?: (m: DisplayMode) => void;
  /** Parts drawn see-through (the engineer's "change transparency"), independent of selection. */
  transparentIds?: string[];
  /** Front / Top / Right reference planes and the origin triad. */
  showPlanes?: boolean;
  /** realistic materials: finish-based roughness / metalness with environment reflections */
  realistic?: boolean;
  onRealistic?: (v: boolean) => void;
  /** show the studio environment behind the model */
  studio?: boolean;
  onStudio?: (v: boolean) => void;
  onShowPlanes?: (v: boolean) => void;
  /** Imperative view command from a keyboard shortcut ({ name, n }: n makes repeats distinct). */
  command?: { name: string; n: number } | null;
  /** localStorage key for this project's view (display, ghost, welds, planes, refs, camera): reopens as left */
  viewKey?: string;
};
export type DisplayMode = 'shaded' | 'edges' | 'wireframe';
/** Standard view directions (camera position relative to the model, Z up; front looks along +Y). */
export const VIEW_DIRS: Record<string, number[]> = { front: [0, -1, 0], back: [0, 1, 0], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1], iso: [1, -1, 0.85] };

type AnySelection = { part: string; occurrence?: number; selection?: 'face' | 'edge'; type?: string; point?: number[]; normal?: number[]; start?: number[]; end?: number[]; center?: number[]; axis?: number[]; radius?: number; length?: number; boundaries?: number[][][]; preview_mesh?: { vertices: number[][]; triangles: number[][] } };

const BACKGROUND = '#eaecef';
const DEFAULT_COLOR = '#aeb4bc';
const SELECT_COLOR = new THREE.Color('#2563eb');
const HOVER_EMISSIVE = new THREE.Color('#2a2f36');
const GHOST_OPACITY = 0.14;
const EXPLODE_SPREAD = 0.9; // multiple of assembly radius at 100 % explode

type Engine = {
  /** render scheduling: last drawn camera state, and keep drawing until this time (ms) after a change */
  camKey?: string; activeUntil: number;
  scene: THREE.Scene;
  meshes: THREE.Mesh[];
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: CadControls;
  planeGroup: THREE.Group | null;
  plane: THREE.Plane;
  center: THREE.Vector3;
  radius: number;
  minZ: number;
  maxZ: number;
  explodeCurrent: number;
  explodeTarget: number;
  fly: { from: THREE.Vector3; to: THREE.Vector3; tFrom: THREE.Vector3; tTo: THREE.Vector3; start: number; duration: number; upFrom?: THREE.Vector3; upTo?: THREE.Vector3 } | null;
  hovered: THREE.Mesh | null;
  grid: THREE.GridHelper | null;
  featureGroup: THREE.Group | null;
  weldGroup: THREE.Group | null;
  savedWeldGroup: THREE.Group | null;
  seamGroup: THREE.Group | null;
  references: THREE.Mesh[];
  hoverGroup: THREE.Group | null;
  edgeLines: THREE.LineSegments[];
  fit: (dir?: number[], ids?: string[] | null, animate?: boolean) => void;
  applyExplode: () => void;
  refresh?: () => void;
  loaded: boolean;
  envTex?: THREE.Texture;
  lights?: THREE.Light[];
};

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

/** World-sized text label (reference plane names, triad letters). Width/height ratio is kept in userData.aspect. */
function textSprite(text: string, color: string, bold = true) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `${bold ? 700 : 500} 56px Inter, system-ui, sans-serif`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width) + 12, h = 72;
  canvas.width = w; canvas.height = h;
  ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'middle'; ctx.fillText(text, 6, h / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false, transparent: true }));
  sprite.userData.aspect = w / h; sprite.renderOrder = 41;
  return sprite;
}

function distanceToPath(point: THREE.Vector3, path: THREE.Vector3[]) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const segment = path[i].clone().sub(path[i - 1]);
    const length2 = segment.lengthSq();
    const t = length2 ? THREE.MathUtils.clamp(point.clone().sub(path[i - 1]).dot(segment) / length2, 0, 1) : 0;
    best = Math.min(best, point.distanceTo(path[i - 1].clone().addScaledVector(segment, t)));
  }
  return best;
}

function sameCadBoundary(a: THREE.Vector3[], b: THREE.Vector3[], tolerance: number) {
  if (a.length < 2 || b.length < 2) return false;
  const samples = (path: THREE.Vector3[]) => [path[0], path[Math.floor(path.length / 4)], path[Math.floor(path.length / 2)], path[Math.floor(path.length * 3 / 4)], path[path.length - 1]];
  return samples(a).every(p => distanceToPath(p, b) <= tolerance) && samples(b).every(p => distanceToPath(p, a) <= tolerance);
}


// Canvas overlay class sets (view rail, tool palette)
const railButton = 'text-muted-foreground hover:text-foreground data-[state=open]:bg-selection data-[state=open]:text-primary';
const railHeading = 'px-0.5 text-2xs font-medium tracking-wider text-faint uppercase';
// Tool palette buttons; the palette root carries `compact` / `tight` (fitPalette) as marker classes for the group variants.
const paletteButton = 'gap-1.5 px-2.5 text-xs font-medium text-foreground [&_svg]:text-muted-foreground group-[.compact]/palette:px-2 group-[.tight]/palette:px-1.5';
const paletteOn = 'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground [&_svg]:text-primary';
const paletteSep = 'mx-1 data-[orientation=vertical]:h-5 group-[.tight]/palette:mx-0.5';
const palettePop = 'flex w-auto items-center gap-3 rounded-lg px-3 py-2.5 shadow-pop';

export default function Viewer({ url, selected, onPick, onIsolateToggle, isolated = false, flat = false, appearance = {}, hidden = [], multi = [], focusIds = [], representativeOccurrences = {}, feature = null, pickMode = null, onGeometryPick, onGeometryHover, hoverGeometry = null, onWeldPreviewStatus, jointPreview = null, welds = [], onWeldClick, seamCandidates = [], hoverSeam = null, onSeamToggle, onSeamHover, hud, toolbarStart, toolbarEnd, corner, navStyle = 'forge', displayMode = 'shaded', onDisplayMode, transparentIds = [], showPlanes = false, onShowPlanes, realistic = true, onRealistic, studio = false, onStudio, command = null, viewKey }: Props) {
  const weldClick = useRef(onWeldClick); weldClick.current = onWeldClick;
  const drafting = !!jointPreview || seamCandidates.length > 0;
  const seamToggle = useRef(onSeamToggle); seamToggle.current = onSeamToggle;
  const seamHover = useRef(onSeamHover); seamHover.current = onSeamHover;
  const geometryPickRef = useRef<{ mode: Props['pickMode']; cb?: Props['onGeometryPick'] }>({ mode: null });
  geometryPickRef.current = { mode: pickMode, cb: onGeometryPick };
  const hoverCallback = useRef(onGeometryHover);
  hoverCallback.current = onGeometryHover;
  const statusCallback = useRef(onWeldPreviewStatus);
  statusCallback.current = onWeldPreviewStatus;
  const representativeRef = useRef(representativeOccurrences);
  representativeRef.current = representativeOccurrences;
  const host = useRef<HTMLDivElement>(null);
  const engine = useRef<Engine | null>(null);
  // any prop / state change may have changed the scene: draw for a moment
  useEffect(() => { if (engine.current) engine.current.activeUntil = performance.now() + 700; });
  // Tool palette: labels while they fit the canvas, icons only (tooltips keep the names) when they would spill over.
  const palette = useRef<HTMLDivElement>(null);
  const fitPalette = () => {
    const p = palette.current; const host = p?.parentElement; if (!p || !host) return;
    p.classList.remove('compact', 'tight');
    if (p.scrollWidth > host.clientWidth - 24) p.classList.add('compact');
    if (p.scrollWidth > host.clientWidth - 24) p.classList.add('tight');
  };
  useLayoutEffect(fitPalette);
  useEffect(() => {
    const host = palette.current?.parentElement; if (!host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => fitPalette()); ro.observe(host); return () => ro.disconnect();
  }, []);
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
  const saved = useRef<Any>(loadView(viewKey));
  const [ghost, setGhost] = useState<boolean>(saved.current.ghost ?? true);
  // View rail: standard views and display options open as small menus (Popover closes them on an outside click or Esc).
  const rail = useRef<HTMLDivElement>(null);
  const [railPop, setRailPop] = useState<'views' | 'display' | null>(null);
  const [distance, setDistance] = useState<number | null>(null);
  const [hoverName, setHoverName] = useState('');
  const [showWelds, setShowWelds] = useState<boolean>(saved.current.welds ?? false);   // weld beads off unless turned on
  const [popover, setPopover] = useState<'section' | 'explode' | null>(null);
  const [showRefs, setShowRefs] = useState<boolean>(saved.current.refs ?? false);
  // ---- remembered view per project ----------------------------------------------------------------
  const viewKeyRef = useRef(viewKey); viewKeyRef.current = viewKey;
  const assemblyView = url.includes(':assembly.glb');
  useEffect(() => {   // opening (or switching to) a project: its last view
    const v = loadView(viewKey); saved.current = v;
    if (v.ghost !== undefined) setGhost(v.ghost);
    setShowWelds(v.welds ?? false);
    if (v.refs !== undefined) setShowRefs(v.refs);
    if (v.display && v.display !== displayMode) onDisplayMode?.(v.display);
    if (v.planes !== undefined && v.planes !== showPlanes) onShowPlanes?.(v.planes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewKey]);
  useEffect(() => { saveView(viewKey, { ghost, welds: showWelds, refs: showRefs, display: displayMode, planes: showPlanes }); }, [viewKey, ghost, showWelds, showRefs, displayMode, showPlanes]);
  const [refCount, setRefCount] = useState(0);
  const measuring = useRef(false);
  measuring.current = measure;
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const navStyleRef = useRef(navStyle);
  navStyleRef.current = navStyle;

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
    // Transparent canvas: the workspace gradient (light / dark) shows behind the model.
    scene.background = null;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    renderer.localClippingEnabled = true;
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100000);
    camera.up.set(0, 0, 1);
    const controls = new CadControls(camera, renderer.domElement);
    controls.style = navStyleRef.current;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8a8f96, 2.4);
    scene.add(hemi);
    // studio environment for reflections (painted, plated and bare metal read by their roughness)
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
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
      activeUntil: performance.now() + 2000, explodeCurrent: 0, explodeTarget: 0, fly: null, hovered: null, grid: null, planeGroup: null, featureGroup: null, weldGroup: null, savedWeldGroup: null, seamGroup: null, references: [], hoverGroup: null, edgeLines: [], loaded: false,
      fit: () => {}, applyExplode: () => {}, envTex, lights: [hemi, key, fill, rim],
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
      const upTo = dir ? upFor(direction) : camera.up.clone();
      const to = c.clone().add(direction.multiplyScalar(dist));
      camera.near = Math.max(e.radius / 2000, 0.01);
      camera.far = e.radius * 200;
      camera.updateProjectionMatrix();
      if (animate) {
        e.fly = { from: camera.position.clone(), to, tFrom: controls.target.clone(), tTo: c, start: performance.now(), duration: 650, upFrom: camera.up.clone(), upTo };
      } else {
        camera.position.copy(to);
        camera.up.copy(upTo);
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
          const bases = mesh.userData.matrices as THREE.Matrix4[];
          const representative = representativeRef.current[String(mesh.userData.partId)];
          const chosen = representative === undefined ? -1 : Math.min(Math.max(representative, 0), bases.length - 1);
          const exploded = (base: THREE.Matrix4) => {
            const t = base.clone();
            if (k > 0) {
              const d = gc.clone().applyMatrix4(base).sub(e.center);
              if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
              d.normalize().multiplyScalar(e.radius * EXPLODE_SPREAD * k);
              t.elements[12] += d.x; t.elements[13] += d.y; t.elements[14] += d.z;
            }
            return t;
          };
          const visibleMatrix = chosen >= 0 ? exploded(bases[chosen]) : null;
          const collapsed = visibleMatrix ? new THREE.Matrix4().makeScale(0, 0, 0).setPosition(gc.clone().applyMatrix4(visibleMatrix)) : null;
          const deltas: (THREE.Vector3 | null)[] = [];
          bases.forEach((base, i) => {
            const m = collapsed && i !== chosen ? collapsed : exploded(base);
            mesh.setMatrixAt(i, m);
            deltas.push(collapsed && i !== chosen ? null : new THREE.Vector3(m.elements[12] - base.elements[12], m.elements[13] - base.elements[13], m.elements[14] - base.elements[14]));
          });
          mesh.userData.deltas = deltas;
          mesh.instanceMatrix.needsUpdate = true;
          mesh.computeBoundingBox();
          mesh.computeBoundingSphere();
        } else {
          mesh.position.copy(mesh.userData.base);
          if (k > 0 && mesh.userData.explode) mesh.position.addScaledVector(mesh.userData.explode, EXPLODE_SPREAD * k);
          mesh.userData.deltas = [mesh.position.clone().sub(mesh.userData.base)];
        }
      }
      // edge lines follow their body (explode, single-occurrence view)
      const byPart = new Map(meshes.map(m => [String(m.userData.partId), m]));
      for (const line of e.edgeLines) {
        const d = (byPart.get(String(line.userData.partId))?.userData.deltas || [])[line.userData.occurrence ?? 0];
        line.userData.collapsed = d === null;
        line.position.copy(line.userData.basePos).add(d || new THREE.Vector3());
      }
      // Keep the ground grid under the lowest exploded body.
      if (e.grid) e.grid.position.z = e.minZ - e.radius * (0.04 + EXPLODE_SPREAD * k);
    };

    // ---- Orientation triad (bottom-right corner): X red, Y green, Z blue, follows the view -------------
    const triadScene = new THREE.Scene();
    const triadCam = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
    for (const [axis, color, label] of [[new THREE.Vector3(1, 0, 0), 0xd63b3b, 'X'], [new THREE.Vector3(0, 1, 0), 0x2f9e44, 'Y'], [new THREE.Vector3(0, 0, 1), 0x2563eb, 'Z']] as const) {
      triadScene.add(new THREE.ArrowHelper(axis, new THREE.Vector3(), 1, color, 0.32, 0.18));
      const sprite = textSprite(label, '#' + color.toString(16).padStart(6, '0'));
      sprite.position.copy(axis.clone().multiplyScalar(1.38)); sprite.scale.set(0.5, 0.5, 1); triadScene.add(sprite);
    }
    const drawTriad = () => {
      const size = 86, w = container.clientWidth;
      triadCam.position.copy(camera.position).sub(controls.target).setLength(4);
      triadCam.up.copy(camera.up); triadCam.lookAt(0, 0, 0);
      renderer.setScissorTest(true);
      renderer.setScissor(w - size - 10, 10, size, size); renderer.setViewport(w - size - 10, 10, size, size);
      renderer.autoClear = false; renderer.clearDepth(); renderer.render(triadScene, triadCam); renderer.autoClear = true;
      renderer.setScissorTest(false); renderer.setViewport(0, 0, w, container.clientHeight);
    };

    // ---- Picking ------------------------------------------------------------------------------
    const ray = new THREE.Raycaster();
    const hitAt = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      const mouse = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1);
      ray.setFromCamera(mouse, camera);
      if (geometryPickRef.current.mode === 'edge') {
        const pixelSize = 2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(rect.height, 1);
        ray.params.Line = { threshold: Math.max(0.08, Math.min(1.5, pixelSize * 6)) };
        const edgeHits = ray.intersectObjects(e.edgeLines.filter(line => line.visible), false);
        if (edgeHits.length) return edgeHits[0];
      }
      const hits = ray.intersectObjects(meshes.filter(m => m.visible && !!m.userData.partId && (m.material as THREE.MeshStandardMaterial).opacity > 0.5), false);
      // Ignore surfaces cut away by the section plane so clicks land on what the user sees.
      return hits.find(h => plane.distanceToPoint(h.point) >= -1e-6) || hits[0];
    };
    /** Seam candidates and saved weld beads sit on top of the parts and are picked first. */
    const overlayAt = (clientX: number, clientY: number): { seamId?: string; weldId?: string } | null => {
      const groups = [e.seamGroup, e.savedWeldGroup].filter(Boolean) as THREE.Group[];
      if (!groups.length) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), camera);
      const hits = ray.intersectObjects(groups, true);
      for (const h of hits) { const d = h.object.userData; if (d.seamId || d.weldId) return { seamId: d.seamId, weldId: d.weldId }; }
      return null;
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
      const overlay = overlayAt(ev.clientX, ev.clientY);
      if (overlay?.seamId) { seamToggle.current?.(overlay.seamId, ev.shiftKey); return; }
      if (overlay?.weldId && !geometryPickRef.current.mode && weldClick.current) { weldClick.current(overlay.weldId); return; }
      const id = hit ? String(hit.object.userData.partId || '') : '';
      if (geometryPickRef.current.mode) {
        if (!hit || !id) return;
        // back to part-definition coordinates (the B-rep frame) through the instance / placement matrix
        const obj = hit.object as THREE.Mesh;
        const world = obj.matrixWorld.clone();
        if ((obj as THREE.InstancedMesh).isInstancedMesh && hit.instanceId !== undefined) {
          const inst = new THREE.Matrix4();
          (obj as THREE.InstancedMesh).getMatrixAt(hit.instanceId, inst);
          world.multiply(inst);
        }
        const local = hit.point.clone().applyMatrix4(world.clone().invert());
        geometryPickRef.current.cb?.(id, [local.x, local.y, local.z], geometryPickRef.current.mode, hit.instanceId ?? Number(obj.userData.occurrence || 0));
        return;
      }
      const now = performance.now();
      const dbl = now - lastClick < 320 && id && id === selectedRef.current;
      lastClick = now;
      const occurrence = hit && (hit.object as THREE.InstancedMesh).isInstancedMesh ? hit.instanceId : undefined;
      if (dbl) { isolateRef.current?.(occurrence); return; }
      pick.current?.(id, ev.ctrlKey || ev.metaKey || ev.shiftKey, occurrence);
    };
    let moveRaf = 0;
    let hoveredSeam: string | null = null;
    let hoverTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHoverPoint: [number, number] | null = null;
    const onMove = (ev: PointerEvent) => {
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (!e.loaded) return;
        if (e.seamGroup) {
          const over = overlayAt(ev.clientX, ev.clientY)?.seamId || null;
          if (over !== hoveredSeam) { hoveredSeam = over; seamHover.current?.(over); renderer.domElement.style.cursor = over ? 'pointer' : ''; }
          if (over) return;
        }
        const hit = hitAt(ev.clientX, ev.clientY);
        const mesh = hit?.object && (hit.object as THREE.Mesh).isMesh ? hit.object as THREE.Mesh : null;
        if (geometryPickRef.current.mode === 'face' || geometryPickRef.current.mode === 'edge') {
          const moved = !lastHoverPoint || Math.hypot(ev.clientX - lastHoverPoint[0], ev.clientY - lastHoverPoint[1]) > 7;
          if (moved) {
            lastHoverPoint = [ev.clientX, ev.clientY];
            if (hoverTimer) clearTimeout(hoverTimer);
            if (!hit?.object.userData.partId) hoverCallback.current?.('', [], geometryPickRef.current.mode, 0);
            else {
              const object = hit.object as THREE.Mesh;
              const transform = object.matrixWorld.clone();
              if (object instanceof THREE.InstancedMesh && hit.instanceId !== undefined) { const instance = new THREE.Matrix4(); object.getMatrixAt(hit.instanceId, instance); transform.multiply(instance); }
              const point = hit.point.clone().applyMatrix4(transform.invert());
              const partId = String(object.userData.partId);
              const mode = geometryPickRef.current.mode;
              hoverTimer = setTimeout(() => hoverCallback.current?.(partId, [point.x, point.y, point.z], mode, hit.instanceId ?? Number(object.userData.occurrence || 0)), 240);
            }
          }
        }
        if (mesh !== e.hovered) {
          e.hovered = mesh;
          renderer.domElement.style.cursor = mesh ? 'pointer' : '';
          const id = mesh?.userData.partId || '';
          setHoverName(id ? appearanceRef.current[id]?.name || id : '');
          e.refresh?.();
        }
      });
    };
    const onLeave = () => { if (hoverTimer) clearTimeout(hoverTimer); lastHoverPoint = null; hoverCallback.current?.('', [], 'face', 0); e.hovered = null; renderer.domElement.style.cursor = ''; setHoverName(''); e.refresh?.(); };
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('pointermove', onMove);
    renderer.domElement.addEventListener('pointerleave', onLeave);

    // ---- Load -------------------------------------------------------------------------------
    const abort = new AbortController();
    loadSecureModel(url, abort.signal)
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
        const edgeGroup = new THREE.Group();
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
          m.userData.base = m.position.clone();
          if (!g.id) {
            // Surface-only bodies (sketch circles, boundary / keep-out surfaces): reference geometry, off by default.
            material.color.set('#8fb3d9'); material.opacity = 0.35; material.depthWrite = false;
            m.userData.reference = true; m.visible = false; e.references.push(m); model.add(m);
            continue;
          }
          m.userData.partId = g.id;
          meshes.push(m);
          model.add(m);
          const edgeGeometry = new THREE.EdgesGeometry(g.geometry, 28);
          const addEdges = (matrix: THREE.Matrix4, occurrence: number) => {
            const line = new THREE.LineSegments(edgeGeometry.clone(), new THREE.LineBasicMaterial({ color: 0xb99b7f, transparent: true, opacity: 0.42, depthTest: true }));
            line.applyMatrix4(matrix); line.userData.basePos = line.position.clone(); line.userData.partId = g.id; line.userData.occurrence = occurrence; line.visible = false; line.renderOrder = 12; edgeGroup.add(line); e.edgeLines.push(line);
          };
          if (g.matrices.length > 1) g.matrices.forEach(addEdges); else addEdges(g.matrices[0], 0);
          edgeGeometry.dispose();
        }
        scene.add(model); scene.add(edgeGroup);
        const bounds = new THREE.Box3();
        for (const m of meshes) bounds.expandByObject(m);
        if (bounds.isEmpty()) bounds.setFromObject(model);
        setRefCount(e.references.length);
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
        const darkTheme = document.documentElement.classList.contains('dark');
        const grid = new THREE.GridHelper(e.radius * 3.5, 24, darkTheme ? 0x3a4352 : 0xc3c7cc, darkTheme ? 0x283040 : 0xd9dce0);
        grid.rotation.x = Math.PI / 2;
        grid.position.set(e.center.x, e.center.y, e.minZ - e.radius * 0.04);
        (grid.material as THREE.Material).transparent = true;
        (grid.material as THREE.Material).opacity = darkTheme ? 0.55 : 0.7;
        scene.add(grid);
        e.grid = grid;
        setCount(meshes.reduce((n, m) => n + (m.geometry.index?.count || m.geometry.attributes.position.count) / 3 * (m instanceof THREE.InstancedMesh ? m.count : 1), 0));
        e.loaded = true;
        const cam = assemblyView ? loadView(viewKeyRef.current).camera : null;
        if (cam && Array.isArray(cam.p) && Array.isArray(cam.t)) {
          // the camera as it was left in this project
          camera.position.fromArray(cam.p); controls.target.fromArray(cam.t); if (Array.isArray(cam.u)) camera.up.fromArray(cam.u);
          camera.near = Math.max(e.radius / 2000, 0.01); camera.far = e.radius * 200; camera.updateProjectionMatrix(); controls.update();
        } else e.fit([1, -1, 0.85], null, false);
        setLoading(false);
        e.refresh?.();
        // If a part was already selected when the model loaded, fly to it.
        if (selectedRef.current && meshes.some(m => m.userData.partId === selectedRef.current)) e.fit(undefined, [selectedRef.current], true);
      })
      .catch(err => { if (!cancelled) { setError(err.message); setLoading(false); } });

    // ---- Render loop --------------------------------------------------------------------------
    const wake = () => { e.activeUntil = performance.now() + 700; };
    for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'pointerup'] as const) container.addEventListener(ev, wake, { passive: true });
    window.addEventListener('keydown', wake);
    // remember the camera of the assembly view (written when it settles, not every frame)
    let lastCam = '';
    const camTimer = assemblyView ? window.setInterval(() => {
      if (!e.loaded || e.fly) return;
      const c = { p: camera.position.toArray().map(x => +x.toFixed(3)), t: controls.target.toArray().map(x => +x.toFixed(3)), u: camera.up.toArray().map(x => +x.toFixed(4)) };
      const key = JSON.stringify(c);
      if (key !== lastCam) { lastCam = key; saveView(viewKeyRef.current, { camera: c }); }
    }, 1200) : 0;
    let frames = 0, last = performance.now(), slow = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const now = performance.now();
      if (e.fly) {
        const t = Math.min(1, (now - e.fly.start) / e.fly.duration);
        const k = ease(t);
        camera.position.lerpVectors(e.fly.from, e.fly.to, k);
        controls.target.lerpVectors(e.fly.tFrom, e.fly.tTo, k);
        if (e.fly.upFrom && e.fly.upTo) {
          camera.up.lerpVectors(e.fly.upFrom, e.fly.upTo, k);
          if (camera.up.lengthSq() < 1e-6) camera.up.copy(e.fly.upTo);
          camera.up.normalize();
        }
        if (t >= 1) e.fly = null;
      }
      if (Math.abs(e.explodeTarget - e.explodeCurrent) > 0.05) {
        e.explodeCurrent += (e.explodeTarget - e.explodeCurrent) * 0.14;
        if (Math.abs(e.explodeTarget - e.explodeCurrent) <= 0.05) e.explodeCurrent = e.explodeTarget;
        e.applyExplode();
      }
      if (!container.clientWidth) return; // kept mounted behind another tab: no GPU work
      if (document.querySelector('[data-forge-config]')) return; // a configuration dialog has its own 3D view
      controls.update();
      // idle model: no GPU work. Redraw while the camera moves, after any change (React commit, input) and while animating.
      const camKey = camera.position.x.toFixed(3) + ',' + camera.position.y.toFixed(3) + ',' + camera.position.z.toFixed(3) + ',' + camera.quaternion.x.toFixed(5) + ',' + camera.quaternion.y.toFixed(5) + ',' + camera.quaternion.z.toFixed(5) + ',' + camera.quaternion.w.toFixed(5) + ',' + container.clientWidth + 'x' + container.clientHeight;
      if (camKey !== e.camKey || e.fly || e.explodeTarget !== e.explodeCurrent || now < e.activeUntil) e.camKey = camKey; else return;
      renderer.render(scene, camera);
      drawTriad();
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
      if (camTimer) clearInterval(camTimer);
      if (hoverTimer) clearTimeout(hoverTimer);
      obs.disconnect();
      window.removeEventListener('keydown', wake);
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
    const focusSet = new Set(focusIds);
    const seeThrough = new Set(transparentIds);
    const refresh = () => {
      const e = engine.current;
      if (!e) return;
      for (const mesh of e.meshes) {
        const id = mesh.userData.partId as string;
        const mat = mesh.material as THREE.MeshStandardMaterial;
        const active = (!!selected && id === selected) || multiSet.has(id);
        const hovered = e.hovered === mesh && !active;
        const look = appearance[id];
        mesh.visible = focusSet.size ? focusSet.has(id) : (!isolated || !selected || active) && (active || !hiddenSet.has(id));
        const base = new THREE.Color(look?.color || DEFAULT_COLOR);
        mat.roughness = realistic ? (look?.roughness ?? 0.5) : 0.55;
        mat.metalness = realistic ? (look?.metalness ?? 0.2) : 0.15;
        if (active) {
          // Keep the part's own (coating) colour and add a warm accent glow so the selection reads on any colour.
          mat.color.copy(base);
          mat.emissive.copy(SELECT_COLOR); mat.emissiveIntensity = 0.18;
          mat.opacity = seeThrough.has(id) ? 0.3 : 1; mat.depthWrite = !seeThrough.has(id);
        } else {
          mat.color.copy(base);
          mat.emissiveIntensity = 1;
          mat.emissive.copy(hovered ? HOVER_EMISSIVE : new THREE.Color(0x000000));
          const ghosted = ghost && !!selected && !isolated;
          mat.opacity = ghosted ? GHOST_OPACITY : seeThrough.has(id) ? 0.3 : 1;
          mat.depthWrite = mat.opacity >= 1;
        }
        // wireframe: faces are not drawn but stay pickable (the raycast ignores material visibility)
        mat.visible = displayMode !== 'wireframe' || !!pickMode;
        mesh.renderOrder = active ? 2 : mat.opacity < 1 ? 1 : 0;
        mat.needsUpdate = false;
      }
      const meshOf = new Map(e.meshes.map(m => [String(m.userData.partId), m]));
      const drawEdges = displayMode !== 'shaded' && !pickMode;
      for (const line of e.edgeLines) {
        const id = String(line.userData.partId);
        const src = meshOf.get(id);
        const sourceVisible = !!src?.visible;
        const representative = representativeOccurrences[id];
        const lm = line.material as THREE.LineBasicMaterial;
        if (pickMode === 'edge') {
          line.visible = sourceVisible && (representative === undefined || line.userData.occurrence === representative);
          lm.color.set(0xb99b7f); lm.opacity = 0.42; lm.depthTest = true;
        } else if (drawEdges) {
          const active = (!!selected && id === selected) || multiSet.has(id);
          const faded = (src?.material as THREE.MeshStandardMaterial | undefined)?.opacity ?? 1;
          line.visible = sourceVisible && !line.userData.collapsed;
          lm.color.set(active ? 0x1d4ed8 : displayMode === 'wireframe' ? 0x2b3340 : 0x1a1f27);
          lm.opacity = displayMode === 'wireframe' ? (faded < 1 && !active ? 0.25 : 0.9) : faded < 1 && !active ? 0.12 : 0.55;
          lm.depthTest = displayMode !== 'wireframe';
        } else line.visible = false;
      }
      e.plane.constant = section >= 100 ? 1e9 : e.minZ + (e.maxZ - e.minZ) * section / 100;
    };
    if (engine.current) engine.current.refresh = refresh;
    if (engine.current?.loaded) engine.current.applyExplode();
    refresh();
  }, [selected, isolated, ghost, section, loading, appearance, realistic, hidden.join('|'), multi.join('|'), focusIds.join('|'), pickMode, displayMode, transparentIds.join('|'), Object.entries(representativeOccurrences).map(([id, occurrence]) => `${id}:${occurrence}`).join('|')]);

  useEffect(() => { for (const m of engine.current?.references || []) m.visible = showRefs; }, [showRefs, loading]);

  // realistic lighting: environment reflections with softer direct lights; optional visible studio backdrop
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    e.scene.environment = realistic ? e.envTex || null : null;
    e.scene.environmentIntensity = 0.9;
    const base = [2.4, 2.6, 1.2, 0.7], soft = [1.1, 1.9, 0.6, 0.4];
    (e.lights || []).forEach((l, i) => { l.intensity = (realistic ? soft : base)[i]; });
    e.scene.background = studio && e.envTex ? e.envTex : null;
    e.scene.backgroundBlurriness = 0.55;
    e.scene.backgroundIntensity = 0.85;
    e.activeUntil = performance.now() + 700;
  }, [realistic, studio, loading]);

  useEffect(() => { if (engine.current) engine.current.controls.style = navStyle; }, [navStyle, loading]);

  // Reference planes through the model origin (Front = XZ, Top = XY, Right = YZ for this Z-up frame) and an origin triad.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.planeGroup) { e.scene.remove(e.planeGroup); disposeGroup(e.planeGroup); e.planeGroup = null; }
    if (!showPlanes) return;
    const group = new THREE.Group();
    const origin = new THREE.Vector3();
    // size from the model, centred on the origin like a CAD system's default planes
    const reach = Math.max(e.radius * 0.9, e.center.length() + e.radius * 0.5) ;
    const size = Math.min(reach, e.radius * 2.5);
    const defs: [string, THREE.Euler, number][] = [['Front', new THREE.Euler(Math.PI / 2, 0, 0), 0x3b82f6], ['Top', new THREE.Euler(0, 0, 0), 0x22a06b], ['Right', new THREE.Euler(0, Math.PI / 2, 0), 0xe0552d]];
    for (const [name, rot, color] of defs) {
      const holder = new THREE.Group(); holder.rotation.copy(rot); holder.position.copy(origin);
      const fill = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
      const edge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(size, size)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 }));
      fill.renderOrder = 3; edge.renderOrder = 3;
      holder.add(fill); holder.add(edge);
      const label = textSprite(name, '#' + color.toString(16).padStart(6, '0'));
      const h = size * 0.045; label.scale.set(h * label.userData.aspect, h, 1);
      label.position.set(-size / 2 + h * label.userData.aspect / 2 + h * 0.3, size / 2 - h * 0.8, 0);
      holder.add(label);
      group.add(holder);
    }
    const len = size * 0.18;
    for (const [axis, color] of [[new THREE.Vector3(1, 0, 0), 0xd63b3b], [new THREE.Vector3(0, 1, 0), 0x2f9e44], [new THREE.Vector3(0, 0, 1), 0x2563eb]] as const) {
      const arrow = new THREE.ArrowHelper(axis, origin, len, color, len * 0.22, len * 0.12);
      arrow.traverse(o => { o.renderOrder = 42; const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) { m.depthTest = false; m.transparent = true; } });
      group.add(arrow);
    }
    e.scene.add(group); e.planeGroup = group;
  }, [showPlanes, loading]);

  // Keyboard view commands (standard views, rotate 15° / 90°, roll, fit, zoom to selection).
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded || !command) return;
    const [verb, arg] = command.name.split(':');
    const step = arg === 'big' ? Math.PI / 2 : Math.PI / 12;
    if (verb === 'view' && VIEW_DIRS[arg]) e.fit(VIEW_DIRS[arg], null);
    else if (verb === 'fit') e.fit(undefined, null);
    else if (verb === 'zoomSelected') { const ids = multi.length > 1 ? multi : selected ? [selected] : null; if (ids) e.fit(undefined, ids); }
    else if (verb === 'rotLeft') e.controls.rotate(step, 0);
    else if (verb === 'rotRight') e.controls.rotate(-step, 0);
    else if (verb === 'rotUp') e.controls.rotate(0, step);
    else if (verb === 'rotDown') e.controls.rotate(0, -step);
    else if (verb === 'rollLeft') e.controls.roll(step);
    else if (verb === 'rollRight') e.controls.roll(-step);
    else if (verb === 'normal' && selected) {
      // look straight at the selected part's largest face direction: its bounding-box thinnest axis
      const m = e.meshes.find(x => x.userData.partId === selected);
      if (m) { const b = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3()); const axis = b.x <= b.y && b.x <= b.z ? [1, 0, 0] : b.y <= b.z ? [0, -1, 0] : [0, 0, 1]; e.fit(axis, [selected]); }
    }
    else if (verb === 'measure') setMeasure(v => !v);
    else if (verb === 'section') setPopover(p => p === 'section' ? null : 'section');
    else if (verb === 'explode') setExplode(v => v > 0 ? 0 : 100);
    else if (verb === 'ghost') setGhost(v => !v);
  }, [command?.n]);

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

  // Showing a single instance of a multi-quantity part: re-frame (and orbit) around that one body.
  const soloOccurrence = selected ? representativeOccurrences[selected] : undefined;
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded || !selected) return;
    e.applyExplode();
    e.fit(undefined, [selected], true);
  }, [soloOccurrence]);

  // Isolation changes what is visible, so re-frame the remaining bodies.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded || !selected) return;
    e.fit(undefined, isolated ? [selected] : [selected], true);
  }, [isolated]);

  // Weld focus only changes visibility. Never move the camera after a face pick or a settings
  // change: the engineer's carefully framed seam must remain exactly where they left it.

  // Welding needs much closer navigation than assembly review. Zoom toward the cursor and lower
  // the near plane so thin sheet edges do not disappear when inspecting the underside.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (pickMode) {
      e.controls.zoomToCursor = true;
      e.controls.zoomSpeed = 1.45;
      e.controls.rotateSpeed = 0.8;
      e.controls.screenSpacePanning = true;
      e.controls.minDistance = Math.max(e.radius * 0.00015, 0.05);
      e.controls.maxDistance = e.radius * 30;
      e.camera.near = Math.max(e.radius / 4000, 0.01);
    } else {
      e.controls.zoomToCursor = true; // CAD zooms about the cursor
      e.controls.zoomSpeed = 1;
      e.controls.rotateSpeed = 1;
      e.controls.minDistance = 0;
      e.controls.maxDistance = Infinity;
      e.camera.near = Math.max(e.radius / 2000, 0.01);
    }
    e.camera.updateProjectionMatrix();
  }, [pickMode, loading]);

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

  /** Part-definition → world transform of one occurrence (follows explode). */
  const occurrenceMatrix = (e: Engine, partId: string, occurrence = 0) => {
    const mesh = e.meshes.find(m => m.userData.partId === partId);
    if (!mesh) return null;
    if (mesh instanceof THREE.InstancedMesh) { const t = new THREE.Matrix4(); mesh.getMatrixAt(Math.min(Math.max(occurrence, 0), mesh.count - 1), t); return mesh.matrixWorld.clone().multiply(t); }
    mesh.updateMatrixWorld(true); return mesh.matrixWorld.clone();
  };

  /**
   * Draw one weld (saved or draft) into a group: seam beads with a joint-shaped cross-section, stitch
   * segments, tack, or a patch overlay. Returns how many seams were found so the panel can validate.
   */
  const drawWeld = (e: Engine, shape: WeldShape, group: THREE.Group, draft: boolean) => {
    const w = shape.weld || {};
    const weldType = String(w.type || 'linear');
    const size = Number(String(w.size || w.thickness || '').match(/[\d.]+/)?.[0] || 3);
    const minVisible = Math.max(e.radius * 0.0022, 0.25);
    const material = beadMaterial(w.process, draft);
    const world = (p: number[] | undefined, t: THREE.Matrix4) => new THREE.Vector3(...(p || [0, 0, 0])).applyMatrix4(t);
    const worldDir = (d: number[] | undefined, t: THREE.Matrix4) => d ? new THREE.Vector3(...d).transformDirection(t) : null;
    const seams: { path: THREE.Vector3[]; legs: [THREE.Vector3, THREE.Vector3] | null; normal: THREE.Vector3 | null; joint?: string; range?: number[]; legsAt?: [THREE.Vector3, THREE.Vector3] }[] = [];
    const faceBoundaries: THREE.Vector3[][][] = [];
    for (const item of shape.faces || []) {
      const t = occurrenceMatrix(e, item.part, item.occurrence); if (!t) continue;
      const boundaries = (item.boundaries || []).map(path => path.map(point => world(point, t)));
      if (item.selection === 'edge') {
        const legs = item.legs?.length === 2 ? [worldDir(item.legs[0], t)!, worldDir(item.legs[1], t)!] as [THREE.Vector3, THREE.Vector3] : null;
        const legsAt = (item as Any).legs_at?.length === 2 ? [world((item as Any).legs_at[0], t), worldDir((item as Any).legs_at[1], t)!] as [THREE.Vector3, THREE.Vector3] : undefined;
        for (const path of boundaries) if (path.length >= 2) seams.push({ path, legs, normal: worldDir(item.normal, t), joint: item.joint, range: item.range, legsAt });
      } else faceBoundaries.push(boundaries);
      if (draft || weldType === 'patch') {
        if (item.preview_mesh?.vertices?.length && item.preview_mesh.triangles?.length) {
          const positions: number[] = [];
          for (const tri of item.preview_mesh.triangles) for (const index of tri) { const p = world(item.preview_mesh.vertices[index], t); positions.push(p.x, p.y, p.z); }
          const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); geometry.computeVertexNormals();
          const overlay = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: weldType === 'patch' ? 0xd99a2b : 0xffa51f, transparent: true, opacity: weldType === 'patch' ? 0.55 : 0.2, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
          overlay.renderOrder = 12; group.add(overlay);
        }
      }
    }
    // Two mating faces: their shared CAD boundary is the seam.
    if (!seams.length && faceBoundaries.length === 2) {
      const tolerance = Math.max(0.2, Math.min(1.5, e.radius * 0.0005));
      for (const path of faceBoundaries[0]) if (faceBoundaries[1].some(other => sameCadBoundary(path, other, tolerance))) seams.push({ path, legs: null, normal: null });
    }
    const addBead = (path: THREE.Vector3[], seam: typeof seams[number]) => {
      if (path.length < 2 || pathLength(path) < 0.01) return;
      const mesh = new THREE.Mesh(beadGeometry(path, { joint: seam.joint, legs: seam.legs, legsAt: seam.legsAt, normal: seam.normal, size, minVisible, ripple: !String(w.process || '').startsWith('Laser') }), material);
      mesh.userData.weldId = shape.id; mesh.renderOrder = 6; group.add(mesh);
    };
    // a weld can cover part of its seam: range = [from, to] mm along the seam
    const span = (seam: typeof seams[number]) => { const total = pathLength(seam.path); const r = seam.range; return r ? [Math.max(0, Math.min(total, r[0])), Math.max(0, Math.min(total, r[1]))] : [0, total]; };
    if (weldType === 'linear' || weldType === 'stitch' || !['patch', 'tack'].includes(weldType)) for (const seam of seams) {
      const [from, to] = span(seam);
      if (weldType === 'stitch') {
        const pitch = Math.max(1, Number(w.pitch || 50)), segment = Math.min(pitch, Math.max(1, Number(w.length || 25)));
        for (let start = from; start < to - 0.01; start += pitch) addBead(pathSection(seam.path, start, Math.min(to, start + segment)), seam);
      } else addBead(from > 0 || to < pathLength(seam.path) - 0.01 ? pathSection(seam.path, from, to) : seam.path, seam);
    }
    // tacks placed on a seam: one at `from`, or a row every `pitch` from `from` to `to`
    if (weldType === 'tack') for (const seam of seams) {
      if (!seam.range) continue;
      const [from, to] = span(seam), pitch = Math.max(1, Number(w.pitch || 40)), r = Math.max(Math.max(size, 2) * 0.6, minVisible);
      for (let at = from; at <= to + 0.01; at += pitch) {
        const tack = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), material); tack.position.copy(pointAt(seam.path, at)); tack.userData.weldId = shape.id; tack.renderOrder = 6; group.add(tack);
        if (to - from < 0.01) break;
      }
    }
    if (weldType === 'tack') {
      const placement = w.placement as { part?: string; point?: number[]; occurrence?: number } | undefined;
      const t = placement?.part ? occurrenceMatrix(e, placement.part, placement.occurrence) : null;
      if (t && placement?.point) {
        const p = world(placement.point, t), width = Math.max(1, Number(w.width || 2)), length = Math.max(1, Number(w.length || 2));
        const tack = new THREE.Mesh(new THREE.CapsuleGeometry(Math.max(width / 2, minVisible), length, 8, 16), material); tack.position.copy(p); tack.rotation.z = Math.PI / 2; tack.userData.weldId = shape.id; tack.renderOrder = 6; group.add(tack);
      }
    }
    // Label at the middle of the longest seam (or the first selection).
    if (shape.label) {
      const longestSeam = seams.slice().sort((x, y) => pathLength(y.path) - pathLength(x.path))[0];
      const longest = longestSeam?.path;
      let at: THREE.Vector3 | null = longest ? pointAt(longest, pathLength(longest) / 2) : null;
      // lift the label out of the weld corner so it is hidden only when the weld itself is
      if (at && longestSeam?.legs) at.addScaledVector(longestSeam.legs[0].clone().add(longestSeam.legs[1]).normalize(), Math.max(size, minVisible) * 3);
      if (!at && shape.faces?.[0]) { const t = occurrenceMatrix(e, shape.faces[0].part, shape.faces[0].occurrence); if (t) at = world(shape.faces[0].point || shape.faces[0].start, t); }
      if (at) { const sprite = labelSprite(shape.label, 0.02, shape.active ? '#2563eb' : '#b45309', true); sprite.position.copy(at); sprite.center.set(0.5, -0.35); sprite.userData.weldId = shape.id; group.add(sprite); }
    }
    return seams.length;
  };

  // Draft weld: selected faces / seams with the bead the configured settings would produce.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.weldGroup) { e.scene.remove(e.weldGroup); disposeGroup(e.weldGroup); e.weldGroup = null; }
    if (!jointPreview?.faces?.length) { statusCallback.current?.(false, 'Select a weld location to preview it.'); return; }
    const group = new THREE.Group();
    const weldType = String(jointPreview.weld?.type || 'linear');
    for (const item of jointPreview.faces) {
      const t = occurrenceMatrix(e, item.part, item.occurrence); if (!t) continue;
      for (const path of item.boundaries || []) {
        if (path.length < 2 || item.selection === 'edge') continue;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map(p => new THREE.Vector3(...p).applyMatrix4(t))), new THREE.LineBasicMaterial({ color: 0xffa51f, transparent: true, opacity: 0.75 }));
        line.renderOrder = 15; group.add(line);
      }
    }
    const count = drawWeld(e, { id: 'draft', faces: jointPreview.faces, weld: jointPreview.weld }, group, true);
    if (weldType === 'tack') statusCallback.current?.(!!jointPreview.weld?.placement, jointPreview.weld?.placement ? 'Tack placed' : 'Place the tack on a selected face.');
    else if (weldType === 'patch') statusCallback.current?.(true, 'Selected area preview');
    else statusCallback.current?.(count > 0, count > 0 ? `${count} seam${count === 1 ? '' : 's'} ready` : 'These faces do not share a CAD seam. Detect seams, pick the seam edge, or pick another face pair.');
    e.scene.add(group); e.weldGroup = group;
  }, [jointPreview, loading, explode]);

  // Saved welds stay visible on the model (toggle in the view tools); click a bead to open it.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.savedWeldGroup) { e.scene.remove(e.savedWeldGroup); disposeGroup(e.savedWeldGroup); e.savedWeldGroup = null; }
    if (!showWelds || !welds.length) return;
    const group = new THREE.Group();
    const visible = new Set(e.meshes.filter(m => m.visible).map(m => String(m.userData.partId)));
    for (const weld of welds) {
      if (!weld.faces?.some(f => visible.has(f.part))) continue;
      drawWeld(e, drafting ? { ...weld, label: undefined } : weld, group, false);
    }
    // while another weld is being set up, existing welds stay visible as quiet context
    if (drafting) group.traverse(o => { const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined; if (m && 'opacity' in m) { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; } });
    e.scene.add(group); e.savedWeldGroup = group;
  }, [welds, showWelds, loading, explode, hidden.join('|'), isolated, selected, focusIds.join('|'), drafting]);

  // New seam detection: look into the weld corners. The camera direction is the average opening of the
  // detected fillets (so a wall in front of the seams never hides them) and the view frames all seams.
  const framedSeams = useRef<unknown>(null);
  useEffect(() => {
    const e = engine.current;
    const key = seamCandidates.map(s => `${s.id}:${s.part}:${s.occurrence || 0}`).join('|');
    if (!e || !e.loaded || !seamCandidates.length || framedSeams.current === key) return;
    framedSeams.current = key;
    const box = new THREE.Box3(); const open = new THREE.Vector3(); let totalLength = 0;
    for (const seam of seamCandidates) {
      const t = occurrenceMatrix(e, seam.part, seam.occurrence); if (!t) continue;
      const pts = (seam.boundaries || []).flat().map(p => new THREE.Vector3(...p).applyMatrix4(t));
      pts.forEach(p => box.expandByPoint(p));
      const len = pts.length > 1 ? pts[0].distanceTo(pts[pts.length - 1]) : 0;
      if (!seam.minor) totalLength += len;
      if (seam.opening?.length === 3 && !seam.minor) open.add(new THREE.Vector3(...seam.opening).transformDirection(t).multiplyScalar(Math.max(len, 1) * 1.4));
      if (seam.legs?.length === 2 && !seam.minor) open.add(new THREE.Vector3(...seam.legs[0]).add(new THREE.Vector3(...seam.legs[1])).transformDirection(t).multiplyScalar(Math.max(len, 1)));
    }
    if (box.isEmpty()) return;
    // Fillets on both sides of a plate cancel out: then keep the current side and look down at ~35°.
    const current = e.camera.position.clone().sub(e.controls.target).normalize();
    const raw = open.length() > totalLength * 0.3 ? open.normalize() : current.clone();
    // Look from the side the fillets open to, at 20–50° elevation, swung ~25° so plates are not seen edge-on.
    let horizontal = new THREE.Vector3(raw.x, raw.y, 0);
    if (horizontal.length() < 0.35) horizontal = new THREE.Vector3(current.x, current.y, 0);
    if (horizontal.length() < 1e-3) horizontal.set(1, -1, 0);
    horizontal.normalize().applyAxisAngle(new THREE.Vector3(0, 0, 1), THREE.MathUtils.degToRad(25));
    const elevation = THREE.MathUtils.degToRad(raw.z < -0.3 ? -35 : Math.min(50, Math.max(20, THREE.MathUtils.radToDeg(Math.asin(Math.min(1, Math.abs(raw.z)))))));
    const dir = horizontal.multiplyScalar(Math.cos(elevation)).add(new THREE.Vector3(0, 0, Math.sin(elevation))).normalize();
    const center = box.getCenter(new THREE.Vector3());
    // keep the welded components in view around the seams (a corner seam alone is a close-up)
    const partsBox = new THREE.Box3();
    const ids = new Set(seamCandidates.flatMap(sc => [sc.part, sc.other_part]).filter(Boolean));
    for (const m of e.meshes) if (ids.has(String(m.userData.partId))) partsBox.expandByObject(m);
    const partsR = partsBox.isEmpty() ? 0 : partsBox.getSize(new THREE.Vector3()).length() / 2;
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, partsR * 0.55, e.radius * 0.05);
    const dist = r / Math.sin(THREE.MathUtils.degToRad(e.camera.fov) / 2) * 1.5;
    e.fly = { from: e.camera.position.clone(), to: center.clone().addScaledVector(dir, dist), tFrom: e.controls.target.clone(), tTo: center, start: performance.now(), duration: 700 };
  }, [seamCandidates, loading]);

  // Detected seam candidates: thin cyan rods; amber once chosen (the draft bead is drawn on top).
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.seamGroup) { e.scene.remove(e.seamGroup); disposeGroup(e.seamGroup); e.seamGroup = null; }
    if (!seamCandidates.length) return;
    const group = new THREE.Group();
    const r = Math.max(e.radius * 0.0016, 0.18);
    for (const seam of seamCandidates) {
      const t = occurrenceMatrix(e, seam.part, seam.occurrence); if (!t) continue;
      for (const raw of seam.boundaries || []) {
        const path = raw.map(p => new THREE.Vector3(...p).applyMatrix4(t));
        if (path.length < 2) continue;
        const hot = seam.id === hoverSeam;
        const color = seam.chosen ? 0xf59e0b : hot ? 0x0ea5e9 : 0x22d3ee;
        const rod = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(resample(path, Math.max(pathLength(path) / 60, 0.5)), false, 'centripetal'), Math.min(240, Math.max(4, path.length * 2)), hot ? r * 1.8 : r, 6, false),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: seam.chosen ? 0.35 : 0.95, depthTest: !hot }));
        rod.userData.seamId = seam.id; rod.renderOrder = hot ? 30 : 20; group.add(rod);
        // a wider invisible sleeve makes thin seams easy to click
        const sleeve = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path.length > 2 ? path : resample(path, pathLength(path) / 4), false), Math.max(4, path.length), r * 5, 4, false), new THREE.MeshBasicMaterial({ visible: false }));
        sleeve.userData.seamId = seam.id; group.add(sleeve);
      }
      if (seam.label && seam.id === hoverSeam) { const mid = seam.boundaries?.[0]; if (mid?.length) { const path = mid.map(p => new THREE.Vector3(...p).applyMatrix4(t)); const sprite = labelSprite(seam.label, 0.022, seam.chosen ? '#d97706' : '#0891b2'); sprite.position.copy(pointAt(path, pathLength(path) / 2)); sprite.center.set(0.5, 1.4); sprite.userData.seamId = seam.id; group.add(sprite); } }
    }
    e.scene.add(group); e.seamGroup = group;
  }, [seamCandidates, hoverSeam, loading, explode]);

  // Exact B-rep target returned for the settled pointer position. Cyan is intentionally
  // distinct from the amber saved selection and yellow weld bead.
  useEffect(() => {
    const e = engine.current;
    if (!e || !e.loaded) return;
    if (e.hoverGroup) { e.scene.remove(e.hoverGroup); e.hoverGroup.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).filter(Boolean).forEach(a => (a as THREE.Material).dispose()); }); e.hoverGroup = null; }
    if (!pickMode || !hoverGeometry?.part) return;
    const mesh = e.meshes.find(m => m.userData.partId === hoverGeometry.part && m.visible);
    if (!mesh) return;
    const transform = mesh.matrixWorld.clone();
    if (mesh instanceof THREE.InstancedMesh) { const instance = new THREE.Matrix4(); mesh.getMatrixAt(Math.min(Math.max(hoverGeometry.occurrence || 0, 0), mesh.count - 1), instance); transform.multiply(instance); }
    const point = (coords: number[]) => new THREE.Vector3(...coords).applyMatrix4(transform);
    const group = new THREE.Group();
    if (hoverGeometry.preview_mesh?.vertices?.length && hoverGeometry.preview_mesh.triangles?.length) {
      const coordinates: number[] = [];
      for (const tri of hoverGeometry.preview_mesh.triangles) for (const index of tri) {
        const p = point(hoverGeometry.preview_mesh.vertices[index]); coordinates.push(p.x, p.y, p.z);
      }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(coordinates, 3));
      const fill = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: 0x15d9ed, transparent: true, opacity: 0.42, side: THREE.DoubleSide, depthTest: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
      fill.renderOrder = 25; group.add(fill);
    }
    for (const path of hoverGeometry.boundaries || []) if (path.length >= 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(path.map(point)), new THREE.LineBasicMaterial({ color: 0x12f3ff, linewidth: 3, depthTest: false, depthWrite: false }));
      line.renderOrder = 26; group.add(line);
    }
    e.scene.add(group); e.hoverGroup = group;
  }, [hoverGeometry, pickMode, loading, explode]);

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

  const frameWeldSelection = (requestedDirection?: number[] | 'opposite') => {
    const e = engine.current;
    if (!e || !e.loaded || !jointPreview?.faces?.length) return;
    const ids = focusIds.length ? focusIds : [...new Set(jointPreview.faces.map(f => f.part))];
    const focusBox = new THREE.Box3();
    for (const mesh of e.meshes) if (ids.includes(String(mesh.userData.partId)) && mesh.visible) focusBox.expandByObject(mesh);
    const focusRadius = focusBox.isEmpty() ? e.radius : Math.max(focusBox.getSize(new THREE.Vector3()).length() / 2, e.radius * 0.002);
    const points: THREE.Vector3[] = [], pickedPoints: THREE.Vector3[] = [];
    for (const item of jointPreview.faces) {
      const mesh = e.meshes.find(m => m.userData.partId === item.part); if (!mesh) continue;
      let transform = mesh.matrixWorld.clone();
      if (mesh instanceof THREE.InstancedMesh) { const instance = new THREE.Matrix4(); mesh.getMatrixAt(Math.min(Math.max(item.occurrence || 0, 0), mesh.count - 1), instance); transform.multiply(instance); }
      const add = (p?: number[], picked = false) => { if (p?.length === 3) { const point = new THREE.Vector3(...p).applyMatrix4(transform); points.push(point); if (picked) pickedPoints.push(point); } };
      add(item.point, true); add(item.start); add(item.end);
      for (const path of item.boundaries || []) for (const p of path) add(p);
    }
    if (!points.length) return;
    const center = pickedPoints.length ? pickedPoints.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / pickedPoints.length) : new THREE.Box3().setFromPoints(points).getCenter(new THREE.Vector3());
    const selectionRadius = new THREE.Box3().setFromPoints(points).getSize(new THREE.Vector3()).length() / 2;
    const radius = Math.max(Math.min(selectionRadius || focusRadius * 0.08, focusRadius * 0.38), focusRadius * 0.025);
    let direction: THREE.Vector3;
    if (requestedDirection === 'opposite') direction = e.controls.target.clone().sub(e.camera.position).normalize();
    else if (requestedDirection) direction = new THREE.Vector3(...requestedDirection).normalize();
    else direction = e.camera.position.clone().sub(e.controls.target).normalize();
    if (direction.lengthSq() < 1e-6) direction.set(1, -1, 0.5).normalize();
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(e.camera.fov) / 2) * 1.12;
    e.camera.near = Math.max(focusRadius / 10000, 0.001);
    e.camera.updateProjectionMatrix();
    e.fly = { from: e.camera.position.clone(), to: center.clone().add(direction.multiplyScalar(distance)), tFrom: e.controls.target.clone(), tTo: center, start: performance.now(), duration: 420 };
  };

  const hasSelection = !!selected;
  const welding = !!(pickMode || jointPreview?.faces?.length || seamCandidates.length);
  return (
    <div className="group/viewer @container/viewer relative min-h-[300px] flex-1 overflow-hidden bg-viewer" data-welding={welding ? '' : undefined}>
      <div ref={host} className="absolute inset-0 [&_canvas]:block [&_canvas]:outline-none" />
      {hud && <div className={cn('pointer-events-none absolute top-3 left-3 z-[6]', welding ? 'max-w-[34%]' : 'max-w-[calc(100%-128px)]')}>{hud}</div>}
      {welding && (
        <div className="absolute top-3 left-1/2 z-[5] flex max-w-[calc(100%-120px)] -translate-x-1/2 items-center gap-2 rounded-full border border-warning/30 bg-warning-soft/95 py-1 pr-1 pl-2.5 text-xs whitespace-nowrap shadow-pop">
          {pickMode ? <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-warning"><Crosshair className="size-3.5 shrink-0" />{pickMode === 'point' ? 'Click a picked face to place the tack' : pickMode === 'edge' ? 'Click seam edges' : 'Click face A, then face B'}</span>
            : seamCandidates.length > 0 ? <span className="inline-flex min-w-0 items-center gap-1.5 truncate font-medium text-warning"><Crosshair className="size-3.5 shrink-0" />Click a seam to add or remove it</span> : null}
          <span className="inline-flex gap-0.5 border-l border-warning/30 pl-1.5">
            <Button type="button" variant="ghost" size="xs" className="rounded-full font-normal hover:bg-warning/10" title="Frame the weld" disabled={!jointPreview?.faces?.length} onClick={() => frameWeldSelection()}><Focus />Weld</Button>
            <Button type="button" variant="ghost" size="xs" className="rounded-full font-normal hover:bg-warning/10" title="Look from the other side" disabled={!jointPreview?.faces?.length} onClick={() => frameWeldSelection('opposite')}>Flip</Button>
            <Button type="button" variant="ghost" size="xs" className="rounded-full font-normal hover:bg-warning/10" title="Look from below" disabled={!jointPreview?.faces?.length} onClick={() => frameWeldSelection([0, 0, -1])}>Below</Button>
            <Button type="button" variant="ghost" size="xs" className="rounded-full font-normal hover:bg-warning/10" title="Look from above" disabled={!jointPreview?.faces?.length} onClick={() => frameWeldSelection([0, 0, 1])}>Above</Button>
          </span>
        </div>
      )}
      <div className="glass absolute top-3 right-3 z-[8] flex flex-col gap-0.5 rounded-xl p-1" ref={rail} role="toolbar" aria-label="View">
        <Button type="button" variant="ghost" size="icon-sm" className={railButton} title="Fit everything (F)" aria-label="Fit everything" onClick={() => engine.current?.fit(undefined, null)}><Maximize /></Button>
        <Button type="button" variant="ghost" size="icon-sm" className={railButton} title="Zoom to the selected part (Z)" aria-label="Zoom to selection" disabled={!hasSelection} onClick={() => selected && engine.current?.fit(undefined, [selected])}><Focus /></Button>
        <Popover open={railPop === 'views'} onOpenChange={o => setRailPop(o ? 'views' : null)}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" className={railButton} title="Standard views" aria-label="Standard views"><Box /></Button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" sideOffset={10} role="menu" className="grid w-64 gap-1.5 rounded-lg p-2.5 shadow-pop">
            <h6 className={railHeading}>Standard views</h6>
            <div className="grid grid-cols-3 gap-1">{([['top', 'Top', '5'], ['front', 'Front', '1'], ['right', 'Right', '4'], ['iso', 'Isometric', '7'], ['back', 'Back', '2'], ['left', 'Left', '3'], ['bottom', 'Bottom', '6']] as const).map(([d, label, key]) =>
              <Button type="button" variant="outline" size="sm" key={d} className={cn('justify-between px-2 font-normal shadow-none', d === 'iso' && 'col-span-3')} onClick={() => { engine.current?.fit(VIEW_DIRS[d], null); setRailPop(null); }}>{label}<Kbd className="h-4 min-w-4 bg-transparent px-0 font-mono text-2xs text-faint">{key}</Kbd></Button>)}</div>
          </PopoverContent>
        </Popover>
        <Popover open={railPop === 'display'} onOpenChange={o => setRailPop(o ? 'display' : null)}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" className={railButton} title="Display style and what is shown" aria-label="Display"><Palette /></Button>
          </PopoverTrigger>
          <PopoverContent side="left" align="start" sideOffset={10} role="menu" className="grid w-64 gap-1.5 rounded-lg p-2.5 shadow-pop">
            {onDisplayMode && <><h6 className={railHeading}>Style</h6>
              <ToggleGroup type="single" variant="outline" size="sm" className="grid w-full grid-cols-3 shadow-none" value={displayMode} onValueChange={v => { if (v) onDisplayMode(v as DisplayMode); }}>
                {([['shaded', 'Shaded', Box], ['edges', 'Edges', Shapes], ['wireframe', 'Wire', Grid3x3]] as const).map(([m, label, Icon]) =>
                  <ToggleGroupItem key={m} value={m} className="gap-1.5 text-xs font-normal data-[state=on]:bg-selection data-[state=on]:text-selection-foreground" title={m === 'edges' ? 'Shaded with edges' : label}><Icon className="size-3.5" />{label}</ToggleGroupItem>)}
              </ToggleGroup></>}
            <h6 className={cn(railHeading, onDisplayMode && 'mt-1.5')}>Show</h6>
            {([
              onRealistic && [Sparkles, 'Realistic materials', 'Colour, gloss and reflections from each part\'s finish and material', realistic, () => onRealistic(!realistic)],
              onStudio && [Sun, 'Studio background', 'Show the studio environment behind the model', studio, () => onStudio(!studio)],
              [EyeOff, 'Fade other parts', 'Fade the other parts while a part is selected', ghost, () => setGhost(!ghost)],
              onShowPlanes && [Square, 'Planes & origin', 'Front / Top / Right planes and origin (P)', showPlanes, () => onShowPlanes(!showPlanes)],
              welds.length > 0 && [Flame, 'Weld beads', 'Weld beads on the model', showWelds, () => setShowWelds(!showWelds)],
              refCount > 0 && [CircleDashed, 'Reference surfaces', 'Sketch circles and boundaries — not solid parts', showRefs, () => setShowRefs(!showRefs)],
            ].filter(Boolean) as [typeof Box, string, string, boolean, () => void][]).map(([Icon, label, tip, on, toggle]) =>
              <Label key={label} title={tip} className="cursor-pointer justify-between gap-2 rounded-md px-1 py-1.5 text-sm font-normal hover:bg-accent"><span className="inline-flex items-center gap-2"><Icon className="size-3.5 text-muted-foreground" />{label}</span><Switch size="sm" checked={!!on} onCheckedChange={toggle} /></Label>)}
          </PopoverContent>
        </Popover>
      </div>
      {loading && <div className="absolute inset-0 flex items-center justify-center gap-2.5 bg-viewer/85 text-base text-muted-foreground"><Loader2 className="size-4 animate-spin text-primary" />Preparing lightweight 3D geometry…</div>}
      {error && <div className="absolute inset-0 flex items-center justify-center gap-2.5 bg-viewer/85 text-base text-muted-foreground">{error}</div>}
      <div className="group/palette glass absolute bottom-3.5 left-1/2 z-[7] flex max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-0.5 rounded-xl p-1 [&.tight]:gap-0" ref={palette} role="toolbar" aria-label="Tools">
        {toolbarStart}
        {toolbarStart ? <Separator orientation="vertical" className={paletteSep} /> : null}
        <Button variant="ghost" className={cn(paletteButton, measure && paletteOn)} title="Measure two surface points" onClick={() => { setMeasure(!measure); setDistance(null); }}><Ruler /><span className="group-[.compact]/palette:hidden">Measure</span></Button>
        <Popover open={popover === 'section'} onOpenChange={o => setPopover(o ? 'section' : null)}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className={cn(paletteButton, (section < 100 || popover === 'section') && paletteOn)} title="Section plane"><Scissors /><span className="group-[.compact]/palette:hidden">Section</span></Button>
          </PopoverTrigger>
          <PopoverContent side="top" sideOffset={10} className={palettePop} onInteractOutside={e => e.preventDefault()}>
            <Label className="gap-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground">Section height<Slider aria-label="Section plane" className="w-40" min={0} max={100} value={[section]} onValueChange={v => setSection(v[0])} /></Label>
            <Button type="button" variant="outline" size="xs" onClick={() => { setSection(100); setPopover(null); }}>Off</Button>
          </PopoverContent>
        </Popover>
        <Popover open={popover === 'explode'} onOpenChange={o => setPopover(o ? 'explode' : null)}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className={cn(paletteButton, (explode > 0 || popover === 'explode') && paletteOn)} title="Explode the assembly"><Layers /><span className="group-[.compact]/palette:hidden">Explode</span></Button>
          </PopoverTrigger>
          <PopoverContent side="top" sideOffset={10} className={palettePop} onInteractOutside={e => e.preventDefault()}>
            <Label className="gap-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground">Explode<Slider aria-label="Explode assembly" className="w-40" min={0} max={100} value={[explode]} onValueChange={v => setExplode(v[0])} /></Label>
            <Button type="button" variant="outline" size="xs" onClick={() => setExplode(explode > 0 ? 0 : 100)}>{explode > 0 ? 'Collapse' : 'Full'}</Button>
          </PopoverContent>
        </Popover>
        {toolbarEnd ? <Separator orientation="vertical" className={paletteSep} /> : null}
        {toolbarEnd}
      </div>
      {corner && <div className="glass absolute bottom-3.5 left-3 z-[7] flex gap-0.5 rounded-xl p-1 @max-[900px]/viewer:bottom-16" role="toolbar" aria-label="Layout">{corner}</div>}
      <div className={cn('pointer-events-none absolute bottom-[18px] z-[5] flex max-w-[22%] flex-col gap-0.5 text-2xs text-faint @max-[1100px]/viewer:hidden', corner ? 'left-[136px]' : 'left-3.5')}>{hoverName ? <span className="truncate text-xs font-medium text-foreground">{hoverName}</span> : null}<span>{loading ? 'Preparing geometry…' : flat ? 'Developed sheet' : `${count >= 1e6 ? (count / 1e6).toFixed(1) + 'M' : count >= 1e4 ? Math.round(count / 1000) + 'k' : count.toLocaleString()} triangles`}</span></div>
      {measure && (
        <div className="absolute bottom-[72px] left-4 flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5 text-sm font-medium shadow-pop">
          {distance === null ? 'Pick two visible surface points' : `${distance.toFixed(3)} mm · mesh measurement`}
          <small className="text-xs font-normal text-muted-foreground">Approximate; use CAD feature dimensions for QC.</small>
        </div>
      )}
    </div>
  );
}
