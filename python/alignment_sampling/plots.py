"""ノートブック用の図（matplotlib）。ブラウザ版の図に合わせた見た目にする。

  plot_selection_map   Waferマップに選んだShot・測るMark・Shot番号・無効マーク（✕）を描く
  plot_residual_boxes  選び方 × 補正（HOWAのみ・推定→HOWA）の残差の分布の図（箱ひげ図に分布の形を重ねたもの）
  plot_sweep           計測Mark数（または計測Shot数）と精度のトレードオフカーブ
  plot_estimation_error_map  未計測Markごとの推定誤差（全WaferのRMS）
"""

import math

import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib import ticker
from matplotlib.patches import Circle, Rectangle
from matplotlib.transforms import offset_copy

from . import constants as C
from .evaluator import estimation_label, summarize_store

# 日本語を表示できるフォント（見つかった最初のものを使う。macOS・Windows の順）
JAPANESE_FONTS = ["Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", "BIZ UDGothic", "Noto Sans CJK JP", "IPAexGothic"]
# 推定手法ごとの色（ブラウザ版と同じ）
SERIES_COLORS = {"howa": "#2a78d6", "rbfXY": "#eb6834", "rbfXYR": "#1baf7a", "gpXY": "#eda100", "gpXYR": "#e87ba4"}
# 選び方ごとの線の色・印・線の種類（ブラウザ版のスイープと同じ。ランダムは基準として灰色）。
# D最適・I最適は、制約なしを破線と中抜きの印、制約付きを実線と塗りの印にする
METHOD_STYLES = {
    "random": ("#6b6a65", "o", "-"),
    "poisson": ("#008300", "s", "-"),
    "dOptimal": ("#4a3aa7", "^", "--"),
    "iOptimal": ("#e34948", "D", "--"),
    "constrainedD": ("#4a3aa7", "^", "-"),
    "constrainedI": ("#e34948", "D", "-"),
}
SELECTED_FILL = "#cfe0f7"
MEASURED_COLOR = "#0d366b"
INVALID_MARK_COLOR = "#a8292a"
INK_2 = "#4a4945"
GRID_COLOR = "#e1e0d9"
BAND_COLOR = "#efeee9"
# 分布の図: 値がこれより少ない行は分布の形の代わりに点で描く。分布の形を計算する点の数、
# 形の高さの半分・点を上下にずらす幅（行の間隔を1とした大きさ）、点をずらす量を決める数（黄金比の小数部）
MIN_VIOLIN_COUNT = 20
DENSITY_STEPS = 64
VIOLIN_HALF_HEIGHT = 0.4
DOT_SPREAD = 0.3
GOLDEN_FRACTION = 0.6180339887
# 選び方の名前を、行の名前の左に置く距離 [pt]。凡例を横軸の下に置く距離 [pt]
GROUP_LABEL_OFFSET_PT = 92
LEGEND_OFFSET_PT = 34
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


