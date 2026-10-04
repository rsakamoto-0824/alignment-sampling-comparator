"""評価の全体の流れ（選ぶ → 補正 → 集計）とスイープ。ブラウザ版（src/js/evaluator.js）と同じ手順・同じ乱数。

  1. サンプリングの前提を作り、ハード制約を同時に満たせるか確かめる
  2. 選び方ごとに計測Markを選ぶ（ランダム系は試行回数ぶん）。手動プランも同列に扱う
  3. 選んだ点ごとに全Waferを補正し、全Markの残差と、未計測Markの推定誤差を求める
  4. 選び方 × 補正 × 軸 × 指標で集計する
"""

import math

import numpy as np

from . import constants as C
from . import constraints as K
from . import correction
from . import sampling
from .rng import Random, derive_seed

METRIC_KEYS = ["rms", "mean3sigma", "max"]
AXES = ["x", "y"]
# 選び方の乱数列の番号（評価データとは別）
STREAM_METHOD_BASE = 1000


def summarize(values):
    """平均・パーセント点・最大（計算できなかった値 NaN・∞ は除く）。パーセント点は線形補間。"""
    array = np.asarray(values, dtype=float).ravel()
    finite = np.sort(array[np.isfinite(array)])
    if finite.size == 0:
        return {key: math.nan for key in ["mean", "p5", "p25", "median", "p75", "p95", "min", "max"]} | {"count": 0}
    percentile = lambda p: float(np.percentile(finite, p, method="linear"))
    return {
        "count": int(finite.size),
        "mean": float(finite.mean()),
        "p5": percentile(5),
        "p25": percentile(25),
        "median": percentile(50),
        "p75": percentile(75),
        "p95": percentile(95),
        "min": float(finite[0]),
        "max": float(finite[-1]),
    }


def residual_metrics(residual):
    """残差（Mark数×Wafer数）から、Waferごとの RMS・|平均|+3σ・最大|残差|。"""
    mean = residual.mean(axis=0)
    mean_square = (residual**2).mean(axis=0)
    variance = np.maximum(0, mean_square - mean**2)
    return {"rms": np.sqrt(mean_square), "mean3sigma": np.abs(mean) + 3 * np.sqrt(variance), "max": np.abs(residual).max(axis=0)}


def _selected_estimators(model_settings):
    return [estimator for estimator in C.ESTIMATORS if model_settings["estimators"].get(estimator["key"])]


def estimation_label(key):
    if key == "howa":
        return "HOWA（多項式の予測）"
    return next(estimator["label"] for estimator in C.ESTIMATORS if estimator["key"] == key)


class ModelCache:
    """全Markでの多項式の当てはめの部品（選んだ点によらないので、項の組み合わせごとに1回だけ作る）。"""

    def __init__(self, wafer_map):
        self.uv = correction.mark_coordinates(wafer_map)
        self._cache = {}

    def get(self, terms):
        key = tuple(terms)
        if key not in self._cache:
            all_design = correction.polynomial_design(self.uv, terms)
            operator, rank_deficient = correction.least_squares_operator(all_design)
            self._cache[key] = (all_design, operator)
        return self._cache[key]


