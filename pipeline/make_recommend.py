"""Pick places where the whole landmark is visible from the ground.

Connected areas of the top visibility class (visible down to the lowest
level) are ranked by size, so open places such as riverbanks and parks come
first. Each area is represented by its most inward point, and picks are kept
apart so the list covers different directions.

Output: web/data/<id>_recommend.json

    python pipeline/make_recommend.py
"""
import json
import math

import numpy as np
from scipy import ndimage

from common import CACHE, LANDMARK, LEVELS, WEB, grid_spec, ground_res, px_to_latlon

MIN_DIST_M = 800      # closer than this the tower does not fit a normal frame
MIN_AREA_M2 = 150
MIN_SEPARATION_M = 400
COUNT = 40


def main():
    g = grid_spec()
    res = ground_res()
    classes = np.load(CACHE / "classes.npy")
    yy, xx = np.ogrid[:g["h"], :g["w"]]
    dist = np.hypot(xx - g["cx"], yy - g["cy"]) * res
    mask = (classes == len(LEVELS)) & (dist >= MIN_DIST_M)
    labels, n = ndimage.label(mask, structure=np.ones((3, 3)))
    areas = ndimage.sum_labels(mask, labels, index=np.arange(1, n + 1)) * res * res
    inner = ndimage.distance_transform_edt(mask)
    # most inward cell of each area
    best = ndimage.maximum_position(inner, labels, index=np.arange(1, n + 1))
    order = np.argsort(-areas)
    picks = []
    for i in order:
        if areas[i] < MIN_AREA_M2 or len(picks) >= COUNT:
            break
        y, x = best[i]
        if any(math.hypot(x - px, y - py) * res < MIN_SEPARATION_M for px, py, _ in picks):
            continue
        picks.append((x, y, areas[i]))
    out = []
    for x, y, area in picks:
        lat, lon = px_to_latlon(g["x0"] + x + 0.5, g["y0"] + y + 0.5)
        d = math.hypot(x - g["cx"], y - g["cy"]) * res
        out.append({"lat": round(float(lat), 6), "lon": round(float(lon), 6), "area": int(area), "d": int(d)})
    (WEB / "data" / f"{LANDMARK['id']}_recommend.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"{n} areas, {len(out)} picks; largest {[o['area'] for o in out[:5]]} m2")


if __name__ == "__main__":
    main()
