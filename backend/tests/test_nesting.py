import io
import json
import zipfile
from shapely.geometry import Polygon
from app import nesting


def _rect(w, h, hole=None):
    flat = {'outline': [[0, 0], [w, 0], [w, h], [0, h]], 'holes': [], 'bends': [{'a': [w / 2, 0], 'b': [w / 2, h]}]}
    if hole:
        x, y, s = hole
        flat['holes'] = [[[x, y], [x + s, y], [x + s, y + s], [x, y + s]]]
    return flat


def test_nesting_places_true_shapes_apart_and_inside_holes():
    parts = [
        {'key': 'frame', 'label': 'FRAME', 'material': 'S235', 'thickness': 2, 'qty': 1, 'flat': _rect(400, 400, (50, 50, 300))},
        {'key': 'tab', 'label': 'TAB', 'material': 'S235', 'thickness': 2, 'qty': 6, 'flat': _rect(60, 40)},
        {'key': 'thin', 'label': 'THIN', 'material': 'S235', 'thickness': 1, 'qty': 2, 'flat': _rect(100, 50)},
        {'key': 'huge', 'label': 'HUGE', 'material': 'S235', 'thickness': 1, 'qty': 1, 'flat': _rect(900, 900)},
    ]
    summary, data = nesting.run(parts, 500, 450, gap=5, margin=10, title='t')
    g2 = next(g for g in summary['groups'] if g['thickness'] == 2)
    assert len(g2['sheets']) == 1 and g2['placed'] == 7                 # the tabs fit inside the frame's window
    g1 = next(g for g in summary['groups'] if g['thickness'] == 1)
    assert g1['placed'] == 2 and [u['label'] for u in g1['unplaced']] == ['HUGE']
    z = zipfile.ZipFile(io.BytesIO(data))
    names = z.namelist()
    assert 'nesting-summary.pdf' in names and any(n.endswith('sheet-01.dxf') for n in names)
    # geometry check from the engine itself: spacing and margin are kept
    shapes = [nesting.Shape(p['key'], p['label'], p['flat']['outline'], p['flat']['holes'], [], p['qty']) for p in parts[:2]]
    sheets, unplaced = nesting.nest_group(shapes, 500, 450, 5, 10, budget=3)
    placed = [p['poly'] for s in sheets for p in s.placed]
    assert len(placed) == 7 and not unplaced
    for i, a in enumerate(placed):
        x0, y0, x1, y1 = a.bounds
        assert x0 >= 10 - 1e-6 and y0 >= 10 - 1e-6 and x1 <= 490 + 1e-6 and y1 <= 440 + 1e-6
        for b in placed[i + 1:]:
            assert a.distance(b) >= 5 - 1e-6   # also for a part sitting in a cut-out (distance to the hole edge)


def test_curved_weld_seam_pieces_join_into_one():
    import math
    import numpy as np
    from types import SimpleNamespace
    from app import seams as S
    a = SimpleNamespace(thickness=1.2, _centre=np.array([0.0, 0.0, -10.0]))
    b = SimpleNamespace(thickness=1.2, _centre=np.array([0.0, 0.0, 10.0]))
    arc = lambda t0, t1: np.array([[100 * math.cos(t), 100 * math.sin(t), 0.0] for t in np.linspace(t0, t1, 30)])
    n = np.array([0.0, 0.0, 1.0])
    def seam(path, index):
        return {'body': a, 'other': b, 'index': index, 'path': path, 'length': float(np.linalg.norm(np.diff(path, axis=0), axis=1).sum()),
                'joint': 'fillet', 'n_free': n, 'n_other': n, 'angle': 90.0}
    pieces = [seam(arc(0, 1.0), 1), seam(arc(1.04, 2.0)[::-1], 2),       # 4 mm notch between them, stored backwards
              seam(arc(2.0, 3.0), 3), seam(np.array([[0, 0, 0.0], [0, 0, 1.2]]), 4),   # a step across the thickness
              seam(arc(4.0, 4.5), 5)]                                     # far away: another seam
    out = S.chain(pieces)
    long = max(out, key=lambda s: s['length'])
    assert len(out) == 3 and long['pieces'] == 3 and abs(long['length'] - 300) < 6 and long['key'].startswith('c')