def evaluate_sample_set(wafer_map, data, model_settings, sample_indices, variants, model_cache=None, estimation=True):
    """1組の計測Markについて、補正ごと・軸ごとの残差の指標と、推定手法ごとの推定精度を求める。"""
    cache = model_cache or ModelCache(wafer_map)
    uv = cache.uv
    mark_count = len(uv)
    sample = np.asarray(sample_indices, dtype=int)
    unmeasured = np.setdiff1d(np.arange(mark_count), sample)
    with_estimation = estimation and unmeasured.size > 0
    warnings = []

    estimator_list = list(_selected_estimators(model_settings)) if with_estimation else []
    for variant in variants:
        if variant["estimator"] is not None and variant["estimator"] not in estimator_list:
            estimator_list.append(variant["estimator"])
    prepared = {}
    for estimator in estimator_list:
        if estimator["type"] == "rbf":
            settings = {"kernel": model_settings["rbfKernel"], "lambda": model_settings["rbfLambda"], "shapeFactor": model_settings["rbfShapeFactor"]}
            operator = correction.rbf_operator(uv, sample, settings, estimator["features"])
            prepared[estimator["key"]] = {"type": "linear", "operator": operator} if operator is not None else None
        else:
            gp = correction.prepare_gp(uv, sample, estimator["features"], model_settings["gpKernel"])
            prepared[estimator["key"]] = {"type": "gp", "gp": gp} if gp is not None else None
        if prepared[estimator["key"]] is None:
            warnings.append(f"{estimator['longLabel']}: 推定できませんでした（計測点が少なすぎるか、並びが偏っています）。")

    results = {variant["key"]: {} for variant in variants}
    gp_choices = {variant["key"]: {"lengthMm": [], "noiseRatio": []} for variant in variants if variant["estimator"] and variant["estimator"]["type"] == "gp"}
    estimation_keys = ["howa"] + [estimator["key"] for estimator in _selected_estimators(model_settings)] if with_estimation else []
    estimation_results = {key: {} for key in estimation_keys}
    estimation_squares = {key: {} for key in estimation_keys}
    howa_cache = {}

    for axis in AXES:
        terms = model_settings["termsX"] if axis == "x" else model_settings["termsY"]
        key = tuple(terms)
        if key not in howa_cache:
            all_design, all_least_squares = cache.get(terms)
            parts = correction.prepare_howa(uv, sample, terms, all_design, all_least_squares)
            warnings.extend(parts["warnings"])
            operators = {}
            for variant in variants:
                if variant["estimator"] is None:
                    operators[variant["key"]] = parts["howa"]
                elif prepared.get(variant["estimator"]["key"]) and prepared[variant["estimator"]["key"]]["type"] == "linear":
                    operators[variant["key"]] = correction.linear_flow_operator(parts, prepared[variant["estimator"]["key"]]["operator"], sample, variant["flowType"])
            howa_cache[key] = (parts, operators)
        parts, operators = howa_cache[key]
        truth = (data["truthX"] if axis == "x" else data["truthY"]).T
        noise = (data["noiseX"] if axis == "x" else data["noiseY"]).T
        measured = truth[sample] + noise[sample]
        howa_correction = parts["howa"] @ measured

        def record_estimation(name, prediction):
            if name not in estimation_results:
                return
            errors = prediction[unmeasured] - truth[unmeasured]
            squares = np.full(mark_count, np.nan)
            squares[unmeasured] = (errors**2).sum(axis=1)
            estimation_squares[name][axis] = squares
            estimation_results[name][axis] = residual_metrics(errors)

        record_estimation("howa", howa_correction)
        raw_gp = {}
        for estimator in estimator_list:
            entry = prepared[estimator["key"]]
            if entry is None:
                if estimator["key"] in estimation_results:
                    estimation_results[estimator["key"]][axis] = {metric: np.full(data["waferCount"], np.nan) for metric in METRIC_KEYS}
                continue
            if entry["type"] == "gp":
                raw_gp[estimator["key"]] = correction.gp_predict(entry["gp"], measured)
                record_estimation(estimator["key"], raw_gp[estimator["key"]][0])
            else:
                record_estimation(estimator["key"], entry["operator"] @ measured)

        for variant in variants:
            if variant["key"] in operators:
                correction_values = operators[variant["key"]] @ measured
            else:
                entry = prepared.get(variant["estimator"]["key"])
                if entry is None:
                    results[variant["key"]][axis] = {metric: np.full(data["waferCount"], np.nan) for metric in METRIC_KEYS}
                    continue
                if variant["flowType"] == "estimateThenHowa":
                    values, lengths, ratios = raw_gp[variant["estimator"]["key"]]
                    filled = values.copy()
                    filled[sample] = measured
                    correction_values = parts["allDesign"] @ (parts["allLeastSquares"] @ filled)
                else:
                    leftover = measured - parts["fitted"] @ measured
                    values, lengths, ratios = correction.gp_predict(entry["gp"], leftover)
                    correction_values = howa_correction + values
                finite = np.isfinite(lengths)
                gp_choices[variant["key"]]["lengthMm"].extend((lengths[finite] * C.NORMALIZATION_RADIUS_MM).tolist())
                gp_choices[variant["key"]]["noiseRatio"].extend(ratios[finite].tolist())
            results[variant["key"]][axis] = residual_metrics(truth - correction_values)
    return {"results": results, "estimation": estimation_results, "estimationSquares": estimation_squares, "gpChoices": gp_choices, "warnings": list(dict.fromkeys(warnings))}


