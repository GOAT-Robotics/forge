"""Press-brake bending simulation data.

The developed blank (the same outline the flat DXF is cut from) is split into rigid flanges and one strip per
bend (the bend allowance). Every strip is sliced across its width so it can curl. The client folds the blank
with the kinematics below; nothing here is a guess about tooling — the punch / die drawn by the viewer are
generic and only illustrate the operation.

Fold of bend b at angle a (0..full angle) in the flat frame, axis u along the bend line, v across it toward the
child flange, n = +Z (top of the blank), s = +1 when the flange folds toward +Z ("up"), w = half strip width,
mid-plane at z = -t/2, current neutral radius rho = 2w / a:
  start of strip S = L - w v, centre of curvature C = S + s rho n
  strip point at distance d from the centre line, height h above the mid-plane: phi = (d + w) / rho,
      p = C + rho (sin(phi) v - s cos(phi) n) + h N(phi),   N(phi) = -s sin(phi) v + cos(phi) n
  child side (d > w): rigid, p = E + (d - w) T(a) + h N(a),  T(a) = cos(a) v + s sin(a) n
Folds are applied from the region's own bend back to the root flange.
"""
import math
import numpy as np
import mapbox_earcut as earcut
from shapely.geometry import Polygon, MultiPolygon, LineString, LinearRing, Point
from shapely import union_all


def _polys(g):
    if g is None or g.is_empty:
        return []
    if isinstance(g, Polygon):
        return [g]
    if isinstance(g, MultiPolygon):
        return list(g.geoms)
    return [x for x in getattr(g, 'geoms', []) if isinstance(x, Polygon)]


def _strip_rect(a, b, v, w0, w1):
    """Rectangle along a..b from w0 to w1 across the bend line."""
    return Polygon([a + v * w0, b + v * w0, b + v * w1, a + v * w1])


def fold_point(p, chain, bends, angles, strip=None):
    """Reference implementation of the client fold (used by tests and the rendered drawing view)."""
    p = np.array(p, float)
    for bi in reversed(chain):
        b = bends[bi]
        L, u, v, n = (np.array(b[k], float) for k in ('L', 'u', 'v', 'n'))
        w, s, a = b['w'], b['s'], angles[bi]
        rel = p - L
        du, d, h = rel @ u, rel @ v, rel @ n
        if a < 1e-6:
            continue
        rho = 2 * w / a
        S = L - w * v
        C = S + s * rho * n
        if strip == bi:
            phi = min(max((d + w) / rho, 0.0), a)
            N = -s * math.sin(phi) * v + math.cos(phi) * n
            p = C + rho * (math.sin(phi) * v - s * math.cos(phi) * n) + h * N + du * u
            strip = None
        else:
            E = C + rho * (math.sin(a) * v - s * math.cos(a) * n)
            T = math.cos(a) * v + s * math.sin(a) * n
            N = -s * math.sin(a) * v + math.cos(a) * n
            p = E + (d - w) * T + h * N + du * u
    return p