def plot_selection_map(wafer_map, selection_set, title="", zones=None, ax=None, show_shot_ids=True, mandatory_shot_indices=()):
    """Waferマップに、選んだShot（塗り）・測るMark（濃い点）・Shot番号・Scan方向（▲▼）・強制計測Shot（太枠）を描く。"""
    if ax is None:
        _, ax = plt.subplots(figsize=(6, 6))
    width, height = wafer_map["shotWidthMm"], wafer_map["shotHeightMm"]
    selected = set(selection_set["shotIndices"]) if selection_set else set()
    measured = set(selection_set["markIndices"]) if selection_set else set()
    mandatory = set(mandatory_shot_indices)
    for index, shot in enumerate(wafer_map["shots"]):
        ax.add_patch(Rectangle((shot["x"] - width / 2, shot["y"] - height / 2), width, height, facecolor=SELECTED_FILL if index in selected else "white", edgecolor="#a3a29a", linewidth=0.4))
        if index in mandatory:
            ax.add_patch(Rectangle((shot["x"] - width / 2 + 0.8, shot["y"] - height / 2 + 0.8), width - 1.6, height - 1.6, fill=False, edgecolor="#0b0b0b", linewidth=1.4))
        glyph_y = shot["y"]
        if show_shot_ids:
            ax.text(shot["x"], shot["y"] + 5.5, shot["id"], ha="center", va="center", fontsize=5, color="#0b0b0b")
            glyph_y = shot["y"] - 6.5
        ax.text(shot["x"], glyph_y, "▲" if shot["scan"] == C.SCAN_UP else "▼", ha="center", va="center", fontsize=4, color="#6b6a65")
    marks = np.array([[mark["x"], mark["y"]] for mark in wafer_map["marks"]])
    is_measured = np.array([index in measured for index in range(len(marks))])
    ax.scatter(marks[~is_measured, 0], marks[~is_measured, 1], s=4, facecolors="white", edgecolors="#6b6a65", linewidths=0.4)
    ax.scatter(marks[is_measured, 0], marks[is_measured, 1], s=9, color=MEASURED_COLOR)
    _draw_invalid(ax, wafer_map, show_shot_ids)
    _draw_wafer(ax, wafer_map, zones)
    ax.set_title(title)
    return ax


def _draw_invalid(ax, wafer_map, show_shot_ids=True):
    """無効マーク（計測データのファイルで、どれかのWaferで測れていないMark）を ✕ で、Markがすべて無効のShotを破線の枠で描く。"""
    width, height = wafer_map["shotWidthMm"], wafer_map["shotHeightMm"]
    for shot in wafer_map.get("inactiveShots", []):
        ax.add_patch(Rectangle((shot["x"] - width / 2, shot["y"] - height / 2), width, height, fill=False, edgecolor="#a3a29a", linewidth=0.5, linestyle="--"))
        if show_shot_ids:
            ax.text(shot["x"], shot["y"] + 5.5, shot["id"], ha="center", va="center", fontsize=5, color="#6b6a65")
    invalid = wafer_map.get("invalidMarks", [])
    if invalid:
        ax.scatter([mark["x"] for mark in invalid], [mark["y"] for mark in invalid], s=14, marker="x", color=INVALID_MARK_COLOR, linewidths=0.8)


def _method_label(output, key):
    method = next((entry for entry in output["methods"] if entry["key"] == key), None)
    if method is None:
        return key
    return f"{method['label']}（手動）" if method.get("manual") else method["label"]


def _density_outline(values, transform):
    """分布の形（ガウス核の密度推定）。横軸の目盛り（transform）の上で求め、(横の位置, 高さ0〜1) を返す。描けなければ None。"""
    points = np.sort(transform(np.asarray(values, dtype=float)))
    points = points[np.isfinite(points)]
    count = points.size
    if count < 2:
        return None
    spread = points[int(0.75 * (count - 1))] - points[int(0.25 * (count - 1))]
    deviation = float(np.std(points, ddof=1))
    # 帯域幅はシルバーマンの目安（標準偏差と四分位範囲の小さいほうを使う）
    robust = min(deviation, spread / 1.34) or deviation
    bandwidth = 0.9 * robust * count ** -0.2
    if not bandwidth > 0 or not points[-1] > points[0]:
        return None
    grid = np.linspace(points[0], points[-1], DENSITY_STEPS + 1)
    density = np.exp(-0.5 * ((grid[:, None] - points[None, :]) / bandwidth) ** 2).sum(axis=1)
    return grid, density / density.max()


