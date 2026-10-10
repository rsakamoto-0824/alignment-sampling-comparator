"""計測Markの選び方（ランダム・ポアソンディスク・D最適・I最適・手動）。ブラウザ版（src/js/sampling.js）と同じ手順。

どの選び方もShotを選び（条件制約はここで反映する）、選んだShotではそのShotの有効なMarkをすべて測る。
制約なしのD最適・I最適には、制約を外した前提（constraints.unconstrained_context）を渡す。
乱数を使う順番はブラウザ版と同じにしてあるので、同じシードなら同じ点を選ぶ。
"""

import math

import numpy as np

from . import constants as C
from . import correction
from .constraints import SelectionState, forced_items_of
from .rng import Random, derive_seed

# コレスキー因子の対角の比がこれより小さければ、多項式が決まらない（ほぼ特異）とみなす
SINGULAR_DIAGONAL_RATIO = 1e-7


def is_clearly_greater(value, best, tolerance=C.TIE_TOLERANCE):
    """value が best より「はっきり」大きいか。差が相対 tolerance 以下なら同点（先に調べた候補を残す）。"""
    if best == -math.inf:
        return value > best
    return value > best + tolerance * max(1.0, abs(best))


# ---- 共通: 制約を満たす無作為な選択 -------------------------------------------


def _item_positions(context):
    return np.array([[item["x"], item["y"]] for item in context["items"]], dtype=float)


def construct_sequential(context, random, min_distance_mm):
    """1つずつ無作為に加えて選ぶ。候補の少ない区画を優先し、ハード制約を守れない候補は選ばない。行き詰まったら None。"""
    state = SelectionState(context, context["shotCount"])
    positions = _item_positions(context)
    nearest = np.full(len(positions), np.inf)

    def add_item(item):
        state.add(item)
        np.minimum(nearest, np.hypot(positions[:, 0] - positions[item, 0], positions[:, 1] - positions[item, 1]), out=nearest)

    for item in forced_items_of(context):
        add_item(item)
    penalty_scale = context["softStrength"] * C.SOFT_PENALTY_SELECTION
    while len(state.list) < context["shotCount"]:
        feasible = ~state.selected & (nearest >= min_distance_mm) & state.can_add_hard_all()
        weights = np.where(feasible, np.exp(-penalty_scale * state.soft_overfill_all()), 0.0)
        for index, constraint in enumerate(context["constraints"]):
            if not constraint["hard"]:
                continue
            classes = constraint["classOf"]
            supply = np.bincount(classes[feasible], minlength=constraint["classCount"])
            need = np.maximum(state.targets[index][0] - state.counts[index], 0)
            if np.any(need > supply):
                return None
            urgency = np.where(need > 0, need / np.maximum(supply, 1), 0.0)
            weights = np.where(feasible, weights * (1 + C.SEQUENTIAL_URGENCY_BOOST * urgency[classes]), 0.0)
        picked = random.pick_weighted(weights.tolist())
        if picked < 0:
            return None
        add_item(picked)
    # 強制計測Shotだけで区画の上限を超えるときは、ハード制約を満たせていない
    return state if state.violation(True) == 0 else None


def random_fill_and_repair(context, random):
    """無作為に埋めてから、入れ替えでハード制約の外れをなくす（1つずつ加える方法で行き詰まったとき用）。"""
    state = SelectionState(context, context["shotCount"])
    forced = set(forced_items_of(context))
    for item in forced_items_of(context):
        state.add(item)
    for item in random.shuffle(list(range(len(context["items"])))):
        if len(state.list) >= context["shotCount"]:
            break
        if not state.selected[item]:
            state.add(item)
    for _ in range(C.REPAIR_MAX_ITERATIONS):
        if state.violation(True) == 0:
            return state
        best_delta, best_swaps = 0, []
        for removed in list(state.list):
            if removed in forced:
                continue
            for added in range(len(context["items"])):
                if state.selected[added]:
                    continue
                delta = state.swap_delta(removed, added, True)
                if delta < best_delta:
                    best_delta, best_swaps = delta, [(removed, added)]
                elif delta == best_delta and delta < 0:
                    best_swaps.append((removed, added))
        if not best_swaps:
            return None
        removed, added = best_swaps[random.integer(len(best_swaps))]
        state.remove(removed)
        state.add(added)
    return state if state.violation(True) == 0 else None