def build(poly, bend_lines, thickness, above=False, root_point=None, order_ids=None, plan_budget=12.0):
    """Foldable mesh + bend kinematics for one developed blank. `above`: the material lies on +Z of the developed
    skin (z 0..t) instead of below it (z -t..0)."""
    t = float(thickness)
    z_top, z_bot = (t, 0.0) if above else (0.0, -t)
    bends = []
    strips = []
    for i, bl in enumerate(bend_lines):
        a = np.array(bl['a'], float)
        b = np.array(bl['b'], float)
        L2 = b - a
        length = float(np.linalg.norm(L2))
        if length < 1e-6:
            raise ValueError('Degenerate bend line')
        u = L2 / length
        v = np.array([-u[1], u[0]])
        w = float(bl['allowance']) / 2
        bends.append({'id': bl['id'], 'a': a, 'b': b, 'u': u, 'v': v, 'w': w, 'angle': float(bl['angle']), 'radius': float(bl['radius']),
                      'length': length, 's': 1 if bl.get('direction') == 'up' else -1})
        e = u * 0.02  # past the ends: shared flange corners must not bridge two flanges by round-off slivers
        strips.append(_strip_rect(a - e, b + e, v, -w, w))
    flanges = _polys(poly.difference(union_all(strips)) if strips else poly)
    flanges = [f for f in flanges if f.area > 1e-3]
    if not flanges:
        raise ValueError('Blank has no flanges')

    # neighbours of every strip: the flange touching each long side
    def side(bi, sgn):
        bd = bends[bi]
        shrink = bd['u'] * min(bd['length'] * .05, 1.0)
        probe = _strip_rect(bd['a'] + shrink, bd['b'] - shrink, bd['v'], sgn * bd['w'], sgn * (bd['w'] + .05))
        best = max(((f.intersection(probe).area, k) for k, f in enumerate(flanges)), default=(0, None))
        return best[1] if best[0] > 1e-6 else None
    nb = [(side(i, -1), side(i, 1)) for i in range(len(bends))]

    root = max(range(len(flanges)), key=lambda k: flanges[k].area)
    if root_point is not None:  # keep the flange the developed pattern was built from fixed (model orientation)
        rp = Point(root_point)
        root = min(range(len(flanges)), key=lambda k: flanges[k].distance(rp))
    chain_of = {root: []}
    parent_bend = {}
    twin = {}
    queue = [root]
    while queue:
        f = queue.pop(0)
        for i, (lo, hi) in enumerate(nb):
            if i in parent_bend or f not in (lo, hi):
                continue
            child = hi if lo == f else lo
            if child is None:
                continue
            if child in chain_of:
                # same flange pair on the same line (a bend split by a relief / cut-out): folds with its twin
                prim = chain_of[child][-1] if chain_of[child] else None
                if prim is not None and parent_bend.get(prim) == f and _collinear(bends[prim], bends[i]):
                    if lo != f:
                        bends[i]['v'] = -bends[i]['v']
                    parent_bend[i] = f
                    twin[i] = prim
                continue
            if lo != f:  # orient v toward the child flange
                bends[i]['v'] = -bends[i]['v']
            parent_bend[i] = f
            chain_of[child] = chain_of[f] + [i]
            queue.append(child)
    if len(chain_of) != len(flanges) or len(parent_bend) != len(bends):
        raise ValueError('Bends do not form a single foldable tree')

    # kinematic frame of every bend: centre line on the mid-plane
    for bd in bends:
        mid = (bd['a'] + bd['b']) / 2
        bd['L'] = [float(mid[0]), float(mid[1]), (z_top + z_bot) / 2]
        bd['u3'] = [float(bd['u'][0]), float(bd['u'][1]), 0.0]
        bd['v3'] = [float(bd['v'][0]), float(bd['v'][1]), 0.0]

    regions = []  # {chain, strip}
    pieces = []   # (polygon, region)
    for k, f in enumerate(flanges):
        regions.append({'chain': chain_of[k], 'strip': None})
        pieces.append((f, len(regions) - 1))
    for i, bd in enumerate(bends):
        regions.append({'chain': chain_of[parent_bend[i]] + [i], 'strip': i})
        r = len(regions) - 1
        n_sl = max(6, int(math.ceil(bd['angle'] / 7.5)))
        for j in range(n_sl):
            w0 = -bd['w'] + 2 * bd['w'] * j / n_sl
            w1 = -bd['w'] + 2 * bd['w'] * (j + 1) / n_sl
            e = bd['u'] * 0.02
            for piece in _polys(poly.intersection(_strip_rect(bd['a'] - e, bd['b'] + e, bd['v'], w0, w1))):
                if piece.area > 1e-6:
                    pieces.append((piece, r))

    outline = poly.boundary
    verts, vreg, tris, edges = [], [], [], []

    def add(x, y, z, r):
        verts.append((round(float(x), 4), round(float(y), 4), round(float(z), 4)))
        vreg.append(r)
        return len(verts) - 1

    for piece, r in pieces:
        piece = piece.buffer(0)
        for pp in _polys(piece):
            rings = [np.array(pp.exterior.coords)[:-1]] + [np.array(h.coords)[:-1] for h in pp.interiors]
            rings = [rg for rg in rings if len(rg) >= 3]
            if not rings:
                continue
            flat2 = np.vstack(rings)
            ends = np.cumsum([len(rg) for rg in rings]).astype(np.uint32)
            tri = earcut.triangulate_float64(flat2, ends).reshape(-1, 3)
            top = [add(x, y, z_top, r) for x, y in flat2]
            bot = [add(x, y, z_bot, r) for x, y in flat2]
            for a_, b_, c_ in tri:
                # orient: top faces +Z, bottom faces -Z
                p0, p1, p2 = flat2[a_], flat2[b_], flat2[c_]
                ccw = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]) > 0
                if ccw:
                    tris += [(top[a_], top[b_], top[c_]), (bot[a_], bot[c_], bot[b_])]
                else:
                    tris += [(top[a_], top[c_], top[b_]), (bot[a_], bot[b_], bot[c_])]
            off = 0
            for ri, rg in enumerate(rings):
                m = len(rg)
                ccw_ring = LinearRing(rg).is_ccw
                right_is_out = (ri == 0) == ccw_ring   # material lies left of an exterior CCW / interior CW ring
                for q in range(m):
                    i0, i1 = off + q, off + (q + 1) % m
                    mid = (flat2[i0] + flat2[i1]) / 2
                    if outline.distance(Point(mid)) > 1e-4:
                        continue  # internal cut between flange and strip / between slabs: no wall
                    a0, a1, b0, b1 = top[i0], top[i1], bot[i0], bot[i1]
                    if right_is_out:
                        tris += [(a0, b0, b1), (a0, b1, a1)]
                    else:
                        tris += [(a0, b1, b0), (a0, a1, b1)]
                    edges += [(a0, a1), (b0, b1)]
                off += m
    # tangent lines of every bend (top and bottom), so the strip reads as a bend
    for i, bd in enumerate(bends):
        for wv in (-bd['w'], bd['w']):
            for seg in _segments(poly.intersection(LineString([bd['a'] + bd['v'] * wv, bd['b'] + bd['v'] * wv]))):
                r = len(flanges) + i
                for z in (z_top, z_bot):
                    edges.append((add(seg[0][0], seg[0][1], z, r), add(seg[1][0], seg[1][1], z, r)))

    # bends on one line with the same angle, radius and direction are one press stroke (split by reliefs / cut-outs)
    from .unfold import bend_groups
    stroke = {}
    for grp in bend_groups(bend_lines):
        if len(grp) < 2:
            continue
        prim = next((i for i in grp if i not in twin), grp[0])
        twin.pop(prim, None)
        for i in grp:
            if i != prim:
                twin[i] = prim
        u, mid = bends[prim]['u'], (bends[prim]['a'] + bends[prim]['b']) / 2
        ts = [float((p - mid) @ u) for i in grp for p in (bends[i]['a'], bends[i]['b'])]
        stroke[prim] = {'center': (min(ts) + max(ts)) / 2, 'span': max(ts) - min(ts), 'ids': [bends[i]['id'] for i in grp]}
    depth = {i: len(chain_of[parent_bend[i]]) for i in range(len(bends))}
    order = sorted((i for i in range(len(bends)) if i not in twin), key=lambda i: (-depth[i], bends[i]['length']))
    sim = {
        'version': 2, 'thickness': t,
        'bends': [{'id': bd['id'], 'L': bd['L'], 'u': bd['u3'], 'v': bd['v3'], 'n': [0.0, 0.0, 1.0], 'w': bd['w'], 'angle': bd['angle'],
                   'radius': bd['radius'], 's': bd['s'], 'length': bd['length'], 'twin': twin.get(i), **({'stroke': stroke[i]} if i in stroke else {})} for i, bd in enumerate(bends)],
        'regions': regions, 'order': order,
        'vertices': [c for v_ in verts for c in v_], 'region': vreg,
        'triangles': [i for tr in tris for i in tr], 'edges': [i for e in edges for i in e],
        'size': [float(x) for x in (poly.bounds[2] - poly.bounds[0], poly.bounds[3] - poly.bounds[1])],
    }
    # bend sequence and tooling: collision-checked against punch, die, beam and bed
    from .bendplan import plan
    geoms = list(flanges) + [poly.intersection(_strip_rect(bd['a'] - bd['u'] * .02, bd['b'] + bd['u'] * .02, bd['v'], -bd['w'], bd['w'])) for bd in bends]
    fixed = None
    if order_ids:
        idx = {bd['id']: i for i, bd in enumerate(bends)}
        fixed = [idx[x] for x in order_ids if x in idx and idx[x] not in twin]
        if sorted(fixed) != sorted(order):
            fixed = None   # stale (bends changed): plan again
    try:
        sim['order'], sim['plan'], sim['tooling'] = plan(sim, geoms, (z_top + z_bot) / 2, fixed, plan_budget)
    except Exception:   # never lose the simulation over the planner: practice order, standard tools, unchecked
        from .bendplan import tooling
        if fixed:
            sim['order'] = fixed
        sim['tooling'] = tooling(t)
        sim['plan'] = [{'bend': i, 'punch': 'straight', 'mirror': False, 'die': 'die', 'segments': [[-stroke.get(i, {}).get('span', bends[i]['length']) / 2, stroke.get(i, {}).get('span', bends[i]['length']) / 2]], 'clash': {}, 'unchecked': True} for i in sim['order']]
    sim['sequence'] = 'custom' if fixed else 'planned'
    return sim


