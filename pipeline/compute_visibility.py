"""Compute, for every ground cell, how much of the landmark is visible.

1. Build the obstacle surface: GSI ground + PLATEAU LOD1 building tops +
   bridge decks (LOD2 OuterFloorSurface, plus a parapet).
2. Build the standing surface: ground, or the deck on bridges people can walk
   on. Water, buildings and expressway/railway decks are not standable; OSM
   expressway/railway bridges decide which PLATEAU decks those are.
3. Treat each height in LEVELS on the landmark as a viewpoint and sweep rays
   outward; an observer (eye EYE_HEIGHT above the standing surface) sees that
   height when the line to it clears every obstacle in between.
4. Class per cell = number of LEVELS visible contiguously from the top:
   0 = tip hidden, 1 = only the tip, ..., len(LEVELS) = nearly the whole tower.
   CLS_* codes >= 252 mark cells where nobody can stand or outside RADIUS_M.

Output (in CACHE/<landmark>/): classes.npy (uint8), deck.npy (walkable deck
height, NaN elsewhere) and visibility_meta.json.

    python pipeline/compute_visibility.py
"""
import json
import math
import time

import numpy as np
from PIL import Image, ImageDraw

from common import (EARTH_R, EXCLUDE_MIN_HEIGHT, EXCLUDE_RADIUS_M, EYE_HEIGHT, LANDMARK, LEVELS, OUT,
                    RADIUS_M, REFRACTION_K, ground_res, grid_spec, landmark_files, world_px)

CLS_VIADUCT = 252   # expressway / railway deck, or the street under it
CLS_WATER = 253
CLS_BUILDING = 254
CLS_OUTSIDE = 255
RAY_BATCH = 512
PARAPET = 1.2       # railing / noise barrier on top of a deck [m]
WALKABLE = {1, 5, 7, 8, 99}   # road, sidewalk, footbridge, deck, unknown
OSM_WIDTH = {"motorway": 14.0, "railway": 10.0}  # corridor width [m]
# assumed deck height above ground where only OSM knows about a viaduct
OSM_HEIGHT = {"motorway": 12.0, "railway": 8.0}


def rasterise_buildings(g):
    img = Image.new("F", (g["w"], g["h"]), -1e4)
    draw = ImageDraw.Draw(img)
    polys = []
    seen = set()  # buildings on a ward boundary appear in both wards' files
    for f in landmark_files("bldg"):
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
    r_ex = EXCLUDE_RADIUS_M / ground_res()
    for top, height, x, y in sorted(polys, key=lambda p: p[0]):
        near = math.hypot(float(x.mean()) - g["cx"], float(y.mean()) - g["cy"]) < r_ex
        if height > 300 or (near and height > EXCLUDE_MIN_HEIGHT):  # the landmark itself
            skipped += 1
            continue
        draw.polygon(list(zip(x.tolist(), y.tolist())), fill=top)
    print(f"skipped {skipped} landmark solids", flush=True)
    return np.asarray(img, dtype=np.float32), len(polys)


def to_px(coords, g):
    x, y = world_px(coords[:, 0], coords[:, 1])
    return x - g["x0"], y - g["y0"]


def rasterise_water(g):
    img = Image.new("L", (g["w"], g["h"]), 0)
    draw = ImageDraw.Draw(img)
    for f in landmark_files("wtr"):
        d = np.load(f)
        if len(d["interior"]) == 0:
            continue
        x, y = to_px(d["coords"], g)
        off = d["offsets"]
        for i, interior in enumerate(d["interior"]):
            a, b = off[i], off[i + 1]
            if b - a >= 3:
                draw.polygon(list(zip(x[a:b].tolist(), y[a:b].tolist())), fill=0 if interior else 1)
    return np.asarray(img, dtype=bool)


def rasterise_osm(g):
    """Expressway / railway bridge corridors: mask and assumed deck height above ground."""
    res = ground_res()
    img = Image.new("F", (g["w"], g["h"]), 0)
    draw = ImageDraw.Draw(img)
    data = json.loads((OUT / "osm_bridges.json").read_text(encoding="utf-8"))
    for kind in ("railway", "motorway"):
        for line in data[kind]:
            x, y = to_px(np.array(line)[:, ::-1], g)  # OSM is (lon, lat)
            draw.line(list(zip(x.tolist(), y.tolist())), fill=OSM_HEIGHT[kind], width=max(1, int(round(OSM_WIDTH[kind] / res))))
    height = np.asarray(img, dtype=np.float32)
    return height > 0, height


