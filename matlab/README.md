# アライメント計測Markの選び方の比較（MATLAB版）

ブラウザ版（リポジトリ直下の `index.html`）・Python版と**同じ計算・同じ乱数**で評価するMATLABのパッケージ（`+asc`）と、セクションごとに実行できる手順スクリプトです。
同じ設定なら、同じShot・Markを選び、同じ残差になります（`tests/` で照合しています）。

## 必要な環境

- MATLAB **R2021a以上**（`pagemtimes` の転置指定と、名前=値の引数を使うため）。R2022b で確認済み
- 追加の Toolbox は不要（統計・最適化の Toolbox を使わずに書いています）

## 使い方

### 手順スクリプトで使う

MATLAB で `alignment_sampling_evaluation.m` を開き、セクション（`%%`）ごとに「セクションの実行」で進めます。
計画の作成（制約付きD・I最適）→ 評価 → 表 → 図 → 計測点数のスイープ → CSV保存 まで進みます。CSVは `output/`（Gitの管理外）に保存されます。

### 自分のスクリプトで使う

```matlab
addpath('（このフォルダの場所）');
settings = asc.defaultSettings();                          % ブラウザ版の初期設定と同じ
waferMap = asc.generateWaferMap(settings.map);
data = asc.generateEvaluationData(waferMap, settings.evaluationData);
plan = asc.planFromShotIds('現行', {'11', '13', '20'}, waferMap);
output = asc.runEvaluation(waferMap, data, settings, plan);
m = find(strcmp({output.methods.key}, 'constrainedD'));
v = find(strcmp({output.variants.key}, 'howa'));
output.summary(m).variants(v).x.rms.all.mean              % 制約付きD最適・HOWAのみ・X の RMS のWafer平均

% 制約付きD最適・I最適の点だけを作り（評価データは使わない）、座標をCSVの文字にする
settings.constraints.mandatoryShotIds = {'46'; '47'};     % 強制計測Shot（Shot番号）
designPlan = asc.runPlan(waferMap, settings);
csvText = asc.selectionToCsv(waferMap, designPlan.sets(1).markIndices);
```

選んだShotでは、そのShotの有効なMarkをすべて測ります。選び方のキーは `random`・`poisson`・`dOptimal`・`iOptimal`（制約なし）・`constrainedD`・`constrainedI`（制約付き）です。

ブラウザ版の「設定をJSONで保存」で作ったファイルは `asc.loadSettingsFile(path)` で読み込めます（CSVのマップ・手動プランも入ります。`asc.mapFromLoaded`、`asc.manualPlanInputs` を参照）。

### Python版との違い

- 番号（Shot・Mark・候補・選び方の並び）はすべて **1始まり** です。設定の多項式の項の番号（`termsX` など）だけは、ブラウザ版の設定JSONと同じ0始まりです。
- 結果は、`output.methods`・`output.variants`・`output.estimationKeys` と同じ並びの構造体配列で持ちます（キーに `:` を含むため、フィールド名にはしていません）。
- Waferマップは、Markごと・Shotごとの列（`markX`、`markY`、`shotIds` など）で持ちます。

## 主な関数（`asc.` を付けて呼ぶ）

| 関数 | 内容 |
|---|---|
| `defaultSettings()` | 初期設定（ブラウザ版の設定JSONと同じ形の構造体） |
| `generateWaferMap(mapSettings)` / `parseMapCsv(text, mapSettings)` / `mapToCsv(waferMap)` | Waferマップを作る／CSVから読む／CSVにする |
| `generateEvaluationData(waferMap, dataSettings)` | Zernikeの乱数係数とノイズで評価データを作る |
| `planFromShotIds(name, shotIds, waferMap)` | Shot番号の一覧から手動プランを作る |
| `runEvaluation(waferMap, data, settings, manualPlans)` | 選び方 × 補正の評価 |
| `runPlan(waferMap, settings)` | 制約付きD最適・I最適の点だけを選ぶ（アプリの「計画を作成」と同じ。評価データは使わない） |
| `runSweep(waferMap, data, settings, sweepSettings, manualPlans)` | 計測Shot数を変えた評価（トレードオフカーブ。比べる選び方は `sweepSettings.methods`） |
| `selectionToCsv(waferMap, markIndices)` | 選択点の座標のCSVの文字（ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY, WaferX, WaferY） |
| `loadSettingsFile(path)` | ブラウザ版で保存した設定JSONを読む（版3。版1・2も読み、以前のD最適・I最適は制約付きとして読む） |
| `plotSelectionMap` / `plotResidualBoxes` / `plotSweep` / `plotEstimationErrorMap` | 選んだ点のマップ・箱ひげ図・トレードオフカーブ・推定誤差マップ |

## テスト（ブラウザ版との照合）

このフォルダで実行します。

```matlab
results = runtests('tests'); table(results)
```

基準データ `../tests/reference/scenario_*.json` は、ブラウザ版の計算をそのまま書き出したものです（`node ../tools/export_reference.js` で作り直せます）。
選んだ点は完全一致、数値は相対誤差 1e-9 以内を合格とします。

## 注意事項

- 計算の中身を変えるときは、ブラウザ版・Python版も同じように直し、基準データを作り直してテストしてください。
- このMacの MATLAB（Rosetta経由）では、初期設定の評価に約16秒、手順スクリプト全体に数分かかります（選んだShotのMarkをすべて測り、6つの選び方を比べるため）。Windows の会社PCでの速さと図の見た目は未確認です。
- 評価データは乱数で作る模擬データです。実データを使う場合も、リポジトリにはコミットしないでください。
