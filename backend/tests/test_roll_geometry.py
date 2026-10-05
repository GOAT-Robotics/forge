import math
import numpy as np
from app.bendplan import roll_centres


def test_lower_rolls_clear_finite_arc_and_tangent_flange_during_feed():
    # Screenshot case: 64 degree curve, R48.4, 1.6 mm stock. Scan both feed directions
    # and early/final curvature; extend the uncurved flanges well past the supports.
    t = 1.6
    r = {'bottom': .85 * .6 * 48.4, 'pitch': (.6 * 48.4 + .85 * .6 * 48.4) * 1.2}
    for direction in (-1, 1):
        for angle in np.linspace(0, math.radians(64), 9):
            rho = (48.4 + .5 * t) * math.radians(64) / angle if angle else 1e7
            for at in np.linspace(0, 1, 17):
                lo, hi = sorted((-direction * angle * at, direction * angle * (1 - at)))
                th = np.linspace(lo, hi, 301)
                y, z = rho * np.sin(th), rho * (1 - np.cos(th))
                points = [np.c_[y, z]]
                for theta, side in ((lo, -1), (hi, 1)):
                    d = np.linspace(0, 300, 601) * side
                    points.append(np.c_[rho * math.sin(theta) + d * math.cos(theta), rho * (1 - math.cos(theta)) + d * math.sin(theta)])
                profile = np.vstack(points)
                for centre in roll_centres(rho, t, r, angle, at, direction):
                    clearance = np.linalg.norm(profile - centre, axis=1).min() - r['bottom'] - t / 2
                    assert clearance >= -1e-6, (angle, at, direction, centre, clearance)


def test_feed_endpoint_support_is_below_straight_flange():
    r = {'bottom': 24.684, 'pitch': 64.469}
    left, right = roll_centres(49.2, 1.6, r, math.radians(64), 0, 1)
    assert np.allclose(left, (-r['pitch'], -r['bottom'] - .8), atol=1e-9)
    assert right[1] > left[1]


def test_planner_reports_lower_roll_collision():
    from app.bendplan import Planner
    # Isolate the collision evaluator: a previously formed flange lies at a lower
    # roller centre, while it clears the top roller. The old top-only check missed it.
    planner = Planner.__new__(Planner)
    planner.t = 1.6
    planner.bends = [{'w': 25, 's': 1}]
    r = {'top': 29.04, 'bottom': 24.684, 'pitch': 64.469, 'length': 230}
    planner.roll_of = lambda p: r
    planner.angles = lambda done, p, frac: [0]
    planner.frame = lambda p, ang, at: (np.eye(3), np.array([0, 0, -.8]))
    planner.folded = lambda ang: [np.array([[0, -r['pitch'], -r['bottom'] - .8]])]
    result = planner.evaluate_roll(frozenset(), 0)
    assert result['clash']['bottom_roll'] > 0
    assert 'roll' not in result['clash']
