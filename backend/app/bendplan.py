"""Bend sequence and tooling plan for the press-brake simulation.

The part is folded exactly as the viewer folds it (bendsim kinematics) and placed in the tool frame of each stroke
(X along the bend line, Y across, Z up; the punch tip touches the inside of the bend, the die is below). Every
region of the blank is sampled with points on its mid-plane; a point collides when it lies inside a tool profile
grown by half the sheet thickness. The bending zone itself (around the punch tip and the die shoulders) is where
the part touches the tools by design and is not tested.

Sequence: depth-first search over the strokes, shortest / outermost flanges first and without needless flips
(press-brake practice), keeping only steps where neither the punch, the die, the upper beam nor the bed is hit.
For every stroke the straight punch is tried first, then a gooseneck punch (either way round, for return flanges),
then tall versions. Punch and die are sectional: as long as the bend line, split where the stroke has gaps. If no
collision-free sequence exists the plan keeps the order with the fewest clashes and reports them — it never hides a
clash. Tooling is generic (sized from the thickness); it shows feasibility, it is not a tool-library selection.
"""
import math
import time
import numpy as np
import shapely
from shapely.geometry import Polygon
from shapely import union_all

FRACTIONS = (0.0, 0.5, 1.0)


DIES = ('standard', 'narrow')


def tooling(t, die='standard'):
    """Generic tools in the tool frame (Y across the bend, Z up; punch tip / die top at Z 0). `standard`: V = 8 t
    die; `narrow`: V = 6 t on a slim body, for short flanges and small Z offsets."""
    k = max(1.0, t / 1.5)
    W = max(6.0, (8 if die == 'standard' else 6) * t)
    vdepth = W / 2 * 1.04
    body = W / 2 + (3 if die == 'standard' else 1.6) * t

    def straight(H):
        return [[-.5 * k, 0], [.5 * k, 0], [9 * k, 26 * k], [9 * k, H - 24 * k], [15 * k, H - 24 * k], [15 * k, H], [-15 * k, H], [-15 * k, H - 24 * k], [-9 * k, H - 24 * k], [-9 * k, 26 * k]]

    def goose(H):
        # nose toward +Y, throat pocket above it for return flanges, body set back toward -Y
        return [[-.5 * k, 0], [.5 * k, 0], [8 * k, 18 * k], [8 * k, 26 * k], [-4 * k, 40 * k], [-4 * k, H - 24 * k], [15 * k, H - 24 * k], [15 * k, H], [-15 * k, H],
                [-15 * k, H - 24 * k], [-15 * k, 40 * k], [-9 * k, 22 * k]]
    punches = {}
    for name, H in (('', 120 * k), ('tall-', 200 * k)):
        upper = [[[-25 * k, H], [25 * k, H], [25 * k, H + 44 * k], [-25 * k, H + 44 * k]],             # clamp
                 [[-45 * k, H + 44 * k], [45 * k, H + 44 * k], [45 * k, H + 220 * k], [-45 * k, H + 220 * k]]]   # upper beam
        punches[name + 'straight'] = {'profile': straight(H), 'upper': upper, 'height': H}
        punches[name + 'goose'] = {'profile': goose(H), 'upper': upper, 'height': H}
    dies = {}
    for name, D in (('', 60 * k), ('tall-', 220 * k)):   # a tall die lets a formed leg hang down beside it
        dies[name + 'die'] = {'profile': [[-body, -D], [body, -D], [body, 0], [W / 2, 0], [0, -vdepth], [-W / 2, 0], [-body, 0]],
                              'lower': [[[-20 * k, -D - 50 * k], [20 * k, -D - 50 * k], [20 * k, -D], [-20 * k, -D]],                  # die rail
                                        [[-35 * k, -D - 270 * k], [35 * k, -D - 270 * k], [35 * k, -D - 50 * k], [-35 * k, -D - 50 * k]]],  # lower beam
                              'height': D}
    return {'k': k, 'W': W, 'vdepth': vdepth, 'die_name': die, 'dies': dies, 'punches': punches}


