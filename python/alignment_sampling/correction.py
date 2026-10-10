"""補正モデル（HOWA多項式）と推定手法（RBF・ガウス過程回帰）、補正の流れ。ブラウザ版（src/js/correction.js）と同じ式。

補正の流れ:
  HOWAのみ     計測したMarkに多項式を当てはめる
  推定→HOWA    未計測Markのずれを推定して全Markを埋め、全Markに多項式を当てはめる（補正量は多項式だけ）
Python版は numpy で全Waferをまとめて計算する（Wafer数×Mark数の行列を一度に扱う）。
"""

import math

import numpy as np

from . import constants as C


def _polynomial_terms():
    terms = []
    for order in range(C.MAX_POLYNOMIAL_ORDER + 1):
        for power_y in range(order + 1):
            terms.append((order - power_y, power_y))
    return terms


# 5次までの多項式の21項（x の次数, y の次数）。並びは次数の低い順、同じ次数では x の次数の高い順
POLYNOMIAL_TERMS = _polynomial_terms()


def mark_coordinates(wafer_map):
    """全Markの正規化座標 (u, v)（Mark数×2）。"""
    return np.array([[mark["u"], mark["v"]] for mark in wafer_map["marks"]], dtype=float)


def polynomial_design(uv, term_indices):
    """多項式の値の表（行 = 点、列 = 項）。"""
    columns = [uv[:, 0] ** POLYNOMIAL_TERMS[t][0] * uv[:, 1] ** POLYNOMIAL_TERMS[t][1] for t in term_indices]
    return np.column_stack(columns) if columns else np.zeros((len(uv), 0))


def _nearly_singular(lower):
    diagonal = np.diag(lower)
    return diagonal.min() / diagonal.max() < 1e-7


def least_squares_operator(design):
    """最小二乗の係数を求める行列 B = (XᵀX)⁻¹Xᵀ（項数×点数）と、正則でなかったかどうか。

    点が項数より少ないなど XᵀX が正則でないときは、小さな値（trace/p × 1e-6）を足して解く。
    """
    rows, cols = design.shape
    normal = design.T @ design
    rank_deficient = False
    lower = None
    if rows >= cols:
        try:
            lower = np.linalg.cholesky(normal)
        except np.linalg.LinAlgError:
            lower = None
    if lower is None or _nearly_singular(lower):
        rank_deficient = True
        ridge = max(np.trace(normal) / cols, 1) * C.LEAST_SQUARES_RIDGE
        normal = normal + ridge * np.eye(cols)
    return np.linalg.solve(normal, design.T), rank_deficient


# ---- 説明変数 ---------------------------------------------------------------


def feature_matrix(uv, features):
    """推定手法の説明変数。xy は (u, v)、xyr は (u, v, 半径)。"""
    if features == "xyr":
        return np.column_stack([uv, np.hypot(uv[:, 0], uv[:, 1])])
    return uv.copy()


def _distances(a, b):
    return np.sqrt(((a[:, None, :] - b[None, :, :]) ** 2).sum(axis=2))


def _mean_nearest_distance(points):
    if len(points) < 2:
        return 1.0
    distances = _distances(points, points)
    np.fill_diagonal(distances, np.inf)
    return distances.min(axis=1).mean()


# ---- RBF ------------------------------------------------------------------


