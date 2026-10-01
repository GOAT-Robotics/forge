import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

type Anchor = { x: number; y: number; cx: number; cy: number };

/**
 * Pinch / ctrl-wheel zoom for a scrolling preview, zooming about the fingers or cursor.
 * - Trackpad pinch (Chrome/Edge/Firefox deliver it as ctrl+wheel), ctrl/cmd + mouse wheel
 * - Safari trackpad gesture events
 * - Two-finger touch pinch (single-finger pan stays native scrolling)
 * The caller renders `zoom`; this hook keeps the point under the fingers fixed by adjusting scroll.
 */
export function usePinchZoom(host: RefObject<HTMLElement | null>, zoom: number, setZoom: (z: number) => void,
  { min = 0.25, max = 8, onPinchStart, active = true }: { min?: number; max?: number; onPinchStart?: () => void; active?: boolean } = {}) {
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const anchor = useRef<Anchor | null>(null);
  const shown = useRef(zoom); // zoom of the layout currently on screen
  const pinching = useRef(false);
  const cb = useRef({ setZoom, onPinchStart }); cb.current = { setZoom, onPinchStart };

  useLayoutEffect(() => {
    shown.current = zoom;
    const a = anchor.current, el = host.current;
    if (!a || !el) return;
    const style = getComputedStyle(el), padX = parseFloat(style.paddingLeft) || 0, padY = parseFloat(style.paddingTop) || 0;
    el.scrollLeft = a.x * zoom + padX - a.cx;
    el.scrollTop = a.y * zoom + padY - a.cy;
  }, [zoom, host]);

  useEffect(() => {
    const el = host.current;
    if (!el || !active) return;
    const clamp = (z: number) => Math.min(max, Math.max(min, z));
    let idle = 0;
    const zoomTo = (next: number, clientX: number, clientY: number) => {
      const z = +clamp(next).toFixed(3);
      if (Math.abs(z - zoomRef.current) < 1e-3) return;
      const r = el.getBoundingClientRect(), cx = clientX - r.left, cy = clientY - r.top;
      const style = getComputedStyle(el), padX = parseFloat(style.paddingLeft) || 0, padY = parseFloat(style.paddingTop) || 0;
      // Point under the fingers in unscaled content units, measured on the layout currently on screen.
      // The anchor lives for the whole gesture, so scroll clamping near the sheet edge never accumulates drift
      // (and moving the fingers while pinching pans).
      if (!anchor.current) anchor.current = { x: (el.scrollLeft + cx - padX) / shown.current, y: (el.scrollTop + cy - padY) / shown.current, cx, cy };
      else { anchor.current.cx = cx; anchor.current.cy = cy; }
      window.clearTimeout(idle); idle = window.setTimeout(() => { anchor.current = null; }, 250);
      zoomRef.current = z;
      cb.current.setZoom(z);
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain wheel/two-finger drag keeps scrolling
      e.preventDefault();
      // trackpad pinch sends small deltas, a mouse notch ~100: cap so one notch is ~1.25x
      const delta = Math.max(-25, Math.min(25, e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY));
      zoomTo(zoomRef.current * Math.exp(-delta * 0.01), e.clientX, e.clientY);
    };
    // Safari (macOS) trackpad pinch
    let gestureBase = 1;
    const gStart = (e: Any) => { e.preventDefault(); gestureBase = zoomRef.current; pinching.current = true; cb.current.onPinchStart?.(); };
    const gChange = (e: Any) => { e.preventDefault(); zoomTo(gestureBase * e.scale, e.clientX, e.clientY); };
    const gEnd = (e: Any) => { e.preventDefault(); pinching.current = false; };
    // Two-finger touch pinch
    const touches = new Map<number, { x: number; y: number }>();
    let startDist = 0, startZoom = 1;
    const spread = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { const s = spread(); startDist = s.d || 1; startZoom = zoomRef.current; pinching.current = true; cb.current.onPinchStart?.(); }
    };
    const moveP = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) { const s = spread(); zoomTo(startZoom * s.d / startDist, s.x, s.y); }
    };
    const up = (e: PointerEvent) => { touches.delete(e.pointerId); if (touches.size < 2) pinching.current = false; };
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', gStart as EventListener);
    el.addEventListener('gesturechange', gChange as EventListener);
    el.addEventListener('gestureend', gEnd as EventListener);
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('pointermove', moveP, true);
    el.addEventListener('pointerup', up, true);
    el.addEventListener('pointercancel', up, true);
    return () => {
      window.clearTimeout(idle);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', gStart as EventListener);
      el.removeEventListener('gesturechange', gChange as EventListener);
      el.removeEventListener('gestureend', gEnd as EventListener);
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('pointermove', moveP, true);
      el.removeEventListener('pointerup', up, true);
      el.removeEventListener('pointercancel', up, true);
    };
  }, [host, min, max, active]);
  return pinching;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
