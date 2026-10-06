"""Weld-seam detection between assembled bodies.

A weld seam is where the boundary of one body lies on the surface of another. For every pair of
selected component occurrences (in their imported assembly pose) we look for B-rep edges of one body
that lie on the other body, classify the joint from the face normals at that edge and suggest a weld:

* fillet  – the edge's free face meets the other body's face at an angle (T-joint, lap edge, inside corner)
* corner  – as fillet, but the other body ends at the same edge (outside corner of a box section)
* butt    – the edge's free face is flush with the other body's face (plates edge to edge)

Results are expressed in the owning part's definition coordinates so they can be saved as ordinary
edge selections on a weld joint and previewed by the viewer for any occurrence.
"""
from __future__ import annotations

import math

import numpy as np

from .cad import explore, read_brep, sample_edge, xyz, TopAbs_EDGE, TopAbs_FACE

TOL = 0.2          # mm: assembly contact tolerance
MAX_PAIRS = 400    # occurrence pairs examined per search (spread over several calls)
MAX_SEAMS = 400    # per call


def _trsf(T):
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(*np.asarray(T, float)[:3, :4].flatten().tolist())
    return t


def _moved(shape, T):
    from OCP.TopLoc import TopLoc_Location
    return shape.Moved(TopLoc_Location(_trsf(T)))


def _box(shape, grow=0.0):
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    b = Bnd_Box()
    BRepBndLib.Add_s(shape, b)
    if grow:
        b.Enlarge(grow)
    return b


def _dist(a, b):
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    d = BRepExtrema_DistShapeShape(a, b)
    return d.Value() if d.IsDone() else math.inf