def criteria_of(wafer_map, mark_indices, model_settings):
    """X・YのD基準・I基準（項が同じなら同じ計算を使い回す）。"""
    x = sampling.design_criteria(wafer_map, mark_indices, model_settings["termsX"])
    same = list(model_settings["termsX"]) == list(model_settings["termsY"])
    return {"x": x, "y": x if same else sampling.design_criteria(wafer_map, mark_indices, model_settings["termsY"]), "sameTerms": same}


def criteria_reference(sets):
    """効率の基準: 全部の選び方・試行の中で、D基準が最大のものとI基準が最小のもの（軸ごと）。"""
    reference = {}
    for axis in AXES:
        usable = [entry["criteria"][axis] for entry in sets if not entry["criteria"][axis]["singular"]]
        reference[axis] = {"logDet": max(c["logDet"] for c in usable), "trace": min(c["trace"] for c in usable)} if usable else None
    return reference


def _describe_set(context, model_settings, entry, selection):
    mark_indices = sorted(set(selection["markIndices"]))
    warnings = []
    if selection.get("notEligible"):
        warnings.append(f"手動プランの、必ず測るMarkが有効範囲外のShot {len(selection['notEligible'])}個は、評価から外しました。")
    return {
        "method": entry["method"],
        "draw": entry["draw"],
        "items": list(selection["items"]),
        "shotIndices": [context["items"][item]["shotIndex"] for item in selection["items"]],
        "markIndices": mark_indices,
        "minSpacingMm": sampling.minimum_shot_spacing(context, selection["items"]),
        "criteria": criteria_of(context["map"], mark_indices, model_settings),
        "status": K.describe_status(context, selection["items"], mark_indices),
        "warnings": warnings,
    }


def _summarize_stores(stores):
    result = {}
    for axis in AXES:
        result[axis] = {}
        for metric in METRIC_KEYS:
            values = [store[axis][metric] for store in stores]
            result[axis][metric] = {"all": summarize(np.concatenate(values)), "perDraw": summarize([summarize(value)["mean"] for value in values])}
    return result


def _summarize_constraints(method_sets):
    first = method_sets[0]["status"]
    rows = first["rows"] + ([first["center"]] if first["center"] else [])
    summary = []
    for row in rows:
        entries = [(entry["status"]["center"] if row["key"] == "center" else next(r for r in entry["status"]["rows"] if r["key"] == row["key"])) for entry in method_sets]
        summary.append({"key": row["key"], "label": row["label"], "hard": row["hard"], "satisfied": sum(e["ok"] for e in entries), "total": len(entries), "meanShift": float(np.mean([e["shift"] for e in entries])), "maxShift": max(e["shift"] for e in entries)})
    return summary


def summarize_results(sets, variants, estimation_keys, methods):
    """選び方 × 補正 × 軸 × 指標ごとに、全試行・全Waferの値をまとめる。"""
    summary = {}
    for method in methods:
        method_sets = [entry for entry in sets if entry["method"] == method["key"] and entry.get("results")]
        if not method_sets:
            continue
        entry = {"drawCount": len(method_sets), "variants": {}, "estimation": {}, "gpChoices": {}}
        for variant in variants:
            entry["variants"][variant["key"]] = _summarize_stores([s["results"][variant["key"]] for s in method_sets])
            if variant["estimator"] and variant["estimator"]["type"] == "gp":
                entry["gpChoices"][variant["key"]] = {
                    "lengthMm": summarize([v for s in method_sets for v in s["gpChoices"][variant["key"]]["lengthMm"]]),
                    "noiseRatio": summarize([v for s in method_sets for v in s["gpChoices"][variant["key"]]["noiseRatio"]]),
                }
        for key in estimation_keys:
            if key in method_sets[0]["estimation"]:
                entry["estimation"][key] = _summarize_stores([s["estimation"][key] for s in method_sets])
        for axis in AXES:
            entry[f"criteria{axis.upper()}"] = {
                "logDet": summarize([s["criteria"][axis]["logDet"] for s in method_sets]),
                "trace": summarize([s["criteria"][axis]["trace"] for s in method_sets]),
                "singularCount": sum(s["criteria"][axis]["singular"] for s in method_sets),
            }
        entry["constraints"] = _summarize_constraints(method_sets)
        entry["kappaX"] = summarize([s["criteria"]["x"]["kappa"] for s in method_sets])
        entry["kappaY"] = summarize([s["criteria"]["y"]["kappa"] for s in method_sets])
        entry["minSpacingMm"] = summarize([s["minSpacingMm"] for s in method_sets])
        entry["markCount"] = summarize([len(s["markIndices"]) for s in method_sets])
        entry["shotCount"] = summarize([len(s["shotIndices"]) for s in method_sets])
        summary[method["key"]] = entry
    return summary


