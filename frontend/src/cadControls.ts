import * as THREE from 'three';

/** Mouse layout of the 3D view. 'forge': left rotates, right / middle pans. 'solidworks': middle rotates,
 * Ctrl+middle pans, Shift+middle zooms, right drag pans; left is free for selection. */
export type NavStyle = 'forge' | 'solidworks';

/**
 * CAD navigation without the turntable limits of OrbitControls: free 360° rotation about any screen axis
 * (no gimbal stop at the poles, the camera may roll), pan in the view plane, zoom toward the cursor.
 * Keeps OrbitControls' surface (target, update, zoomToCursor, min/maxDistance, rotate/zoomSpeed) so the
 * viewer's camera fly-to code keeps working.
 */
export class CadControls {
  target = new THREE.Vector3();
  enabled = true;
  rotateSpeed = 1;
  zoomSpeed = 1;
  zoomToCursor = true;
  minDistance = 0;
  maxDistance = Infinity;
  style: NavStyle = 'forge';
  /** Optional pivot provider: rotate about the point under the cursor (SolidWorks rotates about the model). */
  pivotAt: ((clientX: number, clientY: number) => THREE.Vector3 | null) | null = null;
  private drag: { mode: 'rotate' | 'pan' | 'zoom'; x: number; y: number; pivot: THREE.Vector3 | null } | null = null;
  // compatibility no-ops (OrbitControls fields set by older code)
  enableDamping = false; dampingFactor = 0; screenSpacePanning = true;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.onContext);
    dom.style.touchAction = 'none';
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('contextmenu', this.onContext);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  }

  update() { this.camera.lookAt(this.target); }

  private onContext = (e: Event) => e.preventDefault();

  private modeFor(e: PointerEvent): 'rotate' | 'pan' | 'zoom' | null {
    if (this.style === 'solidworks') {
      if (e.button === 1) return e.ctrlKey ? 'pan' : e.shiftKey ? 'zoom' : 'rotate';
      if (e.button === 2) return 'pan';
      if (e.button === 0 && e.altKey) return 'rotate';
      return null;
    }
    if (e.button === 0) return e.ctrlKey || e.metaKey ? null : e.shiftKey && e.altKey ? 'pan' : 'rotate';
    if (e.button === 1 || e.button === 2) return e.ctrlKey ? 'zoom' : 'pan';
    return null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const mode = this.modeFor(e);
    if (!mode) return;
    if (e.button === 1) e.preventDefault();
    this.drag = { mode, x: e.clientX, y: e.clientY, pivot: mode === 'rotate' && this.pivotAt ? this.pivotAt(e.clientX, e.clientY) : null };
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  };

  private onUp = () => {
    this.drag = null;
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    d.x = e.clientX; d.y = e.clientY;
    if (d.mode === 'rotate') this.rotate(-dx * 0.0062 * this.rotateSpeed, -dy * 0.0062 * this.rotateSpeed, d.pivot);
    else if (d.mode === 'pan') this.pan(dx, dy);
    else this.dolly(Math.pow(0.992, -dy * this.zoomSpeed), null);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    const scale = Math.pow(0.95, (-e.deltaY / (e.deltaMode === 1 ? 3 : 100)) * this.zoomSpeed);
    this.dolly(scale, this.zoomToCursor ? [e.clientX, e.clientY] : null);
  };

  /** Rotate the view: yaw about the screen's up axis, pitch about its right axis (trackball, unlimited). */
  rotate(yaw: number, pitch: number, pivot: THREE.Vector3 | null = null) {
    const cam = this.camera;
    const center = pivot || this.target;
    const forward = this.target.clone().sub(cam.position).normalize();
    const right = forward.clone().cross(cam.up).normalize();
    const up = right.clone().cross(forward).normalize();
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(right, pitch));
    cam.position.sub(center).applyQuaternion(q).add(center);
    if (pivot) this.target.sub(center).applyQuaternion(q).add(center);
    cam.up.copy(up).applyQuaternion(q).normalize();
    this.update();
  }

  /** Spin about the viewing direction (SolidWorks Alt+arrow). */
  roll(angle: number) {
    const forward = this.target.clone().sub(this.camera.position).normalize();
    this.camera.up.applyQuaternion(new THREE.Quaternion().setFromAxisAngle(forward, angle)).normalize();
    this.update();
  }

  pan(dxPixels: number, dyPixels: number) {
    const cam = this.camera;
    const h = this.dom.clientHeight || 1;
    const dist = cam.position.distanceTo(this.target);
    const perPixel = 2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / h;
    const forward = this.target.clone().sub(cam.position).normalize();
    const right = forward.clone().cross(cam.up).normalize();
    const up = right.clone().cross(forward).normalize();
    const move = right.multiplyScalar(-dxPixels * perPixel).add(up.multiplyScalar(dyPixels * perPixel));
    cam.position.add(move); this.target.add(move);
    this.update();
  }

  /** scale < 1 moves closer. With a cursor, the point under it stays put (zoom to cursor). */
  dolly(scale: number, cursor: [number, number] | null) {
    const cam = this.camera;
    const offset = cam.position.clone().sub(this.target);
    let dist = offset.length() * scale;
    dist = Math.min(Math.max(dist, this.minDistance || 1e-6), this.maxDistance);
    const real = dist / Math.max(offset.length(), 1e-9);
    if (cursor) {
      const rect = this.dom.getBoundingClientRect();
      const ndc = new THREE.Vector2((cursor[0] - rect.left) / rect.width * 2 - 1, -(cursor[1] - rect.top) / rect.height * 2 + 1);
      // point on the plane through the target, facing the camera, under the cursor
      const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, cam);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(offset.clone().normalize(), this.target);
      const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
      if (hit) {
        // scale both camera and target about the cursor point
        cam.position.sub(hit).multiplyScalar(real).add(hit);
        this.target.sub(hit).multiplyScalar(real).add(hit);
        this.update();
        return;
      }
    }
    cam.position.copy(this.target).add(offset.multiplyScalar(real));
    this.update();
  }
}

/** Camera "up" for a standard view direction (Z-up model): plan views keep +Y up, others keep +Z up. */
export function upFor(dir: THREE.Vector3) {
  return Math.abs(dir.z) > 0.99 ? new THREE.Vector3(0, dir.z > 0 ? 1 : 1, 0) : new THREE.Vector3(0, 0, 1);
}