def find_feasible_state(context, random):
    """ハード制約を満たす無作為な選択を探す。見つからなければ None。"""
    for _ in range(C.FEASIBLE_ATTEMPTS):
        state = construct_sequential(context, random, 0)
        if state is not None:
            return state
    for _ in range(C.FEASIBLE_ATTEMPTS):
        state = random_fill_and_repair(context, random)
        if state is not None:
            return state
    return None


# ---- ランダム・ポアソンディスク ---------------------------------------------------


def select_random(context, random):
    state = find_feasible_state(context, random)
    if state is None:
        return None
    return {"items": list(state.list), "markIndices": measured_marks(context, state.list)}


def select_poisson(context, random):
    """Shot中心の最小間隔をできるだけ広げて無作為に選ぶ（間隔を二分法で探す）。"""
    low, high = 0.0, 2 * math.sqrt(math.pi * C.WAFER_RADIUS_MM**2 / context["shotCount"])
    best = None
    draw_seed = math.floor(random.next() * 4294967296)
    for step in range(C.POISSON_BISECTION_STEPS):
        distance = (low + high) / 2
        step_random = Random(derive_seed(draw_seed, step))
        state = None
        for _ in range(3):
            state = construct_sequential(context, step_random, distance)
            if state is not None:
                break
        if state is not None:
            best, low = state, distance
        else:
            high = distance
    if best is None:
        best = find_feasible_state(context, random)
        if best is None:
            return None
    return {"items": list(best.list), "markIndices": measured_marks(context, best.list)}


# ---- D最適・I最適 -----------------------------------------------------------


def build_models(context, term_sets):
    """補正多項式ごとの計算材料（XとYで項が同じなら1つにまとめる）。

    blocks は候補（Shot）ごとの、測るMarkでの多項式の値（候補数 × k × p）。Shotごとに有効なMarkの数が違う
    （Markが揃わない端のShot）ので、最も多いMark数 k まで0の行で埋める。0の行は情報行列に何も足さず、
    入れ替えの計算（Woodbury）でも結果を変えないので、まとめて計算できる。
    """
    unique = []
    for terms in term_sets:
        if not any(list(entry) == list(terms) for entry in unique):
            unique.append(list(terms))
    uv = correction.mark_coordinates(context["map"])
    most = max(len(item["marks"]) for item in context["items"])
    models = []
    for terms in unique:
        all_design = correction.polynomial_design(uv, terms)
        weight = all_design.T @ all_design / len(uv)
        blocks = np.zeros((len(context["items"]), most, len(terms)))
        for index, item in enumerate(context["items"]):
            blocks[index, : len(item["marks"])] = correction.polynomial_design(uv[item["marks"]], terms)
        models.append({"terms": terms, "p": len(terms), "weight": weight, "blocks": blocks})
    return models


def _information(model, items):
    blocks = model["blocks"][items]
    return np.einsum("ikp,ikq->pq", blocks, blocks) + C.INFORMATION_RIDGE * np.eye(model["p"])


def prepare_exchange(model, selected_items, use_weight):
    """現在の選択での前計算（A = M⁻¹、候補ごとの Q = A Fᵀ、G = F A Fᵀ、I最適用に S = W Q、H = Qᵀ W Q）。"""
    p = model["p"]
    information = _information(model, selected_items)
    try:
        lower = np.linalg.cholesky(information)
    except np.linalg.LinAlgError:
        information = information + 1e-6 * np.eye(p)
        lower = np.linalg.cholesky(information)
    inverse = np.linalg.inv(information)
    log_det = 2 * np.log(np.diag(lower)).sum()
    trace_weighted = float(np.sum(inverse * model["weight"].T))
    blocks = model["blocks"]
    q = np.einsum("pq,ikq->ipk", inverse, blocks)
    g = np.einsum("ikp,ipl->ikl", blocks, q)
    prepared = {"inverse": inverse, "logDet": log_det, "traceWeighted": trace_weighted, "q": q, "g": g}
    if use_weight:
        s = np.einsum("pq,iqk->ipk", model["weight"], q)
        prepared["s"] = s
        prepared["h"] = np.einsum("ipk,ipl->ikl", q, s)
    return prepared