def _edge_dist(edge, target, limit, body=None, cand=()):
    """Distance from an edge to `target`, or inf when it is certainly more than `limit`.

    BRepExtrema on an edge far from a big curved face can take 100+ ms; sampled points settle that: the
    distance changes by at most the arc length between two samples, so when every point sampled `step`
    apart is further than limit + step / 2, the whole edge is. A point is first checked against the
    bounding boxes of the candidate faces (`body.face_boxes[cand]`, numpy), then exactly."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.GCPnts import GCPnts_AbscissaPoint, GCPnts_UniformAbscissa
    from OCP.TopoDS import TopoDS
    try:
        c = BRepAdaptor_Curve(TopoDS.Edge(edge) if hasattr(TopoDS, 'Edge') else TopoDS.Edge_s(edge))
        length = GCPnts_AbscissaPoint.Length_s(c)
        n = max(2, min(40, int(math.ceil(length / 6.0)) + 1))
        u = GCPnts_UniformAbscissa(c, n)
        if not (u.IsDone() and u.NbPoints() >= 2):
            return _dist(edge, target)
        pts = np.array([[q.X(), q.Y(), q.Z()] for q in (c.Value(u.Parameter(i)) for i in range(1, u.NbPoints() + 1))])
    except Exception:
        return _dist(edge, target)
    reach = limit + length / (len(pts) - 1) / 2 + 1e-6
    if body is not None and len(cand):
        lo, hi = body.box_array[0][list(cand)], body.box_array[1][list(cand)]
        gap = np.maximum(lo[None] - pts[:, None], 0) + np.maximum(pts[:, None] - hi[None], 0)
        close = np.linalg.norm(gap, axis=2).min(1) <= reach + TOL
        pts = pts[close]
    order = sorted(range(len(pts)), key=lambda i: abs(i - (len(pts) - 1) / 2))   # middle first
    for i in order:
        if _dist(_vertex(pts[i]), target) <= reach:
            return _dist(edge, target)
    return math.inf


def _vertex(p):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
    from OCP.gp import gp_Pnt
    return BRepBuilderAPI_MakeVertex(gp_Pnt(*map(float, p))).Vertex()


def face_normal(face, p):
    """Outward unit normal of a face at (the projection of) a world point."""
    from OCP.BRep import BRep_Tool
    from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf
    from OCP.BRepLProp import BRepLProp_SLProps
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.gp import gp_Pnt
    from OCP.TopoDS import TopoDS
    f = TopoDS.Face(face)
    proj = GeomAPI_ProjectPointOnSurf(gp_Pnt(*map(float, p)), BRep_Tool.Surface_s(f))
    if proj.NbPoints() < 1:
        return None
    u, v = proj.LowerDistanceParameters()
    props = BRepLProp_SLProps(BRepAdaptor_Surface(f, True), u, v, 1, 1e-6)
    if not props.IsNormalDefined():
        return None
    n = xyz(props.Normal())
    if f.Orientation() == 1:  # TopAbs_REVERSED
        n = -n
    return n / (np.linalg.norm(n) or 1)


class Body:
    """One component occurrence placed in the assembly."""

    def __init__(self, pid, occurrence, shape, T, thickness):
        self.pid, self.occurrence, self.T, self.thickness = pid, occurrence, np.asarray(T, float), thickness
        self.shape = _moved(shape, T)
        self.box = _box(self.shape, TOL)
        self.inv = np.linalg.inv(self.T)
        # edge index in explorer order (matches /edge-at) -> edge
        seen, self.edges = [], []
        for i, e in enumerate(explore(self.shape, TopAbs_EDGE)):
            if any(e.IsSame(s) for s in seen):
                continue
            seen.append(e)
            self.edges.append((i, e))
        self.faces = list(explore(self.shape, TopAbs_FACE))
        self.face_boxes = [_box(f, TOL) for f in self.faces]
        # the same boxes as two (n, 3) arrays (min corners, max corners) for vectorised tests
        lo = [fb.CornerMin() if not fb.IsVoid() else None for fb in self.face_boxes]
        hi = [fb.CornerMax() if not fb.IsVoid() else None for fb in self.face_boxes]
        self.box_array = (np.array([(p.X(), p.Y(), p.Z()) if p else (-1e9,) * 3 for p in lo], float).reshape(-1, 3),
                          np.array([(p.X(), p.Y(), p.Z()) if p else (1e9,) * 3 for p in hi], float).reshape(-1, 3))
        self.face_edges = [list(explore(f, TopAbs_EDGE)) for f in self.faces]
        self._edge_faces = {}
        for i, edges in enumerate(self.face_edges):
            for e in edges:
                self._edge_faces.setdefault(hash(e), set()).add(i)
        self._vertex_faces = None

    def ring(self, edge, small=0.0):
        """Faces that are topological neighbours of `edge`: the faces sharing a vertex with the faces bounding
        it, plus whatever lies one step beyond a *small* neighbour (e.g. the far side of a narrow slot, whose
        end face is small). A large shared face such as a base plate does not make two flanges neighbours."""
        from OCP.TopAbs import TopAbs_VERTEX
        if self._vertex_faces is None:
            self._face_vertices = [{hash(v) for v in explore(f, TopAbs_VERTEX)} for f in self.faces]
            self._vertex_faces = {}
            for i, vs in enumerate(self._face_vertices):
                for v in vs:
                    self._vertex_faces.setdefault(v, set()).add(i)
            self._face_size = []
            for f in self.faces:
                bb = _box(f)
                self._face_size.append(float(np.linalg.norm(xyz(bb.CornerMax()) - xyz(bb.CornerMin()))))
        own = set(self._edge_faces.get(hash(edge), ()))
        step = lambda faces: {j for i in faces for v in self._face_vertices[i] for j in self._vertex_faces[v]}
        ring1 = own | step(own)
        return ring1 | step({i for i in ring1 - own if self._face_size[i] <= small})

    def local(self, pts):
        pts = np.asarray(pts, float)
        return (np.c_[pts, np.ones(len(pts))] @ self.inv.T)[:, :3]

    def local_dir(self, n):
        return self.inv[:3, :3] @ np.asarray(n, float)

    def faces_at(self, p):
        """(face, outward normal) for every face of this body passing through world point p."""
        from OCP.gp import gp_Pnt
        out = []
        v = _vertex(p)
        for f, b in zip(self.faces, self.face_boxes):
            if b.IsOut(gp_Pnt(*map(float, p))):
                continue
            if _dist(v, f) <= TOL:
                n = face_normal(f, p)
                if n is not None:
                    out.append((f, n))
        return out

    def edge_faces(self, edge):
        return [self.faces[i] for i in sorted(self._edge_faces.get(hash(edge), ()))]


def _compound(faces):
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder
    c = TopoDS_Compound(); bld = BRep_Builder(); bld.MakeCompound(c)
    for f in faces:
        bld.Add(c, f)
    return c


def _near_faces(body, shape_box, grow):
    """Faces of `body` whose bounding box comes within `grow` of a box (cheap prefilter)."""
    from OCP.Bnd import Bnd_Box
    b = Bnd_Box(); b.Add(shape_box); b.Enlarge(grow)
    return [i for i, fb in enumerate(body.face_boxes) if not b.IsOut(fb)]


def _on(target, p):
    return _dist(_vertex(p), target) <= TOL


class Budget(Exception):
    """Raised when seam detection runs past its time budget."""


def _check(deadline):
    import time
    if deadline and time.monotonic() > deadline:
        raise Budget()


def _seams_on(a: Body, b: Body, deadline=None):
    """Edges of body a that lie on the surface of body b."""
    out = []
    for index, edge in a.edges:
        _check(deadline)
        eb = _box(edge, TOL)
        if eb.IsOut(b.box):
            continue
        cand = _near_faces(b, eb, TOL)
        if not cand:
            continue
        target = _compound([b.faces[i] for i in cand])
        if _edge_dist(edge, target, TOL, b, cand) > TOL:
            continue
        pts = sample_edge(edge, .1)
        if len(pts) == 2:  # straight edge: sample along it
            pts = np.linspace(pts[0], pts[1], 9)
        elif len(pts) > 64:
            pts = pts[::max(1, len(pts) // 64)]
        on = [_on(target, p) for p in pts]
        if sum(on) < max(2, .8 * len(pts)):
            continue
        # keep the longest contiguous run that lies on b (an edge may run past the other body)
        runs, cur = [], []
        for p, ok in zip(pts, on):
            if ok:
                cur.append(p)
            elif cur:
                runs.append(cur); cur = []
        if cur:
            runs.append(cur)
        path = np.array(max(runs, key=len))
        length = float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum()) if len(path) > 1 else 0.0
        if length < 1.0:
            continue
        mid = path[len(path) // 2] if len(path) > 2 else path.mean(0)
        other = [n for _, n in b.faces_at(mid)]
        if not other:
            continue
        normals = [n for n in (face_normal(f, mid) for f in a.edge_faces(edge)) if n is not None]
        par = lambda u, w: float(np.dot(u, w)) > .98
        flush = [(n, m) for n in normals for m in other if par(n, m)]
        contact = [(n, m) for n in normals for m in other if par(n, -m)]
        if flush:
            # a face of each body in one plane: an outside, flush seam (welded like a butt / square groove)
            joint, n_free, nb = 'butt', None, flush[0][0]
        elif contact:
            nb = contact[0][1]
            free = [n for n in normals if not par(n, -nb)]
            if not free:
                continue
            n_free = free[0]
            # inside corner (T / lap): the other body continues past the edge on the free side
            joint = 'fillet' if _on(b.shape, mid + n_free * max(1.0, 3 * TOL)) else 'corner'
        else:
            continue
        angle = None if n_free is None else round(math.degrees(math.acos(max(-1, min(1, float(np.dot(n_free, nb)))))), 1)
        out.append({'body': a, 'other': b, 'index': index, 'path': path, 'length': length, 'joint': joint,
                    'n_free': n_free, 'n_other': nb, 'angle': angle})
    return out


def _nearest(p, faces):
    """Distance from world point p to the nearest of `faces`, and the nearest point."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    v = _vertex(p)
    best = (math.inf, None)
    for f in faces:
        d = BRepExtrema_DistShapeShape(v, f)
        if d.IsDone() and d.Value() < best[0]:
            best = (d.Value(), xyz(d.PointOnShape2(1)))
    return best


