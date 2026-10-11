# アライメント計測Markの選び方の比較（Python版）

ブラウザ版（リポジトリ直下の `index.html`）と**同じ計算・同じ乱数**で評価するPythonパッケージと、手順を追って使えるJupyterノートブックです。
同じ設定なら、同じShot・Markを選び、同じ残差になります（`tests/` で照合しています）。

## 必要な環境

- Python **3.14.5以上**（`pyproject.toml` の `requires-python` と同じ）
- numpy 2.5以上、matplotlib 3.11以上
- ノートブックを使うときは jupyter 1.1以上

## 準備（初回だけ）

`python/` フォルダで実行します。

```bash
python3.14 -m venv .venv
.venv/bin/pip install -e ".[notebook]"
```

Windows では `.venv\Scripts\pip install -e ".[notebook]"` です。

## 使い方

### ノートブックで使う

```bash
.venv/bin/jupyter lab notebooks/alignment_sampling_evaluation.ipynb
```

上から順に実行すると、計画の作成（制約なし・制約付きのD・I最適）→ 評価 → 表 → 図 → 計測点数のスイープ → CSV保存 まで進みます。計測データのファイル（csv・xlsx）で評価する手順もあります。CSVは `notebooks/output/`（Gitの管理外）に保存されます。

### スクリプトで使う

```python
import alignment_sampling as asc

settings = asc.default_settings()                      # ブラウザ版の初期設定と同じ
wafer_map = asc.generate_wafer_map(settings["map"])
data = asc.generate_evaluation_data(wafer_map, settings["evaluationData"])
plan = asc.plan_from_shot_ids("現行", ["11", "13", "20"], wafer_map)
output = asc.run_evaluation(wafer_map, data, settings, [plan])
print(output["summary"]["constrainedD"]["variants"]["howa"]["x"]["rms"]["all"]["mean"])

# D最適・I最適（制約なし・制約付き）の点だけを作り（評価データは使わない）、座標をCSVにする
settings["constraints"]["mandatoryShotIds"] = ["46", "47"]   # 強制計測Shot（Shot番号）
design_plan = asc.run_plan(wafer_map, settings)                # sets は dOptimal, iOptimal, constrainedD, constrainedI の順
csv_text = asc.selection_to_csv(wafer_map, design_plan["sets"][2]["markIndices"])

# 計測データのファイル（csv・xlsx）で評価する（マップもファイルから作る。実データは data/ に置き、コミットしない）
result = asc.load_measurement_file("../data/計測.xlsx", settings["map"])
print("\n".join(asc.describe_report(result["map"], result["report"])))
file_output = asc.run_evaluation(result["map"], result["data"], settings)
```

計測データのファイルの列は、ブラウザ版と同じアライメント・OVL計測の標準の表（`Wafer, DateTime, shotNo, Direction, Xmm, Ymm, Radius, markNo, markXmm, markYmm, measX, measY, StsX, StsY`）です。詳しくはリポジトリ直下の README を見てください。xlsx も標準ライブラリだけで読みます（追加のパッケージは要りません）。

選んだShotでは、そのShotの有効なMarkをすべて測ります。選び方のキーは `random`・`poisson`・`dOptimal`・`iOptimal`（制約なし）・`constrainedD`・`constrainedI`（制約付き）です。

補正（`settings["model"]["corrections"]` で選ぶ。キーは `output["variants"]` の key）は、`howa`（HOWA）、`rbfXY`・`rbfXYR`・`gpXY`・`gpXYR`（RBF・GPRの式内: 式の中の多項式を補正値にする）、`rbfXYPredict`・`rbfXYRPredict`・`gpXYPredict`・`gpXYRPredict`（予測: 全Markを予測してから多項式を当てはめる）、`measured`（計測値＋HOWA）の10通りです。補正値はどれも X,Y の高次多項式です（計測値＋HOWA の測ったMarkだけ計測値）。

ブラウザ版の「設定をJSONで保存」で作ったファイルは、`asc.load_settings_file(path)` で読み込めます（CSVのマップ・手動プランも入ります）。

## 主な関数

| 関数 | 内容 |
|---|---|
| `default_settings()` | 初期設定（ブラウザ版と同じキー名） |
| `generate_wafer_map(map_settings)` / `parse_map_csv(text, map_settings)` | Waferマップを作る／CSVから読む |
| `generate_evaluation_data(wafer_map, data_settings)` | Zernikeの乱数係数とノイズで評価データを作る |
| `load_measurement_file(path, map_settings)` | 計測データのファイル（.csv・.xlsx）から、マップと評価データを作る（`{"map", "data", "report"}`。無効マークは `map["invalidMarks"]`） |
| `describe_report(wafer_map, report)` | 読み込みの結果（Wafer数・無効マーク・重複行など）を文の一覧にする |
| `plan_from_shot_ids(name, shot_ids, wafer_map)` | Shot番号の一覧から手動プランを作る |
| `run_evaluation(wafer_map, data, settings, manual_plans)` | 選び方 × 補正の評価（ブラウザ版と同じ形の辞書を返す） |
| `run_plan(wafer_map, settings)` | D最適・I最適（制約なし・制約付き）の点だけを選ぶ（アプリの「計画を作成」と同じ。評価データは使わない） |
| `run_sweep(wafer_map, data, settings, sweep_settings, manual_plans)` | 計測Shot数を変えた評価（トレードオフカーブ。比べる選び方は `sweep_settings["methods"]`） |
| `selection_to_csv(wafer_map, mark_indices)` | 選択点の座標のCSV（ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY, WaferX, WaferY） |
| `load_settings_file(path)` | ブラウザ版で保存した設定JSONを読む（版3。版1・2も読み、以前のD最適・I最適は制約付きとして読む） |
| `plots.*` | 選んだ点のマップ（無効マークは ✕）・残差の分布の図（`plot_residual_boxes(output, log_scale=True)` で横軸を対数）・トレードオフカーブ |

## テスト（ブラウザ版との照合）

```bash
.venv/bin/python -m unittest discover -s tests -v
```

基準データ `../tests/reference/scenario_*.json` は、ブラウザ版の計算をそのまま書き出したものです（`node ../tools/export_reference.js` で作り直せます）。
選んだ点は完全一致、数値は相対誤差 1e-9 以内を合格とします。

## 注意事項

- 計算の中身を変えるときは、ブラウザ版・MATLAB版も同じように直し、基準データを作り直してテストしてください。
- 乱数の評価データは模擬データです。実際の計測データのファイルを使う場合は、リポジトリ直下の `data/`（Gitの管理外）に置き、コミットしないでください。
