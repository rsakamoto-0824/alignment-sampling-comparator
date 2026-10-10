"""サンプリングの前提（選べるShot・区画分け）と条件制約の判定。ブラウザ版（src/js/constraints.js）と同じ手順。

候補（item）: 選べるShot（除外Shotと、設定によってはMarkが揃わない端のShotを除いたもの）。選んだShotの有効なMarkはすべて測る
区画（class）: 制約ごとの分け方。制約は「選んだShotの数」で数え、区画はShot中心で判定する
目標の幅: 各区画の選択数が入るべき範囲 [floor, ceil]（同数配分なら差1以内と同じ）
強制計測Shot: 必ず選ぶShot（常にハード）。中心の1点のShotとあわせて、入れ替えの対象にしない
"""

import math

import numpy as np

from . import constants as C
from .rng import Random, derive_seed

QUADRANT_LABELS = ["第1象限（x≧0, y≧0）", "第2象限（x<0, y≧0）", "第3象限（x<0, y<0）", "第4象限（x≧0, y<0）"]


def quadrant_of(x, y):
    if y >= 0:
        return 0 if x >= 0 else 1
    return 2 if x < 0 else 3


def zone_of(radius, inner, outer):
    if radius < inner:
        return 0
    return 1 if radius < outer else 2


def shot_id_list(values):
    """Shot番号の並び（数でも文字でもよい）を、重複のない文字の並びにする（順番は入力のまま）。"""
    if not isinstance(values, (list, tuple)):
        return []
    result = []
    for value in values:
        text = _shot_id_text(value).strip()
        if text and text not in result:
            result.append(text)
    return result


def _shot_id_text(value):
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def is_incomplete_shot(shot):
    """Markが揃わない端のShot（定義したMarkの一部が有効範囲の外にあるShot）か。"""
    return len(shot["markIndices"]) < shot["definedMarkCount"]


def build_context(wafer_map, settings):
    """候補・区画・中心の1点・強制計測Shotをまとめた「サンプリングの前提」。設定の誤りは ValueError で知らせる。"""
    sampling, zones, constraint_settings = settings["sampling"], settings["zones"], settings["constraints"]
    errors = []
    if not (zones["innerRadiusMm"] > 0 and zones["outerRadiusMm"] > zones["innerRadiusMm"] and zones["outerRadiusMm"] < wafer_map["validRadiusMm"]):
        errors.append(f"同心円の区切りは 0 < 内側 < 外側 < 有効半径（{wafer_map['validRadiusMm']} mm）にしてください。")
    if not (isinstance(sampling["shotCount"], int) and sampling["shotCount"] >= 1):
        errors.append("計測Shot数は1以上の整数にしてください。")
    priorities = [constraint_settings[key]["priority"] for key in C.CONSTRAINT_KEYS if constraint_settings[key]["enabled"]]
    if len(set(priorities)) != len(priorities):
        errors.append("オンにした制約の優先度が重複しています。")
    if errors:
        raise ValueError("\n".join(errors))

    shot_index_by_id = {shot["id"]: index for index, shot in enumerate(wafer_map["shots"])}
    mandatory_ids = shot_id_list(constraint_settings.get("mandatoryShotIds", []))
    excluded_ids = shot_id_list(constraint_settings.get("excludedShotIds", []))
    for ids, label in [(mandatory_ids, "強制計測Shot"), (excluded_ids, "除外Shot")]:
        unknown = [shot_id for shot_id in ids if shot_id not in shot_index_by_id]
        if unknown:
            errors.append(f"{label}の番号 {', '.join(unknown[:8])} がマップにありません。")
    excluded_shots = {shot_index_by_id[shot_id] for shot_id in excluded_ids if shot_id in shot_index_by_id}

    items, item_by_shot = [], {}
    for shot_index, shot in enumerate(wafer_map["shots"]):
        if shot_index in excluded_shots or (sampling["excludeIncompleteShots"] and is_incomplete_shot(shot)):
            continue
        item_by_shot[shot_index] = len(items)
        items.append({"shotIndex": shot_index, "x": shot["x"], "y": shot["y"], "scan": shot["scan"], "marks": list(shot["markIndices"])})

    mandatory_items = []
    for shot_id in mandatory_ids:
        if shot_id not in shot_index_by_id:
            continue
        shot_index = shot_index_by_id[shot_id]
        if shot_index in excluded_shots:
            errors.append(f"Shot {shot_id} が強制計測Shotと除外Shotの両方に入っています。")
        elif shot_index not in item_by_shot:
            errors.append(f"強制計測Shot {shot_id} はMarkが揃わない端のShotなので選べません。")
        else:
            mandatory_items.append(item_by_shot[shot_index])
    mandatory_items.sort()

    shot_count = sampling["shotCount"]
    if not items:
        errors.append("選べるShotがありません。除外Shotや有効半径を見直してください。")
    elif shot_count > len(items):
        errors.append(f"計測Shot数（{shot_count}）が選べるShot数（{len(items)}）を超えています。")
    if errors:
        raise ValueError("\n".join(errors))

    center = _build_center(wafer_map, items, constraint_settings["center"])
    forced_count = len(set(mandatory_items) | ({center["itemIndex"]} if center["active"] else set()))
    if forced_count > shot_count:
        raise ValueError(f"強制計測Shot（中心の1点のShotを含む）が{forced_count}個あり、計測Shot数（{shot_count}）を超えています。")
    return {
        "map": wafer_map,
        "items": items,
        "shotCount": shot_count,
        "constraints": _build_balance_constraints(items, settings),
        "center": center,
        "mandatoryItems": mandatory_items,
        "softStrength": constraint_settings["softStrength"],
    }