def summarize_store(store):
    """1つの基準（Wafer数ぶんの値）を集計する。"""
    return {axis: {metric: summarize(store[axis][metric]) for metric in METRIC_KEYS} for axis in AXES}


def run_evaluation(wafer_map, data, settings, manual_plans=None, progress=None):
    """評価を実行する。

    manual_plans: [{"key": "manual:1", "label": "現行", "shotIndices": [...], "extraMarkIndices": [...]}]
    progress: progress(done, total, label) を呼ぶ関数（省略可）
    戻り値はブラウザ版と同じ形の辞書（sets・summary・methods・variants・baselines など）。
    """
    context = K.build_context(wafer_map, settings)
    sampling_settings = settings["sampling"]
    relaxed = K.resolve_hard_constraints(context, sampling_settings["seed"], lambda ctx, random: sampling.find_feasible_state(ctx, random) is not None)
    variants = correction.build_variants(settings["model"])
    cache = ModelCache(wafer_map)
    term_sets = [settings["model"]["termsX"], settings["model"]["termsY"]]

    plans = [plan for plan in (manual_plans or []) if plan["shotIndices"]]
    methods = [{"key": m["key"], "label": m["label"], "usesDraws": m["usesDraws"], "manual": False} for m in C.METHODS if sampling_settings["methods"].get(m["key"])]
    methods += [{"key": plan["key"], "label": plan["label"], "usesDraws": False, "manual": True} for plan in plans]
    plan_entries = []
    for method in methods:
        if method["manual"]:
            plan_entries.append({"method": method["key"], "draw": 0, "plan": next(p for p in plans if p["key"] == method["key"])})
        else:
            for draw in range(sampling_settings["draws"] if method["usesDraws"] else 1):
                plan_entries.append({"method": method["key"], "draw": draw})
    total_steps = len(plan_entries) * 2 + 2
    done = 0

    sets = []
    for entry in plan_entries:
        method_index = next((i for i, m in enumerate(C.METHODS) if m["key"] == entry["method"]), -1)
        random = Random(derive_seed(sampling_settings["seed"], STREAM_METHOD_BASE + method_index * 100000 + entry["draw"]))
        if entry["method"] == "random":
            selection = sampling.select_random(context, random)
        elif entry["method"] == "poisson":
            selection = sampling.select_poisson(context, random)
        elif entry["method"] == "dOptimal":
            selection = sampling.select_optimal(context, random, "D", term_sets, sampling_settings["optimalStarts"])
        elif entry["method"] == "iOptimal":
            selection = sampling.select_optimal(context, random, "I", term_sets, sampling_settings["optimalStarts"])
        else:
            selection = sampling.manual_selection(context, entry["plan"]["shotIndices"], entry["plan"]["extraMarkIndices"])
        done += 1
        if progress:
            progress(done, total_steps, "計測Markを選んでいます")
        if not selection or not selection["markIndices"]:
            continue
        sets.append(_describe_set(context, settings["model"], entry, selection))

    for entry in sets:
        evaluation = evaluate_sample_set(wafer_map, data, settings["model"], entry["markIndices"], variants, cache)
        entry.update({"results": evaluation["results"], "estimation": evaluation["estimation"], "estimationSquares": evaluation["estimationSquares"], "gpChoices": evaluation["gpChoices"]})
        entry["warnings"].extend(evaluation["warnings"])
        done += 1
        if progress:
            progress(done, total_steps, "補正して残差を求めています")

    uncorrected = {axis: residual_metrics((data["truthX"] if axis == "x" else data["truthY"]).T) for axis in AXES}
    howa_only = [{"key": "howa", "flowType": "howa", "estimator": None, "label": "HOWAのみ"}]
    all_marks = evaluate_sample_set(wafer_map, data, settings["model"], list(range(len(wafer_map["marks"]))), howa_only, cache, estimation=False)
    if progress:
        progress(total_steps, total_steps, "集計しています")
    estimation_keys = ["howa"] + [estimator["key"] for estimator in _selected_estimators(settings["model"])]
    return {
        "context": context,
        "relaxed": relaxed,
        "sets": sets,
        "variants": variants,
        "criteriaReference": criteria_reference(sets),
        "criteriaSameTerms": list(settings["model"]["termsX"]) == list(settings["model"]["termsY"]),
        "methods": [m for m in methods if any(s["method"] == m["key"] for s in sets)],
        "estimationKeys": estimation_keys,
        "summary": summarize_results(sets, variants, estimation_keys, methods),
        "baselines": {"uncorrected": uncorrected, "allMarks": all_marks["results"]},
        "waferCount": data["waferCount"],
        "map": wafer_map,
    }