# (punch, mirrored, die) in order of preference: standard tools first, special ones only when they avoid a clash
VARIANTS = [(pn, m, dn) for pn, dn in (('straight', 'die'), ('goose', 'die'), ('straight', 'tall-die'), ('goose', 'tall-die'), ('tall-straight', 'die'),
                                       ('tall-goose', 'die'), ('tall-straight', 'tall-die'), ('tall-goose', 'tall-die'))
            for m in ((False,) if pn.endswith('straight') else (False, True))]


ROLL_RATIO = 10     # inner radius / thickness from which a curve is rolled instead of press-braked (default)


def default_process(radius, t):
    return 'roll' if radius >= max(ROLL_RATIO * t, 10.0) else 'brake'


def roll_setup(radius, angle, span, t):
    """Generic 3-roll (pyramid) plate roll for one curve: top roll inside the curve, two bottom rolls outside;
    the curvature is reached in a few passes over the whole zone."""
    top = min(max(.6 * radius, 6.0), 60.0)
    bottom = .85 * top
    return {'top': round(top, 3), 'bottom': round(bottom, 3), 'pitch': round((top + bottom) * 1.2, 3),
            'length': round(span + 2 * max(15.0, .1 * span), 3), 'passes': int(min(5, max(2, math.ceil(angle / 45))))}


def roll_centres(rho, t, r, angle=math.pi, at=.5, direction=1):
    """Supports tangent to the finite arc or its straight tangent extensions, in the mid-plane frame."""
    rho = min(rho, 1e7)
    D = rho + t / 2 + r['bottom']
    bounds = sorted((-direction * angle * at, direction * angle * (1 - at)))
    out = []
    for y in (-r['pitch'], r['pitch']):
        theta = math.asin(max(-.95, min(.95, y / D)))
        theta = max(bounds[0], min(bounds[1], theta))
        # Past an arc endpoint, continue its tangent rather than the imaginary full circle.
        z = rho - D * math.cos(theta) + math.tan(theta) * (y - D * math.sin(theta))
        out.append((y, z))
    return tuple(out)


def sink(a, W, vdepth, t):
    return min(W / 2 * math.tan(a / 2) * 0.55, vdepth - t)


# ------------------------------------------------------------------------------------------------ vector folding
def fold_arr(P, chain, bends, angles, strip=None):
    """Vectorised bendsim.fold_point for many points of one region."""
    P = np.array(P, float)
    for bi in reversed(chain):
        b = bends[bi]
        a = angles[bi]
        if a < 1e-6:
            if strip == bi:
                strip = None
            continue
        L, u, v, n = b['L'], b['u'], b['v'], b['n']
        w, s = b['w'], b['s']
        rel = P - L
        du, d, h = rel @ u, rel @ v, rel @ n
        rho = 2 * w / a
        C = L - w * v + s * rho * n
        if strip == bi:
            phi = np.clip((d + w) / rho, 0.0, a)
            sp, cp = np.sin(phi)[:, None], np.cos(phi)[:, None]
            N = -s * sp * v + cp * n
            P = C + rho * (sp * v - s * cp * n) + h[:, None] * N + du[:, None] * u
            strip = None
        else:
            E = C + rho * (math.sin(a) * v - s * math.cos(a) * n)
            T = math.cos(a) * v + s * math.sin(a) * n
            N = -s * math.sin(a) * v + math.cos(a) * n
            P = E + (d - w)[:, None] * T + h[:, None] * N + du[:, None] * u
    return P


def _samples(geom, h, z):
    """Points on a polygon (grid inside plus its outline) at spacing h, on the mid-plane."""
    pts = []
    for g in getattr(geom, 'geoms', [geom]):
        if g.is_empty or g.geom_type != 'Polygon':
            continue
        x0, y0, x1, y1 = g.bounds
        xs, ys = np.arange(x0 + h / 2, x1, h), np.arange(y0 + h / 2, y1, h)
        if len(xs) and len(ys):
            X, Y = np.meshgrid(xs, ys)
            X, Y = X.ravel(), Y.ravel()
            inside = shapely.contains_xy(g, X, Y)
            pts.append(np.c_[X[inside], Y[inside]])
        for ring in [g.exterior, *g.interiors]:
            n = max(4, int(math.ceil(ring.length / h)))
            q = shapely.line_interpolate_point(ring, np.linspace(0, ring.length, n, endpoint=False))
            pts.append(shapely.get_coordinates(q))
    if not pts:
        return np.zeros((0, 3))
    P = np.vstack(pts)
    return np.c_[P, np.full(len(P), z)]


