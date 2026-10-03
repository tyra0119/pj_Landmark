"""Public-transport data for the app: stations with first/last trains, bike-share ports.

- Stations, railways and first/last trains come from the ODPT (公共交通オープンデータ
  センター) data built by the sibling `iss` project (scripts/build-transit.mjs ->
  data/transit.json); only stations near the observer areas are kept.
- Bike-share ports (GBFS station_information) are fetched through the ODPT relay
  (https://tyra.jp/odpt/api/, no token needed here); the app reads live bike
  counts from the same relay.

Output: web/data/transit.json, web/data/cycle.json

    python pipeline/make_transit.py
"""
import json
import math
import os
import urllib.request
from pathlib import Path

from common import LANDMARKS, WEB

ISS = Path(os.environ.get("ISS_DIR", Path(__file__).resolve().parents[2] / "iss"))
RELAY = "https://tyra.jp/odpt/api/main/v4/gbfs"
GBFS_SYSTEMS = ["docomo-cycle-tokyo", "docomo-cycle", "hellocycling"]
STATION_MARGIN_M = 2500
PORT_MARGIN_M = 800


def dist(lat1, lon1, lat2, lon2):
    p = math.pi / 180
    a = math.sin((lat2 - lat1) * p / 2) ** 2 + math.cos(lat1 * p) * math.cos(lat2 * p) * math.sin((lon2 - lon1) * p / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(a))


def areas():
    out = []
    for lm in LANDMARKS.values():
        out += lm.get("area") or [{"lat": lm["lat"], "lon": lm["lon"], "r": 8000.0}]
    return out


def near(lat, lon, margin):
    return any(dist(lat, lon, c["lat"], c["lon"]) <= c["r"] + margin for c in areas())


def main():
    src = json.loads((ISS / "data" / "transit.json").read_text(encoding="utf-8"))
    railways = {r["id"]: r for r in src["railways"]}
    stations, used = [], set()
    for i, s in enumerate(src["stations"]):
        if not near(s["lat"], s["lon"], STATION_MARGIN_M):
            continue
        fl = src["fl"].get(str(i), {}).get(s["r"], {})
        stations.append({"id": s["id"], "n": s["n"], "lat": s["lat"], "lon": s["lon"], "r": s["r"], "fl": fl})
        used.add(s["r"])
    out = {
        "source": "公共交通オープンデータセンター（ODPT）の路線・駅・時刻表データ",
        "generated": src["generated"][:10],
        "railways": {k: {"n": railways[k]["n"], "op": railways[k]["op"], "c": railways[k].get("c")} for k in sorted(used)},
        "stations": stations,
    }
    (WEB / "data" / "transit.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"stations {len(stations)} on {len(used)} railways (data {out['generated']})")

    ports = []
    for sys in GBFS_SYSTEMS:
        req = urllib.request.Request(f"{RELAY}/{sys}/station_information.json", headers={"User-Agent": "landmark-visibility/0.1"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.load(r)
        n = 0
        for s in data["data"]["stations"]:
            if near(s["lat"], s["lon"], PORT_MARGIN_M):
                ports.append({"id": str(s["station_id"]), "sys": sys, "n": s.get("name"), "lat": s["lat"], "lon": s["lon"]})
                n += 1
        print(f"{sys}: {n} ports")
    (WEB / "data" / "cycle.json").write_text(json.dumps({"systems": GBFS_SYSTEMS, "ports": ports}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