def _collinear(a, b):
    if abs(a['angle'] - b['angle']) > .1 or a['s'] != b['s'] or abs(a['w'] - b['w']) > 1e-3:
        return False
    if abs(a['u'][0] * b['u'][1] - a['u'][1] * b['u'][0]) > 1e-4:
        return False
    d = b['a'] - a['a']
    return abs(d[0] * a['u'][1] - d[1] * a['u'][0]) < .02


def _segments(geom):
    if geom.is_empty:
        return []
    if geom.geom_type == 'LineString':
        c = list(geom.coords)
        return [(c[0], c[-1])] if len(c) >= 2 else []
    out = []
    for gg in getattr(geom, 'geoms', []):
        out += _segments(gg)
    return out


def folded_vertices(sim, progress=1.0):
    """All vertices folded to progress × full angle (reference / tests)."""
    V = np.array(sim['vertices'], float).reshape(-1, 3)
    bends = [{**b, 'L': b['L'], 'u': b['u'], 'v': b['v'], 'n': b['n']} for b in sim['bends']]
    angles = [math.radians(b['angle']) * progress for b in bends]
    out = np.empty_like(V)
    for i, (p, r) in enumerate(zip(V, sim['region'])):
        reg = sim['regions'][r]
        out[i] = fold_point(p, reg['chain'], bends, angles, reg['strip'])
    return out