def swap_changes(model, prepared, removed, use_weight):
    """removed を外して各候補を入れたときの変化（Woodburyの公式。全候補をまとめて計算）。

    戻り値: (log det の変化, 予測分散の和の変化, 正則のままか) をそれぞれ候補数の配列で。
    """
    blocks = model["blocks"]
    item_count, k, _ = blocks.shape
    q_r, g_r = prepared["q"][removed], prepared["g"][removed]
    g_cross = np.einsum("ikp,pl->ikl", blocks, q_r)  # F_added A F_removedᵀ
    size = 2 * k
    kmat = np.zeros((item_count, size, size))
    kmat[:, :k, :k] = prepared["g"] + np.eye(k)
    kmat[:, :k, k:] = g_cross
    kmat[:, k:, :k] = np.transpose(g_cross, (0, 2, 1))
    kmat[:, k:, k:] = g_r - np.eye(k)
    signed_det = (1 if k % 2 == 0 else -1) * np.linalg.det(kmat)
    valid = signed_det > 1e-12
    with np.errstate(divide="ignore", invalid="ignore"):
        log_det_change = np.where(valid, np.log(np.where(valid, signed_det, 1)), np.nan)
    trace_change = np.zeros(item_count)
    if use_weight:
        h_cross = np.einsum("ipk,pl->ikl", prepared["q"], prepared["s"][removed])  # Q_addedᵀ W Q_removed
        hmat = np.zeros((item_count, size, size))
        hmat[:, :k, :k] = prepared["h"]
        hmat[:, :k, k:] = h_cross
        hmat[:, k:, :k] = np.transpose(h_cross, (0, 2, 1))
        hmat[:, k:, k:] = prepared["h"][removed]
        safe = np.where(valid[:, None, None], kmat, np.eye(size))
        solved = np.linalg.solve(safe, hmat)
        trace_change = np.where(valid, -np.trace(solved, axis1=1, axis2=2), np.nan)
    return log_det_change, trace_change, valid


def _soft_swap_deltas(state, removed):
    return np.array([state.swap_delta(removed, added, False) for added in range(len(state.selected))], dtype=float)


def exchange_optimize(context, models, criterion, state):
    """D最適またはI最適の入れ替え法（Fedorov）。ハード制約を外す入れ替えはしない。"""
    use_weight = criterion == "I"
    total_terms = sum(model["p"] for model in models)
    penalty_scale = context["softStrength"] * C.SOFT_PENALTY_LOG_EFFICIENCY
    forced = set(forced_items_of(context))
    item_count = len(context["items"])
    for _ in range(C.OPTIMAL_MAX_PASSES):
        prepared = [prepare_exchange(model, state.list, use_weight) for model in models]
        trace_total = sum(entry["traceWeighted"] for entry in prepared)
        best_gain, best_swap = 1e-9, None
        for removed in list(state.list):
            if removed in forced:
                continue
            hard_delta = np.array([state.swap_delta(removed, added, True) for added in range(item_count)])
            changes = [swap_changes(model, prepared[index], removed, use_weight) for index, model in enumerate(models)]
            valid = np.all([change[2] for change in changes], axis=0)
            if use_weight:
                trace_change = np.sum([change[1] for change in changes], axis=0)
                with np.errstate(invalid="ignore", divide="ignore"):
                    gains = math.log(trace_total) - np.log(trace_total + trace_change)
                valid &= trace_total + trace_change > 0
            else:
                gains = np.sum([change[0] for change in changes], axis=0) / total_terms
            gains = gains - penalty_scale * _soft_swap_deltas(state, removed)
            for added in range(item_count):
                if state.selected[added] or hard_delta[added] > 0 or not valid[added]:
                    continue
                if is_clearly_greater(gains[added], best_gain):
                    best_gain, best_swap = gains[added], (removed, added)
        if best_swap is None:
            break
        state.remove(best_swap[0])
        state.add(best_swap[1])
    return state


