"""OpenCascade solids from Parasolid XT nodes, with the exact geometry the part file stores.

Conventions (checked against SolidWorks parts): a FIN runs into its `vertex`; a '+' fin runs along its edge; a
curve or surface with sense '-' runs against the edge / face that uses it; a face whose sense differs from its
surface's has its normal reversed. Analytic surfaces are parameterised as in OpenCascade except for lengths, which
Parasolid keeps in metres (uv_map); lengths are converted to millimetres here.
"""
from __future__ import annotations

import math

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
from OCP.BRepLib import BRepLib
from OCP.Geom import (Geom_BSplineCurve, Geom_BSplineSurface, Geom_Circle, Geom_ConicalSurface,
                      Geom_CylindricalSurface, Geom_Ellipse, Geom_Line, Geom_OffsetSurface, Geom_Plane,
                      Geom_SphericalSurface, Geom_SurfaceOfLinearExtrusion, Geom_SurfaceOfRevolution,
                      Geom_ToroidalSurface, Geom_TrimmedCurve)
from OCP.Geom2d import Geom2d_BSplineCurve
from OCP.GeomAPI import GeomAPI_PointsToBSpline, GeomAPI_ProjectPointOnCurve, GeomAPI_ProjectPointOnSurf
from OCP.GeomAbs import GeomAbs_C2
from OCP.ShapeFix import ShapeFix_Shape
from OCP.BRepBuilderAPI import BRepBuilderAPI_Sewing
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID, TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS
from OCP.collections import (Array1_double as TColStd_Array1OfReal, Array1_gp_Pnt as TColgp_Array1OfPnt,
                             Array1_gp_Pnt2d as TColgp_Array1OfPnt2d, Array1_int as TColStd_Array1OfInteger,
                             Array2_double as TColStd_Array2OfReal, Array2_gp_Pnt as TColgp_Array2OfPnt)
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopoDS import TopoDS_Face, TopoDS_Shell, TopoDS_Solid, TopoDS_Vertex, TopoDS_Wire
from OCP.gp import gp_Ax1, gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt, gp_Pnt2d

S = 1000.0  # Parasolid metres -> mm
NULLD = -3.0e13


class BrepError(ValueError):
    pass


def P(v):
    return gp_Pnt(v[0] * S, v[1] * S, v[2] * S)


def D(v):
    return gp_Dir(v[0], v[1], v[2])


def ax3(p, z, x):
    return gp_Ax3(P(p), D(z), D(x))


def ax2(p, z, x):
    return gp_Ax2(P(p), D(z), D(x))


def null(i):
    return i is None or i <= 1