def _material_above(shape, R, tv, th):
    """(material lies on +Z of the developed root skin, a point of the root skin in the flat frame)."""
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN
    from .cad import mesh
    m = mesh(shape, max(.2, th / 2))
    F = m.vertices @ R.T + tv
    flat_tri = np.all(np.abs(F[m.faces][:, :, 2]) < 1e-3, axis=1)
    if not flat_tri.any():
        return False, None
    tri = m.vertices[m.faces[flat_tri]]
    area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)
    pick = np.argsort(-area)[:25]                       # centroids of the largest triangles on the root skin
    Rinv = R.T
    votes = 0
    for p in tri[pick].mean(axis=1):
        res = []
        for sgn in (1, -1):
            q = p + Rinv @ np.array([0, 0, sgn * th / 2])
            c = BRepClass3d_SolidClassifier(shape, gp_Pnt(*map(float, q)), 1e-6)
            res.append(c.State() == TopAbs_IN)
        if res[0] != res[1]:
            votes += 1 if res[0] else -1
    big = F[m.faces[flat_tri][pick[0]]].mean(axis=0)
    return votes > 0, big[:2].tolist()


def for_part(shape, g, spec, k, order_ids=None):
    """Simulation data for a formed sheet-metal part (hole sizes as cut: hardware mounting holes applied)."""
    from .unfold import unfold
    if g.get('category') not in (None, 'sheet_metal') and not g.get('bends'):
        raise ValueError('Not a formed sheet-metal part')
    if not g.get('bends'):
        raise ValueError('Part has no bends')
    poly, lines = unfold(shape, g, k)
    try:
        from .worker import hardware_holes
        poly, _ = hardware_holes(poly, g, spec or {})
    except Exception:
        pass
    maps = getattr(unfold, 'maps', None) or []
    above, root_point = False, None
    if maps:
        # which side of the developed skin the material is on: probe half a thickness behind the root face
        _, normal, R, tv = maps[0]
        R, tv = np.asarray(R, float), np.asarray(tv, float)
        above, root_point = _material_above(shape, R, tv, float(g['thickness']))
    sim = build(poly, lines, g['thickness'], above, root_point, order_ids)
    if maps:
        # the root flange as it sits in the part: lets the viewer show the folded result in model orientation
        sim['root'] = {'R': R.tolist(), 't': tv.tolist()}
    return sim
