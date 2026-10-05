"""Software renderer for drawing pictorials: shaded, anti-aliased images of the real B-rep tessellation.

No GPU or display is needed (the worker runs headless). A vectorised z-buffer rasteriser with per-pixel normals
(smooth inside every B-rep face, crisp at face boundaries) and a three-light studio setup; the drawing paints its
visible edges on top, like "shaded with edges" in a CAD system.
"""
import io
import numpy as np
from PIL import Image

BASE = np.array([0.80, 0.83, 0.87])      # brushed sheet steel / aluminium
LIGHTS = [(np.array([-0.45, 0.55, 0.70]), 0.62), (np.array([0.55, 0.15, 0.55]), 0.22), (np.array([0.0, -0.6, 0.4]), 0.12)]


def mesh_data(shape, deflection=None):
    """Triangles with per-B-rep-face vertex normals (vertices are not shared between faces)."""
    from .cad import bounds
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from .cad import explore, xyz
    bb = np.asarray(bounds(shape), float)
    size = float(np.linalg.norm(bb[3:] - bb[:3]))
    defl = deflection or max(0.02, size / 1500)
    BRepMesh_IncrementalMesh(shape, defl, False, .3, True).Perform()
    V, F, N = [], [], []
    off = 0
    for f in explore(shape, TopAbs_FACE):
        face = TopoDS.Face(f)
        loc = TopLoc_Location()
        t = BRep_Tool.Triangulation_s(face, loc)
        if t is None:
            continue
        tr = loc.Transformation()
        verts = np.array([xyz(t.Node(i).Transformed(tr)) for i in range(1, t.NbNodes() + 1)])
        tris = np.array([list(t.Triangle(i).Get()) for i in range(1, t.NbTriangles() + 1)]) - 1
        if face.Orientation() == TopAbs_REVERSED:
            tris = tris[:, ::-1]
        # area-weighted vertex normals within this face only
        fn = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
        vn = np.zeros_like(verts)
        for k in range(3):
            np.add.at(vn, tris[:, k], fn)
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        V.append(verts)
        N.append(vn)
        F.append(tris + off)
        off += len(verts)
    if not V:
        return None
    return {'v': np.vstack(V), 'n': np.vstack(N), 'f': np.vstack(F)}


def _raster(sx, sy, sz, F, W, H):
    """Z-buffer (larger sz = nearer). Returns triangle id and barycentrics per pixel (-1 = background)."""
    zbuf = np.full(W * H, -np.inf)
    tid = np.full(W * H, -1, np.int64)
    b1 = np.zeros(W * H)
    b2 = np.zeros(W * H)
    X = sx[F]
    Y = sy[F]
    Z = sz[F]
    x0 = np.clip(np.floor(X.min(1)).astype(int), 0, W - 1)
    x1 = np.clip(np.ceil(X.max(1)).astype(int), 0, W - 1)
    y0 = np.clip(np.floor(Y.min(1)).astype(int), 0, H - 1)
    y1 = np.clip(np.ceil(Y.max(1)).astype(int), 0, H - 1)
    area = (X[:, 1] - X[:, 0]) * (Y[:, 2] - Y[:, 0]) - (X[:, 2] - X[:, 0]) * (Y[:, 1] - Y[:, 0])
    good = np.where((np.abs(area) > 1e-12) & (X.max(1) >= 0) & (X.min(1) <= W) & (Y.max(1) >= 0) & (Y.min(1) <= H))[0]
    rows = (y1 - y0 + 1)
    # scanline rasterisation, vectorised over (triangle, row) pairs and then over pixels; chunks bound memory
    cum = np.cumsum(rows[good])
    start = 0
    while start < len(good):
        stop = int(np.searchsorted(cum, (cum[start - 1] if start else 0) + 2_000_000, side='right'))
        stop = max(stop, start + 1)
        t = good[start:stop]
        start = stop
        rt = np.repeat(t, rows[t])
        ry = np.concatenate([np.arange(y0[i], y1[i] + 1) for i in t]) if len(t) < 64 else (np.arange(len(rt)) - np.repeat(np.cumsum(rows[t]) - rows[t], rows[t]) + np.repeat(y0[t], rows[t]))
        cy = ry + .5
        xl = np.full(len(rt), np.inf)
        xr = np.full(len(rt), -np.inf)
        for e0, e1 in ((0, 1), (1, 2), (2, 0)):
            ya, yb = Y[rt, e0], Y[rt, e1]
            xa, xb = X[rt, e0], X[rt, e1]
            lo_, hi_ = np.minimum(ya, yb), np.maximum(ya, yb)
            m = (cy >= lo_) & (cy <= hi_) & (hi_ > lo_)
            xx = np.where(m, xa + (cy - ya) * (xb - xa) / np.where(hi_ > lo_, yb - ya, 1), np.nan)
            xl = np.where(m, np.minimum(xl, xx), xl)
            xr = np.where(m, np.maximum(xr, xx), xr)
        a0 = np.clip(np.ceil(xl - .5), 0, W - 1)
        a1 = np.clip(np.floor(xr - .5), 0, W - 1)
        cnt = np.where(np.isfinite(xl) & (a1 >= a0) & (xr - .5 >= 0) & (xl - .5 <= W - 1), (a1 - a0 + 1), 0).astype(np.int64)
        if not cnt.sum():
            continue
        tri = np.repeat(rt, cnt)
        py = np.repeat(ry, cnt)
        px = (np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt) + np.repeat(a0.astype(np.int64), cnt))
        cx, cyy = px + .5, py + .5
        xa, xb, xc = X[tri, 0], X[tri, 1], X[tri, 2]
        ya, yb, yc = Y[tri, 0], Y[tri, 1], Y[tri, 2]
        ar = area[tri]
        L1 = ((xc - cx) * (ya - cyy) - (xa - cx) * (yc - cyy)) / ar
        L2 = ((xa - cx) * (yb - cyy) - (xb - cx) * (ya - cyy)) / ar
        L1 = np.clip(L1, 0, 1)
        L2 = np.clip(L2, 0, 1 - L1)
        L0 = 1 - L1 - L2
        pix = py * W + px
        z = L0 * Z[tri, 0] + L1 * Z[tri, 1] + L2 * Z[tri, 2]
        order = np.lexsort((-z, pix))            # nearest first per pixel
        pix, z, tri, L1, L2 = pix[order], z[order], tri[order], L1[order], L2[order]
        first = np.r_[True, pix[1:] != pix[:-1]]
        pix, z, tri, L1, L2 = pix[first], z[first], tri[first], L1[first], L2[first]
        win = z > zbuf[pix]
        pix = pix[win]
        zbuf[pix] = z[win]
        tid[pix] = tri[win]
        b1[pix] = L1[win]
        b2[pix] = L2[win]
    return tid, b1, b2, zbuf


