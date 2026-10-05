/** Lower supports follow the finite arc and its tangent flanges, not an infinite circle.
 * Keep aligned with backend/app/bendplan.py:roll_centres. */
export function rollCentres(rho: number, t: number, r: { bottom: number; pitch: number }, angle: number, at: number, direction: number): [number, number][] {
  rho = Math.min(rho, 1e7);
  const D = rho + t / 2 + r.bottom;
  const bounds = [-direction * angle * at, direction * angle * (1 - at)].sort((a, b) => a - b);
  return [-r.pitch, r.pitch].map(y => {
    let theta = Math.asin(Math.max(-.95, Math.min(.95, y / D)));
    theta = Math.max(bounds[0], Math.min(bounds[1], theta));
    return [y, rho - D * Math.cos(theta) + Math.tan(theta) * (y - D * Math.sin(theta))];
  });
}