class Planner:
    def __init__(self, sim, region_geoms, z_mid, budget_s=12.0, die='standard', process=None):
        self.t = float(sim['thickness'])
        self.sim = sim
        self.bends = [{**b, 'L': np.array(b['L'], float), 'u': np.array(b['u'], float), 'v': np.array(b['v'], float), 'n': np.array(b['n'], float)} for b in sim['bends']]
        self.regions = sim['regions']
        size = max(sim['size']) if sim.get('size') else 200
        h = min(6.0, max(3.0, size / 110, 1.5 * self.t))
        self.pts = [_samples(gm, h, z_mid) for gm in region_geoms]
        self.primary = [i for i, b in enumerate(self.bends) if b.get('twin') is None]
        self.members = {p: [i for i, b in enumerate(self.bends) if i == p or b.get('twin') == p] for p in self.primary}
        self.full = [math.radians(b['angle']) for b in self.bends]
        # forming process of every stroke: override by bend id (any segment of the stroke), else by radius
        process = process or {}
        self.process = {}
        for p_ in self.primary:
            ids = [self.bends[m]['id'] for m in self.members[p_]]
            chosen = next((process[i] for i in ids if process.get(i) in ('roll', 'brake')), None)
            self.process[p_] = chosen or default_process(self.bends[p_]['radius'], self.t)
        self.tool = tooling(self.t, die)
        T = self.tool
        grow = max(.05, self.t / 2 - .15)
        self.dies = {n: (Polygon(d['profile']).buffer(grow, join_style=2), union_all([Polygon(q) for q in d['lower']]).buffer(grow, join_style=2)) for n, d in T['dies'].items()}
        self.punch = {n: (Polygon(p['profile']).buffer(grow, join_style=2), union_all([Polygon(q) for q in p['upper']]).buffer(grow, join_style=2)) for n, p in T['punches'].items()}
        self.punch_m = {n: (_mirror(pp), _mirror(rr)) for n, (pp, rr) in self.punch.items()}
        self.deadline = time.time() + budget_s
        self.cache = {}
        self.evals = 0
        # sides of every stroke: area that moves (smaller side) for the outside-in heuristic
        areas = [gm.area for gm in region_geoms]
        sub = {}
        for r, reg in enumerate(self.regions):
            for bi in reg['chain']:
                sub[bi] = sub.get(bi, 0) + areas[r]
        tot = sum(areas)
        self.small_side = {p: min(sub.get(p, 0), tot - sub.get(p, 0)) for p in self.primary}
        self.depth = {p: len(next((reg['chain'] for reg in self.regions if reg['strip'] == p), [])) for p in self.primary}

    # -------------------------------------------------------------------------------------------- geometry
    def angles(self, done, cur=None, frac=0.0):
        a = [0.0] * len(self.bends)
        for p in done:
            for m in self.members[p]:
                a[m] = self.full[m]
        if cur is not None:
            for m in self.members[cur]:
                a[m] = self.full[m] * frac
        return a

    def folded(self, ang):
        return [fold_arr(P, reg['chain'], self.bends, ang, reg['strip']) if len(P) else P for P, reg in zip(self.pts, self.regions)]

    def frame(self, bi, ang, at=0.5):
        """Stroke frame at the point `at` (0..1) across the bend zone: the middle for a press stroke, the line of
        contact under the top roll for rolling."""
        b = self.bends[bi]
        a = ang[bi]
        mid = b['L'] + b['u'] * (b.get('stroke') or {}).get('center', 0.0) + b['v'] * (2 * at - 1) * b['w']
        N = b['n']
        if a > 1e-6:
            mid = fold_arr(mid[None], [bi], self.bends, ang, bi)[0]
            N = -b['s'] * math.sin(a * at) * b['v'] + math.cos(a * at) * b['n']
        anc = next((reg['chain'] for reg in self.regions if reg['strip'] == bi), [bi])[:-1]
        q = fold_arr(np.array([mid, mid + b['u'], mid + N]), anc, self.bends, ang)
        X = q[1] - q[0]
        X /= np.linalg.norm(X)
        Z = (q[2] - q[0]) * b['s']
        Z /= np.linalg.norm(Z)
        Y = np.cross(Z, X)
        contact = q[0] - Z * self.t / 2
        return np.array([X, Y, Z]), contact

    def segments(self, p):
        b = self.bends[p]
        u, mid = b['u'], b['L'] + b['u'] * (b.get('stroke') or {}).get('center', 0.0)
        iv = []
        for m in self.members[p]:
            bm = self.bends[m]
            c, hl = float((bm['L'] - mid) @ u), bm['length'] / 2
            iv.append([c - hl, c + hl])
        iv.sort()
        out = [iv[0]]
        for x0, x1 in iv[1:]:
            if x0 - out[-1][1] < max(10.0, 4 * self.t):
                out[-1][1] = max(out[-1][1], x1)
            else:
                out.append([x0, x1])
        return out

    # -------------------------------------------------------------------------------------------- collision
    def evaluate(self, done, p):
        """Clashes of stroke p after the strokes in `done`: first punch variant without any, else the one with fewest."""
        key = (done, p)
        if key in self.cache:
            return self.cache[key]
        self.evals += 1
        if self.process[p] == 'roll':
            res = self.evaluate_roll(done, p)
            self.cache[key] = res
            return res
        T = self.tool
        segs = self.segments(p)
        rex = max(T['W'] * .65, 3 * self.t)
        e = self.t + .5   # sectional tools end a little inside the bend line (corner flanges stand right at its ends)
        frames = []
        for frac in FRACTIONS:
            ang = self.angles(done, p, frac)
            R, contact = self.frame(p, ang)
            d = sink(ang[p], T['W'], T['vdepth'], self.t)
            P = np.vstack([q for q in self.folded(ang) if len(q)])
            W_ = (P - contact) @ R.T
            x, y, z = W_[:, 0], W_[:, 1], W_[:, 2] - d
            keep = (y ** 2 + (z - (self.t / 2 - d)) ** 2) > rex ** 2
            inseg = np.zeros(len(x), bool)
            for x0, x1 in segs:
                inseg |= (x > x0 + e) & (x < x1 - e)
            ts = keep & inseg
            frames.append((y, z, z - (self.t - d), keep, ts))
        lower = {}

        def low(dn):   # die / bed hits of one die
            if dn not in lower:
                dp, bp = self.dies[dn]
                lower[dn] = (sum(int(shapely.contains_xy(dp, y[ts], z[ts]).sum()) for y, z, _, _, ts in frames if ts.any()),
                             sum(int(shapely.contains_xy(bp, y[keep], z[keep]).sum()) for y, z, _, keep, _ in frames))
            return lower[dn]
        upper = {}
        best = None
        for v in VARIANTS:
            pn, mirror, dn = v
            if (pn, mirror) not in upper:
                pp, rr = (self.punch_m if mirror else self.punch)[pn]
                upper[(pn, mirror)] = (sum(int(shapely.contains_xy(pp, y[ts], zp[ts]).sum()) for y, _, zp, _, ts in frames if ts.any()),
                                       sum(int(shapely.contains_xy(rr, y[keep], zp[keep]).sum()) for y, _, zp, keep, _ in frames))
            h = dict(zip(('punch', 'beam'), upper[(pn, mirror)]))
            h.update(zip(('die', 'bed'), low(dn)))
            sc = sum(h.values())
            if best is None or sc < best['score']:
                best = {'variant': v, 'clash': {k: n for k, n in h.items() if n}, 'score': sc}
            if sc == 0:
                break
        self.cache[key] = best
        return best

    def roll_of(self, p):
        b = self.bends[p]
        span = (b.get('stroke') or {}).get('span', b['length'])
        return roll_setup(b['radius'], b['angle'], span, self.t)

    def evaluate_roll(self, done, p):
        """Rolling: the top roll sits inside the curve, so formed flanges on the inside are what can hit it."""
        r = self.roll_of(p)
        hits = {'roll': 0, 'bottom_roll': 0}
        grow = max(.05, self.t / 2 - .15)
        for frac in np.linspace(0, 1, 9):
            ang = self.angles(done, p, frac)
            P = np.vstack([q for q in self.folded(ang) if len(q)])
            a = ang[p]
            rho = 2 * self.bends[p]['w'] / a if a > 1e-6 else 1e7
            for at in np.linspace(0, 1, 9):
                R, contact = self.frame(p, ang, at)
                W_ = (P - (contact + R[2] * self.t / 2)) @ R.T
                x, y, z = W_[:, 0], W_[:, 1], W_[:, 2]
                ins = np.abs(x) < r['length'] / 2
                centres = [('roll', (0, self.t / 2 + r['top']), r['top'])]
                centres += [('bottom_roll', c, r['bottom']) for c in roll_centres(rho, self.t, r, a, at, self.bends[p]['s'])]
                for key, (cy, cz), rad in centres:
                    hits[key] += int((ins & ((y - cy)**2 + (z - cz)**2 < (rad + grow)**2)).sum())
        return {'variant': ('roll', False, 'roll'), 'clash': {k: n for k, n in hits.items() if n}, 'score': sum(hits.values())}

    # -------------------------------------------------------------------------------------------- sequence
    def ranked(self, done, last_s):
        rest = [p for p in self.primary if p not in done]
        return sorted(rest, key=lambda p: (self.process[p] != 'roll', round(math.log2(self.small_side[p] + 1)), self.bends[p]['s'] != last_s, -self.depth[p], self.bends[p]['length']))

    def search(self):
        P = self.primary
        # pairwise precedence: q must come before p when p clashes with q already formed
        before = {p: set() for p in P}
        for p in P:
            for q in P:
                if q != p and time.time() < self.deadline and self.evaluate(frozenset([q]), p)['score'] > 0:
                    before[q].add(p)          # p has to be formed before q
        mutual = any(p in before[q] and q in before[p] for p in P for q in P if p < q)
        dead = set()
        found = {'seq': None}

        def allowed(p, done):
            return not any(q not in done and q != p for q in before[p])

        def dfs(done, seq, last_s):
            if len(seq) == len(P):
                found['seq'] = list(seq)
                return True
            if done in dead or time.time() > self.deadline:
                return False
            for p in self.ranked(done, last_s):
                if allowed(p, done) and self.evaluate(done, p)['score'] == 0:
                    seq.append(p)
                    if dfs(done | {p}, seq, self.bends[p]['s']):
                        return True
                    seq.pop()
                if time.time() > self.deadline:
                    return False
            dead.add(done)
            return False
        if not mutual:
            dfs(frozenset(), [], None)
        if found['seq']:
            return found['seq'], True
        # no collision-free sequence (or out of time): greedy, fewest clashes, precedence and practice order on ties
        done, seq, last = frozenset(), [], None
        while len(seq) < len(P):
            cand = self.ranked(done, last)
            p = min(cand, key=lambda c: (self.evaluate(done, c)['score'], not allowed(c, done), cand.index(c)))
            seq.append(p)
            done, last = done | {p}, self.bends[p]['s']
        return seq, False

    def plan(self, order=None):
        seq = order if order else self.search()[0]
        steps, done = [], frozenset()
        for p in seq:
            r = self.evaluate(done, p)
            if self.process[p] == 'roll':
                ro = self.roll_of(p)
                steps.append({'bend': p, 'process': 'roll', 'roll': ro, 'punch': '', 'mirror': False, 'die': '', 'segments': [[-ro['length'] / 2, ro['length'] / 2]], 'clash': r['clash']})
            else:
                name, mirror, die = r['variant']
                steps.append({'bend': p, 'process': 'brake', 'punch': name, 'mirror': mirror, 'die': die, 'segments': [[round(a, 3), round(b, 3)] for a, b in self.segments(p)], 'clash': r['clash']})
            done = done | {p}
        return seq, steps


def _mirror(poly):
    return shapely.transform(poly, lambda c: c * np.array([-1.0, 1.0]))


def plan(sim, region_geoms, z_mid, order=None, budget_s=12.0, process=None):
    """(order, steps, tooling) for a built simulation. `order`: fixed sequence of primary bend indices. The standard
    V-die is used unless only the narrow one avoids clashes."""
    best = None
    for die in DIES:
        pl = Planner(sim, region_geoms, z_mid, budget_s / len(DIES), die, process)
        seq, steps = pl.plan(order)
        score = sum(sum(st['clash'].values()) for st in steps)
        if best is None or score < best[0]:
            best = (score, seq, steps, pl.tool)
        if score == 0:
            break
    return best[1], best[2], best[3]
