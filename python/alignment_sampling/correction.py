"""補正。ブラウザ版（src/js/correction.js）と同じ式。

補正値はどれも X,Y の高次多項式（HOWAの項）。違いは多項式の係数の決め方:
  HOWA           計測したMarkに最小二乗で当てはめる
  RBF・GPR 式内  RBF（多項式＋距離の基底関数）・GPR（平均が多項式）の式の中の多項式を補正値にする。
                 GPRは、HOWAの残差から調整値を選び、その共分散で一般化最小二乗の係数を求める（2段階）
  RBF・GPR 予測  RBF・GPR（平均は説明変数の1次式）で未計測Markを予測して全Markを埋め、全Markに多項式を当てはめる
  計測値＋HOWA   測ったMarkは計測値そのもの、測っていないMarkはHOWAの多項式で補正する
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
    """RBF・GPRの説明変数。xy は (u, v)、xyr は (u, v, 半径)。"""
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


def rbf_polynomial_operator(uv, sample_indices, sample_design, rbf_settings, features):
    """RBFの式内: 多項式の係数を決める行列 C（項数×計測点数）。係数 = C × 計測値。

    計測値を f(x) = Σ cₖ Pₖ(u, v) + Σ wⱼ φ(|q(x) − q(xⱼ)|) で表し（Pₖ はHOWAの多項式の項、q は説明変数）、
    条件 Σ wⱼ Pₖ(xⱼ) = 0 のもとで解いた c を補正に使う。点が項数より少ないか解けないときは None。
    """
    all_points = feature_matrix(uv, features)
    sample_points = all_points[sample_indices]
    n, p = sample_design.shape
    if n < p:
        return None
    shape = max(rbf_settings["shapeFactor"], 1e-6) * _mean_nearest_distance(sample_points)
    kernel_sample = rbf_kernel(rbf_settings["kernel"], _distances(sample_points, sample_points), shape)
    off_diagonal = np.abs(kernel_sample).sum() - np.abs(np.diag(kernel_sample)).sum()
    kernel_scale = off_diagonal / (n * (n - 1)) if n > 1 else 1.0
    system = np.zeros((n + p, n + p))
    system[:n, :n] = kernel_sample + rbf_settings["lambda"] * kernel_scale * np.eye(n)
    system[:n, n:] = sample_design
    system[n:, :n] = sample_design.T
    right = np.zeros((n + p, n))
    right[:n, :n] = np.eye(n)
    try:
        solution = np.linalg.solve(system, right)
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(solution)):
        return None
    return solution[n:]


def rbf_operator(uv, sample_indices, rbf_settings, features):
    """RBFの予測の演算子 G（全Mark数×計測点数）。f(p) = a₀ + Σ aₖ·pₖ + Σ wⱼ φ(|p − pⱼ|)。

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


# QR分解の対角の比がこれより小さければ、係数が決まらない（点が偏っている）とみなす
GPR_RANK_TOLERANCE = 1e-10


def prepare_gpr_kernel(uv, sample_indices, features, kernel):
    """GPRの式内の前準備（選んだ点・説明変数ごとに1回）: 相関の長さの候補ごとに、共分散行列を固有値分解する。"""
    sample_points = feature_matrix(uv, features)[sample_indices]
    distances = _distances(sample_points, sample_points)
    scales = []
    for length in log_space(C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_MAX, C.GP_LENGTH_SCALE_STEPS):
        values, vectors = np.linalg.eigh(gp_kernel(kernel, distances, length))
        scales.append({"length": length, "values": np.maximum(values, 0), "vectors": vectors})
    return {"n": len(sample_indices), "scales": scales}


def prepare_gpr_polynomial(kernel_part, sample_design):
    """GPRの式内の前準備（多項式の項ごと）: VᵀP と、候補（相関の長さ, ノイズ比）ごとの 1/(λ+α)・log det K。

    点が「項数＋2」より少なければ None。
    """
    n, p = sample_design.shape
    if n < p + 2:
        return None
    ratios = np.array(log_space(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS))
    scales = []
    for scale in kernel_part["scales"]:
        shifted = scale["values"][None, :] + ratios[:, None]
        scales.append({"projected": scale["vectors"].T @ sample_design, "inverse": 1 / shifted, "logDet": np.log(shifted).sum(axis=1)})
    return {"n": n, "p": p, "ratios": ratios, "scales": scales}


