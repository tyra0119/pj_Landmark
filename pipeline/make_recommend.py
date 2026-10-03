"""Pick places where the whole landmark is visible from the ground.

Connected areas of the top visibility class (visible down to the lowest
level; one or two classes lower where those are rare) are ranked by size, so open places such as riverbanks and parks come
first. Each area is represented by its most inward point, and picks are kept
apart so the list covers different directions.

Output: web/data/<id>_recommend.json

    python pipeline/make_recommend.py
"""
import json
import math

import numpy as np
from scipy import ndimage

from common import LANDMARK, LEVELS, OUT, WEB, grid_spec, ground_res, px_to_latlon

MIN_DIST_M = 800      # closer than this the tower does not fit a normal frame
MIN_AREA_M2 = 150
MIN_SEPARATION_M = 400
COUNT = 40
ENOUGH = 15           # widen the class until this many places are found


def pick_areas(mask, res, picks, cls):
    labels, n = ndimage.label(mask, structure=np.ones((3, 3)))
    if n == 0:
        return
    idx = np.arange(1, n + 1)
    areas = ndimage.sum_labels(mask, labels, index=idx) * res * res
    inner = ndimage.distance_transform_edt(mask)
    best = ndimage.maximum_position(inner, labels, index=idx)   # most inward cell
    for i in np.argsort(-areas):
        if areas[i] < MIN_AREA_M2 or len(picks) >= COUNT:
            break
        y, x = best[i]
        if any(math.hypot(x - p[0], y - p[1]) * res < MIN_SEPARATION_M for p in picks):
            continue
        picks.append((x, y, areas[i], cls))


def main():
    g = grid_spec()
    res = ground_res()
    classes = np.load(OUT / "classes.npy")
    yy, xx = np.ogrid[:g["h"], :g["w"]]
    dist = np.hypot(xx - g["cx"], yy - g["cy"]) * res
    near = dist < MIN_DIST_M
    # the whole tower first; where that is rare (dense high-rises), widen to "almost whole"
    picks = []
    top = len(LEVELS)
    for cls in range(top, 0, -1):
        if len(picks) >= ENOUGH:
            break
        pick_areas((classes >= cls) & (classes <= top) & ~near, res, picks, cls)
    out = []
    for x, y, area, cls in picks:
        lat, lon = px_to_latlon(g["x0"] + x + 0.5, g["y0"] + y + 0.5)
        d = math.hypot(x - g["cx"], y - g["cy"]) * res
        out.append({"lat": round(float(lat), 6), "lon": round(float(lon), 6), "area": int(area), "d": int(d), "cls": cls})
    (WEB / "data" / f"{LANDMARK['id']}_recommend.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{len(out)} picks by class {[o['cls'] for o in out]}")


if __name__ == "__main__":
    main()
