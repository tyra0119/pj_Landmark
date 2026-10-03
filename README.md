# Landmark

Project PLATEAU の3D都市モデルを使い、ランドマーク（富士山・東京スカイツリー・東京タワーなど）が**地上から**見える場所を提案するアプリ。

建物による遮蔽と天体（太陽・月）の位置を組み合わせ、「いつ・どこに立てば、ランドマークと月や太陽が重なって見えるか」を地図上で探せることを目指す。

## アプリ

**スカイツリー × 月**：https://tyra0119.github.io/pj_Landmark/

- 日付を選ぶと、月（または太陽）がスカイツリーの先端に重なって見える地上の場所と時刻を地図に表示
- 地図をタップすると、その地点から重なる日時を1年分探す
- スカイツリーがどこからどれだけ見えるかを色分け表示（半径8km）

## 構成

- `index.html` / `app.js` / `style.css`：Webアプリ（静的ファイル。MapLibre GL JS + Astronomy Engine）
- `tiles/` / `data/`：可視判定の結果（地図タイルとメタデータ）
- [pipeline/](pipeline/)：PLATEAUと標高データから可視判定タイルを作る処理（使い方は [pipeline/README.md](pipeline/README.md)。出力先は `web/` なので、生成後にリポジトリ直下へコピーする）
- [docs/](docs/)：企画・調査・作業ログ

## ドキュメント

- [コンセプト](docs/01_コンセプト.md)
- [類似サービス調査](docs/02_類似サービス調査.md)
- [作業ログ](docs/03_作業ログ.md)
- [MVP：スカイツリー×月](docs/04_MVP_スカイツリー×月.md)

## データ

- [Project PLATEAU](https://www.mlit.go.jp/plateau/)（国土交通省、CC BY 4.0）
- [地理院タイル](https://maps.gsi.go.jp/development/ichiran.html)（標高・背景地図）