def forced_items_of(context):
    """必ず選ぶ候補（中心の1点のShot → 強制計測Shot の順。入れ替えの対象にしない）。"""
    forced = [context["center"]["itemIndex"]] if context["center"]["active"] else []
    for item in context["mandatoryItems"]:
        if item not in forced:
            forced.append(item)
    return forced


def unconstrained_context(context):
    """条件制約を使わない選び方（D最適・I最適の制約なし）の前提。候補は同じで、制約・中心の1点・強制計測Shotを外す。"""
    return {**context, "constraints": [], "center": {"enabled": False, "active": False}, "mandatoryItems": []}


def _build_balance_constraints(items, settings):
    zones = settings["zones"]
    definitions = {
        "scan": (2, ["Up", "Down"], ["Up", "Down"], lambda item: 0 if item["scan"] == C.SCAN_UP else 1),
        "quadrant": (4, QUADRANT_LABELS, ["第1", "第2", "第3", "第4"], lambda item: quadrant_of(item["x"], item["y"])),
        "zone": (
            3,
            [f"内側（r < {zones['innerRadiusMm']} mm）", f"中間（{zones['innerRadiusMm']}〜{zones['outerRadiusMm']} mm）", f"外側（r ≧ {zones['outerRadiusMm']} mm）"],
            ["内側", "中間", "外側"],
            lambda item: zone_of(math.hypot(item["x"], item["y"]), zones["innerRadiusMm"], zones["outerRadiusMm"]),
        ),
    }
    constraints = []
    for key in ["scan", "quadrant", "zone"]:
        setting = settings["constraints"][key]
        if not setting["enabled"]:
            continue
        class_count, labels, short_labels, class_of = definitions[key]
        classes = np.array([class_of(item) for item in items], dtype=int)
        constraints.append(
            {
                "key": key,
                "label": C.CONSTRAINT_LABELS[key],
                "classCount": class_count,
                "classLabels": labels,
                "classShortLabels": short_labels,
                "classOf": classes,
                "available": np.bincount(classes, minlength=class_count),
                "allocation": setting["allocation"],
                "hard": setting["hard"],
                "priority": setting["priority"],
                "weight": C.PRIORITY_WEIGHTS.get(setting["priority"], 1),
            }
        )
    return constraints


def _build_center(wafer_map, items, setting):
    """中心に最も近いMark（選べるShotの全Markから探す）。そのMarkのShotを必ず選ぶ。"""
    if not setting["enabled"]:
        return {"enabled": False, "active": False}
    best = None
    for item_index, item in enumerate(items):
        for mark_index in item["marks"]:
            mark = wafer_map["marks"][mark_index]
            distance = math.hypot(mark["x"], mark["y"])
            if best is None or distance < best["distance"]:
                best = {"itemIndex": item_index, "markIndex": mark_index, "distance": distance}
    return {"enabled": True, "active": True, "hard": True, "priority": setting["priority"], "itemIndex": best["itemIndex"], "markIndex": best["markIndex"]}


