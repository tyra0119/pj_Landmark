# 可視判定パイプライン

PLATEAUの建物データと国土地理院の標高から、スカイツリーがどこからどれだけ見えるかを計算し、Webアプリ用のタイル（`web/tiles/`）とメタデータ（`web/data/skytree.json`）を作ります。

## 実行

```bash
pip install -r pipeline/requirements.txt
cd pipeline
python fetch_buildings.py   # PLATEAU CityGML（約21GB）を取得し、LOD1だけ抜き出す（8並列で十数分）
python fetch_dem.py         # 地理院の標高タイル（dem5a → dem5b → dem10b）
python compute_visibility.py  # 建物の高さを敷き詰めた地表モデルで可視判定（約30秒）
python make_tiles.py        # XYZタイルとメタデータを書き出す
```

中間データは `~/.cache/landmark`（環境変数 `LANDMARK_CACHE` で変更可）に置きます。CityGMLは1ファイルずつ取得→抽出→削除するので、ディスクに残るのは約400MBです。

## 方法

- 解析グリッド：Webメルカトルのズーム16のピクセル（約1.94m）。スカイツリーから半径8km
- 地表モデル：地理院の標高 + PLATEAUのLOD1建物（立体の上端の標高）
- 可視判定：スカイツリーの高さ630/500/450/350/250/150/50mを視点にして放射状にレイを飛ばし、障害物の仰角の累積最大と目の高さ（地面+1.6m）を比べる。地球の丸みと大気差（k=0.13）を補正
- 分類：上から連続して見える段数（0＝先端が見えない、7＝ほぼ全体）。建物の中は対象外

## 設定

`common.py` の `LANDMARK`、`RADIUS_M`、`LEVELS` などで変えられます。
