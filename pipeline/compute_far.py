"""Visibility of a distant landmark (Mt. Fuji) from every ground cell of the area.

Same idea as compute_visibility.py, but the viewpoints are ~100 km away:

- Rays leave the summit and cross the observer grid. Up to the grid they are
  sampled every ~31 m on a coarse DEM (the mountains in between, e.g. Tanzawa);
  inside the grid every pixel on the building/bridge surface.
- Each level is a point on the mountain's flank facing the observer: the first
  place along the ray where the terrain drops below that height.
- Earth curvature and refraction matter here (~700 m of drop at 100 km).

Output (in CACHE/<landmark>/): classes.npy, deck.npy, visibility_meta.json.

    LANDMARK_ID=fuji python pipeline/compute_far.py
"""
import io
import json
import math
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from common import (AREA, AREA_CENTER, CACHE, EARTH_R, EYE_HEIGHT, LANDMARK, LEVELS, OUT, REFRACTION_K,
                    area_mask, grid_spec, landmark_files, px_to_latlon, world_px)
from compute_visibility import CLS_OUTSIDE, build_surfaces

FAR_ZOOM = 12            # coarse DEM for the terrain between the landmark and the area
FAR_STEP = 16            # z16 pixels per far sample (= one z12 pixel, ~31 m)
RAY_BATCH = 192
SELF_MARGIN_M = 60       # ignore the flank right at the viewpoint
DEM_URL = "https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png"


def res_at(lat):
    return 2 * math.pi * 6378137.0 * np.cos(np.radians(lat)) / (256.0 * (1 << 16))