class Builder:
    def __init__(self, nodes):
        self.n = nodes
        self.surfaces, self.curves, self.vertices, self.edges = {}, {}, {}, {}
        self.notes = []
        self.ring_at = {}   # vertexless ring edge -> where its OpenCascade vertex goes (see _anchor_rings)
        self.bb = BRep_Builder()

    def node(self, i):
        if null(i):
            return None
        try:
            return self.n[i]
        except KeyError:
            raise BrepError(f'the Parasolid data references node {i}, which is not in the stream')

    # ---------------------------------------------------------------- B-splines
    def _knots(self, mult_i, knots_i, count=None):
        mult = self.node(mult_i).mult
        knots = self.node(knots_i).knots
        mult = mult if isinstance(mult, list) else [mult]
        knots = knots if isinstance(knots, list) else [knots]
        if count:  # the arrays may be longer than the knot count (null-padded)
            mult, knots = mult[:count], knots[:count]
        tk = TColStd_Array1OfReal(1, len(knots))
        tm = TColStd_Array1OfInteger(1, len(mult))
        for k, (a, m) in enumerate(zip(knots, mult), 1):
            tk.SetValue(k, a)
            tm.SetValue(k, m)
        return tk, tm, knots, mult

    def nurbs_curve(self, nc, dim3=True):
        verts = self.node(nc.bspline_vertices).vertices
        dim = nc.vertex_dim
        n = nc.n_vertices
        rational = bool(nc.rational)
        tk, tm, knots, mult = self._knots(nc.knot_mult, nc.knots, nc.n_knots)
        periodic = bool(nc.periodic)
        cdim = dim - 1 if rational else dim
        w = TColStd_Array1OfReal(1, n)
        if dim3:
            poles = TColgp_Array1OfPnt(1, n)
        else:
            poles = TColgp_Array1OfPnt2d(1, n)
        for k in range(n):
            c = verts[k * dim:(k + 1) * dim]
            wt = c[-1] if rational else 1.0
            xyz = [c[j] / wt for j in range(cdim)]  # Parasolid stores homogeneous coordinates
            if dim3:
                poles.SetValue(k + 1, gp_Pnt(xyz[0] * S, xyz[1] * S, xyz[2] * S))
            else:
                poles.SetValue(k + 1, gp_Pnt2d(xyz[0], xyz[1]))
            w.SetValue(k + 1, wt)
        periodic = self._periodic(sum(mult), n, nc.degree, bool(nc.periodic))
        if dim3:
            return Geom_BSplineCurve(poles, w, tk, tm, nc.degree, periodic) if rational else Geom_BSplineCurve(poles, tk, tm, nc.degree, periodic)
        return Geom2d_BSplineCurve(poles, w, tk, tm, nc.degree, periodic) if rational else Geom2d_BSplineCurve(poles, tk, tm, nc.degree, periodic)

    @staticmethod
    def _periodic(nknots, npoles, degree, flagged):
        """Whether the knot data is OpenCascade's periodic form (sum of multiplicities = poles + last one)."""
        if nknots == npoles + degree + 1:
            return False
        if flagged:
            return True
        raise BrepError(f'B-spline with {npoles} poles, degree {degree} and {nknots} knots is inconsistent')

    def nurbs_surface(self, ns):
        verts = self.node(ns.bspline_vertices).vertices
        dim = ns.vertex_dim
        nu, nv = ns.n_u_vertices, ns.n_v_vertices
        rational = bool(ns.rational)
        uk, um, _, umult = self._knots(ns.u_knot_mult, ns.u_knots, ns.n_u_knots)
        vk, vm, _, vmult = self._knots(ns.v_knot_mult, ns.v_knots, ns.n_v_knots)
        up = self._periodic(sum(umult), nu, ns.u_degree, bool(ns.u_periodic))
        vp = self._periodic(sum(vmult), nv, ns.v_degree, bool(ns.v_periodic))
        poles = TColgp_Array2OfPnt(1, nu, 1, nv)
        w = TColStd_Array2OfReal(1, nu, 1, nv)
        for i in range(nu):
            for j in range(nv):
                k = (i * nv + j) * dim  # Parasolid: v varies fastest
                c = verts[k:k + dim]
                wt = c[3] if rational else 1.0
                poles.SetValue(i + 1, j + 1, gp_Pnt(c[0] / wt * S, c[1] / wt * S, c[2] / wt * S))
                w.SetValue(i + 1, j + 1, wt)
        if rational:
            return Geom_BSplineSurface(poles, w, uk, vk, um, vm, ns.u_degree, ns.v_degree, up, vp)
        return Geom_BSplineSurface(poles, uk, vk, um, vm, ns.u_degree, ns.v_degree, up, vp)

    # ---------------------------------------------------------------- surfaces
    def surface(self, i):
        if i in self.surfaces:
            return self.surfaces[i]
        s = self.node(i)
        t = s.name
        if t == 'PLANE':
            g = Geom_Plane(ax3(s.pvec, s.normal, s.x_axis))
        elif t == 'CYLINDER':
            g = Geom_CylindricalSurface(ax3(s.pvec, s.axis, s.x_axis), s.radius * S)
        elif t == 'CONE':
            # Parasolid: radius at pvec, cone widens along +axis by tan(half angle)
            ang = math.atan2(s.sin_half_angle, s.cos_half_angle)
            g = Geom_ConicalSurface(ax3(s.pvec, s.axis, s.x_axis), ang, s.radius * S)
        elif t == 'SPHERE':
            g = Geom_SphericalSurface(ax3(s.centre, s.axis, s.x_axis), s.radius * S)
        elif t == 'TORUS':
            if s.major_radius > 0:
                g = Geom_ToroidalSurface(ax3(s.centre, s.axis, s.x_axis), s.major_radius * S, s.minor_radius * S)
            else:
                # lemon torus (major radius <= 0): the same (u, v) form as a revolved circle; OpenCascade's
                # torus does not accept it
                z, x = D(s.axis), D(s.x_axis)
                c = P(s.centre)
                cc = gp_Pnt(c.X() + x.X() * s.major_radius * S, c.Y() + x.Y() * s.major_radius * S, c.Z() + x.Z() * s.major_radius * S)
                circle = Geom_Circle(gp_Ax2(cc, x.Crossed(z), x), s.minor_radius * S)
                g = Geom_SurfaceOfRevolution(circle, gp_Ax1(c, z))
        elif t == 'B_SURFACE':
            g = self.nurbs_surface(self.node(s.nurbs))
        elif t == 'OFFSET_SURF':
            g = Geom_OffsetSurface(self.surface(s.surface), s.offset * S)
        elif t == 'SPUN_SURF':
            g = Geom_SurfaceOfRevolution(self.curve(s.profile), gp_Ax1(P(s.base), D(s.axis)))
        elif t == 'SWEPT_SURF':
            g = Geom_SurfaceOfLinearExtrusion(self.curve(s.section), D(s.sweep))
        else:
            raise BrepError(f'surface type {t} not supported')
        self.surfaces[i] = g
        return g

    # ---------------------------------------------------------------- curves
    def curve(self, i):
        if i in self.curves:
            return self.curves[i]
        c = self.node(i)
        t = c.name
        if t == 'LINE':
            g = Geom_Line(P(c.pvec), D(c.direction))
        elif t == 'CIRCLE':
            g = Geom_Circle(ax2(c.centre, c.normal, c.x_axis), c.radius * S)
        elif t == 'ELLIPSE':
            if c.minor_radius > c.major_radius:
                raise BrepError('ellipse with minor radius above major radius')
            g = Geom_Ellipse(ax2(c.centre, c.normal, c.x_axis), c.major_radius * S, c.minor_radius * S)
        elif t == 'B_CURVE':
            g = self.nurbs_curve(self.node(c.nurbs))
        elif t == 'TRIMMED_CURVE':
            g = self.curve(c.basis_curve)
        elif t == 'INTERSECTION':
            g = self.intersection(c)
        elif t == 'SP_CURVE':
            g = self.sp_curve_3d(c)
        else:
            raise BrepError(f'curve type {t} not supported')
        self.curves[i] = g
        return g

    def uv_map(self, i):
        """Parasolid (u, v) on surface node i -> OpenCascade parameters of the mm-scaled surface."""
        s = self.node(i)
        t = s.name
        if t == 'PLANE':
            return lambda u, v: (u * S, v * S)
        if t == 'CYLINDER':
            return lambda u, v: (u, v * S)
        if t == 'CONE':
            k = S / s.cos_half_angle
            return lambda u, v: (u, v * k)
        if t == 'OFFSET_SURF':
            return self.uv_map(s.surface)
        if t == 'SWEPT_SURF':
            k = S if self.node(s.section).name == 'LINE' else 1.0
            return lambda u, v: (u * k, v * S)
        if t == 'SPUN_SURF':
            # Parasolid: u along the profile, v the angle; OpenCascade's surface of revolution has them the other
            # way round
            k = S if self.node(s.profile).name == 'LINE' else 1.0
            return lambda u, v: (v, u * k)
        return lambda u, v: (u, v)

    def sp_curve_3d(self, c):
        surf = self.surface(c.surface)
        c2 = self.nurbs_curve(self.node(self.node(c.b_curve).nurbs), dim3=False)
        m = self.uv_map(c.surface)
        for k in range(1, c2.NbPoles() + 1):
            p = c2.Pole(k)
            c2.SetPole(k, gp_Pnt2d(*m(p.X(), p.Y())))
        e = BRepBuilderAPI_MakeEdge(c2, surf).Edge()
        BRepLib.BuildCurves3d_s(e, 1e-7)
        crv = BRep_Tool.Curve_s(e, 0.0, 0.0)
        a, b = BRep_Tool.Range_s(e)
        if crv is None:
            raise BrepError('could not evaluate an SP_CURVE')
        return Geom_TrimmedCurve(crv, a, b)

    def intersection(self, c):
        """Intersection curve: the chart points lie on both surfaces; refine extra points onto both surfaces and
        fit a B-spline through them (Parasolid evaluates these procedurally)."""
        chart = self.node(c.chart)
        pts = [P(v) for v in chart.hvec]
        # the curve runs between its start and end limits, which may lie beyond the first / last chart point
        for lim, at in ((self.node(c.start), 0), (self.node(c.end), None)):
            if lim is None or not lim.hvec:
                continue
            q = P(lim.hvec[0])
            ref = pts[0] if at == 0 else pts[-1]
            if q.Distance(ref) > 1e-7:
                if at == 0:
                    pts.insert(0, q)
                else:
                    pts.append(q)
        from OCP.ShapeAnalysis import ShapeAnalysis_Surface
        # one projector per surface (it keeps its search grid; a fresh projection per point rebuilds it, which on
        # B-spline surfaces is most of the read time), each projection started from the previous one
        sas = [ShapeAnalysis_Surface(self.surface(c.surface[0])), ShapeAnalysis_Surface(self.surface(c.surface[1]))]
        last = [None, None]

        def onto(k, q):
            uv = sas[k].ValueOfUV(q, 1e-9) if last[k] is None else sas[k].NextValueOfUV(last[k], q, 1e-9, -1.0)
            last[k] = uv
            return sas[k].Value(uv)
        dense = [pts[0]]
        for a, b in zip(pts, pts[1:]):
            for k in range(1, 8):
                t = k / 8
                p = gp_Pnt(a.X() + (b.X() - a.X()) * t, a.Y() + (b.Y() - a.Y()) * t, a.Z() + (b.Z() - a.Z()) * t)
                for _ in range(30):
                    q = onto(1, onto(0, p))
                    if q.Distance(p) < 1e-9:
                        break
                    p = q
                dense.append(p)
            dense.append(b)
        arr = TColgp_Array1OfPnt(1, len(dense))
        for k, p in enumerate(dense, 1):
            arr.SetValue(k, p)
        fit = GeomAPI_PointsToBSpline(arr, 3, 8, GeomAbs_C2, 1e-6)
        if not fit.IsDone():
            raise BrepError('intersection curve fit failed')
        return fit.Curve()

    # ---------------------------------------------------------------- topology
    def vertex(self, i):
        if null(i):
            return None
        if i not in self.vertices:
            v = self.node(i)
            p = self.node(v.point).pvec
            tol = v.tolerance * S if v.tolerance > NULLD else 1e-5
            tv = TopoDS_Vertex()
            self.bb.MakeVertex(tv, P(p), max(tol, 1e-5))
            self.vertices[i] = tv
        return self.vertices[i]

    @staticmethod
    def _param(curve, pnt):
        """(parameter, distance) of the curve point nearest `pnt`; the ends of a bounded curve count too (the
        projection only reports interior extrema)."""
        best = None
        pr = GeomAPI_ProjectPointOnCurve(pnt, curve)
        if pr.NbPoints():
            best = (pr.LowerDistanceParameter(), pr.LowerDistance())
        if not curve.IsPeriodic():
            for t in (curve.FirstParameter(), curve.LastParameter()):
                if abs(t) < 1e100:
                    d = curve.Value(t).Distance(pnt)
                    if best is None or d < best[1]:
                        best = (t, d)
        if best is None:
            raise BrepError('vertex does not project onto its edge curve')
        return best

    def edge(self, i):
        if i in self.edges:
            return self.edges[i]
        e = self.node(i)
        fin = self.node(e.fin)
        if fin is None:
            raise BrepError(f'edge {i} has no fin')
        other = self.node(fin.other)
        # fin.vertex is the vertex a fin runs into; a '+' fin runs along the edge
        if fin.sense == ord('+'):
            ve, vs = fin.vertex, (other.vertex if other else None)
        else:
            vs, ve = fin.vertex, (other.vertex if other else None)
        if null(vs) and not null(ve):
            vs = ve
        if null(ve) and not null(vs):
            ve = vs
        tol = e.tolerance * S if e.tolerance > NULLD else 1e-5
        crv_i, against = e.curve, False
        if null(crv_i):
            # tolerant edge: the fins carry curves on their faces, running along the fin
            cand = [f for f in (fin, other) if f is not None and not null(f.curve)]
            if not cand:
                return self._chord_edge(i, e, vs, ve)
            cand.sort(key=lambda f: f.sense != ord('+'))
            crv_i, against = cand[0].curve, cand[0].sense != ord('+')
        cnode = self.node(crv_i)
        crv = self.curve(crv_i)
        if cnode.name == 'TRIMMED_CURVE' and self.node(cnode.basis_curve).sense == ord('-'):
            # a trimmed piece of a reversed curve runs against the basis's parameterisation
            against = not against
        if (cnode.sense == ord('-')) != against:
            crv = crv.Reversed()
        tvs, tve = self.vertex(vs), self.vertex(ve)
        first, last = crv.FirstParameter(), crv.LastParameter()
        if tvs is None:
            if not crv.IsClosed():
                raise BrepError(f'open edge {i} without vertices')
            a, b = first, last
            if i in self.ring_at and crv.IsPeriodic():
                a = self._param(crv, self.ring_at[i])[0]
                b = a + crv.Period()
        else:
            a, da = self._param(crv, BRep_Tool.Pnt_s(tvs))
            b, db = self._param(crv, BRep_Tool.Pnt_s(tve))
            limit = max(0.01, 2 * (tol + BRep_Tool.Tolerance_s(tvs) + BRep_Tool.Tolerance_s(tve)))
            if max(da, db) > limit:
                # the decoded curve misses its own vertices: a reading error, never something to paper over
                raise BrepError(f'edge {i}: {cnode.name.lower()} misses its vertex by {max(da, db):.3g} mm')
            tol = max(tol, da * 1.01, db * 1.01)
            for tv, dd in ((tvs, da), (tve, db)):
                if dd * 1.01 > BRep_Tool.Tolerance_s(tv):
                    self.bb.UpdateVertex(tv, dd * 1.01 + 1e-7)
            if crv.IsPeriodic():
                per = crv.Period()
                if vs == ve:
                    b = a + per
                else:
                    while b <= a:
                        b += per
                    while b - a > per:
                        b -= per
            elif vs == ve and crv.IsClosed():
                a, b = first, last
            elif b < a:
                # an open curve's ends fix the piece; only its direction disagrees with the edge (fin curves
                # trimmed against their basis) - run it the other way
                a, b = crv.ReversedParameter(a), crv.ReversedParameter(b)
                crv = crv.Reversed()
            if b <= a:
                raise BrepError(f'edge {i}: parameters out of order ({a:.6g} >= {b:.6g})')
        mk = BRepBuilderAPI_MakeEdge(crv, tvs, tve, a, b) if tvs is not None else BRepBuilderAPI_MakeEdge(crv, a, b)
        if not mk.IsDone():
            raise BrepError(f'edge {i} could not be built (error {mk.Error()})')
        te = mk.Edge()
        self.bb.UpdateEdge(te, max(tol, 1e-5))
        self.edges[i] = te
        return te

    def _chord_edge(self, i, e, vs, ve):
        """An edge with no curve anywhere: Parasolid leaves sliver edges (well below the modelling tolerance) without
        geometry. It is the straight segment between its vertices; anything longer is a reading error."""
        tvs, tve = self.vertex(vs), self.vertex(ve)
        if tvs is None or tve is None:
            raise BrepError(f'edge {i} has no curve')
        pa, pb = BRep_Tool.Pnt_s(tvs), BRep_Tool.Pnt_s(tve)
        d = pa.Distance(pb)
        if d > 0.01:
            raise BrepError(f'edge {i} has no curve ({d:.3g} mm long)')
        if d < 1e-9:
            raise BrepError(f'edge {i} has no curve and no length')
        mk = BRepBuilderAPI_MakeEdge(tvs, tve)
        if not mk.IsDone():
            raise BrepError(f'edge {i} has no curve')
        te = mk.Edge()
        self.bb.UpdateEdge(te, max(d, 1e-5))
        self.edges[i] = te
        return te

    def loop_fins(self, lp):
        """[(fin, edge)] of a loop in order; empty for a vertex loop (one fin, no edge: a cone apex, sphere pole)."""
        out = []
        f0 = self.node(lp.fin)
        f, guard = f0, 0
        while f is not None:
            if not null(f.edge):
                out.append((f, self.edge(f.edge)))
            f = self.node(f.forward)
            guard += 1
            if f is None or f.index == f0.index or guard > 100000:
                break
        return out

    def face(self, fn, flip):
        # each face its own surface object: OpenCascade keys an edge's pcurves by surface, so two faces sharing
        # one surface and an edge would read the edge as a seam
        used = self.__dict__.setdefault('_faced', set())
        if fn.surface in used:
            self.surfaces.pop(fn.surface, None)
        used.add(fn.surface)
        surf = self.surface(fn.surface)
        snode = self.node(fn.surface)
        reversed_ = (fn.sense == ord('-')) != (snode.sense == ord('-'))
        reversed_ = reversed_ != flip
        tf = TopoDS_Face()
        tol = max(fn.tolerance * S if fn.tolerance > NULLD else 1e-5, 1e-5)
        self.bb.MakeFace(tf, surf, tol)
        loops, poles = [], []
        lp = self.node(fn.loop)
        while lp is not None:
            fins = self.loop_fins(lp)
            if not fins:
                f0 = self.node(lp.fin)
                if f0 is not None and not null(f0.vertex):
                    poles.append(f0.vertex)
            if fins:
                loops.append(fins)
                w = TopoDS_Wire()
                self.bb.MakeWire(w)
                for f, te in fins:
                    self.bb.Add(w, te if f.sense == ord('+') else te.Reversed())
                self.bb.Add(tf, w.Reversed() if reversed_ else w)
            lp = self.node(lp.next)
        for v in poles:
            self._pole_wire(tf, surf, v, tol)
        if not loops:
            # a closed surface used whole (sphere, torus): its natural bounds
            from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
            mk = BRepBuilderAPI_MakeFace(surf, tol)
            if not mk.IsDone():
                raise BrepError(f'face {fn.index}: no boundary and the surface is not closed')
            tf = mk.Face()
        else:
            used = [f.edge for fins in loops for f, _ in fins]
            if surf.IsUPeriodic() or surf.IsVPeriodic():
                self._seam_pcurves(tf, surf, loops, reversed_, tol, len(used) != len(set(used)))
        if reversed_:
            tf.Orientation(TopAbs_REVERSED)
        return tf

    def _pole_wire(self, tf, surf, vi, tol):
        """A vertex loop (cone apex, sphere pole) as OpenCascade wants it: a degenerated edge along the u-line of
        the pole; ShapeFix then adds the seam that joins it to the rest of the boundary."""
        from OCP.Geom2d import Geom2d_Line
        from OCP.gp import gp_Dir2d
        from OCP.TopoDS import TopoDS_Edge
        from OCP.TopAbs import TopAbs_FORWARD
        if not surf.IsUPeriodic():
            return
        tv = self.vertex(vi)
        pr = GeomAPI_ProjectPointOnSurf(BRep_Tool.Pnt_s(tv), surf)
        if not pr.NbPoints():
            return
        _u, v = pr.LowerDistanceParameters()
        e = TopoDS_Edge()
        self.bb.MakeEdge(e)
        self.bb.Degenerated(e, True)
        self.bb.Add(e, tv.Oriented(TopAbs_FORWARD))
        self.bb.Add(e, tv.Reversed())
        self.bb.UpdateEdge(e, Geom2d_Line(gp_Pnt2d(0.0, v), gp_Dir2d(1.0, 0.0)), tf, tol)
        self.bb.Range(e, tf, 0.0, surf.UPeriod())
        w = TopoDS_Wire()
        self.bb.MakeWire(w)
        self.bb.Add(w, e)
        self.bb.Add(tf, w)

    def _anchor_rings(self, surf, info, pu):
        """A face winding round a u-periodic surface needs a seam, which ShapeFix runs from a vertex of one winding
        loop to the other. A ring edge (a whole circle) has no vertex in Parasolid, so where its OpenCascade vertex
        sits is free: put it at the u of a vertex of the other winding loop (or anywhere when both are rings), as far
        as possible from the face's other loops, which the seam must not touch."""
        def span(used):
            us = []
            for _f, te, pc, _s in used:
                a, b = BRep_Tool.Range_s(te)
                us += [pc.Value(a + (b - a) * k / 8).X() for k in range(9)]
            return min(us), max(us)
        wind, rest = [], []
        for used in info:
            lo, hi = span(used)
            (wind if hi - lo > pu * 0.999 else rest).append(used)
        rings = [u for u in wind if len(u) == 1 and BRep_Tool.IsClosed_s(u[0][1]) and null(u[0][0].vertex)
                 and u[0][0].edge not in self.ring_at]
        if len(wind) < 2 or not rings:
            return
        others = [u for u in wind if not any(u is r for r in rings)]
        cands = [x[3].X() for u in others for x in u] or [pu * k / 16 for k in range(16)]
        blocked = [span(u) for u in rest]

        def clearance(u0):
            best = pu
            for lo, hi in blocked:
                for k in (-1, 0, 1):
                    l, h = lo + k * pu, hi + k * pu
                    best = min(best, 0.0 if l <= u0 <= h else min(abs(u0 - l), abs(u0 - h)))
            return best
        u0 = max(cands, key=clearance)
        for r in rings:
            f, te, pc, start = r[0]
            self.ring_at[f.edge] = surf.Value(u0, start.Y())

    @staticmethod
    def _uv_samples(c3, a, b, n, sas, pu, pv):
        uv, prev = [], None
        for i in range(n):
            t = a + (b - a) * i / (n - 1)
            p = c3.Value(t)
            q = sas.ValueOfUV(p, 1e-7) if prev is None else sas.NextValueOfUV(prev, p, 1e-7, -1.0)
            u, v = q.X(), q.Y()
            if prev is not None:
                if pu:
                    u += round((prev.X() - u) / pu) * pu
                if pv:
                    v += round((prev.Y() - v) / pv) * pv
            prev = gp_Pnt2d(u, v)
            uv.append((t, prev))
        return uv

    @staticmethod
    def _pcurve(te, surf, pu, pv):
        """(pcurve, a, b) of an edge on a periodic surface, continuous in (u, v): points along the 3D curve, each
        projected next to the one before and unwrapped by whole periods, interpolated at the edge's own parameters
        (a projection of the whole curve can put an end lying on the seam a period away from the rest)."""
        from OCP.ShapeAnalysis import ShapeAnalysis_Surface
        from OCP.Geom2dAPI import Geom2dAPI_Interpolate
        from OCP.collections import HArray1_gp_Pnt2d as TColgp_HArray1OfPnt2d, HArray1_double as TColStd_HArray1OfReal
        c3 = BRep_Tool.Curve_s(te, 0.0, 0.0)
        a, b = BRep_Tool.Range_s(te)
        if c3 is None or b <= a:
            return None, a, b
        n = 33 if c3.DynamicType().Name() in ('Geom_Line', 'Geom_Circle', 'Geom_Ellipse') else 65
        sas = ShapeAnalysis_Surface(surf)
        uv = Builder._uv_samples(c3, a, b, n, sas, pu, pv)
        # a curve winding round the surface (a thread's helix makes many turns) needs ~32 samples a turn
        travel = sum(abs(q.X() - p.X()) for (_, p), (_, q) in zip(uv, uv[1:])) if pu else 0.0
        if pu and 32 * travel / pu > n:
            uv = Builder._uv_samples(c3, a, b, min(4001, int(32 * travel / pu) + 2), sas, pu, pv)
        n = len(uv)
        (t0, p0), (t1, p1) = uv[0], uv[-1]
        d = p0.Distance(p1)
        if d > 1e-12 and all(abs((p.X() - p0.X()) * (p1.Y() - p0.Y()) - (p.Y() - p0.Y()) * (p1.X() - p0.X())) / d < 1e-9
                             and abs(p0.Distance(p) / d - (t - t0) / (t1 - t0)) < 1e-6 for t, p in uv):
            # a straight pcurve traced at constant speed (lines and circles on cylinders, cones, planes)
            # degree-1 B-spline from (t0, p0) to (t1, p1): exact, parameterised like the edge
            from OCP.Geom2d import Geom2d_BSplineCurve
            poles = TColgp_Array1OfPnt2d(1, 2)
            poles.SetValue(1, p0)
            poles.SetValue(2, p1)
            knots = TColStd_Array1OfReal(1, 2)
            knots.SetValue(1, t0)
            knots.SetValue(2, t1)
            mults = TColStd_Array1OfInteger(1, 2)
            mults.SetValue(1, 2)
            mults.SetValue(2, 2)
            return Geom2d_BSplineCurve(poles, knots, mults, 1), a, b
        pts = TColgp_HArray1OfPnt2d(1, n)
        prm = TColStd_HArray1OfReal(1, n)
        for i, (t, p) in enumerate(uv, 1):
            pts.SetValue(i, p)
            prm.SetValue(i, t)
        try:
            it = Geom2dAPI_Interpolate(pts, prm, False, 1e-9)
            it.Perform()
        except Exception:  # coincident (u, v) samples: an edge through a pole; ShapeFix projects it instead
            return None, a, b
        return (it.Curve() if it.IsDone() else None), a, b

    def _seam_pcurves(self, tf, surf, loops, reversed_, tol, twice):
        """Pcurves for a face on a periodic surface (Parasolid needs no seam; OpenCascade wants an edge used twice to
        have two pcurves one period apart, a loop winding round the surface continuous so ShapeFix can add the
        missing seam, and every loop on the same side of the seam): each edge projected continuously, shifted by
        whole periods so each loop is continuous in (u, v), each further loop shifted next to the first."""
        from OCP.gp import gp_Vec2d
        pu = surf.UPeriod() if surf.IsUPeriodic() else 0.0
        pv = surf.VPeriod() if surf.IsVPeriodic() else 0.0
        per_edge, ref, info = {}, None, []
        for fins in loops:
            prev, used = None, []
            for f, te in fins:
                pc, a, b = self._pcurve(te, surf, pu, pv)
                if pc is None:
                    return
                start, end = (pc.Value(a), pc.Value(b)) if f.sense == ord('+') else (pc.Value(b), pc.Value(a))
                if prev is not None:
                    ku = round((prev.X() - start.X()) / pu) if pu else 0
                    kv = round((prev.Y() - start.Y()) / pv) if pv else 0
                    if ku or kv:
                        pc.Translate(gp_Vec2d(ku * pu, kv * pv))
                        start = gp_Pnt2d(start.X() + ku * pu, start.Y() + kv * pv)
                        end = gp_Pnt2d(end.X() + ku * pu, end.Y() + kv * pv)
                prev = end
                used.append((f, te, pc, start))
            import os
            if os.environ.get('SWDEBUG') and used and prev.Distance(used[0][3]) > 1e-6:
                print('LOOP open in 2d', [(f.edge, BRep_Tool.Curve_s(te, 0.0, 0.0).DynamicType().Name()[5:], chr(f.sense), BRep_Tool.Range_s(te), (round(st.X(), 3), round(st.Y(), 3))) for f, te, pc, st in used], (round(prev.X(), 3), round(prev.Y(), 3)))
            mid = (sum(x[3].X() for x in used) / len(used), sum(x[3].Y() for x in used) / len(used))
            if ref is None:
                ref = mid
            else:
                ku = round((ref[0] - mid[0]) / pu) if pu else 0
                kv = round((ref[1] - mid[1]) / pv) if pv else 0
                if ku or kv:
                    for x in used:
                        x[2].Translate(gp_Vec2d(ku * pu, kv * pv))
            for f, te, pc, _ in used:
                occ_forward = (f.sense == ord('+')) != reversed_
                per_edge.setdefault(f.edge, []).append((occ_forward, pc, te))
            info.append(used)
        if pu:
            self._anchor_rings(surf, info, pu)
        for uses in per_edge.values():
            te = uses[0][2]
            if len(uses) == 2:
                c1 = next((pc for fw, pc, _ in uses if fw), uses[0][1])
                c2 = next((pc for fw, pc, _ in uses if not fw), uses[1][1])
                self.bb.UpdateEdge(te, c1, c2, tf, tol)
            else:
                self.bb.UpdateEdge(te, uses[0][1], tf, tol)

    def body(self, b):
        """TopoDS_Solid for a BODY node (solid regions only). Built twice when a face asked for a ring edge's
        vertex to move (_anchor_rings): every face using the edge must see the same one."""
        n0 = len(self.ring_at)
        solid = self._body(b)
        if len(self.ring_at) > n0:
            self.surfaces, self.curves, self.vertices, self.edges, self._faced = {}, {}, {}, {}, set()
            solid = self._body(b)
        return solid

    def _body(self, b):
        faces_of = {}
        for x in self.n.values():
            if x.name == 'FACE':
                faces_of.setdefault(x.shell, []).append((x, False))
                if not null(x.front_shell) and x.front_shell != x.shell:
                    faces_of.setdefault(x.front_shell, []).append((x, True))
        solid = TopoDS_Solid()
        self.bb.MakeSolid(solid)
        regions = [x for x in self.n.values() if x.name == 'REGION' and x.body == b.index]
        nshell = 0
        for r in regions:
            if r.f['type'] != ord('S'):
                continue
            sh = self.node(r.shell)
            while sh is not None:
                ts = TopoDS_Shell()
                self.bb.MakeShell(ts)
                for fn, flip in faces_of.get(sh.index, []):
                    self.bb.Add(ts, self.face(fn, flip))
                self.bb.Add(solid, ts)
                nshell += 1
                sh = self.node(sh.next)
        if not nshell:
            raise BrepError('body has no solid region shells')
        return solid

    def solid_bodies(self):
        return [x for x in self.n.values() if x.name == 'BODY' and x.f.get('body_type') == 1]

    def sheet_bodies(self):
        """Sheet (surface) bodies: body_type 3, every region void. Imported vendor models often arrive this way."""
        return [x for x in self.n.values() if x.name == 'BODY' and x.f.get('body_type') == 3]

    def sheet(self, b):
        """A shell of all the faces of a sheet body."""
        shells = {x.shell for x in self.n.values() if x.name == 'REGION' and x.body == b.index}
        ts = TopoDS_Shell()
        self.bb.MakeShell(ts)
        n = 0
        for x in self.n.values():
            if x.name == 'FACE' and x.shell in shells:
                self.bb.Add(ts, self.face(x, False))
                n += 1
        shell_ids = set()
        for r in (x for x in self.n.values() if x.name == 'REGION' and x.body == b.index):
            sh = self.node(r.shell)
            while sh is not None:
                shell_ids.add(sh.index)
                sh = self.node(sh.next)
        if not n:
            for x in self.n.values():
                if x.name == 'FACE' and (x.shell in shell_ids or x.front_shell in shell_ids):
                    self.bb.Add(ts, self.face(x, False))
                    n += 1
        if not n:
            raise BrepError(f'sheet body {b.index} has no faces')
        return ts