def targets_for(constraint, total):
    """選択数 total のときの、区画ごとの目標の幅 (floor, ceil)。"""
    available = constraint["available"]
    available_sum = int(available.sum())
    floor = np.zeros(constraint["classCount"], dtype=int)
    ceil = np.zeros(constraint["classCount"], dtype=int)
    for c in range(constraint["classCount"]):
        if constraint["allocation"] == C.ALLOCATION_PROPORTIONAL and available_sum > 0:
            share = available[c] / available_sum
        else:
            share = 1 / constraint["classCount"]
        target = total * share
        floor[c] = math.floor(target + 1e-9)
        ceil[c] = math.ceil(target - 1e-9)
    return floor, ceil


def violation_of(counts, targets):
    floor, ceil = targets
    return int(np.maximum(counts - ceil, 0).sum() + np.maximum(floor - counts, 0).sum())


def has_capacity(constraint, total):
    floor, ceil = targets_for(constraint, total)
    available = constraint["available"]
    if np.any(available < floor):
        return False
    return int(np.minimum(available, ceil).sum()) >= total


def _class_violation(count, floor, ceil):
    if count > ceil:
        return count - ceil
    if count < floor:
        return floor - count
    return 0


class SelectionState:
    """選択の状態。区画ごとの数を持ち、追加・削除・入れ替えでの制約の変化を求める（ブラウザ版の createState）。"""

    def __init__(self, context, total):
        self.context = context
        self.total = total
        self.selected = np.zeros(len(context["items"]), dtype=bool)
        self.list = []
        self.counts = [np.zeros(constraint["classCount"], dtype=int) for constraint in context["constraints"]]
        self.targets = [targets_for(constraint, total) for constraint in context["constraints"]]

    def add(self, item):
        self.selected[item] = True
        self.list.append(item)
        for index, constraint in enumerate(self.context["constraints"]):
            self.counts[index][constraint["classOf"][item]] += 1

    def remove(self, item):
        self.selected[item] = False
        self.list.remove(item)
        for index, constraint in enumerate(self.context["constraints"]):
            self.counts[index][constraint["classOf"][item]] -= 1

    def violation(self, hard):
        total = 0
        for index, constraint in enumerate(self.context["constraints"]):
            if constraint["hard"] == hard:
                value = violation_of(self.counts[index], self.targets[index])
                total += value if hard else value * constraint["weight"]
        return total

    def can_add_hard_all(self):
        """全候補について、加えても残りの枠でハード制約を満たせる見込みがあるか（真偽の配列）。"""
        remaining_after = self.total - len(self.list) - 1
        ok = np.ones(len(self.context["items"]), dtype=bool)
        for index, constraint in enumerate(self.context["constraints"]):
            if not constraint["hard"]:
                continue
            counts = self.counts[index]
            floor, ceil = self.targets[index]
            deficit = np.maximum(floor - counts, 0)
            classes = constraint["classOf"]
            over = counts[classes] + 1 > ceil[classes]
            # その区画に加えると、その区画の不足が1減る（不足していれば）
            deficit_after = deficit.sum() - (deficit[classes] > 0)
            ok &= ~over & (deficit_after <= remaining_after)
        return ok

    def soft_overfill_all(self):
        """全候補について、加えたときにソフト制約の区画が上限を超える量（重み付き）。"""
        total = np.zeros(len(self.context["items"]))
        for index, constraint in enumerate(self.context["constraints"]):
            if constraint["hard"]:
                continue
            classes = constraint["classOf"]
            _, ceil = self.targets[index]
            total += np.where(self.counts[index][classes] + 1 > ceil[classes], constraint["weight"], 0)
        return total

    def swap_delta(self, removed, added, hard):
        """removed を外して added を入れたときの、ハード（hard=True）またはソフトの外れ量の変化。"""
        delta = 0
        for index, constraint in enumerate(self.context["constraints"]):
            if constraint["hard"] != hard:
                continue
            source = constraint["classOf"][removed]
            target = constraint["classOf"][added]
            if source == target:
                continue
            counts = self.counts[index]
            floor, ceil = self.targets[index]
            before = _class_violation(counts[source], floor[source], ceil[source]) + _class_violation(counts[target], floor[target], ceil[target])
            after = _class_violation(counts[source] - 1, floor[source], ceil[source]) + _class_violation(counts[target] + 1, floor[target], ceil[target])
            delta += (after - before) if hard else (after - before) * constraint["weight"]
        return delta