def _inside(body, p):
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.gp import gp_Pnt
    from OCP.TopAbs import TopAbs_IN
    c = BRepClass3d_SolidClassifier(body.shape, gp_Pnt(*map(float, p)), 1e-6)
    return c.State() == TopAbs_IN


def _air(a, b, edge, cand, p, q, tangent):
    """p (on a's edge) and q (on one of b's faces `cand`) are separated by air across the seam: the segment
    neither heads into a's own material nor reaches b's face from behind, and runs across the edge, not along it
    (an edge that merely ends near a face is not a seam)."""
    v = q - p
    lv = np.linalg.norm(v)
    if lv < 1e-9:
        return False
    lt = np.linalg.norm(tangent)
    if lt > 1e-9 and abs(float(np.dot(v / lv, tangent / lt))) > .5:
        return False
    own = [n for n in (face_normal(f, p) for f in a.edge_faces(edge)) if n is not None]
    if own and all(float(np.dot(v, n)) < -1e-6 for n in own):
        return False
    vq = _vertex(q)
    facing = [face_normal(b.faces[i], q) for i in cand if _dist(vq, b.faces[i]) <= 1e-3]
    return not facing or any(n is not None and float(np.dot(-v, n)) > 1e-6 for n in facing)


def _gap_seams(a: Body, b: Body, max_gap: float, edges=None, target=None, self_mode=False, deadline=None):
    """Edges of `a` that run alongside a face of `b` across a small air gap (TOL < gap <= max_gap): the weld
    has to bridge the gap. The seam is the mid-line of the gap. `target` limits the faces of b considered;
    `self_mode` looks for gaps inside one body (e.g. the open corner of a bent box), ignoring faces that are
    topological neighbours of the edge."""
    out = []
    for index, edge in (edges if edges is not None else a.edges):
        _check(deadline)
        eb = _box(edge, max_gap)
        if eb.IsOut(b.box):
            continue
        cand = [i for i, fb in enumerate(b.face_boxes) if not eb.IsOut(fb) and (target is None or i in target)]
        if self_mode and cand:
            near = a.ring(edge, small=2 * max_gap + 2 * (a.thickness or 0))
            cand = [i for i in cand if i not in near]
        if not cand:
            continue
        faces = [_compound([b.faces[i] for i in cand])]
        if _edge_dist(edge, faces[0], max_gap + 1e-3, b, cand) > max_gap + 1e-3:
            continue
        pts = sample_edge(edge, .1)
        if len(pts) == 2:
            pts = np.linspace(pts[0], pts[1], max(7, min(24, int(np.linalg.norm(pts[1] - pts[0]) / 10) + 2)))
        elif len(pts) > 24:
            pts = pts[::max(1, len(pts) // 24)]
        # quick look at three points before sampling the whole edge
        probe = [_nearest(pts[int(k * (len(pts) - 1))], faces) for k in (.25, .5, .75)]
        hits = [(pts[int(k * (len(pts) - 1))], q) for k, (d, q) in zip((.25, .5, .75), probe) if q is not None and TOL < d <= max_gap + 1e-3]
        if len(hits) < 2 or not _air(a, b, edge, cand, *hits[len(hits) // 2], pts[-1] - pts[0]):
            continue
        near = [_nearest(p, faces) for p in pts]
        runs, cur = [], []
        for p, (d, q) in zip(pts, near):
            if q is not None and TOL < d <= max_gap + 1e-3:
                cur.append((p, q, d))
            elif cur:
                runs.append(cur); cur = []
        if cur:
            runs.append(cur)
        if not runs:
            continue
        run = max(runs, key=len)
        mids = np.array([(p + q) / 2 for p, q, _ in run])
        # A weld gap is air between two faces that look at each other; from a plate edge to the
        # opposite face of the same plate the segment runs through material instead.
        p, q, _ = run[len(run) // 2]
        if not _air(a, b, edge, cand, p, q, run[-1][0] - run[0][0]):
            continue
        length = float(np.linalg.norm(np.diff(mids, axis=0), axis=1).sum()) if len(mids) > 1 else 0.0
        gap = float(np.median([d for _, _, d in run]))
        if length < max(5.0, 2 * gap):
            continue
        # which way the gap opens (the side a welder works from): across the seam, away from the bodies
        t = mids[-1] - mids[0]; g = q - p
        opening = np.cross(t, g)
        if np.linalg.norm(opening) > 1e-9:
            opening = opening / np.linalg.norm(opening)
            centre = (xyz(a.box.CornerMin()) + xyz(a.box.CornerMax()) + xyz(b.box.CornerMin()) + xyz(b.box.CornerMax())) / 4
            if float(np.dot(opening, mids.mean(0) - centre)) < 0:
                opening = -opening
        else:
            opening = None
        out.append({'body': a, 'other': b, 'index': index, 'path': mids, 'length': length, 'joint': 'gap', 'gap': gap,
                    'n_free': None, 'n_other': None, 'angle': None, 'opening': opening})
    return out


def auto_gap(*thicknesses):
    """Largest air gap a weld is proposed to bridge without being asked: 1.5 × the thinner plate, 1.5–5 mm."""
    ts = [t for t in thicknesses if t and t > 0]
    return min(5.0, max(1.5, 1.5 * min(ts) if ts else 3.0))


def _same(s, t):
    """Two seams describe the same line in space (an edge shared by both bodies)."""
    if abs(s['length'] - t['length']) > max(1.0, .05 * s['length']):
        return False
    a, b = s['path'], t['path']
    ends = min(np.linalg.norm(a[0] - b[0]) + np.linalg.norm(a[-1] - b[-1]), np.linalg.norm(a[0] - b[-1]) + np.linalg.norm(a[-1] - b[0]))
    return ends <= 4 * TOL + max(s.get('gap', 0), t.get('gap', 0))


def suggested_size(t1, t2):
    """Starting throat 'a' for a fillet: half the thinner plate, rounded down to 0.5 mm (3 mm minimum from 6 mm plate)."""
    ts = [x for x in (t1, t2) if x and x > 0]
    if not ts:
        return 3.0
    t = min(ts)
    a = math.floor(.5 * t * 2) / 2
    return max(a, 3.0) if t >= 6 else max(a, 1.0)


def pair_key(a: Body, b: Body) -> str:
    return f'{a.pid}:{a.occurrence}|{b.pid}:{b.occurrence}'


def find_seams(bodies: list[Body], self_mode=False, budget=25.0, done=(), stats=None):
    """Seams between every pair of overlapping bodies: contact seams (edges lying on the other body) and
    gap seams (edges alongside the other body across a small gap). With `self_mode` also the gaps inside
    each body (a bent part closing on itself).

    Searched one pair at a time (contact, then gap seams) within `budget` seconds. Pairs listed in `done`
    were searched by an earlier call and are skipped; `stats` (a dict) receives `done` (every finished pair),
    `pending` (pairs left) and `skipped` (pairs too slow to search), so a caller continues where the budget stopped."""
    pairs = []
    for i, a in enumerate(bodies):
        for b in bodies[i + 1:]:
            if a.pid == b.pid and a.occurrence == b.occurrence:
                continue
            g = auto_gap(a.thickness, b.thickness)
            if not _box(a.shape, g).IsOut(b.box):
                pairs.append((a, b, g))
    pairs = pairs[:MAX_PAIRS]
    seams = []
    def add(found):
        for s in found:
            if len(seams) < MAX_SEAMS and not any(_same(s, t) for t in seams):
                seams.append(s)
    import time
    start = time.monotonic()
    finished = set(done)
    todo = [(pair_key(a, b), lambda a=a, b=b, g=g: _seams_on(a, b, dl[0]) + _seams_on(b, a, dl[0]) + _gap_seams(a, b, g, deadline=dl[0]) + _gap_seams(b, a, g, deadline=dl[0]))
            for a, b, g in pairs]
    if self_mode:
        todo += [(f'self:{a.pid}:{a.occurrence}', lambda a=a: _gap_seams(a, a, auto_gap(a.thickness), self_mode=True, deadline=dl[0])) for a in bodies[:4]]
    dl = [None]
    skipped, first = [], True
    for key, search in todo:
        if key in finished or f'skip:{key}' in finished:
            continue
        if budget and not first and time.monotonic() > start + budget:
            break
        # every call finishes at least one pair; a single pair gets up to 45 s (proxies cut requests near 100 s), then it is skipped
        dl[0] = (time.monotonic() + (max(45.0, 2 * budget) if first else max(0.5, start + budget - time.monotonic()))) if budget else None
        try:
            add(search()); finished.add(key)
        except Budget:
            if not first:
                break
            finished.add(f'skip:{key}'); skipped.append(key)
        first = False
    out = describe(seams)
    pending = sum(k not in finished and f'skip:{k}' not in finished for k, _ in todo)
    if stats is not None:
        stats.update(done=sorted(finished), pending=pending, total=len(todo), skipped=sorted(k[5:] for k in finished if k.startswith('skip:')))
    return out


def face_gap_seams(fa: tuple, fb: tuple, max_gap=25.0):
    """Seams bridging two faces the engineer picked, which do not touch: edges of either face that run
    alongside the other face within `max_gap`."""
    (a, ia), (b, ib) = fa, fb
    def edges_of(body, i):
        return [(k, e) for k, e in body.edges if i in body._edge_faces.get(hash(e), ())]
    seams = []
    for s in _gap_seams(a, b, max_gap, edges_of(a, ia), {ib}) + _gap_seams(b, a, max_gap, edges_of(b, ib), {ia}):
        if not any(_same(s, t) for t in seams):
            seams.append(s)
    return describe(seams)


def _join(polylines, tol=0.05):
    """Chain sampled section edges into continuous polylines (section edges come unordered)."""
    chains = [np.asarray(p, float) for p in polylines if len(p) >= 2]
    merged = True
    while merged and len(chains) > 1:
        merged = False
        for i in range(len(chains)):
            for j in range(i + 1, len(chains)):
                a, b = chains[i], chains[j]
                for x, y in ((a, b), (a, b[::-1]), (a[::-1], b), (a[::-1], b[::-1])):
                    if np.linalg.norm(x[-1] - y[0]) <= tol:
                        chains[i] = np.vstack([x, y[1:]]); chains.pop(j); merged = True
                        break
                if merged:
                    break
            if merged:
                break
    return chains


def face_pair_seams(fa: tuple, fb: tuple, max_gap=25.0):
    """The weld seam between two faces the engineer picked — any two faces: of two parts, of several parts
    picked pair by pair, or two faces of one part (a bent part closing on itself).

    * faces that meet: their exact intersection curve (B-rep section) is the seam; the bead fills the corner
      between them (fillet), or lies on the surface when the faces are flush (butt);
    * faces lying on each other (lap / plate on plate): the edges of one face that lie on the other;
    * faces apart (≤ max_gap): the mid-line of the gap, bead sized to fill it.
    Returns (seams, distance)."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Section
    (a, ia), (b, ib) = fa, fb
    FA, FB = a.faces[ia], b.faces[ib]
    d = _dist(FA, FB)
    if d > max_gap:
        return [], d
    def edges_of(body, i):
        return [(k, e) for k, e in body.edges if i in body._edge_faces.get(hash(e), ())]
    seams = []
    if d <= TOL:
        sec = BRepAlgoAPI_Section(FA, FB, False)
        sec.ComputePCurveOn1(True); sec.Approximation(True); sec.Build()
        polylines = []
        if sec.IsDone():
            for e in explore(sec.Shape(), TopAbs_EDGE):
                pts = sample_edge(e, .1)
                if len(pts) == 2:
                    pts = np.linspace(pts[0], pts[1], max(2, min(40, int(np.linalg.norm(pts[1] - pts[0]) / 5) + 2)))
                polylines.append(pts)
        for k, path in enumerate(_join(polylines)):
            length = float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum())
            if length < 1.0:
                continue
            mid = path[len(path) // 2]
            t = path[min(len(path) - 1, len(path) // 2 + 1)] - path[max(0, len(path) // 2 - 1)]
            t = t / (np.linalg.norm(t) or 1)
            nA, nB = face_normal(FA, mid), face_normal(FB, mid)
            if nA is None or nB is None:
                continue
            c = float(np.dot(nA, nB))
            if c < -.98:
                continue  # faces lying on each other: handled below from their edges
            item = {'body': a, 'other': b, 'index': -1, 'key': f'p{ia}-{ib}-{k}', 'path': path, 'length': length, 'angle': None}
            if c > .98:
                item.update(joint='butt', n_free=None, n_other=nA)  # flush faces: bead on the surface
            else:
                # along each face, perpendicular to the seam, toward the side the other face looks at
                dA = np.cross(t, nA); dA /= (np.linalg.norm(dA) or 1)
                if float(np.dot(dA, nB)) < 0: dA = -dA
                dB = np.cross(t, nB); dB /= (np.linalg.norm(dB) or 1)
                if float(np.dot(dB, nA)) < 0: dB = -dB
                item.update(joint='fillet', n_free=dB, n_other=dA, angle=round(math.degrees(math.acos(max(-1, min(1, float(np.dot(dA, dB)))))), 1))
            seams.append(item)
        if not seams:
            # lap / plate-on-plate contact: edges of either face lying on the other face
            for x, ix, y, iy in ((a, ia, b, ib), (b, ib, a, ia)):
                for s in _seams_on(x, y):
                    if ix in x._edge_faces.get(hash(next(e for k, e in x.edges if k == s['index'])), ()) and not any(_same(s, u) for u in seams):
                        seams.append(s)
    else:
        for s in _gap_seams(a, b, max_gap, edges_of(a, ia), {ib}) + _gap_seams(b, a, max_gap, edges_of(b, ib), {ia}):
            if not any(_same(s, t) for t in seams):
                seams.append(s)
    return describe(seams), d


def _centre(body):
    if getattr(body, '_centre', None) is None:
        lo, hi = body.box.CornerMin(), body.box.CornerMax()
        body._centre = np.array([(lo.X() + hi.X()) / 2, (lo.Y() + hi.Y()) / 2, (lo.Z() + hi.Z()) / 2])
    return body._centre


def access_side(s):
    """Where the welder works from: the air side of the seam (world direction), and whether that is the inside
    or the outside of the two parts together (towards / away from their combined centre)."""
    nf, no = s.get('n_free'), s.get('n_other')
    if s['joint'] == 'gap' and s.get('opening') is not None:
        d = np.asarray(s['opening'], float)
    elif s['joint'] == 'fillet' and nf is not None and no is not None:
        d = np.asarray(nf, float) + np.asarray(no, float)
    elif nf is not None:
        d = np.asarray(nf, float)
    elif no is not None:
        d = np.asarray(no, float)
    else:
        return None, None
    n = np.linalg.norm(d)
    if n < 1e-9:
        return None, None
    d = d / n
    path = np.asarray(s['path'], float)
    mid = path[len(path) // 2]
    c = (_centre(s['body']) + _centre(s['other'])) / 2
    return d, ('outside' if float(np.dot(d, mid - c)) > 0 else 'inside')


def _tangent(path, end):
    p = np.asarray(path, float)
    if len(p) < 2:
        return None
    d = (p[-1] - p[-2]) if end else (p[1] - p[0])
    n = np.linalg.norm(d)
    return d / n if n > 1e-9 else None


def chain(seams):
    """One seam per joint line: CAD splits a curved joint into several edges (each cylinder patch, each tangent
    plane), so a weld along a curve came out as several pieces. Seams of the same two bodies, of the same kind,
    on the same side (inside / outside), whose ends meet and continue smoothly, are joined into one."""
    items = [dict(x) for x in seams]
    for x in items:
        x['_side'] = access_side(x)[1]
        x['_members'] = [x.get('key') or str(x['index'])]
        x['_tiny'] = x['length'] < max(3.0, 2.5 * min(x['body'].thickness or 1, x['other'].thickness or 1))
        p = np.asarray(x['path'], float)
        if len(p) >= 2:   # where the fillet legs were measured: a curved bead turns them along the seam from here
            m = len(p) // 2
            t = p[min(len(p) - 1, m + 1)] - p[max(0, m - 1)]
            x['_ref'] = (p[m], t / (np.linalg.norm(t) or 1))
    # ends this close are one joint line: round / relieved corners of a contour leave a few mm where neither
    # edge lies on the other part, but the welder carries the bead round them
    tol_of = lambda x: max(1.0, min(8.0, 6 * min(x['body'].thickness or 1, x['other'].thickness or 1)))
    joined = True
    while joined:
        joined = False
        for i in range(len(items)):
            for j in range(len(items)):
                if i == j:
                    continue
                a, b = items[i], items[j]
                if a.get('_tiny') or b.get('_tiny'):
                    continue   # steps across a thickness at a notch: kept apart, bridged over
                if (a['body'] is not b['body'] or a['other'] is not b['other'] or a['joint'] != b['joint'] or a['_side'] != b['_side']):
                    continue
                pa, pb = np.asarray(a['path'], float), np.asarray(b['path'], float)
                tol = tol_of(a)
                for qa, qb in ((pa, pb), (pa, pb[::-1]), (pa[::-1], pb), (pa[::-1], pb[::-1])):
                    gap = float(np.linalg.norm(qa[-1] - qb[0]))
                    if gap > tol:
                        continue
                    ta, tb = _tangent(qa, True), _tangent(qb, False)
                    # smooth continuation; across a small rounded corner any turn short of doubling back
                    if ta is None or tb is None or float(np.dot(ta, tb)) < (.82 if gap < .2 else .5):
                        continue
                    path = np.vstack([qa, qb[1:]]) if gap < .05 else np.vstack([qa, qb])
                    longer = a if a['length'] >= b['length'] else b
                    merged = {**longer, 'path': path, 'length': a['length'] + b['length'] + (gap if gap >= .05 else 0), 'index': min(a['index'], b['index']) if a['index'] >= 0 and b['index'] >= 0 else -1,
                              '_members': a['_members'] + b['_members']}
                    if a['joint'] == 'gap':
                        merged['gap'] = max(a.get('gap') or 0, b.get('gap') or 0)
                    items[i] = merged
                    items.pop(j)
                    joined = True
                    break
                if joined:
                    break
            if joined:
                break
    import hashlib
    for x in items:
        if len(x['_members']) > 1:
            x['key'] = 'c' + hashlib.sha1('+'.join(sorted(x['_members'])).encode()).hexdigest()[:14]
            x['pieces'] = len(x['_members'])
        x.pop('_members', None)
        x.pop('_side', None)
        x.pop('_tiny', None)
    return items


def describe(seams):
    seams = chain(seams)
    out = []
    order = {'fillet': 0, 'gap': 1, 'butt': 2, 'corner': 3}
    seams.sort(key=lambda s: (order[s['joint']], -s['length']))
    for n, s in enumerate(seams, 1):
        a, b = s['body'], s['other']
        local = a.local(s['path'])
        size = suggested_size(a.thickness, b.thickness)
        if s['joint'] == 'gap':  # the bead has to fill the gap
            size = max(size, math.ceil(s['gap'] * 2) / 2 + 0.5)
        weld = {'fillet': 'fillet', 'corner': 'fillet', 'butt': 'butt', 'gap': 'gap'}[s['joint']]
        item = {
            'id': f"S{n}", 'part': a.pid, 'occurrence': a.occurrence, 'selection': 'edge', 'index': s['index'],
            **({'key': s['key']} if s.get('key') else {}),
            'type': 'line' if len(local) <= 9 and np.allclose(np.cross(local[-1] - local[0], local - local[0]), 0, atol=1e-3) else 'curve',
            'start': [round(float(v), 4) for v in local[0]], 'end': [round(float(v), 4) for v in local[-1]],
            'length': round(s['length'], 2), 'boundaries': [[[round(float(v), 4) for v in p] for p in local]],
            'joint': s['joint'], 'weld': weld, 'angle': s['angle'], 'size': size,
            # end seams across a plate thickness etc.: offered, not proposed
            'minor': s['length'] < max(3 * size, 12.0),
            'other_part': b.pid, 'other_occurrence': b.occurrence,
            'gap': round(s['gap'], 2) if s.get('gap') else None,
            'opening': [round(float(v), 5) for v in a.local_dir(s['opening'])] if s.get('opening') is not None else None,
            # Fillet legs in the owner's coordinates: along the other body's surface (away from the edge's free
            # face) and up the free face. Used to draw the bead's triangular cross-section.
            'legs': [[round(float(v), 5) for v in a.local_dir(s['n_free'])], [round(float(v), 5) for v in a.local_dir(s['n_other'])]] if s['n_free'] is not None else None,
            'normal': [round(float(v), 5) for v in a.local_dir(s['n_other'])] if s['n_other'] is not None else None,
        }
        acc, side = access_side(s)
        item['access'] = [round(float(v), 4) for v in acc] if acc is not None else None
        # the air side in the owner's coordinates: the dialog draws and picks the seam from that side only
        item['access_local'] = [round(float(v), 5) for v in a.local_dir(acc)] if acc is not None else None
        if s.get('pieces') and s.get('_ref') is not None:
            item['legs_at'] = [[round(float(v), 4) for v in a.local(np.array([s['_ref'][0]]))[0]], [round(float(v), 5) for v in a.local_dir(s['_ref'][1])]]
        item['thickness'] = round(float(min(a.thickness or 0, b.thickness or 0) or a.thickness or 0), 3)
        if s.get('pieces'):
            item['pieces'] = s['pieces']
        item['side'] = side
        out.append(item)
    return out


def load_bodies(folder, parts, instances, wanted, keep_all=False):
    """Bodies for the requested (pid, occurrence|None) list; None = every occurrence near another selected part."""
    lookup = {p['id']: p for p in parts}
    shapes, protos = {}, []
    for pid, occ in wanted:
        if pid not in lookup:
            continue
        if pid not in shapes:
            f = folder / 'parts' / pid / 'shape.brep'
            if not f.exists():
                continue
            shapes[pid] = read_brep(f)
        g = lookup[pid].get('geometry') or {}
        thickness = g.get('thickness') or min(g.get('dimensions') or [0])
        inst = instances.get(pid) or [{'matrix': np.eye(4).tolist()}]
        occs = [occ] if occ is not None else range(len(inst))
        for o in occs:
            if 0 <= o < len(inst):
                protos.append((pid, o, inst[o]['matrix'], thickness))
    # Many-occurrence parts: keep only occurrences whose placement overlaps another selected part.
    bodies = [Body(pid, o, shapes[pid], T, t) for pid, o, T, t in protos[:200]]
    if len({b.pid for b in bodies}) > 1 and not keep_all:
        # (within the largest gap a weld is proposed to bridge)
        grown = {id(b): _box(b.shape, 5.0) for b in bodies}
        bodies = [b for b in bodies if any(c.pid != b.pid and not grown[id(b)].IsOut(c.box) for c in bodies)]
    return bodies