def fix(shape):
    """Pcurves, tolerances and orientation for a solid assembled from the topology."""
    sf = ShapeFix_Shape(shape)
    sf.SetPrecision(1e-6)
    sf.SetMaxTolerance(0.05)
    sf.Perform()
    return sf.Shape()


def volume(shape):
    """Enclosed volume, mm3; 0 for a shape with no solid (an open surface body encloses nothing)."""
    if not TopExp_Explorer(shape, TopAbs_SOLID).More():
        return 0.0
    # adaptive integration: the fixed Gauss scheme misjudges long thin face domains (a thread's helical strips
    # winding many turns) by percent
    g = GProp_GProps()
    try:
        BRepGProp.VolumeProperties_s(shape, g, 1e-3, False)
    except Exception:
        g = GProp_GProps()
        BRepGProp.VolumeProperties_s(shape, g)
    return g.Mass()


def check(shape, strict=True):
    """(ok, detail): a valid, closed solid of positive volume. strict=False lets through a closed solid that
    BRepCheck faults on a few faces (a wire touching itself within tolerance, a sliver face's orientation): the
    geometry is all there and meshes, so it is used, and the detail names what was faulted."""
    if shape is None or shape.IsNull():
        return False, 'empty'
    an = BRepCheck_Analyzer(shape)
    faulted, bad = 0, not an.IsValid()
    if bad:
        if strict:
            return False, 'not a valid solid'
        ex = TopExp_Explorer(shape, TopAbs_FACE)
        while ex.More():
            faulted += not an.IsValid(ex.Current())
            ex.Next()
    ex = TopExp_Explorer(shape, TopAbs_SHELL)
    while ex.More():
        if not BRep_Tool.IsClosed_s(TopoDS.Shell(ex.Current())):
            return False, 'open shell'
        ex.Next()
    v = volume(shape)
    if v <= 0:
        return False, f'volume {v:.3g}'
    if bad:
        what = f'{faulted} face{"s" if faulted > 1 else ""}' if faulted else 'the solid'
        return True, f'volume {v:.1f} mm3, closed; {what} faulted by the validity check'
    return True, f'volume {v:.1f} mm3'


