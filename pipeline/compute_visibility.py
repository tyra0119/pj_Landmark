"""Compute, for every ground cell, how much of the landmark is visible.

1. Rasterise PLATEAU LOD1 building tops over the GSI ground grid (a DSM).
2. Treat each height in LEVELS on the landmark as a viewpoint and sweep rays
   outward; a ground observer (eye at EYE_HEIGHT) sees that height when the
   line to it clears every obstacle in between (prefix maximum of slopes).
3. Class per cell = number of LEVELS visible contiguously from the top:
   0 = tip hidden, 1 = only the tip, ..., len(LEVELS) = nearly the whole tower.
   CLS_BUILDING / CLS_OUTSIDE mark cells inside buildings / beyond RADIUS_M.

Output: CACHE/classes.npy (uint8 grid) and CACHE/visibility_meta.json.

    python pipeline/compute_visibility.py
"""
import json
import math
import time

import numpy as np
from PIL import Image, ImageDraw

from common import (CACHE, EARTH_R, EYE_HEIGHT, LANDMARK, LEVELS, RADIUS_M, REFRACTION_K,
                    ground_res, grid_spec, world_px)

CLS_BUILDING = 254
CLS_OUTSIDE = 255
RAY_BATCH = 512


def rasterise_buildings(g):
    img = Image.new("F", (g["w"], g["h"]), -1e4)
    draw = ImageDraw.Draw(img)
    polys = []
    seen = set()  # buildings on a ward boundary appear in both wards' files
    for f in sorted((CACHE / "bldg").glob("*.npz")):
        d = np.load(f)
        offsets, coords, base, top = d["offsets"], d["coords"], d["base"], d["top"]
        if len(top) == 0:
            continue
        x, y = world_px(coords[:, 0], coords[:, 1])
        x -= g["x0"]
        y -= g["y0"]
        for i in range(len(top)):
            a, b = offsets[i], offsets[i + 1]
            key = (round(float(x[a]), 1), round(float(y[a]), 1), round(float(top[i]), 1))
            if key in seen:
                continue
            seen.add(key)
            polys.append((float(top[i]), float(top[i] - base[i]), x[a:b], y[a:b]))
    print(f"{len(polys)} buildings", flush=True)
    skipped = 0
    for top, height, x, y in sorted(polys, key=lambda p: p[0]):
        if height > 300:  # the landmark itself
            skipped += 1
            continue
        draw.polygon(list(zip(x.tolist(), y.tolist())), fill=top)
    print(f"skipped {skipped} landmark solids", flush=True)
    return np.asarray(img, dtype=np.float32), len(polys)


def main():
    t0 = time.time()
    g = grid_spec()
    res = ground_res()
    ground = np.load(CACHE / "ground.npy")
    btop, n_bldg = rasterise_buildings(g)
    inside = btop > -1e3
    dsm = np.where(inside, np.maximum(btop, ground), ground).astype(np.float32)
    del btop
    print(f"DSM ready {time.time() - t0:.0f}s", flush=True)

    cx, cy = g["cx"], g["cy"]
    ci, cj = int(round(cy)), int(round(cx))
    r30 = int(30 / res)
    base_z = float(np.median(ground[ci - r30:ci + r30, cj - r30:cj + r30]))
    view_z = np.array([base_z + h for h in LEVELS], dtype=np.float32)

    n = int(RADIUS_M / res)                     # samples per ray, 1 px apart
    k_rays = int(math.ceil(2 * math.pi * n * 1.25))
    r_px = np.arange(1, n + 1, dtype=np.float32)
    r_m = r_px * res
    drop = (r_m ** 2) * (1 - REFRACTION_K) / (2 * EARTH_R)  # curvature minus refraction
    flat_dsm, flat_ground, flat_in = dsm.ravel(), ground.ravel(), inside.ravel()
    ray_cls = np.zeros((k_rays, n), dtype=np.uint8)

    for k0 in range(0, k_rays, RAY_BATCH):
        k1 = min(k0 + RAY_BATCH, k_rays)
        th = (np.arange(k0, k1, dtype=np.float64) * (2 * math.pi / k_rays)).astype(np.float32)
        xs = np.rint(cx + np.cos(th)[:, None] * r_px[None, :]).astype(np.int64)
        ys = np.rint(cy + np.sin(th)[:, None] * r_px[None, :]).astype(np.int64)
        np.clip(xs, 0, g["w"] - 1, out=xs)
        np.clip(ys, 0, g["h"] - 1, out=ys)
        idx = ys * g["w"] + xs
        z = flat_dsm[idx] - drop
        eye = flat_ground[idx] + EYE_HEIGHT - drop
        blocked_cell = flat_in[idx]
        cls = np.zeros(z.shape, dtype=np.uint8)
        running = np.ones(z.shape, dtype=bool)
        for vz in view_z:
            slope = (z - vz) / r_m
            horizon = np.maximum.accumulate(slope, axis=1)
            horizon = np.concatenate([np.full((len(th), 1), -np.inf, np.float32), horizon[:, :-1]], axis=1)
            running &= (eye - vz) / r_m >= horizon
            cls += running
        cls[blocked_cell] = CLS_BUILDING
        ray_cls[k0:k1] = cls
        if (k0 // RAY_BATCH) % 10 == 0:
            print(f"rays {k1}/{k_rays} {time.time() - t0:.0f}s", flush=True)

    classes = np.empty((g["h"], g["w"]), dtype=np.uint8)
    xx = np.arange(g["w"], dtype=np.float32) - cx
    for row in range(0, g["h"], 512):
        yy = (np.arange(row, min(row + 512, g["h"]), dtype=np.float32) - cy)[:, None]
        r = np.hypot(xx[None, :], yy)
        th = np.mod(np.arctan2(yy, xx[None, :]), 2 * math.pi)
        k = np.mod(np.rint(th / (2 * math.pi) * k_rays).astype(np.int64), k_rays)
        s = np.clip(np.rint(r).astype(np.int64) - 1, 0, n - 1)
        c = ray_cls[k, s]
        c[r > n] = CLS_OUTSIDE
        classes[row:row + len(yy)] = c
    classes[inside & (classes != CLS_OUTSIDE)] = CLS_BUILDING
    np.save(CACHE / "classes.npy", classes)

    meta = {
        "landmark": LANDMARK,
        "base_z": round(base_z, 2),
        "levels": LEVELS,
        "radius_m": RADIUS_M,
        "eye_height": EYE_HEIGHT,
        "refraction_k": REFRACTION_K,
        "buildings": n_bldg,
        "files": len(list((CACHE / "bldg").glob("*.npz"))),
    }
    (CACHE / "visibility_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    vals, counts = np.unique(classes, return_counts=True)
    print(dict(zip(vals.tolist(), counts.tolist())))
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
