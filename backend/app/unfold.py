"""Conservative developable sheet unfolding; refuse unsupported/double-curved topology."""
import math
import numpy as np
from shapely.geometry import Polygon
from shapely import union_all
from OCP.TopAbs import TopAbs_EDGE,TopAbs_WIRE
from OCP.TopoDS import TopoDS
from .cad import face_features,explore,wire_points,props

def unfold(s,g,k=.4):
 try:return _unfold(s,g,k)
 except ValueError as e:
  try:return unfold_profile(s,g,k)
  except ValueError:raise e

def _unfold(s,g,k=.4):
 faces,planes,cyl,_=face_features(s);by_index={p['index']:p for p in planes};th=g['thickness']
 if not planes or th<=0:raise ValueError('Constant thickness could not be established')
 root=max(planes,key=lambda p:p['area']);n=root['normal'];x=root['x'];y=root['y'];R=np.vstack([x,y,n]);origin=root['origin'];maps={root['index']:(R,-R@origin)}
 from .cad import sample_edge as _se
 # Skin graph: planes and bend (cylinder) faces. A bend face touches the planes it is tangent to (their normal is
 # radial at the shared edge; cut faces of a neighbouring flange can also touch it in closed corners) and, in a
 # rolled profile, the next bend face of the same skin (R48 -> R618 -> R48 tangent arcs).
 bend_of={ci:b for b in g['bends'] for ci in b['faces']}
 plane_n={};bend_n={}
 for ci,b in bend_of.items():
  bendface=faces[ci];edge_list=list(explore(bendface,TopAbs_EDGE))
  ax_=np.array(b['axis'],float);ax_/=np.linalg.norm(ax_);c_=np.array(b['center'],float)
  nb=[]
  for pi,p in by_index.items():
   if abs(np.dot(p['normal'],ax_))>.001:continue
   for e in explore(p['face'],TopAbs_EDGE):
    if any(e.IsSame(other) for other in edge_list):
     pts=_se(e);m=pts.mean(axis=0);rad=(m-c_)-ax_*np.dot(m-c_,ax_);rn=np.linalg.norm(rad)
     if rn<1e-9 or abs(np.dot(p['normal'],rad/rn))<.99:break
     nb.append((pi,e,float(np.linalg.norm(pts[-1]-pts[0]))));break
  plane_n[ci]=[(pi,e) for pi,e,_ in sorted(nb,key=lambda t:-t[2])[:2]]
  bb=[]
  for cj,b2 in bend_of.items():
   if cj==ci or b2 is b:continue
   for e in explore(faces[cj],TopAbs_EDGE):
    if any(e.IsSame(other) for other in edge_list):
     pts=_se(e);d=pts[-1]-pts[0];L=float(np.linalg.norm(d))
     if L>1e-6 and abs(np.dot(d/L,ax_))>.999:bb.append((cj,L));break
  bend_n[ci]=[cj for cj,_ in sorted(bb,key=lambda t:-t[1])[:2]]
 links={};bend_lookup={}
 for ci in bend_of:
  for pa,pe in plane_n[ci]:
   # walk through tangent bend faces until another plane is reached: plane - bend(s) - plane
   chain=[ci];cur=ci
   while True:
    ends=[(pi,e) for pi,e in plane_n[cur] if pi!=pa or cur!=ci]
    if cur!=ci and ends:
     for pc,ce in ends:
      key=(pa,pc,tuple(bend_of[c]['id'] for c in chain))
      if key not in bend_lookup:
       bs=[bend_of[c] for c in chain];bend_lookup[key]=bs
       links.setdefault(pa,[]).append((pc,bs,pe,ce))
     break
    if cur==ci and len(plane_n[ci])==2 and not bend_n[ci]:
     pc,ce=[t for t in plane_n[ci] if t[0]!=pa][0] if any(t[0]!=pa for t in plane_n[ci]) else (None,None)
     if pc is not None:
      key=(pa,pc,(bend_of[ci]['id'],))
      if key not in bend_lookup:bend_lookup[key]=[bend_of[ci]];links.setdefault(pa,[]).append((pc,[bend_of[ci]],pe,ce))
     break
    nxt=[c for c in bend_n[cur] if c not in chain]
    if not nxt or len(chain)>12:
     if cur==ci:
      for pc,ce in plane_n[ci]:
       if pc!=pa:
        key=(pa,pc,(bend_of[ci]['id'],))
        if key not in bend_lookup:bend_lookup[key]=[bend_of[ci]];links.setdefault(pa,[]).append((pc,[bend_of[ci]],pe,ce))
     break
    chain.append(nxt[0]);cur=nxt[0]
 if g['bends'] and root['index'] not in links:raise ValueError('Could not connect the largest planar skin to the bend graph')
 rectangles=[];bend_lines=[];queue=[root['index']];used=set();done_pairs={}
 from .cad import sample_edge
 while queue:
  pi=queue.pop(0);Rp,tp=maps[pi];parent=by_index[pi]
  for ci,bs,pe,ce in links.get(pi,[]):
   ids=[b['id'] for b in bs]
   if all(i in used for i in ids):continue
   b=bs[0]
   if ci in maps:
    # a second bend between the same two flanges on the same line (the bend split by a relief / cut-out):
    # already developed with its twin; only its bend line and allowance strip are added
    if len(bs)!=1:continue
    twin=next((t for t in done_pairs.get((pi,ci),[]) if np.linalg.norm(np.cross(np.array(t['axis'],float),np.array(b['axis'],float)))<1e-3
               and np.linalg.norm(np.cross(np.array(b['center'],float)-np.array(t['center'],float),np.array(t['axis'],float)/np.linalg.norm(t['axis'])))<.05
               and abs(t['angle']-b['angle'])<.1 and abs(t['radius']-b['radius'])<.01),None)
    closure=twin is None   # a loop in the skin graph (a blank with a window: both strips bend on the same lines)
   else:closure=False
   pp=sample_edge(pe);cp=sample_edge(ce);p=pp.mean(axis=0);q=cp.mean(axis=0);axis=np.array(b['axis'],float);axis/=np.linalg.norm(axis)
   # bending keeps the position along the axis: match the child edge to the parent edge at the same axial station
   # (tangent edges of different length / offset, e.g. a flange longer than its bend, must not shift the flange)
   q=q+axis*np.dot(axis,p-q)
   outward=p-parent['center'];outward-=axis*np.dot(axis,outward)
   inside=by_index[ci]['center']-q;inside-=axis*np.dot(axis,inside)
   if np.linalg.norm(outward)<1e-6 or np.linalg.norm(inside)<1e-6:raise ValueError('Ambiguous flange orientation')
   outward/=np.linalg.norm(outward);inside/=np.linalg.norm(inside)
   target_t=Rp@axis;target_o=Rp@outward
   basis_source=np.column_stack([axis,inside,np.cross(axis,inside)]);basis_target=np.column_stack([target_t,target_o,np.cross(target_t,target_o)])
   Rc=basis_target@basis_source.T
   # developed length of the bend (or of a rolled chain of tangent arcs): sum of the neutral-fibre arcs
   allow=[math.radians(x['angle'])*(x['radius']+k*th) for x in bs];ba=sum(allow)
   if ci not in maps:
    target_q=Rp@p+tp+target_o*ba;tc=target_q-Rc@q;maps[ci]=(Rc,tc);queue.append(ci)
   elif closure:
    # the loop closes only if this bend develops the flange exactly where the other path already put it
    target_q=Rp@p+tp+target_o*ba;tc=target_q-Rc@q;Rm,tm=maps[ci]
    if np.abs(Rc-Rm).max()>1e-4 or np.linalg.norm(tc-tm)>max(.05,.02*th):continue
   for x in bs:done_pairs.setdefault((pi,ci),[]).append(x);done_pairs.setdefault((ci,pi),[]).append(x)
   a=Rp@pp[0]+tp;z=Rp@pp[-1]+tp
   # Bend direction as seen from the developed view: UP when the flange folds toward the viewer
   # (the root skin's outward normal), DOWN when it folds away. Sign of the bend axis offset from the
   # parent skin, corrected for parents whose outward normal maps to -Z in the flat.
   side=np.dot(Rp@parent['normal'],[0,0,1])*np.dot(np.array(b['center'])-parent['origin'],parent['normal'])
   # For right-angle bends, measure the adjoining planar face from the OUTER
   # parent plane. The selected development skin can be either inside or outside.
   outside_height=None
   if len(bs)==1 and abs(b['angle']-90)<.01:
    from OCP.BRepTools import BRepTools
    child_points=wire_points(BRepTools.OuterWire_s(by_index[ci]['face']))
    nparent=parent['normal'];center=np.array(b['center'])
    tangent_radius=abs(float(np.dot(p-center,nparent)))
    if min(abs(tangent_radius-b['radius']),abs(tangent_radius-b['radius']-th))<.02:
     correction=max(0,b['radius']+th-tangent_radius)
     outside_height=float(np.max(np.abs((child_points-p)@nparent))+correction)
   rectangles.append(Polygon([a[:2],z[:2],(z+target_o*ba)[:2],(a+target_o*ba)[:2]]))
   off=0.0
   for x,al in zip(bs,allow):
    mid=off+al/2;off+=al
    bend_lines.append({'id':x['id'],'a':(a+target_o*mid)[:2].tolist(),'b':(z+target_o*mid)[:2].tolist(),'allowance':al,'angle':x['angle'],'radius':x['radius'],
                       'length':float(np.linalg.norm(z-a)),'direction':'up' if side>0 else 'down','outside_height':outside_height if len(bs)==1 else None,
                       **({'rolled':True} if len(bs)>1 else {})})
    used.add(x['id'])
 if len(used)!=len(g['bends']):
  raise ValueError('Not all bends belong to a single developable skin; manual unfolding required')
 polys=[]
 from OCP.BRepTools import BRepTools
 for pi,(r,t) in maps.items():
  f=by_index[pi]['face'];outer=BRepTools.OuterWire_s(f);rings=[];shell=None
  for w in explore(f,TopAbs_WIRE):
   pts=wire_points(TopoDS.Wire(w));coords=(pts@r.T+t)[:,:2]
   if len(coords)<3:continue
   if w.IsSame(outer):shell=coords
   else:rings.append(coords)
  if shell is not None:
   poly=Polygon(shell,rings)
   if not poly.is_valid:raise ValueError('Projected flange contour is invalid')
   polys.append(poly)
 if not polys:raise ValueError('No developable faces')
 if not g['bends']:
  # Require an extruded constant-thickness plate, not an arbitrary solid's largest face.
  predicted=polys[0].area*th
  if abs(predicted-g['volume'])/max(g['volume'],1)>.04:raise ValueError('Flat projection does not match constant-thickness volume')
 else:
  projected_area=sum(p.area for p in polys)
  approx_skin_area=(g['area']-sum(2*math.radians(b['angle'])*(b['radius']+th/2)*b['length'] for b in g['bends']))/2
  if projected_area<approx_skin_area*.60:raise ValueError('Unfold coverage incomplete')
 # Snap only sub-micron round-off at shared flange/bend edges.
 merged=union_all(polys+rectangles,grid_size=0.00001)
 if merged.geom_type!='Polygon' or not merged.is_valid:raise ValueError('Unfold produced disconnected or invalid outline')
 summed=sum(p.area for p in polys+rectangles)
 if summed-merged.area>max(1,summed*.003):raise ValueError('Unfolded flanges overlap')
 # 3D -> flat transform of every developed skin plane (hardware hole resizing maps hole centres with it)
 unfold.maps=[(np.array(by_index[pi]['origin'],float),np.array(by_index[pi]['normal'],float),r,t) for pi,(r,t) in maps.items()]
 return merged,bend_lines