def rasterise_bridges(g, osm):
    """Return (obstacle top, walkable deck height or NaN, non-standable mask, stats)."""
    top_img = Image.new("F", (g["w"], g["h"]), -1e4)
    deck_img = Image.new("F", (g["w"], g["h"]), -1e4)
    id_img = Image.new("I", (g["w"], g["h"]), 0)
    top_draw, deck_draw, id_draw = ImageDraw.Draw(top_img), ImageDraw.Draw(deck_img), ImageDraw.Draw(id_img)
    functions = [0]
    decks = []
    for f in landmark_files("brid"):
        d = np.load(f)
        base_id = len(functions)
        functions += d["function"].tolist()
        has_deck = np.zeros(len(d["function"]), dtype=bool)
        if len(d["deck_z"]):
            x, y = to_px(d["deck_coords"], g)
            off = d["deck_offsets"]
            for k in range(len(d["deck_z"])):
                a, b = off[k], off[k + 1]
                if b - a >= 3:
                    owner = int(d["deck_owner"][k])
                    decks.append((float(d["deck_z"][k]), base_id + owner, list(zip(x[a:b].tolist(), y[a:b].tolist()))))
                    has_deck[owner] = True
        # bridges without a deck model: the LOD1 prism is a plain obstacle nobody stands in
        x, y = to_px(d["fp_coords"], g)
        off = d["fp_offsets"]
        for i in np.where(~has_deck)[0]:
            a, b = off[i], off[i + 1]
            if b - a >= 3:
                pts = list(zip(x[a:b].tolist(), y[a:b].tolist()))
                top_draw.polygon(pts, fill=float(d["top"][i]))
                id_draw.polygon(pts, fill=-1)
    for z, bid, pts in sorted(decks, key=lambda t: t[0]):
        deck_draw.polygon(pts, fill=z)
        top_draw.polygon(pts, fill=z + PARAPET)
        id_draw.polygon(pts, fill=bid)
    deck = np.asarray(deck_img, dtype=np.float32)
    top = np.asarray(top_img, dtype=np.float32)
    ids = np.asarray(id_img, dtype=np.int32)

    # people can stand on a deck unless its type says otherwise or OSM maps an
    # expressway / railway bridge over most of it
    functions = np.array(functions)
    on_deck = ids > 0
    px_count = np.bincount(ids[on_deck], minlength=len(functions))
    osm_count = np.bincount(ids[on_deck & osm], minlength=len(functions))
    walk = np.isin(functions, list(WALKABLE)) & (osm_count <= 0.3 * np.maximum(px_count, 1))
    walk[0] = False
    walk_cell = on_deck & walk[np.where(on_deck, ids, 0)]
    deck = np.where(walk_cell, deck, np.nan).astype(np.float32)
    blocked = (ids != 0) & ~walk_cell
    has = px_count > 0
    stats = {"total": int(len(functions) - 1), "walkable": int((walk & has).sum()), "not_walkable": int((~walk & has).sum() - 1)}
    return top, deck, blocked, stats


def build_surfaces(g, t0):
    """Obstacle surface, standing surface, cell status and walkable deck heights."""
    ground = np.load(OUT / "ground.npy")
    btop, n_bldg = rasterise_buildings(g)
    inside = btop > -1e3
    dsm = np.where(inside, np.maximum(btop, ground), ground).astype(np.float32)
    del btop
    water = rasterise_water(g)
    osm, osm_h = rasterise_osm(g)
    brtop, deck, viaduct, bstats = rasterise_bridges(g, osm)
    dsm = np.maximum(dsm, brtop)
    # viaducts PLATEAU does not model (e.g. parts of the Shuto expressway)
    osm_only = osm & ~(brtop > -1e3) & ~inside
    dsm = np.where(osm_only, np.maximum(dsm, ground + osm_h + PARAPET), dsm)
    viaduct |= osm_only
    bstats["osm_only_px"] = int(osm_only.sum())
    del brtop, osm, osm_h, osm_only
    on_deck = ~np.isnan(deck)
    stand = np.where(on_deck, deck, ground).astype(np.float32)
    status = np.zeros(ground.shape, dtype=np.uint8)
    status[viaduct] = CLS_VIADUCT
    status[water & ~on_deck] = CLS_WATER
    status[inside] = CLS_BUILDING
    print(f"DSM ready {time.time() - t0:.0f}s  bridges {bstats}  water {water.mean():.1%}", flush=True)
    return ground, dsm, stand, status, deck, n_bldg, bstats


def main():
    t0 = time.time()
    g = grid_spec()
    res = ground_res()
    ground, dsm, stand, status, deck, n_bldg, bstats = build_surfaces(g, t0)

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
    flat_dsm, flat_stand, flat_status = dsm.ravel(), stand.ravel(), status.ravel()
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
        eye = flat_stand[idx] + EYE_HEIGHT - drop
        cell_status = flat_status[idx]
        cls = np.zeros(z.shape, dtype=np.uint8)
        running = np.ones(z.shape, dtype=bool)
        for vz in view_z:
            slope = (z - vz) / r_m
            horizon = np.maximum.accumulate(slope, axis=1)
            horizon = np.concatenate([np.full((len(th), 1), -np.inf, np.float32), horizon[:, :-1]], axis=1)
            running &= (eye - vz) / r_m >= horizon
            cls += running
        cls = np.where(cell_status > 0, cell_status, cls)
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
    keep = (status > 0) & (classes != CLS_OUTSIDE)
    classes[keep] = status[keep]
    np.save(OUT / "classes.npy", classes)
    np.save(OUT / "deck.npy", deck)

    meta = {
        "landmark": LANDMARK,
        "base_z": round(base_z, 2),
        "levels": LEVELS,
        "radius_m": RADIUS_M,
        "eye_height": EYE_HEIGHT,
        "refraction_k": REFRACTION_K,
        "buildings": n_bldg,
        "bridges": bstats,
        "files": len(landmark_files("bldg")),
    }
    (OUT / "visibility_meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    vals, counts = np.unique(classes, return_counts=True)
    print(dict(zip(vals.tolist(), counts.tolist())))
    print(f"done {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
