"""How often the sky is clear, by month and hour (past 10 years, Open-Meteo / ERA5).

Used for dates beyond the weather forecast. A clear hour has little cloud
overall and almost no low cloud, which hides a body near the horizon. For a
distant landmark the sky must be clear both where people stand and at the
landmark, so the joint rate is computed from the paired hours.

Output: web/data/<id>_climate.json  {"clear": [[% x 24 hours] x 12 months], ...}

    python pipeline/fetch_climate.py
"""
import json
import urllib.request

import numpy as np

from common import LANDMARK, WEB

URL = ("https://archive-api.open-meteo.com/v1/archive?latitude={lat:.4f}&longitude={lon:.4f}"
       "&start_date={y0}-01-01&end_date={y1}-12-31&hourly=cloud_cover,cloud_cover_low&timezone=Asia%2FTokyo")
YEARS = (2016, 2025)
MAX_TOTAL = 40   # %
MAX_LOW = 20     # %


def clear_hours(lat, lon):
    with urllib.request.urlopen(URL.format(lat=lat, lon=lon, y0=YEARS[0], y1=YEARS[1]), timeout=120) as r:
        h = json.load(r)["hourly"]
    total = np.array(h["cloud_cover"], dtype=float)
    low = np.array(h["cloud_cover_low"], dtype=float)
    month = np.array([int(t[5:7]) for t in h["time"]])
    hour = np.array([int(t[11:13]) for t in h["time"]])
    return (total <= MAX_TOTAL) & (low <= MAX_LOW), month, hour


def main():
    observer = LANDMARK.get("area_center", LANDMARK)
    clear, month, hour = clear_hours(observer["lat"], observer["lon"])
    if LANDMARK.get("far"):
        at_landmark, _, _ = clear_hours(LANDMARK["lat"], LANDMARK["lon"])
        clear &= at_landmark
    table = [[round(float(clear[(month == m) & (hour == h)].mean()) * 100) for h in range(24)] for m in range(1, 13)]
    out = {"clear": table, "years": f"{YEARS[0]}-{YEARS[1]}", "rule": f"雲量{MAX_TOTAL}%以下かつ下層雲{MAX_LOW}%以下",
           "source": "Open-Meteo Historical Weather API (ERA5)"}
    (WEB / "data" / f"{LANDMARK['id']}_climate.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print("clear % by month at 18h:", [row[18] for row in table])


if __name__ == "__main__":
    main()