def sewn(solid, tol=1e-3):
    """Fallback: sew the faces of a solid whose shells did not close as built."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid
    from OCP.TopAbs import TopAbs_FACE
    sw = BRepBuilderAPI_Sewing(tol)
    ex = TopExp_Explorer(solid, TopAbs_FACE)
    while ex.More():
        sw.Add(ex.Current())
        ex.Next()
    sw.Perform()
    sh = sw.SewedShape()
    ms = BRepBuilderAPI_MakeSolid()
    ex = TopExp_Explorer(sh, TopAbs_SHELL)
    while ex.More():
        ms.Add(TopoDS.Shell(ex.Current()))
        ex.Next()
    return fix(ms.Solid()) if ms.IsDone() else None


def build_bodies(nodes, sheets=False):
    """One record per body in a Parasolid stream: {'body', 'kind', 'shape', 'detail', 'error'}. A body that cannot
    be built carries its error instead of a shape (the caller decides whether it matters: hidden bodies do not).
    Solid bodies always; sheet bodies too with sheets=True (made solid when their faces close up)."""
    b = Builder(nodes)
    out = []
    for body in b.solid_bodies():
        rec = {'body': body, 'kind': 'solid', 'shape': None, 'detail': '', 'error': ''}
        try:
            raw = b.body(body)
            shape = fix(raw)
            ok, detail = check(shape)
            if not ok:
                alt = sewn(raw)
                ok2, detail2 = check(alt)
                if ok2:
                    shape, detail = alt, detail2 + ', faces sewn'
                else:
                    ok3, detail3 = check(shape, strict=False)
                    if not ok3:
                        raise BrepError(f'body {body.index}: {detail} after assembly, {detail2} after sewing')
                    detail = detail3
            if volume(shape) < 0:
                shape.Reverse()
            rec.update(shape=shape, detail=detail)
        except BrepError as e:
            rec['error'] = str(e)
        except Exception as e:  # OpenCascade refusing a construction
            rec['error'] = f'body {body.index}: {type(e).__name__} {e}'.strip()
        out.append(rec)
    if sheets:
        for body in b.sheet_bodies():
            rec = {'body': body, 'kind': 'sheet', 'shape': None, 'detail': '', 'error': ''}
            try:
                raw = b.sheet(body)
                solid = sewn(raw)
                ok, detail = check(solid)
                if ok:
                    if volume(solid) < 0:
                        solid.Reverse()
                    rec.update(shape=solid, detail=detail + ', closed surface body made solid')
                else:
                    rec.update(shape=fix(raw), detail='surface body (open, not a solid)')
            except Exception as e:
                rec['error'] = f'sheet body {body.index}: {type(e).__name__} {e}'.strip()
            out.append(rec)
    return out


def build(nodes, sheets=False):
    """[(shape, detail)] for every body in a stream; BrepError on the first that cannot be built."""
    out = []
    for r in build_bodies(nodes, sheets):
        if r['error']:
            raise BrepError(r['error'])
        out.append((r['shape'], r['detail']))
    return out