def _draw_distribution(ax, values, stats, position, color, log_scale):
    """1行の分布: 分布の形（薄い山）か値の点、5〜95%点の線、25〜75%点の太い棒、中央値の白丸。"""
    finite = np.asarray([value for value in values if math.isfinite(value) and (value > 0 or not log_scale)])
    if finite.size >= MIN_VIOLIN_COUNT:
        transform = np.log10 if log_scale else (lambda array: array)
        outline = _density_outline(finite, transform)
        if outline is not None:
            grid, height = outline
            xs = 10 ** grid if log_scale else grid
            ax.fill_between(xs, position - height * VIOLIN_HALF_HEIGHT, position + height * VIOLIN_HALF_HEIGHT, facecolor=color, alpha=0.16, edgecolor="none", zorder=2)
            ax.plot(xs, position + height * VIOLIN_HALF_HEIGHT, color=color, alpha=0.55, linewidth=0.8, zorder=2)
            ax.plot(xs, position - height * VIOLIN_HALF_HEIGHT, color=color, alpha=0.55, linewidth=0.8, zorder=2)
    else:
        offsets = [(((index * GOLDEN_FRACTION) % 1) - 0.5) * 2 * DOT_SPREAD for index in range(finite.size)]
        ax.scatter(finite, position + np.asarray(offsets), s=14, color=color, alpha=0.6, edgecolors="white", linewidths=0.5, zorder=3)
    ax.plot([stats["p5"], stats["p95"]], [position, position], color=color, linewidth=2, solid_capstyle="round", zorder=3)
    ax.plot([stats["p25"], stats["p75"]], [position, position], color=color, linewidth=7, solid_capstyle="round", zorder=4)
    ax.scatter([stats["median"]], [position], s=30, color="white", edgecolors=color, linewidths=1.6, zorder=5)


