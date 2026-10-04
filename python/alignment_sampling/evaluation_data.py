"""評価データ（乱数のWafer高次傾向と計測ノイズ）。ブラウザ版（src/js/evaluation-data.js）と同じ乱数の使い方。

各Waferのずれ量 = Σ（Zernike項 × 乱数の係数）＋ Scan方向によるずれ（Upは+δ、Downは−δ）
計測値 = ずれ量 ＋ 計測ノイズ。ノイズは全Markぶんを先に作る（同じWafer・同じMarkなら、どの選び方でも同じノイズ）。
"""

import math

import numpy as np

from . import constants as C
from . import zernike
from .rng import Random, derive_seed

MAX_WAFER_COUNT = 5000
# 乱数列の用途ごとの番号（ノイズの設定を変えても傾向が変わらないように分ける）
STREAM_TREND = 0
STREAM_NOISE = 1
STREAM_SCAN = 2


def default_term_settings(low_order_amplitude_nm, high_order_amplitude_nm):
    """Zernike各項の初期設定。5次以下と6次以上で大きさを分ける。"""
    settings = []
    for term in zernike.TERMS:
        amplitude = low_order_amplitude_nm if term["polynomialExpressible"] else high_order_amplitude_nm
        settings.append({"fringeIndex": term["fringeIndex"], "enabled": True, "xValue": amplitude, "yValue": amplitude})
    return settings


def _draw_value(random, distribution, scale):
    """分布の設定に従って乱数を1つ作る。大きさが0なら乱数を使わない（ブラウザ版と同じ）。"""
    if scale == 0:
        return 0.0
    if distribution == C.DISTRIBUTION_NORMAL:
        return scale * random.normal()
    return scale * (2 * random.next() - 1)


def generate_evaluation_data(wafer_map, settings):
    """評価データを作る。戻り値の truthX などは (Wafer数, Mark数) の配列。"""
    wafer_count = settings["waferCount"]
    if not isinstance(wafer_count, int) or not 1 <= wafer_count <= MAX_WAFER_COUNT:
        raise ValueError(f"Wafer数は1〜{MAX_WAFER_COUNT}の整数にしてください。")
    marks = wafer_map["marks"]
    mark_count = len(marks)
    active = [term for term in settings["terms"] if term["enabled"] and (term["xValue"] > 0 or term["yValue"] > 0)]
    term_count = len(active)

    basis = np.zeros((mark_count, term_count))
    for i, mark in enumerate(marks):
        rho = math.hypot(mark["u"], mark["v"])
        theta = math.atan2(mark["v"], mark["u"])
        for k, term_setting in enumerate(active):
            basis[i, k] = zernike.evaluate_term(zernike.term_by_fringe(term_setting["fringeIndex"]), rho, theta, settings["normalization"])
    scan_sign = np.array([1.0 if wafer_map["shots"][mark["shotIndex"]]["scan"] == C.SCAN_UP else -1.0 for mark in marks])

    trend_random = Random(derive_seed(settings["seed"], STREAM_TREND))
    noise_random = Random(derive_seed(settings["seed"], STREAM_NOISE))
    scan_random = Random(derive_seed(settings["seed"], STREAM_SCAN))
    distribution = settings["distribution"]

    coefficients_x = np.zeros((wafer_count, term_count))
    coefficients_y = np.zeros((wafer_count, term_count))
    scan_offsets = np.zeros((wafer_count, 2))
    noise_x = np.zeros((wafer_count, mark_count))
    noise_y = np.zeros((wafer_count, mark_count))
    for wafer in range(wafer_count):
        for k, term_setting in enumerate(active):
            coefficients_x[wafer, k] = _draw_value(trend_random, distribution, term_setting["xValue"])
            coefficients_y[wafer, k] = _draw_value(trend_random, distribution, term_setting["yValue"])
        scan_offsets[wafer, 0] = _draw_value(scan_random, distribution, settings["scanOffsetXnm"])
        scan_offsets[wafer, 1] = _draw_value(scan_random, distribution, settings["scanOffsetYnm"])
        for i in range(mark_count):
            noise_x[wafer, i] = settings["noiseSigmaXnm"] * noise_random.normal()
            noise_y[wafer, i] = settings["noiseSigmaYnm"] * noise_random.normal()

    truth_x = coefficients_x @ basis.T + scan_offsets[:, [0]] * scan_sign
    truth_y = coefficients_y @ basis.T + scan_offsets[:, [1]] * scan_sign
    return {
        "waferCount": wafer_count,
        "markCount": mark_count,
        "truthX": truth_x,
        "truthY": truth_y,
        "noiseX": noise_x,
        "noiseY": noise_y,
        "fringeIndices": [term["fringeIndex"] for term in active],
        "coefficientsX": coefficients_x,
        "coefficientsY": coefficients_y,
    }
