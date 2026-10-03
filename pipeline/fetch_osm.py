"""Fetch expressway and railway bridges from OpenStreetMap (Overpass API).

PLATEAU bridges are often typed "unknown", so OSM tells which decks belong to
expressways or railways, where nobody can stand. Lakes and ponds (closed ways)
fill in where PLATEAU has no water bodies.
Output: CACHE/<landmark>/osm_bridges.json  ({"motorway": [[[lon, lat], ...], ...], "railway": [...]})

    python pipeline/fetch_osm.py
"""
import json
import urllib.parse
import urllib.request

from common import OUT, bbox_lonlat

URL = "https://overpass-api.de/api/interpreter"
QUERY = """[out:json][timeout:120];
(
  way["highway"~"^(motorway|motorway_link)$"]["bridge"]({s},{w},{n},{e});
  way["railway"~"^(rail|subway|light_rail|monorail)$"]["bridge"]({s},{w},{n},{e});
  way["natural"="water"]({s},{w},{n},{e});
);
out geom;"""


def main():
    w, s, e, n = bbox_lonlat()
    body = urllib.parse.urlencode({"data": QUERY.format(s=s, w=w, n=n, e=e)}).encode()
    req = urllib.request.Request(URL, data=body, headers={"User-Agent": "landmark-visibility/0.1 (PLATEAU research)"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.load(r)
    out = {"motorway": [], "railway": [], "water": []}
    for el in data["elements"]:
        if el.get("geometry"):
            tags = el["tags"]
            kind = "water" if tags.get("natural") == "water" else "motorway" if "highway" in tags else "railway"
            out[kind].append([[p["lon"], p["lat"]] for p in el["geometry"]])
    (OUT / "osm_bridges.json").write_text(json.dumps(out), encoding="utf-8")
    print({k: len(v) for k, v in out.items()})


if __name__ == "__main__":
    main()