def rbf_kernel(kernel, r, shape):
    """RBFの基底関数。r は説明変数の空間での距離、shape は幅。"""
    if kernel == "gaussian":
        return np.exp(-((r / shape) ** 2))
    if kernel == "multiquadric":
        return np.sqrt(1 + (r / shape) ** 2)
    if kernel == "inverseQuadric":
        return 1 / (1 + (r / shape) ** 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(r > 0, r * r * np.log(np.where(r > 0, r, 1)), 0.0)


def rbf_operator(uv, sample_indices, rbf_settings, features):
    """RBF補間の演算子 G（全Mark数×計測点数）。f(p) = a₀ + Σ aₖ·pₖ + Σ wⱼ φ(|p − pⱼ|)。

    緩和パラメータ λ は、基底の値の平均の大きさ（対角以外の |φ| の平均）を掛けて使う。
    解けないときは None。
    """
    all_points = feature_matrix(uv, features)
    sample_points = all_points[sample_indices]
    n = len(sample_indices)
    dimension = sample_points.shape[1]
    size = n + 1 + dimension
    shape = max(rbf_settings["shapeFactor"], 1e-6) * _mean_nearest_distance(sample_points)
    kernel_sample = rbf_kernel(rbf_settings["kernel"], _distances(sample_points, sample_points), shape)
    off_diagonal = np.abs(kernel_sample).sum() - np.abs(np.diag(kernel_sample)).sum()
    kernel_scale = off_diagonal / (n * (n - 1)) if n > 1 else 1.0
    basis = np.column_stack([np.ones(n), sample_points])
    system = np.zeros((size, size))
    system[:n, :n] = kernel_sample + rbf_settings["lambda"] * kernel_scale * np.eye(n)
    system[:n, n:] = basis
    system[n:, :n] = basis.T
    right = np.zeros((size, n))
    right[:n, :n] = np.eye(n)
    try:
        weights = np.linalg.solve(system, right)
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(weights)):
        return None
    kernel_all = rbf_kernel(rbf_settings["kernel"], _distances(all_points, sample_points), shape)
    basis_all = np.column_stack([np.ones(len(all_points)), all_points])
    return np.hstack([kernel_all, basis_all]) @ weights


# ---- ガウス過程回帰 ---------------------------------------------------------


def gp_kernel(kernel, d, length):
    """共分散関数（信号の分散を1としたもの）。"""
    if kernel == "matern52":
        scaled = math.sqrt(5) * d / length
        return (1 + scaled + scaled**2 / 3) * np.exp(-scaled)
    return np.exp(-(d**2) / (2 * length**2))


def log_space(minimum, maximum, steps):
    if steps <= 1:
        return [minimum]
    return [minimum * (maximum / minimum) ** (i / (steps - 1)) for i in range(steps)]


def prepare_gp(uv, sample_indices, features, kernel):
    """ガウス過程回帰の前準備（選んだ点ごとに1回）。

    平均は説明変数の1次式で、最小二乗で先に取り除く。相関の長さの候補ごとに共分散行列を固有値分解し、
    ノイズ比の候補ごとの 1/(λ+α) と log det を先に求める。点が足りなければ None。
    """
    all_points = feature_matrix(uv, features)
    sample_points = all_points[sample_indices]
    n = len(sample_indices)
    trend_size = 1 + sample_points.shape[1]
    if n < trend_size + 2:
        return None
    trend_sample = np.column_stack([np.ones(n), sample_points])
    trend_all = np.column_stack([np.ones(len(all_points)), all_points])
    trend_operator, _ = least_squares_operator(trend_sample)
    ratios = np.array(log_space(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS))
    sample_distances = _distances(sample_points, sample_points)
    all_distances = _distances(all_points, sample_points)
    scales = []
    for length in log_space(C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_MAX, C.GP_LENGTH_SCALE_STEPS):
        covariance = gp_kernel(kernel, sample_distances, length)
        values, vectors = np.linalg.eigh(covariance)
        values = np.maximum(values, 0)
        inverse = 1 / (values[None, :] + ratios[:, None])
        log_determinant = np.log(values[None, :] + ratios[:, None]).sum(axis=1)
        scales.append({"length": length, "vectors": vectors, "inverse": inverse, "logDet": log_determinant, "cross": gp_kernel(kernel, all_distances, length)})
    return {"n": n, "trendOperator": trend_operator, "trendSample": trend_sample, "trendAll": trend_all, "ratios": ratios, "scales": scales}