def bend_groups(lines, tol=.05):
    """Bend lines the press brake makes in one stroke: on the same straight line in the flat, same angle, inner
    radius and direction (a bend interrupted by reliefs, notches or cut-outs). Returns lists of indices into
    `lines`, in order of first appearance; a single bend is a group of one."""
    groups = []
    for i, b in enumerate(lines):
        a, z = np.asarray(b['a'], float), np.asarray(b['b'], float)
        d = z - a
        L = float(np.linalg.norm(d))
        u = d / max(L, 1e-12)
        placed = False
        for g in groups:
            r = lines[g[0]]
            ra, rz = np.asarray(r['a'], float), np.asarray(r['b'], float)
            rd = rz - ra
            ru = rd / max(float(np.linalg.norm(rd)), 1e-12)
            if abs(u[0] * ru[1] - u[1] * ru[0]) > 1e-4:
                continue                                   # not parallel
            off = a - ra
            if abs(off[0] * ru[1] - off[1] * ru[0]) > tol:
                continue                                   # parallel but a different line
            if abs(b['angle'] - r['angle']) > .1 or abs(b['radius'] - r['radius']) > .01 or b.get('direction') != r.get('direction'):
                continue
            g.append(i)
            placed = True
            break
        if not placed:
            groups.append([i])
    return groups