def view_image(md, n, right, lo, hi, px_per_mm=8.0, max_px=1800, ss=2, fmt='JPEG'):
    """Shaded image of the mesh seen along -n (n toward the viewer), x = right, y = n × right, cropped to the
    view's 2D box lo..hi (model mm, same frame as the hidden-line projection). Returns encoded image bytes."""
    n = np.asarray(n, float) / np.linalg.norm(n)
    right = np.asarray(right, float) / np.linalg.norm(right)
    up = np.cross(n, right)
    lo = np.asarray(lo, float)
    hi = np.asarray(hi, float)
    span = np.maximum(hi - lo, 1e-6)
    k = min(px_per_mm, max_px / max(span))
    W, H = max(8, int(round(span[0] * k))), max(8, int(round(span[1] * k)))
    k2 = k * ss
    W2, H2 = W * ss, H * ss
    v = md['v']
    sx = (v @ right - lo[0]) * k2
    sy = (hi[1] - v @ up) * k2
    sz = v @ n
    tid, b1, b2, _ = _raster(sx, sy, sz, md['f'], W2, H2)
    img = np.ones((W2 * H2, 3))
    hit = tid >= 0
    if hit.any():
        F = md['f'][tid[hit]]
        NN = md['n']
        l1, l2 = b1[hit][:, None], b2[hit][:, None]
        nrm = (1 - l1 - l2) * NN[F[:, 0]] + l1 * NN[F[:, 1]] + l2 * NN[F[:, 2]]
        nv = np.c_[nrm @ right, nrm @ up, nrm @ n]
        nv /= np.maximum(np.linalg.norm(nv, axis=1, keepdims=True), 1e-12)
        nv[nv[:, 2] < 0] *= -1                       # two-sided: the visible side of thin sheet faces
        shade = np.full(len(nv), 0.40)
        spec = np.zeros(len(nv))
        for d, w in LIGHTS:
            d = d / np.linalg.norm(d)
            shade += w * np.clip(nv @ d, 0, 1)
            h = d + np.array([0, 0, 1.0])
            h /= np.linalg.norm(h)
            spec += w * np.clip(nv @ h, 0, 1) ** 40
        # soft rim darkening toward silhouettes reads the bends
        shade *= 0.82 + 0.18 * nv[:, 2]
        base = md['c'][F[:, 0]] if 'c' in md else BASE[None, :]
        col = base * shade[:, None] + 0.35 * spec[:, None]
        img[hit] = np.clip(col, 0, 1)
    im = Image.fromarray((img.reshape(H2, W2, 3) * 255).astype(np.uint8), 'RGB')
    if ss > 1:
        im = im.resize((W, H), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, fmt, quality=90) if fmt == 'JPEG' else im.save(out, fmt, optimize=True)
    return out.getvalue()
