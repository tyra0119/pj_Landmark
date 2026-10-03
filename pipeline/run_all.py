"""Run the whole pipeline for one landmark.

    python pipeline/run_all.py tokyotower            # everything
    python pipeline/run_all.py skytree --no-fetch    # reuse downloaded data
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
FETCH = [["fetch_plateau.py", "bldg", "brid", "wtr"], ["fetch_osm.py"], ["fetch_dem.py"]]
BUILD = [["compute_visibility.py"], ["make_tiles.py"], ["make_recommend.py"], ["fetch_climate.py"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("landmark")
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()
    env = {**os.environ, "LANDMARK_ID": args.landmark, "PYTHONIOENCODING": "utf-8"}
    for step in ([] if args.no_fetch else FETCH) + BUILD:
        print(f"== {args.landmark}: {' '.join(step)}", flush=True)
        subprocess.run([sys.executable, str(HERE / step[0]), *step[1:]], cwd=HERE, env=env, check=True)
    print("== shared 3D view tiles", flush=True)
    subprocess.run([sys.executable, str(HERE / "make_view_tiles.py")], cwd=HERE, env=env, check=True)


if __name__ == "__main__":
    main()