def gpr_fit(kernel_part, prepared, measured, ols_residual, ols_coefficients, exact):
    """GPRの式内: 全Waferの計測値（計測点数×Wafer数）から、多項式の係数（項数×Wafer数）を求める（2段階）。

    1. 調整値（相関の長さ・ノイズ比）は、HOWAの残差 e での周辺尤度 −½[n log(eᵀK⁻¹e/n) + log det K] が最大の候補
       （候補の並び順も、同じ値のときに前の候補を選ぶのもブラウザ版と同じ）
    2. 選んだ共分散で一般化最小二乗 β = (PᵀK⁻¹P)⁻¹PᵀK⁻¹y を、重み付きの多項式の細いQR分解で解く
    exact（Waferごと）が真のWaferは、計測値が多項式でほぼ表せるので、HOWAの係数をそのまま使う。
    戻り値: 係数（項数×Wafer数）、選んだ相関の長さ（Wafer数。HOWAの係数を使ったWaferは NaN）、ノイズ比
    """
    n, p = prepared["n"], prepared["p"]
    wafer_count = measured.shape[1]
    best = np.full(wafer_count, -np.inf)
    best_scale = np.zeros(wafer_count, dtype=int)
    best_ratio = np.zeros(wafer_count, dtype=int)
    for scale_index, (kernel_scale, scale) in enumerate(zip(kernel_part["scales"], prepared["scales"])):
        squared = (kernel_scale["vectors"].T @ ols_residual) ** 2
        quadratic = scale["inverse"] @ squared
        with np.errstate(divide="ignore"):
            likelihood = -0.5 * (n * np.log(quadratic / n) + scale["logDet"][:, None])
        for ratio_index in range(len(prepared["ratios"])):
            with np.errstate(invalid="ignore"):
                threshold = np.where(np.isneginf(best), best, best + C.TIE_TOLERANCE * np.maximum(1.0, np.abs(best)))
            better = likelihood[ratio_index] > threshold
            best = np.where(better, likelihood[ratio_index], best)
            best_scale = np.where(better, scale_index, best_scale)
            best_ratio = np.where(better, ratio_index, best_ratio)
    coefficients = np.array(ols_coefficients, dtype=float, copy=True)
    lengths = np.full(wafer_count, np.nan)
    ratios = np.full(wafer_count, np.nan)
    for scale_index, (kernel_scale, scale) in enumerate(zip(kernel_part["scales"], prepared["scales"])):
        for ratio_index in range(len(prepared["ratios"])):
            chosen = (best_scale == scale_index) & (best_ratio == ratio_index) & ~exact
            if not chosen.any():
                continue
            lengths[chosen] = kernel_scale["length"]
            ratios[chosen] = prepared["ratios"][ratio_index]
            scale_factors = np.sqrt(scale["inverse"][ratio_index])
            q, r = np.linalg.qr(scale_factors[:, None] * scale["projected"])
            diagonal = np.abs(np.diag(r))
            if not diagonal.min() > diagonal.max() * GPR_RANK_TOLERANCE:
                continue  # 選んだ共分散では係数が決まらない（点が偏っている）。HOWAの係数を使う
            gamma = q.T @ (scale_factors[:, None] * (kernel_scale["vectors"].T @ measured[:, chosen]))
            coefficients[:, chosen] = np.linalg.solve(r, gamma)
    return coefficients, lengths, ratios


def prepare_gp(uv, sample_indices, features, kernel):
    """GPRの予測の前準備（選んだ点ごとに1回）。

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
    """GPRの予測: 全Waferの計測値（計測点数×Wafer数）から全Markのずれを予測する（事後平均）。

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


# ---- 補正の一覧と、線形の補正の演算子 ------------------------------------------


def build_variants(model_settings):
    """比べる補正の一覧（設定で選んだもの。並びは C.CORRECTIONS の順）。"""
    return [dict(correction) for correction in C.CORRECTIONS if model_settings["corrections"].get(correction["key"])]


def prepare_howa(uv, sample_indices, term_indices, all_design, all_least_squares):
    """1つの軸のHOWAの部品。

    sampleDesign: 計測点での多項式の値、leastSquares: 計測値 → 係数、howa: 計測値 → 全Markの補正量、
    allLeastSquares: 全Markの値 → 係数（予測で使う）。
    """
    sample_design = polynomial_design(uv[sample_indices], term_indices)
    operator, rank_deficient = least_squares_operator(sample_design)
    warnings = []
    if rank_deficient:
        warnings.append(f"計測点（{len(sample_indices)}点）に対して多項式の項（{len(term_indices)}項）が多すぎるか、点の並びが偏っています。")
    return {
        "allDesign": all_design,
        "allLeastSquares": all_least_squares,
        "sampleDesign": sample_design,
        "leastSquares": operator,
        "howa": all_design @ operator,
        "warnings": warnings,
    }


def measured_operator(howa_operator, sample_indices):
    """計測値＋HOWA の演算子（全Mark数×計測点数）: 測ったMarkの行は計測値そのもの、測っていないMarkの行はHOWA。"""
    operator = howa_operator.copy()
    operator[sample_indices, :] = 0
    operator[sample_indices, np.arange(len(sample_indices))] = 1
    return operator


def estimate_then_howa_operator(howa_parts, estimate, sample_indices):
    """RBFの予測の演算子（全Mark数×計測点数）。

    未計測MarkをRBFの予測で埋め（計測Markは計測値のまま）、全Markに多項式を当てはめる。
    """
    n = len(sample_indices)
    filled = estimate.copy()
    filled[sample_indices, :] = 0
    filled[sample_indices, np.arange(n)] = 1
    return howa_parts["allDesign"] @ (howa_parts["allLeastSquares"] @ filled)
