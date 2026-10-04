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

上から順に実行すると、評価 → 表 → 図 → 計測点数のスイープ → CSV保存 まで進みます。CSVは `notebooks/output/`（Gitの管理外）に保存されます。

### スクリプトで使う

```python
import alignment_sampling as asc

settings = asc.default_settings()                      # ブラウザ版の初期設定と同じ
wafer_map = asc.generate_wafer_map(settings["map"])
data = asc.generate_evaluation_data(wafer_map, settings["evaluationData"])
plan = asc.plan_from_shot_ids("現行", ["11", "13", "20"], wafer_map)
output = asc.run_evaluation(wafer_map, data, settings, [plan])
print(output["summary"]["dOptimal"]["variants"]["howa"]["x"]["rms"]["all"]["mean"])
```

ブラウザ版の「設定をJSONで保存」で作ったファイルは、`asc.load_settings_file(path)` で読み込めます（CSVのマップ・手動プランも入ります）。

## 主な関数

| 関数 | 内容 |
|---|---|
| `default_settings()` | 初期設定（ブラウザ版と同じキー名） |
| `generate_wafer_map(map_settings)` / `parse_map_csv(text, map_settings)` | Waferマップを作る／CSVから読む |
| `generate_evaluation_data(wafer_map, data_settings)` | Zernikeの乱数係数とノイズで評価データを作る |
| `plan_from_shot_ids(name, shot_ids, wafer_map)` | Shot番号の一覧から手動プランを作る |
| `run_evaluation(wafer_map, data, settings, manual_plans)` | 選び方 × 補正の評価（ブラウザ版と同じ形の辞書を返す） |
| `run_sweep(wafer_map, data, settings, sweep_settings, manual_plans)` | 計測Shot数を変えた評価（トレードオフカーブ） |
| `load_settings_file(path)` | ブラウザ版で保存した設定JSONを読む |
| `plots.*` | 選んだ点のマップ・箱ひげ図・トレードオフカーブ・推定誤差マップ |

## テスト（ブラウザ版との照合）

```bash
.venv/bin/python -m unittest discover -s tests -v
```

基準データ `../tests/reference/scenario_*.json` は、ブラウザ版の計算をそのまま書き出したものです（`node ../tools/export_reference.js` で作り直せます）。
選んだ点は完全一致、数値は相対誤差 1e-9 以内を合格とします。

## 注意事項

- 計算の中身を変えるときは、ブラウザ版・MATLAB版も同じように直し、基準データを作り直してテストしてください。
- 評価データは乱数で作る模擬データです。実データは入れていません。実データを使う場合も、リポジトリにはコミットしないでください。