def gp_predict(prepared, measured):
    """全Waferの計測値（計測点数×Wafer数）から全Markのずれを推定する（事後平均）。

    調整値（相関の長さ・ノイズ比）は、Waferごとにその計測点での周辺尤度が最大になる候補を選ぶ
    （候補の並び順も同じ値のときに前の候補を選ぶのもブラウザ版と同じ）。
    戻り値: 推定値（全Mark数×Wafer数）、選んだ相関の長さ（Wafer数。1次式だけのときは NaN）、ノイズ比
    """
    n = prepared["n"]
    trend = prepared["trendOperator"] @ measured
    residual = measured - prepared["trendSample"] @ trend
    wafer_count = measured.shape[1]
    best = np.full(wafer_count, -np.inf)
    best_scale = np.zeros(wafer_count, dtype=int)
    best_ratio = np.zeros(wafer_count, dtype=int)
    zero_residual = np.zeros(wafer_count, dtype=bool)
    for scale_index, scale in enumerate(prepared["scales"]):
        squared = (scale["vectors"].T @ residual) ** 2
        quadratic = scale["inverse"] @ squared
        zero_residual |= (quadratic <= 1e-300).any(axis=0)
        with np.errstate(divide="ignore"):
            likelihood = -0.5 * n * np.log(quadratic / n) - 0.5 * scale["logDet"][:, None]
        for ratio_index in range(len(prepared["ratios"])):
            # 差がごくわずかなら同点とみなし、先の候補を残す（ブラウザ版の isClearlyGreater と同じ）
            with np.errstate(invalid="ignore"):
                threshold = np.where(np.isneginf(best), best, best + C.TIE_TOLERANCE * np.maximum(1.0, np.abs(best)))
            better = likelihood[ratio_index] > threshold
            best = np.where(better, likelihood[ratio_index], best)
            best_scale = np.where(better, scale_index, best_scale)
            best_ratio = np.where(better, ratio_index, best_ratio)
    values = prepared["trendAll"] @ trend
    lengths = np.full(wafer_count, np.nan)
    ratios = np.full(wafer_count, np.nan)
    for scale_index, scale in enumerate(prepared["scales"]):
        chosen = (best_scale == scale_index) & ~zero_residual
        if not chosen.any():
            continue
        projected = scale["vectors"].T @ residual[:, chosen]
        inverse = scale["inverse"][best_ratio[chosen]].T
        weights = scale["vectors"] @ (projected * inverse)
        values[:, chosen] += scale["cross"] @ weights
        lengths[chosen] = scale["length"]
        ratios[chosen] = prepared["ratios"][best_ratio[chosen]]
    return values, lengths, ratios


# ---- 補正の流れ --------------------------------------------------------------


def build_variants(model_settings):
    """比べる補正の一覧（HOWAのみ ＋ 推定→HOWA × 推定手法）。key は "howa" か "流れ:推定手法"。"""
    variants = []
    if model_settings["flows"]["howa"]:
        variants.append({"key": "howa", "flowType": "howa", "estimator": None, "label": "HOWAのみ"})
    for flow in C.FLOW_TYPES:
        if flow["key"] == "howa" or not model_settings["flows"].get(flow["key"]):
            continue
        for estimator in C.ESTIMATORS:
            if not model_settings["estimators"].get(estimator["key"]):
                continue
            variants.append({"key": f"{flow['key']}:{estimator['key']}", "flowType": flow["key"], "estimator": estimator, "label": f"{estimator['label']}→HOWA"})
    return variants


def prepare_howa(uv, sample_indices, term_indices, all_design, all_least_squares):
    """1つの軸のHOWAの部品。howa: 計測値 → 全Markの補正量、allLeastSquares: 全Markの値 → 多項式の係数（推定→HOWA で使う）。"""
    sample_design = polynomial_design(uv[sample_indices], term_indices)
    operator, rank_deficient = least_squares_operator(sample_design)
    warnings = []
    if rank_deficient:
        warnings.append(f"計測点（{len(sample_indices)}点）に対して多項式の項（{len(term_indices)}項）が多すぎるか、点の並びが偏っています。")
    return {
        "allDesign": all_design,
        "allLeastSquares": all_least_squares,
        "howa": all_design @ operator,
        "warnings": warnings,
    }


def estimate_then_howa_operator(howa_parts, estimate, sample_indices):
    """線形の推定手法（RBF）を使う「推定→HOWA」の演算子（全Mark数×計測点数）。

    未計測Markを推定値で埋め（計測Markは計測値のまま）、全Markに多項式を当てはめる。
    """
    n = len(sample_indices)
    filled = estimate.copy()
    filled[sample_indices, :] = 0
    filled[sample_indices, np.arange(n)] = 1
    return howa_parts["allDesign"] @ (howa_parts["allLeastSquares"] @ filled)