def describe_status(context, selected_items, measured_marks):
    """選択の制約の満たし具合。ずれ = 外れた数の合計 ÷ 2（切り上げ。何個のShotを移せば満たせるか）。"""
    total = len(selected_items)
    rows = []
    for constraint in context["constraints"]:
        counts = np.bincount(constraint["classOf"][list(selected_items)], minlength=constraint["classCount"]) if selected_items else np.zeros(constraint["classCount"], dtype=int)
        floor, ceil = targets_for(constraint, total)
        classes = [
            {"label": label, "shortLabel": constraint["classShortLabels"][c], "count": int(counts[c]), "floor": int(floor[c]), "ceil": int(ceil[c]), "ok": bool(floor[c] <= counts[c] <= ceil[c])}
            for c, label in enumerate(constraint["classLabels"])
        ]
        rows.append(
            {
                "key": constraint["key"],
                "label": constraint["label"],
                "hard": constraint["hard"],
                "priority": constraint["priority"],
                "ok": all(entry["ok"] for entry in classes),
                "shift": math.ceil(violation_of(counts, (floor, ceil)) / 2),
                "classes": classes,
            }
        )
    center = context["center"]
    center_row = None
    if center["enabled"]:
        included = center["markIndex"] in measured_marks
        center_row = {"key": "center", "label": C.CONSTRAINT_LABELS["center"], "hard": center["active"], "priority": center["priority"], "ok": included, "shift": 0 if included else 1}
    # 強制計測Shot: ずれは選ばれていない強制計測Shotの数
    mandatory_row = None
    if context["mandatoryItems"]:
        selected = set(selected_items)
        included = sum(1 for item in context["mandatoryItems"] if item in selected)
        total = len(context["mandatoryItems"])
        mandatory_row = {"key": "mandatory", "label": C.CONSTRAINT_LABELS["mandatory"], "hard": True, "priority": 0, "ok": included == total, "shift": total - included, "included": included, "total": total}
    return {"rows": rows, "center": center_row, "mandatory": mandatory_row}


def status_rows(status):
    """満たし具合の行を、表に出す順（区画の制約 → 中心の1点 → 強制計測Shot）に並べる。"""
    return status["rows"] + ([status["center"]] if status["center"] else []) + ([status["mandatory"]] if status.get("mandatory") else [])


def resolve_hard_constraints(context, seed, find_feasible):
    """ハード制約を同時に満たせるか確かめ、満たせなければ優先度の低い順にソフトへ切り替える。"""
    relaxed = []
    for constraint in context["constraints"]:
        if constraint["hard"] and not has_capacity(constraint, context["shotCount"]):
            constraint["hard"] = False
            relaxed.append({"key": constraint["key"], "label": constraint["label"], "reason": "区画によっては選べるShotが目標の数に足りないため"})
    for attempt in range(len(context["constraints"]) + 2):
        random = Random(derive_seed(seed, 7919 + attempt))
        if find_feasible(context, random):
            return relaxed
        candidates = [constraint for constraint in context["constraints"] if constraint["hard"]]
        if context["center"]["active"]:
            candidates.append(context["center"])
        if not candidates:
            return relaxed
        lowest = candidates[0]
        for entry in candidates[1:]:
            if entry["priority"] > lowest["priority"]:
                lowest = entry
        if lowest is context["center"]:
            context["center"]["active"] = False
            relaxed.append({"key": "center", "label": C.CONSTRAINT_LABELS["center"], "reason": "ほかのハード制約と同時に満たす選び方が見つからないため"})
        else:
            lowest["hard"] = False
            relaxed.append({"key": lowest["key"], "label": lowest["label"], "reason": "ほかのハード制約と同時に満たす選び方が見つからないため"})
    return relaxed
