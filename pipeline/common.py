"""Shared settings and coordinate helpers for the visibility pipeline.

The analysis grid is the Web Mercator pixel grid at zoom GRID_ZOOM, so the
output can be cut straight into XYZ map tiles without resampling.
"""
import math
import os
from pathlib import Path

# Tokyo Skytree (antenna top is 634 m above the base).
LANDMARK = {
    "id": "skytree",
    "name": "東京スカイツリー",
    "lat": 35.710139,
    "lon": 139.810833,
    "height": 634.0,
}

RADIUS_M = 8000.0          # analysis radius around the landmark
GRID_ZOOM = 16             # ~1.94 m per pixel at Tokyo's latitude
EYE_HEIGHT = 1.6           # observer eye height above ground [m]
REFRACTION_K = 0.13        # terrestrial refraction coefficient
EARTH_R = 6371000.0

# Heights on the landmark (above its base) tested for visibility, top first.
LEVELS = [630.0, 500.0, 450.0, 350.0, 250.0, 150.0, 50.0]

CACHE = Path(os.environ.get("LANDMARK_CACHE", Path.home() / ".cache" / "landmark"))
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


def ground_res(lat=LANDMARK["lat"], zoom=GRID_ZOOM):
    """Metres per grid pixel at the given latitude."""
    return 2 * math.pi * 6378137.0 * math.cos(math.radians(lat)) / (256.0 * (1 << zoom))


def grid_spec():
    """Tile-aligned grid covering RADIUS_M around the landmark."""
    cx, cy = world_px(LANDMARK["lat"], LANDMARK["lon"])
    r_px = RADIUS_M / ground_res() + 8
    x0 = int(math.floor((float(cx) - r_px) / 256)) * 256
    y0 = int(math.floor((float(cy) - r_px) / 256)) * 256
    x1 = int(math.ceil((float(cx) + r_px) / 256)) * 256
    y1 = int(math.ceil((float(cy) + r_px) / 256)) * 256
    return {"x0": x0, "y0": y0, "w": x1 - x0, "h": y1 - y0, "cx": float(cx) - x0, "cy": float(cy) - y0}


def bbox_lonlat(margin_m=0.0):
    g = grid_spec()
    pad = margin_m / ground_res()
    lat_n, lon_w = px_to_latlon(g["x0"] - pad, g["y0"] - pad)
    lat_s, lon_e = px_to_latlon(g["x0"] + g["w"] + pad, g["y0"] + g["h"] + pad)
    return float(lon_w), float(lat_s), float(lon_e), float(lat_n)
