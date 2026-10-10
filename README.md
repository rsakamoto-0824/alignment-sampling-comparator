# alignment-sampling-comparator

Wafer高次補正（HOWA）のアライメント計測で、**計測するMarkの選び方**を条件制約つきで比べるブラウザアプリです。

- 選び方: ランダム、ポアソンディスク、D最適・I最適（制約なし）、制約付きD最適・制約付きI最適と、人が選ぶ「手動プラン」（名前付きで10個まで。マップのクリックかShot番号の貼り付けで作り、現行のサンプリングなどを同列に比べる）。どの選び方も、選んだShotに紐づくMark（有効範囲の中にあるもの）をすべて測る。Markが揃わない端のShotを選ばない設定もできる
- 条件制約: Scan方向のUp/Downがほぼ同数、4象限がほぼ均等、同心円の3領域がほぼ均等、中心に最も近い1点を必ず測る（オン・オフ、ハード・ソフト、優先度を指定）。強制計測Shot（必ず測る）と除外Shot（選ばない）をShot番号で指定できる
- 計画を作成: Waferマップと制約だけから、制約付きD最適・I最適の計測点をすぐに出す（評価データは使わない）。マップに表示し、座標をCSVで保存できる
- Waferマップ: Scan方向は初期設定で露光順の一筆書き（行ごとに折り返し、1 Shot進むごとにUp/Downを交互）。マップにShot番号を表示する
- 補正の流れ: HOWAのみ／推定→HOWA（未計測Markを推定して埋め、全Markに多項式）
- 推定手法: RBF とガウス過程回帰を、説明変数 X,Y と X,Y,半径 で（4通り）。ガウス過程回帰はWaferごとに計測点で学習する
- 評価データ: Zernike（Fringe Z1〜Z36）の乱数係数で作ったWafer高次傾向。6次以上の項・計測ノイズ・Scan方向のずれで「多項式で補正できない成分」も入れられる
- 評価: 全Waferの全Markで残差（RMS・|平均|+3σ・最大）を求め、一覧表・箱ひげ図・表で比べる。選び方ごとに選んだ点のマップも並べて見比べられる
- 推定精度: RBF・GPが未計測Markのずれをどれだけ当てられるか（推定値 − 真のずれ）を、多項式の予測と比べる。Markごとの誤差のマップも出す
- 計測点数のスイープ: 計測Shot数を変えながら評価し、計測Mark数（計測コスト）と精度のトレードオフカーブを描く。比べる選び方を選べ（制約なし・制約付きのD最適・I最適を含む）、目標の精度に届く最小の計測Mark数も出す
- 選択点のCSV: 「マップと選択点」「選び方ごとのマップ」で表示中の選択点の座標を、1行1Mark（ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY, WaferX, WaferY）で保存できる

要件は [requirements.md](requirements.md)、設計は [design.md](design.md)、課題は [issues.md](issues.md) にあります。

同じ評価を **Python（Jupyterノートブック）** と **MATLAB** でも行えます。同じ設定なら、同じ点を選び、同じ残差になります（3つの版を自動テストで照合しています）。
アプリで条件を決めて設定JSONを保存し、Python・MATLABで細かい解析や大量の条件の計算をする、という使い分けができます。

- Python版: [python/README.md](python/README.md)（ノートブック `python/notebooks/alignment_sampling_evaluation.ipynb`）
- MATLAB版: [matlab/README.md](matlab/README.md)（手順スクリプト `matlab/alignment_sampling_evaluation.m`）

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
4. 「4. サンプリング」「5. 条件制約」で計測Shot数・制約（強制計測Shot・除外Shotを含む）を決める
5. 制約付きD最適・I最適の点だけを見たいときは「計画を作成」を押す（すぐに終わる）。「表示中の選択点をCSVで保存」で座標を保存できる
6. 人が選んだ点と比べたいときは「マップと選択点」で手動プランを作る（Shotをクリック、またはShot番号を貼り付け）
7. 「評価を実行」を押し、「評価結果」で比べ、「選び方ごとのマップ」で選んだ点を見比べる
8. 計測点の数を決めたいときは「計測点数のスイープ」のタブで比べる選び方を選び、「スイープを実行」を押す

初期設定（Wafer 100枚、ランダム・ポアソンは30回試行、6つの選び方、比べる補正5通り）なら、計算は8秒前後で終わります。推定手法を減らすと速くなります。

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
CSVで読み込んだマップのScan方向は、CSVの ScanDir をそのまま使います（一筆書きなどの並べ方は、生成したマップだけに使います）。

### 選択点のCSV（保存）

「マップと選択点」の「表示中の選択点をCSVで保存」と、「選び方ごとのマップ」の各マップの「この選択点をCSVで保存」で、
表示中の選択点を1行1Markで保存します。列はマップのCSVと同じ並びに、Wafer座標を足したものです。

| 列 | 内容 |
|---|---|
| ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY | マップのCSVと同じ（Shot中心とShot中心からのMark座標 [mm]） |
| WaferX, WaferY | Wafer中心からのMark座標（= ShotX + MarkX, ShotY + MarkY）[mm] |

ExcelでもShot番号の順に並び、文字化けしないようにBOM付きのUTF-8で保存します。

## テスト

計算部分（画面以外）の自動テストを Node.js で実行できます。

```bash
node tests/run_tests.js
```

Python版・MATLAB版がブラウザ版と同じ結果になるかは、ブラウザ版の計算を書き出した基準データ（`tests/reference/`）と照合します。計算の中身を変えたら、基準データを作り直してから、それぞれのテストを実行します。

```bash
node tools/export_reference.js
```

```bash
cd python && .venv/bin/python -m unittest discover -s tests -v
```

MATLAB版は `matlab` フォルダで `runtests('tests')` を実行します。

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
│   ├── manual-plans.js     手動プラン（人が選んだShot）の管理
│   ├── ui-*.js             画面の部品（設定欄・マップ・結果・選び方ごとのマップ・スイープ）
│   └── app.js              画面全体のまとめ役
├── samples/sample_map.csv  マップCSVの見本
├── tests/run_tests.js      自動テスト（Node.js）
├── tests/reference/        Python版・MATLAB版の照合用の基準データ（ブラウザ版の計算結果）
├── tools/export_reference.js  基準データを作る
├── python/                 Python版（alignment_sampling パッケージ・ノートブック・照合テスト）
└── matlab/                 MATLAB版（+asc パッケージ・手順スクリプト・照合テスト）
```

## 必要な環境変数

ありません。外部サービスへの通信もしません（計算はすべてブラウザの中で行います）。

## 注意事項

- 評価データはすべて乱数です。実測データは読み込みません。
- 実際のWaferマップ（製品のShot配置など）をCSVで読み込んで使う場合、そのCSVや保存した設定JSONをこのリポジトリにコミットしないでください。
- 多項式で表せる成分だけで計測ノイズがないと、どの選び方でも残差はほぼ0になり差が出ません。6次以上のZernike項や計測ノイズを入れて比べてください。
- 参考にした特許: ASML US20120218533A1（RBFのアライメントモデル）、US9291916B2（HOWAなどの高次モデル）。