def unfold_profile(s, g, k=.4):
    """Development of a rolled / formed profile without a planar root skin (a curved band or ring segment, e.g.
    R632 - R47 - R632 tangent arcs): every skin face is a cylinder or a plane parallel to one axis A, so the part is
    a constant cross-section profile (with cut-outs) swept along A. The neutral profile is walked from one free end;
    a skin point maps to (arc length along the neutral fibre, position along A). Refuses anything else (double
    curvature, closed rings without a seam, branched profiles)."""
    from OCP.BRepTools import BRepTools
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from .cad import xyz
    th = float(g.get('thickness') or 0)
    if th <= 0:
        raise ValueError('Constant thickness could not be established')
    faces, planes, cyl, cones = face_features(s)
    if cones or len(planes) + len(cyl) < len(faces):
        raise ValueError('Profile development needs plane and cylinder faces only')
    big = [c for c in cyl if c['radius'] > 2 * th]
    if not big:
        raise ValueError('No rolled faces')
    A = np.array(max(big, key=lambda c: c['radius'] * c['angle'])['axis'], float)
    A /= np.linalg.norm(A)
    E1 = np.cross(A, [1, 0, 0] if abs(A[0]) < .9 else [0, 1, 0])
    E1 /= np.linalg.norm(E1)
    E2 = np.cross(A, E1)
    q2 = lambda p: np.array([np.dot(p, E1), np.dot(p, E2)])

    def cyl_frame(c):
        cy = BRepAdaptor_Surface(faces[c['index']], True).Cylinder()
        pos = cy.Position()
        X, Y, L = xyz(pos.XDirection()), xyz(pos.YDirection()), xyz(pos.Location())
        u0, u1, v0, v1 = BRepTools.UVBounds_s(faces[c['index']])
        return {'C': q2(L), 'X': q2(X), 'Y': q2(Y), 'X3': X, 'Y3': Y, 'L3': L, 'u0': u0, 'u1': u1, 'r': cy.Radius()}

    # skin arcs: concentric cylinder pairs one thickness apart with the same angular range
    arcs, used = [], set()
    skin = [c for c in cyl if abs(abs(np.dot(c['axis'], A)) - 1) < 1e-4]
    frames = {c['index']: cyl_frame(c) for c in skin}
    for c in skin:
        if c['index'] in used:
            continue
        fa = frames[c['index']]
        for d in skin:
            if d['index'] == c['index'] or d['index'] in used:
                continue
            fb = frames[d['index']]
            if np.linalg.norm(fa['C'] - fb['C']) > .02 or abs(abs(fa['r'] - fb['r']) - th) > .05:
                continue
            # same angular range (compare the end points' directions)
            ea = [fa['X'] * math.cos(u) + fa['Y'] * math.sin(u) for u in (fa['u0'], fa['u1'])]
            eb = [fb['X'] * math.cos(u) + fb['Y'] * math.sin(u) for u in (fb['u0'], fb['u1'])]
            if not (min(np.linalg.norm(ea[0] - eb[0]), np.linalg.norm(ea[0] - eb[1])) < 2e-3 and min(np.linalg.norm(ea[1] - eb[0]), np.linalg.norm(ea[1] - eb[1])) < 2e-3):
                continue
            inner, outer = (c, d) if fa['r'] < fb['r'] else (d, c)
            fi = frames[inner['index']]
            rm = fi['r'] + th / 2
            ends = [fi['C'] + rm * (fi['X'] * math.cos(u) + fi['Y'] * math.sin(u)) for u in (fi['u0'], fi['u1'])]
            arcs.append({'kind': 'arc', 'face': inner['index'], 'faces': [inner['index'], outer['index']], 'f': fi, 'ends': ends,
                         'length': (fi['u1'] - fi['u0']) * (fi['r'] + k * th), 'angle': math.degrees(fi['u1'] - fi['u0']), 'radius': fi['r']})
            used |= {c['index'], d['index']}
            break
    if any(c['index'] not in used and c['radius'] > 2 * th for c in skin):
        raise ValueError('Unpaired curved face: not a constant-thickness rolled profile')
    # skin walls: parallel plane pairs (normal across A) one thickness apart
    walls, pused = [], set()
    side = [p for p in planes if abs(np.dot(p['normal'], A)) < 1e-4]
    for p in side:
        if p['index'] in pused:
            continue
        for q in side:
            if q['index'] == p['index'] or q['index'] in pused or abs(abs(np.dot(p['normal'], q['normal'])) - 1) > 1e-5:
                continue
            if abs(abs(np.dot(q['origin'] - p['origin'], p['normal'])) - th) > .05:
                continue
            D = np.cross(p['normal'], A)
            pts = np.vstack([sample_edge(e) for e in explore(p['face'], TopAbs_EDGE)])
            tq = pts @ D
            if np.ptp(tq) < th * 1.5:
                continue   # an end face of the band, not a wall
            nm = p['normal'] * (np.dot(q['origin'] - p['origin'], p['normal']) / 2)
            mid = lambda x: q2(pts[0] + D * (x - pts[0] @ D) + nm - p['normal'] * np.dot(pts[0] - p['origin'], p['normal']))
            walls.append({'kind': 'wall', 'face': p['index'], 'faces': [p['index'], q['index']], 'D': D, 'ends': [mid(tq.min()), mid(tq.max())], 'length': float(np.ptp(tq))})
            pused |= {p['index'], q['index']}
            break
    prims = arcs + walls
    # chain the primitives end to end (tangent joints share the mid-surface end point)
    tol = max(.05, .05 * th)
    links = {}
    for i, a in enumerate(prims):
        for ea in (0, 1):
            for j, b in enumerate(prims):
                if j != i:
                    for eb in (0, 1):
                        if np.linalg.norm(a['ends'][ea] - b['ends'][eb]) < tol:
                            links.setdefault((i, ea), []).append((j, eb))
    if any(len(v) > 1 for v in links.values()):
        raise ValueError('Branched profile: manual unfolding required')
    free = [(i, e) for i in range(len(prims)) for e in (0, 1) if (i, e) not in links]
    if not free:
        raise ValueError('Closed rolled ring: the seam position is required for the blank')
    if len(free) != 2:
        raise ValueError('Profile is not one connected strip')
    order, cur = [], free[0]
    while True:
        i, e = cur
        order.append((i, e))          # enter primitive i at end e
        nxt = links.get((i, 1 - e))
        if not nxt:
            break
        cur = nxt[0]
        if len(order) > len(prims):
            raise ValueError('Profile walk did not terminate')
    if len(order) != len(prims):
        raise ValueError('Profile is not one connected strip')
    # development: s along the neutral fibre, z along A
    zref = 0.0
    offs = []
    s0 = 0.0
    for i, e in order:
        offs.append(s0)
        s0 += prims[i]['length']

    def mapper(i, e, start):
        P = prims[i]
        if P['kind'] == 'arc':
            f = P['f']
            rn = f['r'] + k * th

            def m(pts):
                rel = pts - f['L3']
                u = np.arctan2(rel @ f['Y3'], rel @ f['X3'])
                u = f['u0'] + np.mod(u - f['u0'] + 1e-6, 2 * math.pi) - 1e-6
                t = (u - f['u0']) if e == 0 else (f['u1'] - u)
                return np.c_[start + t * rn, pts @ A - zref]
            return m
        D = P['D'] if np.dot(q2(P['D']), P['ends'][1] - P['ends'][0]) > 0 else -P['D']
        if e == 1:
            D = -D
        e0 = P['ends'][e]

        def m(pts):
            return np.c_[start + (np.c_[pts @ E1, pts @ E2] - e0) @ q2(D) / max(np.linalg.norm(q2(D)), 1e-12), pts @ A - zref]
        return m
    polys, lines = [], []
    from OCP.BRepTools import BRepTools as BT
    for (i, e), start in zip(order, offs):
        P = prims[i]
        m = mapper(i, e, start)
        f = faces[P['face']]
        outer = BT.OuterWire_s(f)
        shell, rings = None, []
        for w in explore(f, TopAbs_WIRE):
            pts = wire_points(TopoDS.Wire(w))
            if len(pts) < 3:
                continue
            c2 = m(pts)
            if w.IsSame(outer):
                shell = c2
            else:
                rings.append(c2)
        if shell is None:
            raise ValueError('Profile face without boundary')
        poly = Polygon(shell, rings).buffer(0)
        polys.append(poly)
        if P['kind'] == 'arc':
            fr = P['f']
            sm = start + P['length'] / 2
            zlo, zhi = poly.bounds[1], poly.bounds[3]
            # direction: toward the flat's +Z (viewer) when the arc curls toward the side T x A
            u_in = fr['u0'] if e == 0 else fr['u1']
            rad = fr['X3'] * math.cos(u_in) + fr['Y3'] * math.sin(u_in)
            tangent = (-fr['X3'] * math.sin(u_in) + fr['Y3'] * math.cos(u_in)) * (1 if e == 0 else -1)
            up = np.dot(-rad, np.cross(tangent, A)) > 0
            lines.append({'id': '', 'a': [sm, zlo], 'b': [sm, zhi], 'allowance': P['length'], 'angle': P['angle'], 'radius': P['radius'],
                          'length': zhi - zlo, 'direction': 'up' if up else 'down', 'outside_height': None, 'rolled': True})
    # consecutive faces of one arc (same centre and radius, split by the CAD) are one bend / one roll
    joined = []
    for ln, (i, e) in zip(lines, [o for o in order if prims[o[0]]['kind'] == 'arc']):
        f = prims[i]['f']
        prev = joined[-1] if joined else None
        if prev and prev[2] is not None and np.linalg.norm(prev[2]['C'] - f['C']) < .02 and abs(prev[0]['radius'] - ln['radius']) < .01 \
                and abs(prev[0]['a'][0] + prev[0]['allowance'] / 2 - (ln['a'][0] - ln['allowance'] / 2)) < 1e-6 and prev[0]['direction'] == ln['direction']:
            q = prev[0]
            lo_s = q['a'][0] - q['allowance'] / 2
            q['allowance'] += ln['allowance']
            q['angle'] += ln['angle']
            sm = lo_s + q['allowance'] / 2
            zlo, zhi = min(q['a'][1], ln['a'][1]), max(q['b'][1], ln['b'][1])
            q['a'], q['b'], q['length'] = [sm, zlo], [sm, zhi], zhi - zlo
            continue
        joined.append((ln, i, f))
    lines = [j[0] for j in joined]
    merged = union_all([p.buffer(1e-4, join_style=2) for p in polys]).buffer(-1e-4, join_style=2)
    if merged.geom_type != 'Polygon' or not merged.is_valid:
        raise ValueError('Profile development produced a disconnected outline')
    expected = g['volume'] / th
    if abs(merged.area - expected) / max(expected, 1) > .05:
        raise ValueError('Developed profile does not match the constant-thickness volume')
    for n, ln in enumerate(lines, 1):
        ln['id'] = f'B{n:03d}'
    unfold.maps = []
    return merged, lines
