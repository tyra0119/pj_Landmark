"""Shared settings and coordinate helpers for the visibility pipeline.

The analysis grid is the Web Mercator pixel grid at zoom GRID_ZOOM, so the
output can be cut straight into XYZ map tiles without resampling.
"""
import json
import math
import os
from pathlib import Path

# Landmarks. "levels" are heights on the landmark (above its base) tested for
# visibility, top first; "model" is a rough silhouette for the 3D view:
# [bottom, top, radius] in metres, drawn as stacked columns with "sides" sides.
LANDMARKS = {
    "skytree": {
        "id": "skytree", "name": "東京スカイツリー", "short": "スカイツリー",
        "lat": 35.710139, "lon": 139.810833, "height": 634.0,
        "levels": [630.0, 500.0, 450.0, 350.0, 250.0, 150.0, 50.0],
        "model": [[0, 60, 34], [60, 160, 30], [160, 250, 26], [250, 320, 22], [320, 352, 27],
                  [352, 440, 17], [440, 452, 19], [452, 495, 12], [495, 600, 3], [600, 634, 1.6]],
        "sides": 24, "color": [232, 236, 242], "night_color": [190, 205, 255],
    },
    "tokyotower": {
        "id": "tokyotower", "name": "東京タワー", "short": "東京タワー",
        "lat": 35.658581, "lon": 139.745433, "height": 333.0,
        "levels": [330.0, 250.0, 200.0, 150.0, 100.0, 60.0, 25.0],
        "model": [[0, 30, 44], [30, 70, 34], [70, 110, 26], [110, 140, 19], [140, 158, 22],
                  [158, 210, 11], [210, 228, 9], [228, 270, 4], [270, 333, 1.8]],
        "sides": 4, "color": [236, 92, 40], "night_color": [255, 150, 70],
    },
    # A distant landmark: observers are in central Tokyo (the areas analysed for
    # the two towers, whose PLATEAU data is already cached), ~100 km away.
    "fuji": {
        "id": "fuji", "name": "富士山", "short": "富士山", "tip": "山頂", "far": True,
        "lat": 35.360628, "lon": 138.727363, "height": 3776.0, "base": 0.0,
        "levels": [3770.0, 3500.0, 3200.0, 2900.0, 2600.0, 2300.0, 2000.0],
        "area": [{"lat": 35.710139, "lon": 139.810833, "r": 8000.0},
                 {"lat": 35.658581, "lon": 139.745433, "r": 8000.0}],
        "area_label": "都心部（スカイツリー・東京タワー周辺）",
        "model": [], "sides": 4, "color": [0, 0, 0], "night_color": [0, 0, 0],
    },
}
LANDMARK = LANDMARKS[os.environ.get("LANDMARK_ID", "skytree")]
LEVELS = LANDMARK["levels"]
# where observers can be: circles around the landmark, or a separate area for a far one
AREA = LANDMARK.get("area") or [{"lat": LANDMARK["lat"], "lon": LANDMARK["lon"], "r": 8000.0}]
AREA_CENTER = {"lat": sum(c["lat"] for c in AREA) / len(AREA), "lon": sum(c["lon"] for c in AREA) / len(AREA)}
# buildings near the landmark taller than this are the landmark itself (or its parts)
EXCLUDE_RADIUS_M = 60.0
EXCLUDE_MIN_HEIGHT = 40.0

RADIUS_M = 8000.0          # analysis radius around the landmark
GRID_ZOOM = 16             # ~1.94 m per pixel at Tokyo's latitude
EYE_HEIGHT = 1.6           # observer eye height above ground [m]
REFRACTION_K = 0.13        # terrestrial refraction coefficient
EARTH_R = 6371000.0

CACHE = Path(os.environ.get("LANDMARK_CACHE", Path.home() / ".cache" / "landmark"))
OUT = CACHE / LANDMARK["id"]          # per-landmark results; PLATEAU extracts are shared
OUT.mkdir(parents=True, exist_ok=True)
ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"


def world_px(lat, lon, zoom=GRID_ZOOM):
    """Global Web Mercator pixel coordinates (float). Works on numpy arrays."""
    import numpy as np
    n = 256.0 * (1 << zoom)
    lat = np.radians(lat)
    x = (np.asarray(lon) + 180.0) / 360.0 * n
    y = (1.0 - np.log(np.tan(lat) + 1.0 / np.cos(lat)) / math.pi) / 2.0 * n
    return x, y


def px_to_latlon(x, y, zoom=GRID_ZOOM):
    import numpy as np
    n = 256.0 * (1 << zoom)
    lon = np.asarray(x) / n * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(math.pi * (1.0 - 2.0 * np.asarray(y) / n))))
    return lat, lon


def ground_res(lat=AREA_CENTER["lat"], zoom=GRID_ZOOM):
    """Metres per grid pixel at the given latitude."""
    return 2 * math.pi * 6378137.0 * math.cos(math.radians(lat)) / (256.0 * (1 << zoom))


def grid_spec():
    """Tile-aligned grid covering the observer area; cx/cy is the landmark (maybe far outside)."""
    xs, ys = [], []
    for c in AREA:
        x, y = world_px(c["lat"], c["lon"])
        r_px = c["r"] / ground_res() + 8
        xs += [float(x) - r_px, float(x) + r_px]
        ys += [float(y) - r_px, float(y) + r_px]
    x0 = int(math.floor(min(xs) / 256)) * 256
    y0 = int(math.floor(min(ys) / 256)) * 256
    x1 = int(math.ceil(max(xs) / 256)) * 256
    y1 = int(math.ceil(max(ys) / 256)) * 256
    cx, cy = world_px(LANDMARK["lat"], LANDMARK["lon"])
    return {"x0": x0, "y0": y0, "w": x1 - x0, "h": y1 - y0, "cx": float(cx) - x0, "cy": float(cy) - y0}


def area_mask(g):
    """Grid cells inside the observer area (any of the circles)."""
    import numpy as np
    res = ground_res()
    yy, xx = np.ogrid[:g["h"], :g["w"]]
    mask = np.zeros((g["h"], g["w"]), dtype=bool)
    for c in AREA:
        x, y = world_px(c["lat"], c["lon"])
        mask |= np.hypot(xx - (float(x) - g["x0"]), yy - (float(y) - g["y0"])) * res <= c["r"]
    return mask


def landmark_files(kind):
    """Cached PLATEAU extracts that cover this landmark's area."""
    listed = json.loads((OUT / f"files_{kind}.json").read_text(encoding="utf-8"))
    paths = [CACHE / kind / f"{f['city']}_{f['code']}.npz" for f in listed]
    return [p for p in paths if p.exists()]


def bbox_lonlat(margin_m=0.0):
    g = grid_spec()
    pad = margin_m / ground_res()
    lat_n, lon_w = px_to_latlon(g["x0"] - pad, g["y0"] - pad)
    lat_s, lon_e = px_to_latlon(g["x0"] + g["w"] + pad, g["y0"] + g["h"] + pad)
    return float(lon_w), float(lat_s), float(lon_e), float(lat_n)