def _objective(context, models, criterion, state):
    use_weight = criterion == "I"
    prepared = [prepare_exchange(model, state.list, use_weight) for model in models]
    penalty = context["softStrength"] * C.SOFT_PENALTY_LOG_EFFICIENCY * state.violation(False)
    if use_weight:
        return -math.log(sum(entry["traceWeighted"] for entry in prepared)) - penalty
    return sum(entry["logDet"] for entry in prepared) / sum(model["p"] for model in models) - penalty


def select_optimal(context, random, criterion, term_sets, start_count):
    """D最適・I最適。開始点ごとに入れ替え法を行い、目的が最も良いものを使う（I最適はD最適で整えてから探す）。"""
    models = build_models(context, term_sets)
    best, best_objective = None, -math.inf
    for _ in range(start_count):
        start = find_feasible_state(context, random)
        if start is None:
            continue
        prepared = exchange_optimize(context, models, "D", start) if criterion == "I" else start
        state = exchange_optimize(context, models, criterion, prepared)
        objective = _objective(context, models, criterion, state)
        if is_clearly_greater(objective, best_objective):
            best, best_objective = state, objective
    if best is None:
        return None
    return {"items": list(best.list), "markIndices": measured_marks(context, best.list)}


def measured_marks(context, selected_items):
    """選んだShot（候補番号）で測るMark（Shotの有効なMarkすべて。選んだ順）。"""
    marks = []
    for item in selected_items:
        marks.extend(context["items"][item]["marks"])
    return marks


# ---- 手動 ------------------------------------------------------------------


def manual_selection(context, shot_indices):
    """手動の選択（Shotの並び番号）から、測るMarkの一覧を作る。選べないShot（除外Shot・端のShot）は not_eligible で返す。"""
    item_by_shot = {item["shotIndex"]: index for index, item in enumerate(context["items"])}
    items, not_eligible = [], []
    for shot_index in shot_indices:
        if shot_index in item_by_shot:
            items.append(item_by_shot[shot_index])
        else:
            not_eligible.append(shot_index)
    return {"items": items, "markIndices": measured_marks(context, items), "notEligible": not_eligible}


# ---- 選んだ点の性質 ----------------------------------------------------------


def minimum_shot_spacing(context, selected_items):
    """Shot中心の最小間隔 [mm]。"""
    positions = _item_positions(context)[list(selected_items)]
    if len(positions) < 2:
        return math.inf
    distances = np.hypot(positions[:, None, 0] - positions[None, :, 0], positions[:, None, 1] - positions[None, :, 1])
    distances[np.diag_indices(len(positions))] = np.inf
    return float(distances.min())


def design_criteria(wafer_map, mark_indices, terms):
    """選んだ点のD基準（log det(XᵀX)）とI基準（全Markで平均した予測分散÷σ²）、κ。"""
    p = len(terms)
    result = {"p": p, "n": len(mark_indices), "logDet": -math.inf, "trace": math.inf, "kappa": math.inf, "singular": True, "reason": "tooFew"}
    if len(mark_indices) < p:
        return result
    result["reason"] = "degenerate"
    uv = correction.mark_coordinates(wafer_map)
    sample_design = correction.polynomial_design(uv[list(mark_indices)], terms)
    information = sample_design.T @ sample_design
    try:
        lower = np.linalg.cholesky(information)
    except np.linalg.LinAlgError:
        return result
    diagonal = np.diag(lower)
    if diagonal.min() / diagonal.max() < SINGULAR_DIAGONAL_RATIO:
        return result
    inverse = np.linalg.inv(information)
    all_design = correction.polynomial_design(uv, terms)
    trace = float(np.sum(inverse * (all_design.T @ all_design).T)) / len(uv)
    result.update({"logDet": float(2 * np.log(diagonal).sum()), "trace": trace, "kappa": math.sqrt(trace), "singular": False, "reason": None})
    return result


def efficiencies(criteria, reference):
    """D効率とI効率（%）。reference（基準の log det と予測分散）を100%とする。"""
    if reference is None or criteria["singular"]:
        value = 0.0 if criteria["singular"] else math.nan
        return {"d": value, "i": value}
    return {"d": 100 * math.exp((criteria["logDet"] - reference["logDet"]) / criteria["p"]), "i": 100 * reference["trace"] / criteria["trace"]}