def sweep_shot_counts(sweep_settings, eligible_count):
    """スイープする計測Shot数の一覧。設定の誤りは ValueError。"""
    start, end, step = sweep_settings["startShots"], sweep_settings["endShots"], sweep_settings["stepShots"]
    if not (start >= 1 and step >= 1 and end >= start):
        raise ValueError("計測Shot数の範囲は「1 ≦ 開始 ≦ 終了」、刻みは1以上の整数にしてください。")
    if end > eligible_count:
        raise ValueError(f"終了の計測Shot数（{end}）が選べるShot数（{eligible_count}）を超えています。")
    return list(range(start, end + 1, step))


def run_sweep(wafer_map, data, settings, sweep_settings=None, manual_plans=None, progress=None):
    """計測Shot数を変えながら評価する（計測コストと精度のトレードオフ）。

    「k個以上」のときは、Shotあたりの総Mark数の比を保つ。手動プランは1回だけ評価して点として返す（manual）。
    """
    import copy

    sweep_settings = sweep_settings or settings["sweep"]
    context = K.build_context(wafer_map, settings)
    values = sweep_shot_counts(sweep_settings, len(context["items"]))
    sampling_settings = settings["sampling"]
    per_shot = context["markCountPerShot"] if sampling_settings["markMode"] == "exact" else sampling_settings["totalMarkCount"] / sampling_settings["shotCount"]
    points, last = [], None
    steps = len(values) + (1 if manual_plans else 0)
    for index, shot_count in enumerate(values):
        point_settings = copy.deepcopy(settings)
        point_settings["sampling"]["shotCount"] = shot_count
        # 丸めはブラウザ版の Math.round と同じ（0.5 は大きい方へ）
        point_settings["sampling"]["totalMarkCount"] = max(shot_count * context["markCountPerShot"], math.floor(shot_count * per_shot + 0.5))
        point_settings["sampling"]["draws"] = sweep_settings["draws"]
        report = (lambda done, total, label, i=index, s=shot_count: progress(i + done / total, steps, f"計測Shot数 {s}: {label}")) if progress else None
        try:
            output = run_evaluation(wafer_map, data, point_settings, [], report)
        except ValueError as error:
            points.append({"shotCount": shot_count, "errors": [str(error)]})
            continue
        points.append(
            {
                "shotCount": shot_count,
                "markCounts": {key: entry["markCount"]["mean"] for key, entry in output["summary"].items()},
                "summary": output["summary"],
                "relaxed": output["relaxed"],
                "warnings": list(dict.fromkeys(w for s in output["sets"] for w in s["warnings"])),
            }
        )
        last = output
    manual = None
    plans = [plan for plan in (manual_plans or []) if plan["shotIndices"]]
    if plans:
        manual_settings = copy.deepcopy(settings)
        manual_settings["sampling"]["methods"] = {key: False for key in manual_settings["sampling"]["methods"]}
        output = run_evaluation(wafer_map, data, manual_settings, plans)
        manual = {
            "methods": output["methods"],
            "summary": output["summary"],
            "shotCounts": {key: entry["shotCount"]["mean"] for key, entry in output["summary"].items()},
            "markCounts": {key: entry["markCount"]["mean"] for key, entry in output["summary"].items()},
        }
    return {
        "points": points,
        "methods": last["methods"] if last else [],
        "manual": manual,
        "variants": last["variants"] if last else [],
        "estimationKeys": last["estimationKeys"] if last else [],
        "baseline": summarize_store(last["baselines"]["allMarks"]["howa"]) if last else None,
        "uncorrected": summarize_store(last["baselines"]["uncorrected"]) if last else None,
        "waferCount": data["waferCount"],
        "draws": sweep_settings["draws"],
    }