def plot_residual_boxes(output, axis="x", metric="rms", ax=None, log_scale=False):
    """選び方ごとに、HOWAのみ と推定→HOWA（推定手法ごと）の残差の分布を並べる（ブラウザ版の評価結果の図と同じ見た目）。

    各行に、分布の形（薄い山。値が20個より少なければ値の点）、5〜95%点の線、25〜75%点の太い棒、中央値の白丸を重ねる。
    縦の破線は全点計測（基準）の中央値。log_scale=True で横軸を対数にする（値の小さい選び方どうしの差が見やすい）。
    """
    variants = output["variants"]
    methods = [method for method in output["methods"] if method["key"] in output["summary"]]
    row_count = len(methods) * len(variants) + 1
    if ax is None:
        _, ax = plt.subplots(figsize=(10, 0.34 * row_count + 1.8))
    position, ticks, labels = 0.0, [], []
    groups = [(method["key"], _method_label(output, method["key"])) for method in methods] + [("baseline", "全点計測（基準）")]
    baseline_values = output["baselines"]["allMarks"]["howa"][axis][metric]
    baseline_stats = summarize_store(output["baselines"]["allMarks"]["howa"])[axis][metric]
    for group_index, (key, group_label) in enumerate(groups):
        group_top = position + 0.5
        rows = []
        if key == "baseline":
            rows.append(("HOWAのみ", SERIES_COLORS["howa"], baseline_values, baseline_stats))
        else:
            for variant in variants:
                values = []
                for entry in output["sets"]:
                    if entry["method"] == key:
                        values.extend(np.asarray(entry["results"][variant["key"]][axis][metric]).tolist())
                color = SERIES_COLORS[variant["estimator"]["key"] if variant["estimator"] else "howa"]
                row_label = variant["estimator"]["label"] if variant["estimator"] else "HOWAのみ"
                rows.append((row_label, color, values, output["summary"][key]["variants"][variant["key"]][axis][metric]["all"]))
        for row_label, color, values, stats in rows:
            if math.isfinite(stats["median"]):
                _draw_distribution(ax, values, stats, position, color, log_scale)
            ticks.append(position)
            labels.append(row_label)
            position -= 1
        group_bottom = position + 0.5
        if group_index % 2 == 1:
            ax.axhspan(group_bottom, group_top, color=BAND_COLOR, alpha=0.7, zorder=0, linewidth=0)
        # 選び方の名前は、行の名前（目盛りの文字）のさらに左に置く
        ax.annotate(group_label, (0, (group_top + group_bottom) / 2), xycoords=("axes fraction", "data"), xytext=(-GROUP_LABEL_OFFSET_PT, 0), textcoords="offset points", ha="right", va="center", fontsize=9, fontweight="bold")
        position -= 0.3
    ax.axvline(baseline_stats["median"], color=INK_2, linewidth=1, linestyle=(0, (5, 4)), zorder=1)
    ax.annotate(f"全点計測の中央値 {baseline_stats['median']:.3g} nm", (baseline_stats["median"], 1), xycoords=("data", "axes fraction"), xytext=(4, 4), textcoords="offset points", fontsize=8, color=INK_2)
    ax.set_yticks(ticks, labels, fontsize=8, color=INK_2)
    ax.tick_params(axis="y", length=0, pad=6)
    ax.set_ylim(position + 0.3, 0.8)
    if log_scale:
        # 対数の目盛りは 1・2・5 × 10のべき に、数字はそのまま（2×10⁻¹ ではなく 0.2）で書く
        ax.set_xscale("log")
        ax.xaxis.set_major_locator(ticker.LogLocator(subs=(1, 2, 5)))
        ax.xaxis.set_major_formatter(ticker.FuncFormatter(lambda value, _: f"{value:g}"))
        ax.xaxis.set_minor_formatter(ticker.NullFormatter())
    ax.set_xlabel(f"Waferごとの残差 {metric}（{axis.upper()}）[nm]")
    ax.grid(axis="x", color=GRID_COLOR, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.legend(
        handles=[Rectangle((0, 0), 1, 1, color=SERIES_COLORS[variant["estimator"]["key"] if variant["estimator"] else "howa"]) for variant in variants],
        labels=[variant["label"] for variant in variants],
        loc="upper center",
        bbox_to_anchor=(0.5, 0),
        bbox_transform=offset_copy(ax.transAxes, fig=ax.figure, y=-LEGEND_OFFSET_PT, units="points"),
        ncol=min(len(variants), 5),
        fontsize=8,
        frameon=False,
    )
    return ax


def plot_sweep(sweep, variant_key="howa", axis="x", metric="rms", stat="mean", log_scale=False, target=None, ax=None, x_axis="marks"):
    """計測Mark数（x_axis="marks"）か計測Shot数（"shots"）を横軸、残差を縦軸にしたトレードオフカーブ。

    計測Mark数は選び方ごとの試行平均（端のShotを選べば選び方ごとに少し違う）。手動プランは × の点で重ねる。
    """
    if ax is None:
        _, ax = plt.subplots(figsize=(8, 5))
    points = [point for point in sweep["points"] if "summary" in point]
    for method in sweep["methods"]:
        color, marker, line_style = METHOD_STYLES.get(method["key"], ("#000000", "o", "-"))
        xs = [point["markCounts"][method["key"]] if x_axis == "marks" else point["shotCount"] for point in points]
        ys = [point["summary"][method["key"]]["variants"][variant_key][axis][metric]["all"][stat] for point in points]
        hollow = line_style == "--"
        ax.plot(xs, ys, marker=marker, color=color, linestyle=line_style, linewidth=2, markerfacecolor="white" if hollow else color, label=method["label"])
    if sweep.get("manual"):
        for method in sweep["manual"]["methods"]:
            x = sweep["manual"]["markCounts" if x_axis == "marks" else "shotCounts"][method["key"]]
            y = sweep["manual"]["summary"][method["key"]]["variants"][variant_key][axis][metric]["all"][stat]
            ax.scatter([x], [y], marker="x", s=60, color="black", zorder=5)
            ax.annotate(f"{method['label']}（手動）", (x, y), xytext=(6, 0), textcoords="offset points", va="center", fontsize=8)
    if sweep.get("baseline"):
        ax.axhline(sweep["baseline"][axis][metric]["p95" if stat == "p95" else "mean"], color="#4a4945", linewidth=1, label="全点計測")
    if target:
        ax.axhline(target, color="#4a4945", linewidth=1, linestyle=":", label=f"目標 {target}")
    if log_scale:
        ax.set_yscale("log")
    ax.set_xlabel("計測Mark数（計測コスト）" if x_axis == "marks" else "計測Shot数")
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
