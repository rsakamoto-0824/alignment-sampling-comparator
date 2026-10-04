"""ノートブック用の図（matplotlib）。ブラウザ版の図に合わせた見た目にする。

  plot_selection_map   Waferマップに選んだShot・測るMarkを描く
  plot_residual_boxes  選び方 × 補正の残差の箱ひげ図
  plot_sweep           計測Mark数と精度のトレードオフカーブ
  plot_estimation_error_map  未計測Markごとの推定誤差（全WaferのRMS）
"""

import math

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.patches import Circle, Rectangle

from . import constants as C
from .evaluator import estimation_label

# 日本語を表示できるフォント（見つかった最初のものを使う。macOS・Windows の順）
JAPANESE_FONTS = ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "BIZ UDGothic", "Noto Sans CJK JP", "IPAexGothic"]
# 推定手法ごとの色（ブラウザ版と同じ）
SERIES_COLORS = {"howa": "#2a78d6", "rbfXY": "#eb6834", "rbfXYR": "#1baf7a", "gpXY": "#eda100", "gpXYR": "#e87ba4"}
# 選び方ごとの線の色と形（ブラウザ版のスイープと同じ。ランダムは基準として灰色）
METHOD_STYLES = {"random": ("#6b6a65", "o"), "poisson": ("#008300", "s"), "dOptimal": ("#4a3aa7", "^"), "iOptimal": ("#e34948", "D")}
SELECTED_FILL = "#cfe0f7"
MEASURED_COLOR = "#0d366b"
STEP_COLORS = ["#e3eefc", "#b7d3f6", "#86b6ef", "#3987e5", "#1c5cab"]
ERROR_MARKER_SIZE = 40


def use_japanese_font():
    """日本語フォントを設定する（見つからなければ何もしない）。"""
    available = {font.name for font in font_manager.fontManager.ttflist}
    for name in JAPANESE_FONTS:
        if name in available:
            plt.rcParams["font.family"] = name
            return name
    return None


def _draw_wafer(ax, wafer_map, zones=None):
    ax.add_patch(Circle((0, 0), C.WAFER_RADIUS_MM, fill=False, linewidth=1, color="#4a4945"))
    ax.axhline(0, color="#6b6a65", linewidth=0.5)
    ax.axvline(0, color="#6b6a65", linewidth=0.5)
    if zones:
        for radius in [zones["innerRadiusMm"], zones["outerRadiusMm"]]:
            ax.add_patch(Circle((0, 0), radius, fill=False, linewidth=0.6, linestyle="--", color="#6b6a65"))
    limit = C.WAFER_RADIUS_MM + 12
    ax.set_xlim(-limit, limit)
    ax.set_ylim(-limit, limit)
    ax.set_aspect("equal")
    ax.set_xlabel("X [mm]")
    ax.set_ylabel("Y [mm]")


def plot_selection_map(wafer_map, selection_set, title="", zones=None, ax=None):
    """Waferマップに、選んだShot（塗り）・測るMark（濃い点）・Scan方向（▲▼）を描く。"""
    if ax is None:
        _, ax = plt.subplots(figsize=(6, 6))
    width, height = wafer_map["shotWidthMm"], wafer_map["shotHeightMm"]
    selected = set(selection_set["shotIndices"]) if selection_set else set()
    measured = set(selection_set["markIndices"]) if selection_set else set()
    for index, shot in enumerate(wafer_map["shots"]):
        ax.add_patch(Rectangle((shot["x"] - width / 2, shot["y"] - height / 2), width, height, facecolor=SELECTED_FILL if index in selected else "white", edgecolor="#a3a29a", linewidth=0.4))
        ax.text(shot["x"], shot["y"], "▲" if shot["scan"] == C.SCAN_UP else "▼", ha="center", va="center", fontsize=5, color="#6b6a65")
    marks = np.array([[mark["x"], mark["y"]] for mark in wafer_map["marks"]])
    is_measured = np.array([index in measured for index in range(len(marks))])
    ax.scatter(marks[~is_measured, 0], marks[~is_measured, 1], s=4, facecolors="white", edgecolors="#6b6a65", linewidths=0.4)
    ax.scatter(marks[is_measured, 0], marks[is_measured, 1], s=9, color=MEASURED_COLOR)
    _draw_wafer(ax, wafer_map, zones)
    ax.set_title(title)
    return ax


def _method_label(output, key):
    method = next((entry for entry in output["methods"] if entry["key"] == key), None)
    if method is None:
        return key
    return f"{method['label']}（手動）" if method.get("manual") else method["label"]


