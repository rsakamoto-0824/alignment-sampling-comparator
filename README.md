# alignment-sampling-comparator

Wafer高次補正（HOWA）のアライメント計測で、**計測するMarkの選び方**を条件制約つきで比べるブラウザアプリです。

- 選び方: ランダム、ポアソンディスク、D最適、I最適、手動（マップをクリック）
- 条件制約: Scan方向のUp/Downがほぼ同数、4象限がほぼ均等、同心円の3領域がほぼ均等、中心に最も近い1点を必ず測る（オン・オフ、ハード・ソフト、優先度を指定）
- 補正の流れ: HOWAのみ／推定→HOWA（未計測Markを推定して埋め、全Markに多項式）／HOWA＋推定（多項式の取り残しを推定して足す）
- 推定手法: RBF とガウス過程回帰を、説明変数 X,Y と X,Y,半径 で（4通り）。ガウス過程回帰はWaferごとに計測点で学習する
- 評価データ: Zernike（Fringe Z1〜Z36）の乱数係数で作ったWafer高次傾向。6次以上の項・計測ノイズ・Scan方向のずれで「多項式で補正できない成分」も入れられる
- 評価: 全Waferの全Markで残差（RMS・|平均|+3σ・最大）を求め、一覧表・箱ひげ図・表で比べる。選び方ごとに選んだ点のマップも並べて見比べられる

要件は [requirements.md](requirements.md)、設計は [design.md](design.md)、課題は [issues.md](issues.md) にあります。

## 実行方法

インストールとサーバーは要りません。`index.html` をブラウザ（Microsoft Edge か Google Chrome）で開くだけで動きます。

```bash
open -a "Microsoft Edge" index.html
```

Windowsでは `index.html` をダブルクリックするか、Edgeにドラッグします。

### 使う順番

1. 「1. Waferマップ」でShotとMarkを用意する（生成するか、CSVを読み込む）
2. 「2. 評価データ」でZernike項の大きさ、計測ノイズ、Scan方向のずれを決める
3. 「3. 補正モデル」でHOWAの多項式の項（21項から選ぶ）、比べる補正の流れ、推定手法を選ぶ
4. 「4. サンプリング」「5. 条件制約」で計測Shot数・必ず測るMark・制約を決める
5. 必要なら「マップと選択点」で手動選択を作る
6. 「評価を実行」を押し、「評価結果」で比べ、「選び方ごとのマップ」で選んだ点を見比べる

初期設定（Wafer 100枚、ランダム・ポアソンは30回試行、比べる補正9通り）なら、計算は5秒前後で終わります。推定手法を減らすと速くなります。

### WaferマップのCSV

1行1Markで、次の列を持つCSVです（見本: [samples/sample_map.csv](samples/sample_map.csv)）。

| 列 | 内容 |
|---|---|
| ShotId | Shotを区別する値 |
| ShotX, ShotY | Shot中心の座標（Wafer中心が原点）[mm] |
| ScanDir | `Up` / `Down`（`U` / `D`、`上` / `下`、`+1` / `-1` も可） |
| MarkNo | Shot内のMark番号（1以上の整数） |
| MarkX, MarkY | Shot中心からのMark座標 [mm] |

Shotの幅と高さは画面で入れます（マップの描画に使います）。有効半径（初期値150 mm）以上にあるMarkは使いません。

## テスト

計算部分（画面以外）の自動テストを Node.js で実行できます。

```bash
node tests/run_tests.js
```

## ファイル構成

```text
alignment-sampling-comparator/
├── index.html              画面
├── src/css/style.css       見た目
├── src/js/
│   ├── constants.js        定数と初期設定
│   ├── math-utils.js       乱数・行列・統計
│   ├── zernike.js          Zernike（Fringe Z1〜Z36）
│   ├── wafer-map.js        マップの生成・CSV
│   ├── evaluation-data.js  評価データ（傾向とノイズ）
│   ├── correction.js       HOWA・推定手法（RBF・ガウス過程回帰）・補正の流れ
│   ├── constraints.js      条件制約の判定
│   ├── sampling.js         5つの選び方
│   ├── evaluator.js        評価の全体の流れと集計
│   ├── ui-*.js             画面の部品（設定欄・マップ・結果・選び方ごとのマップ）
│   └── app.js              画面全体のまとめ役
├── samples/sample_map.csv  マップCSVの見本
└── tests/run_tests.js      自動テスト（Node.js）
```

## 必要な環境変数

ありません。外部サービスへの通信もしません（計算はすべてブラウザの中で行います）。

## 注意事項

- 評価データはすべて乱数です。実測データは読み込みません。
- 実際のWaferマップ（製品のShot配置など）をCSVで読み込んで使う場合、そのCSVや保存した設定JSONをこのリポジトリにコミットしないでください。
- 多項式で表せる成分だけで計測ノイズがないと、どの選び方でも残差はほぼ0になり差が出ません。6次以上のZernike項や計測ノイズを入れて比べてください。
- 参考にした特許: ASML US20120218533A1（RBFのアライメントモデル）、US9291916B2（HOWAなどの高次モデル）。
