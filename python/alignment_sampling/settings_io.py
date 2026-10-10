"""ブラウザ版で保存した設定JSON（「設定をJSONで保存」）の読み込み。

設定・CSVのマップ・手動プランをそのまま使えるので、アプリで決めた条件と同じ評価を Python で行える。
"""

import copy
import json
from pathlib import Path

from . import constants as C
from .wafer_map import build_map_from_settings

READABLE_VERSIONS = (1, 2, 3)


def _merge(base, loaded):
    """読み込んだ設定を初期設定に重ねる（ブラウザ版の mergeSettings と同じ。型が違う値や知らない項目は使わない）。"""
    if isinstance(base, list):
        return loaded if isinstance(loaded, list) else base
    if isinstance(base, dict):
        return {key: _merge(value, loaded[key]) if isinstance(loaded, dict) and key in loaded else value for key, value in base.items()}
    if base is None:
        return loaded
    if isinstance(base, bool):
        return loaded if isinstance(loaded, bool) else base
    if isinstance(base, (int, float)):
        return loaded if isinstance(loaded, (int, float)) and not isinstance(loaded, bool) else base
    return loaded if isinstance(loaded, type(base)) else base


def _migrate_old_settings(loaded, version):
    """版2以前の設定を版3の形に読み替える（ブラウザ版の migrateOldSettings と同じ）。

    以前のD最適・I最適は制約を守る選び方だったので、制約付きD最適・I最適として読む。
    「必ず測るMark」「k個以上」「HOWA＋推定」は、なくなったので使わない（重ねるときに捨てられる）。
    """
    if version >= 3 or not isinstance(loaded, dict) or not isinstance(loaded.get("sampling"), dict) or not isinstance(loaded["sampling"].get("methods"), dict):
        return loaded
    old = loaded["sampling"]["methods"]
    loaded = copy.deepcopy(loaded)
    loaded["sampling"]["methods"] = {
        "random": old.get("random") is not False,
        "poisson": old.get("poisson") is not False,
        "dOptimal": False,
        "iOptimal": False,
        "constrainedD": old.get("dOptimal") is not False,
        "constrainedI": old.get("iOptimal") is not False,
    }
    return loaded


def load_settings_file(path):
    """設定JSONを読む。戻り値: {"settings", "csvText", "manual"}（manual は手動プランのJSONのまま）。"""
    content = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(content, dict) or content.get("version") not in READABLE_VERSIONS or "settings" not in content:
        raise ValueError("このアプリで保存した設定ファイルではありません。")
    settings = _merge(C.default_settings(), _migrate_old_settings(content["settings"], content["version"]))
    if not isinstance(settings["evaluationData"].get("terms"), list) or len(settings["evaluationData"]["terms"]) != C.MAX_FRINGE_INDEX:
        settings["evaluationData"]["terms"] = C.default_settings()["evaluationData"]["terms"]
    return {"settings": settings, "csvText": content.get("csvText"), "manual": content.get("manual")}


def map_from_loaded(loaded):
    """読み込んだ設定からWaferマップを作る（CSVのマップならファイルに含まれるCSVを使う）。"""
    return build_map_from_settings(loaded["settings"], loaded.get("csvText"))


def manual_plan_inputs(manual_json, wafer_map, only_included=True):
    """手動プランのJSONを、評価に渡す形（マップ上の番号）に直す。以前の形式（手動選択1つ）も読む。

    選んだShotのMarkはすべて測るので、以前の版の追加Mark（marks）は使わない。
    """
    if not manual_json:
        return []
    entries = manual_json.get("plans") if isinstance(manual_json.get("plans"), list) else ([{"name": "手動1", "included": True, **manual_json}] if manual_json.get("shotIds") else [])
    shot_index_by_id = {shot["id"]: index for index, shot in enumerate(wafer_map["shots"])}
    plans = []
    for number, entry in enumerate(entries, start=1):
        if only_included and entry.get("included") is False:
            continue
        shot_ids = [str(shot_id) for shot_id in entry.get("shotIds", [])]
        shot_indices = [shot_index_by_id[shot_id] for shot_id in shot_ids if shot_id in shot_index_by_id]
        plans.append({"key": f"{C.MANUAL_PREFIX}{number}", "label": entry.get("name") or f"手動{number}", "shotIndices": shot_indices})
    return plans


def plan_from_shot_ids(name, shot_ids, wafer_map, key=None):
    """Shot番号の一覧から手動プランを作る（ノートブックやスクリプトで現行のサンプリングを試すとき用）。"""
    shot_index_by_id = {shot["id"]: index for index, shot in enumerate(wafer_map["shots"])}
    unknown = [str(shot_id) for shot_id in shot_ids if str(shot_id) not in shot_index_by_id]
    if unknown:
        raise ValueError(f"マップにないShot番号があります: {', '.join(unknown[:10])}")
    return {"key": key or f"{C.MANUAL_PREFIX}{name}", "label": name, "shotIndices": [shot_index_by_id[str(shot_id)] for shot_id in shot_ids]}


def copy_settings(settings):
    return copy.deepcopy(settings)