def far_dem(g):
    """z12 DEM mosaic covering the landmark and the grid, in z16 pixel coordinates."""
    sx, sy = world_px(LANDMARK["lat"], LANDMARK["lon"])
    xs = [float(sx), g["x0"], g["x0"] + g["w"]]
    ys = [float(sy), g["y0"], g["y0"] + g["h"]]
    pad = 2000  # z16 px
    tx0, tx1 = int((min(xs) - pad) // 4096), int((max(xs) + pad) // 4096)
    ty0, ty1 = int((min(ys) - pad) // 4096), int((max(ys) + pad) // 4096)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    cache = CACHE / "dem" / f"dem_png_{FAR_ZOOM}"
    cache.mkdir(parents=True, exist_ok=True)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            path = cache / f"{tx}_{ty}.png"
            if not path.exists():
                try:
                    with urllib.request.urlopen(DEM_URL.format(z=FAR_ZOOM, x=tx, y=ty)) as r:
                        path.write_bytes(r.read())
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        raise
                    path.write_bytes(b"")
                time.sleep(0.05)
            data = path.read_bytes()
            if not data:
                continue  # sea
            rgb = np.asarray(Image.open(io.BytesIO(data)).convert("RGB")).astype(np.int64)
            v = (rgb[..., 0] << 16) | (rgb[..., 1] << 8) | rgb[..., 2]
            h = np.where(v < 2 ** 23, v, v - 2 ** 24) * 0.01
            h[v == 2 ** 23] = 0
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = h
    print(f"far DEM {mosaic.shape}, max {mosaic.max():.0f} m", flush=True)
    return mosaic, tx0 * 4096, ty0 * 4096   # origin in z16 pixels


def main():
    t0 = time.time()
    g = grid_spec()
    ground, dsm, stand, status, deck, n_bldg, bstats = build_surfaces(g, t0)
    del ground
    in_area = area_mask(g)
    dem, dx0, dy0 = far_dem(g)

    # rays from the summit (global z16 pixel coordinates)
    sx, sy = (float(v) for v in world_px(LANDMARK["lat"], LANDMARK["lon"]))
    corners = [(g["x0"] + a, g["y0"] + b) for a in (0, g["w"]) for b in (0, g["h"])]
    angles = [math.atan2(y - sy, x - sx) for x, y in corners]
    th0, th1 = min(angles), max(angles)
    dists = [math.hypot(x - sx, y - sy) for x, y in corners]
    r_near = min(math.hypot(min(max(sx, g["x0"]), g["x0"] + g["w"]) - sx, min(max(sy, g["y0"]), g["y0"] + g["h"]) - sy), *dists)
    r_far = max(dists)
    far_r = np.arange(0, r_near, FAR_STEP, dtype=np.float64)
    fine_r = np.arange(r_near, r_far, 1.0, dtype=np.float64)
    r_px = np.concatenate([far_r, fine_r])
    n_far = len(far_r)
    k_rays = int(math.ceil((th1 - th0) * r_far * 1.25))
    print(f"{k_rays} rays, {len(r_px)} samples each ({n_far} far)", flush=True)

    lat_s = LANDMARK["lat"]
    flat_dsm, flat_stand, flat_status = dsm.ravel(), stand.ravel(), status.ravel()
    ray_cls = np.zeros((k_rays, len(fine_r)), dtype=np.uint8)
    levels = np.array(LEVELS, dtype=np.float64)

    for k0 in range(0, k_rays, RAY_BATCH):
        k1 = min(k0 + RAY_BATCH, k_rays)
        th = th0 + (np.arange(k0, k1) + 0.5) * (th1 - th0) / k_rays
        x = sx + np.cos(th)[:, None] * r_px[None, :]
        y = sy + np.sin(th)[:, None] * r_px[None, :]
        lat = px_to_latlon(x, y)[0]
        r_m = r_px[None, :] * (res_at(lat_s) + res_at(lat)) / 2   # mean scale along the way
        # terrain everywhere from the coarse DEM; the building surface inside the grid
        di = np.clip(((y - dy0) / FAR_STEP).astype(np.int64), 0, dem.shape[0] - 1)
        dj = np.clip(((x - dx0) / FAR_STEP).astype(np.int64), 0, dem.shape[1] - 1)
        z = dem[di, dj].astype(np.float64)
        gi = np.rint(y - g["y0"]).astype(np.int64)
        gj = np.rint(x - g["x0"]).astype(np.int64)
        in_grid = (gi >= 0) & (gi < g["h"]) & (gj >= 0) & (gj < g["w"])
        idx = np.where(in_grid, gi * g["w"] + gj, 0)
        z = np.where(in_grid, flat_dsm[idx], z)
        eye = np.where(in_grid, flat_stand[idx] + EYE_HEIGHT, np.nan)
        cell = np.where(in_grid, flat_status[idx], CLS_OUTSIDE)

        cls = np.zeros(z.shape, dtype=np.uint8)
        running = np.ones(z.shape, dtype=bool)
        far_z = z[:, :n_far]
        for t in levels:
            # viewpoint: first far sample where the flank drops below this height
            below = far_z < t
            iv = np.where(below.any(axis=1), below.argmax(axis=1), 0)
            rv = np.take_along_axis(r_m, iv[:, None], axis=1)
            dist = r_m - rv
            valid = dist > SELF_MARGIN_M
            drop = dist ** 2 * (1 - REFRACTION_K) / (2 * EARTH_R)
            slope = np.where(valid, (z - drop - t) / np.maximum(dist, 1), -np.inf)
            horizon = np.maximum.accumulate(slope, axis=1)
            horizon = np.concatenate([np.full((len(th), 1), -np.inf), horizon[:, :-1]], axis=1)
            seen = valid & ((eye - drop - t) / np.maximum(dist, 1) >= horizon)
            running &= seen
            cls += running
        cls = np.where(cell > 0, cell, cls)
        ray_cls[k0:k1] = cls[:, n_far:]
        if (k0 // RAY_BATCH) % 10 == 0:
            print(f"rays {k1}/{k_rays} {time.time() - t0:.0f}s", flush=True)

    # back to the grid: each cell takes the nearest ray and sample
    classes = np.empty((g["h"], g["w"]), dtype=np.uint8)
    xx = np.arange(g["w"], dtype=np.float64) + g["x0"] - sx
    for row in range(0, g["h"], 512):
        yy = (np.arange(row, min(row + 512, g["h"]), dtype=np.float64) + g["y0"] - sy)[:, None]
        th = np.arctan2(yy, xx[None, :])
        k = np.clip(np.floor((th - th0) / (th1 - th0) * k_rays).astype(np.int64), 0, k_rays - 1)
        s = np.clip(np.rint(np.hypot(xx[None, :], yy) - r_near).astype(np.int64), 0, len(fine_r) - 1)
        classes[row:row + len(yy)] = ray_cls[k, s]
    keep = status > 0
    classes[keep] = status[keep]
    classes[~in_area] = CLS_OUTSIDE
    np.save(OUT / "classes.npy", classes)
    np.save(OUT / "deck.npy", np.where(in_area, deck, np.nan).astype(np.float32))

    # distances from the summit where observers in the area can be
    res_c = float(res_at(AREA_CENTER["lat"]))
    d_range = [int(r_near * (res_at(lat_s) + res_c) / 2) - 500, int(r_far * (res_at(lat_s) + res_c) / 2) + 500]
    meta = {
        "landmark": LANDMARK, "base_z": LANDMARK.get("base", 0.0), "levels": LEVELS, "radius_m": None,
        "eye_height": EYE_HEIGHT, "refraction_k": REFRACTION_K, "buildings": n_bldg, "bridges": bstats,
        "files": len(landmark_files("bldg")), "area": AREA, "area_center": AREA_CENTER,
        "area_label": LANDMARK.get("area_label"), "d_range": d_range,
    }
    (OUT / "visibility_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    vals, counts = np.unique(classes, return_counts=True)
    print(dict(zip(vals.tolist(), counts.tolist())))
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