def plot_residual_boxes(output, flow_type="estimateThenHowa", axis="x", metric="rms", ax=None):
    """選び方ごとに、HOWAのみ と選んだ流れの推定手法の残差を箱ひげ図で並べる（箱 25〜75%、ひげ 5〜95%）。"""
    variants = [variant for variant in output["variants"] if variant["flowType"] in ("howa", flow_type)]
    methods = output["methods"]
    if ax is None:
        _, ax = plt.subplots(figsize=(9, 0.35 * len(methods) * len(variants) + 1.5))
    position, ticks, labels = 0, [], []
    for method in methods:
        for variant in variants:
            values = []
            for entry in output["sets"]:
                if entry["method"] == method["key"]:
                    values.extend(entry["results"][variant["key"]][axis][metric].tolist())
            values = np.array([value for value in values if math.isfinite(value)])
            color = SERIES_COLORS[variant["estimator"]["key"] if variant["estimator"] else "howa"]
            if values.size:
                ax.boxplot(values, positions=[position], vert=False, widths=0.6, whis=(5, 95), showfliers=False, patch_artist=True,
                           boxprops={"facecolor": color, "edgecolor": color}, medianprops={"color": "white"}, whiskerprops={"color": color}, capprops={"color": color})
            ticks.append(position)
            labels.append(f"{_method_label(output, method['key'])}・{variant['label']}")
            position -= 1
        position -= 0.6
    ax.set_yticks(ticks, labels, fontsize=8)
    ax.set_xlabel(f"Waferごとの残差 {metric}（{axis.upper()}）[nm]")
    ax.grid(axis="x", color="#e1e0d9")
    return ax


def plot_sweep(sweep, variant_key="howa", axis="x", metric="rms", stat="mean", log_scale=False, target=None, ax=None):
    """計測Mark数（横軸）と残差（縦軸）のトレードオフカーブ。手動プランは × の点で重ねる。"""
    if ax is None:
        _, ax = plt.subplots(figsize=(8, 5))
    points = [point for point in sweep["points"] if "summary" in point]
    for method in sweep["methods"]:
        color, marker = METHOD_STYLES.get(method["key"], ("#000000", "o"))
        xs = [point["markCounts"][method["key"]] for point in points]
        ys = [point["summary"][method["key"]]["variants"][variant_key][axis][metric]["all"][stat] for point in points]
        ax.plot(xs, ys, marker=marker, color=color, linewidth=2, label=method["label"])
    if sweep.get("manual"):
        for method in sweep["manual"]["methods"]:
            x = sweep["manual"]["markCounts"][method["key"]]
            y = sweep["manual"]["summary"][method["key"]]["variants"][variant_key][axis][metric]["all"][stat]
            ax.scatter([x], [y], marker="x", s=60, color="black", zorder=5)
            ax.annotate(f"{method['label']}（手動）", (x, y), xytext=(6, 0), textcoords="offset points", va="center", fontsize=8)
    if sweep.get("baseline"):
        ax.axhline(sweep["baseline"][axis][metric]["p95" if stat == "p95" else "mean"], color="#4a4945", linewidth=1, label="全点計測")
    if target:
        ax.axhline(target, color="#4a4945", linewidth=1, linestyle=":", label=f"目標 {target}")
    if log_scale:
        ax.set_yscale("log")
    ax.set_xlabel("計測Mark数（計測コスト）")
    ax.set_ylabel(f"残差 {metric}（{axis.upper()}、{'95%点' if stat == 'p95' else 'Wafer平均'}）[nm]")
    ax.grid(color="#e1e0d9")
    ax.legend(fontsize=8)
    return ax


def plot_estimation_error_map(output, method_key, estimation_key, axis="x", scale_max=None, ax=None):
    """未計測Markごとの推定誤差（全WaferのRMS）を色で示す（計測Markは小さい点）。ランダム系は最初の試行を使う。"""
    entry = next(entry for entry in output["sets"] if entry["method"] == method_key)
    squares = entry["estimationSquares"][estimation_key][axis]
    rms = np.sqrt(squares / output["waferCount"])
    wafer_map = output["map"]
    marks = np.array([[mark["x"], mark["y"]] for mark in wafer_map["marks"]])
    if ax is None:
        _, ax = plt.subplots(figsize=(6, 6))
    finite = np.isfinite(rms)
    upper = scale_max or float(np.percentile(rms[finite], 95))
    scatter = ax.scatter(marks[finite, 0], marks[finite, 1], c=np.minimum(rms[finite], upper), cmap="Blues", vmin=0, vmax=upper, s=ERROR_MARKER_SIZE, edgecolors="#4a4945", linewidths=0.3)
    ax.scatter(marks[~finite, 0], marks[~finite, 1], s=4, color=MEASURED_COLOR)
    _draw_wafer(ax, wafer_map)
    ax.set_title(f"{_method_label(output, method_key)}・推定誤差（{estimation_label(estimation_key)}、{axis.upper()}）")
    plt.colorbar(scatter, ax=ax, label="推定誤差RMS [nm]（上限は95%点）")
    return ax
