"""Pictorial (isometric / dimetric / custom) view definitions for drawing sheets.

Kept free of CAD imports so the API can validate and list presets cheaply. Angles are relative to the
drawing's main (front) view: azimuth turns about the vertical axis (0 = looking at the front, +90 = from the
right), elevation tilts up (+) or down (-), roll rotates the picture in the sheet plane.
"""
import math
import re

ISO_EL = math.degrees(math.atan(1 / math.sqrt(2)))  # 35.264 deg: true isometric
PRESETS = {
    'iso-front-right': ('Isometric - front right, from above', 45, ISO_EL),
    'iso-front-left': ('Isometric - front left, from above', -45, ISO_EL),
    'iso-back-right': ('Isometric - back right, from above', 135, ISO_EL),
    'iso-back-left': ('Isometric - back left, from above', -135, ISO_EL),
    'iso-below-front-right': ('Isometric - front right, from below', 45, -ISO_EL),
    'iso-below-front-left': ('Isometric - front left, from below', -45, -ISO_EL),
    'iso-below-back-right': ('Isometric - back right, from below', 135, -ISO_EL),
    'iso-below-back-left': ('Isometric - back left, from below', -135, -ISO_EL),
    'dimetric-front-right': ('Dimetric - front right', 30, 20.0),
    'dimetric-front-left': ('Dimetric - front left', -30, 20.0),
    'trimetric-front-right': ('Trimetric - front right', 25, 28.0),
    'trimetric-front-left': ('Trimetric - front left', -25, 28.0),
}
DEFAULT = [{'id': 'iso', 'preset': 'iso-front-right'}]
MAX_VIEWS = 8


def presets():
    return [{'preset': k, 'label': v[0], 'azimuth': v[1], 'elevation': round(v[2], 3)} for k, v in PRESETS.items()]


def normalize(items):
    """Validate user pictorial definitions -> [{id, preset, label, azimuth, elevation, roll, scale}]."""
    if items is None:
        return [dict(p, **resolve(p)) for p in DEFAULT]
    if not isinstance(items, list) or len(items) > MAX_VIEWS:
        raise ValueError(f'At most {MAX_VIEWS} pictorial views')
    out, seen = [], set()
    for i, it in enumerate(items):
        if not isinstance(it, dict) or set(it) - {'id', 'preset', 'label', 'azimuth', 'elevation', 'roll', 'scale'}:
            raise ValueError('Unsupported pictorial view field')
        pid = str(it.get('id') or ('iso' if i == 0 else f'iso{i + 1}'))
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,40}', pid) or pid in seen:
            raise ValueError('Invalid or duplicate pictorial view id')
        seen.add(pid)
        preset = it.get('preset') or 'custom'
        if preset != 'custom' and preset not in PRESETS:
            raise ValueError(f'Unknown pictorial preset {preset}')
        rec = {'id': pid, 'preset': preset, **resolve(it)}
        out.append(rec)
    return out


def resolve(it):
    preset = it.get('preset') or 'custom'
    label, az, el = PRESETS.get(preset, (None, None, None))
    if preset == 'custom' or az is None:
        az, el = it.get('azimuth', 45), it.get('elevation', ISO_EL)
    roll = it.get('roll', 0) or 0
    scale = it.get('scale')
    for name, v, lo, hi in (('azimuth', az, -360, 360), ('elevation', el, -89.5, 89.5), ('roll', roll, -360, 360)):
        if not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
            raise ValueError(f'Pictorial {name} must be between {lo} and {hi} degrees')
    if scale is not None and (not isinstance(scale, (int, float)) or not math.isfinite(scale) or not .01 <= scale <= 20):
        raise ValueError('Pictorial scale must be between 0.01 and 20 (or automatic)')
    text = str(it.get('label') or label or f'Pictorial {az:g} / {el:g}')[:60]
    return {'label': text, 'azimuth': float(az), 'elevation': float(el), 'roll': float(roll), 'scale': None if scale is None else float(scale)}


def frame(n0, up0, azimuth, elevation, roll):
    """Viewing direction (toward the viewer) and in-sheet x axis for a pictorial view."""
    import numpy as np
    n0 = np.asarray(n0, float)
    up0 = np.asarray(up0, float)
    r0 = np.cross(up0, n0)
    az, el, rl = map(math.radians, (azimuth, elevation, roll))
    d = math.cos(el) * (math.sin(az) * r0 + math.cos(az) * n0) + math.sin(el) * up0
    d /= np.linalg.norm(d)
    r = np.cross(up0, d)
    if np.linalg.norm(r) < 1e-6:  # looking straight down/up: keep the front view's horizontal, turned by azimuth
        r = math.cos(az) * r0 - math.sin(az) * n0
    r /= np.linalg.norm(r)
    if rl:
        r = r * math.cos(rl) + np.cross(d, r) * math.sin(rl)
        r /= np.linalg.norm(r)
    return d, r
