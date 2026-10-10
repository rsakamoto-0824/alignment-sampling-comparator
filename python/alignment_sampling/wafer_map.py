"""Waferマップ（Shot・Mark・Scan方向）の生成とCSVの読み書き。ブラウザ版（src/js/wafer-map.js）と同じ手順。

マップは辞書で持つ。
  shots: [{"id", "x", "y", "scan", "markIndices", "definedMarkCount"}]  x, y はShot中心 [mm]
    definedMarkCount はShotに定義したMarkの数（有効範囲外も含む）。markIndices の数より多ければ「Markが揃わない端のShot」
  marks: [{"shotIndex", "markNo", "x", "y", "u", "v"}]  x, y はWafer座標 [mm]、u, v は正規化座標
marks には有効範囲（r < 有効半径）のMarkだけを入れる。
"""

import csv
import io
import math

from . import constants as C

CSV_COLUMNS = ["ShotId", "ShotX", "ShotY", "ScanDir", "MarkNo", "MarkX", "MarkY"]
# 選んだ点のCSV: マップのCSVの列に、Wafer座標（Shot中心＋Mark座標）を足す
SELECTION_CSV_COLUMNS = CSV_COLUMNS + ["WaferX", "WaferY"]
SCAN_ALIASES = {
    "up": C.SCAN_UP, "u": C.SCAN_UP, "上": C.SCAN_UP, "+1": C.SCAN_UP, "1": C.SCAN_UP,
    "down": C.SCAN_DOWN, "d": C.SCAN_DOWN, "下": C.SCAN_DOWN, "-1": C.SCAN_DOWN,
}


def _scan_from_pattern(pattern, column, row):
    """格子の位置で決まる並べ方のScan方向（一筆書きは、マップを作ったあとで assign_serpentine_scan が決める）。"""
    if pattern == "column":
        return C.SCAN_UP if column % 2 == 0 else C.SCAN_DOWN
    if pattern == "row":
        return C.SCAN_UP if row % 2 == 0 else C.SCAN_DOWN
    if pattern == "allUp":
        return C.SCAN_UP
    return C.SCAN_UP if (column + row) % 2 == 0 else C.SCAN_DOWN


def build_map(shot_records, options):
    """Shot・Markの記録からマップを組み立てる（生成とCSV読込で共通）。"""
    valid_radius = options["validRadiusMm"]
    shots, marks = [], []
    excluded_marks = excluded_shots = 0
    mark_numbers = set()
    for record in shot_records:
        valid = []
        for mark in record["marks"]:
            x = record["x"] + mark["localX"]
            y = record["y"] + mark["localY"]
            if math.hypot(x, y) < valid_radius:
                valid.append({"markNo": mark["markNo"], "x": x, "y": y})
        if not valid:
            excluded_shots += 1
            continue
        excluded_marks += len(record["marks"]) - len(valid)
        shot_index = len(shots)
        shot = {"id": str(record["id"]), "x": record["x"], "y": record["y"], "scan": record["scan"], "markIndices": [], "definedMarkCount": len(record["marks"])}
        for mark in sorted(valid, key=lambda entry: entry["markNo"]):
            shot["markIndices"].append(len(marks))
            mark_numbers.add(mark["markNo"])
            marks.append(
                {
                    "shotIndex": shot_index,
                    "markNo": mark["markNo"],
                    "x": mark["x"],
                    "y": mark["y"],
                    "u": mark["x"] / C.NORMALIZATION_RADIUS_MM,
                    "v": mark["y"] / C.NORMALIZATION_RADIUS_MM,
                }
            )
        shots.append(shot)
    return {
        "shots": shots,
        "marks": marks,
        "markNumbers": sorted(mark_numbers),
        "validRadiusMm": valid_radius,
        "shotWidthMm": options.get("shotWidthMm"),
        "shotHeightMm": options.get("shotHeightMm"),
        "excludedMarkCount": excluded_marks,
        "excludedShotCount": excluded_shots,
    }


def assign_serpentine_scan(shots, start, first_scan):
    """一筆書き（露光順）のScan方向を付ける（ブラウザ版の assignSerpentineScan と同じ）。

    開始の角の行から、行ごとに進む向きを反転しながらたどり、たどった順に first・その逆・first… と付ける。
    shots は生成した順（上の行から下へ、各行は左から右へ）。マップにあるShotだけを道順に数える。
    """
    rows = []
    for shot in shots:
        if rows and rows[-1][0]["y"] == shot["y"]:
            rows[-1].append(shot)
        else:
            rows.append([shot])
    if start in ("bottomLeft", "bottomRight"):
        rows.reverse()
    first_left_to_right = start in ("topLeft", "bottomLeft")
    other_scan = C.SCAN_DOWN if first_scan == C.SCAN_UP else C.SCAN_UP
    order = 0
    for row_index, row in enumerate(rows):
        left_to_right = first_left_to_right if row_index % 2 == 0 else not first_left_to_right
        for shot in row if left_to_right else list(reversed(row)):
            shot["scan"] = first_scan if order % 2 == 0 else other_scan
            order += 1


def generate_wafer_map(settings):
    """設定からマップを生成する。Shotは上の行から下へ、各行は左から右へ番号を付ける。"""
    width, height = settings["shotWidthMm"], settings["shotHeightMm"]
    if not (width > 0 and height > 0):
        raise ValueError("Shotの幅と高さは0より大きい値にしてください。")
    if settings["scanPattern"] == "serpentine":
        if settings.get("serpentineStart") not in C.SERPENTINE_STARTS:
            raise ValueError("一筆書きの開始の角を選んでください。")
        if settings.get("serpentineFirstScan") not in (C.SCAN_UP, C.SCAN_DOWN):
            raise ValueError("一筆書きの最初のScan方向は Up か Down にしてください。")
    reach = C.WAFER_RADIUS_MM + max(width, height)
    column_limit = math.ceil((reach + abs(settings["offsetXmm"])) / width)
    row_limit = math.ceil((reach + abs(settings["offsetYmm"])) / height)
    records = []
    for row in range(row_limit, -row_limit - 1, -1):
        for column in range(-column_limit, column_limit + 1):
            records.append(
                {
                    "id": "",
                    "x": settings["offsetXmm"] + column * width,
                    "y": settings["offsetYmm"] + row * height,
                    "scan": _scan_from_pattern(settings["scanPattern"], column, row),
                    "marks": [{"markNo": mark["markNo"], "localX": mark["x"], "localY": mark["y"]} for mark in settings["marks"]],
                }
            )
    wafer_map = build_map(records, settings)
    wafer_map["excludedShotCount"] = 0
    if settings["scanPattern"] == "serpentine":
        assign_serpentine_scan(wafer_map["shots"], settings["serpentineStart"], settings["serpentineFirstScan"])
    for index, shot in enumerate(wafer_map["shots"]):
        shot["id"] = str(index + 1)
    if not wafer_map["shots"]:
        raise ValueError("有効範囲に入るMarkがありません。Shotの配置か有効半径を見直してください。")
    return wafer_map


def _number_text(value):
    """JavaScript の数値の文字列化に近い形（整数は小数点なし）。ShotId などの照合に使う。"""
    return str(int(value)) if float(value).is_integer() else repr(float(value))


def parse_map_csv(text, options):
    """CSV（1行1Mark）を読み込んでマップを作る。誤りは「何行目の何が」を ValueError で知らせる。"""
    rows = list(csv.reader(io.StringIO(text.lstrip("﻿"))))
    if not rows:
        raise ValueError("CSVが空です。")
    header = [cell.strip().lower() for cell in rows[0]]
    missing = [name for name in CSV_COLUMNS if name.lower() not in header]
    if missing:
        raise ValueError(f"1行目に列 {', '.join(missing)} がありません。見出しを {', '.join(CSV_COLUMNS)} にしてください。")
    column = {name: header.index(name.lower()) for name in CSV_COLUMNS}
    errors, shots_by_id = [], {}
    for line_number, cells in enumerate(rows[1:], start=2):
        if not any(cell.strip() for cell in cells):
            continue
        read = lambda name: cells[column[name]].strip() if column[name] < len(cells) else ""
        try:
            shot_x, shot_y = float(read("ShotX")), float(read("ShotY"))
            mark_no, mark_x, mark_y = float(read("MarkNo")), float(read("MarkX")), float(read("MarkY"))
        except ValueError:
            errors.append(f"{line_number}行目: 数値でない値があります。")
            continue
        scan = SCAN_ALIASES.get(read("ScanDir").lower())
        if scan is None or read("ShotId") == "" or not mark_no.is_integer() or mark_no < 1:
            errors.append(f"{line_number}行目: ScanDir（Up/Down）・ShotId・MarkNo（1以上の整数）を確かめてください。")
            continue
        shot_id = read("ShotId")
        shot = shots_by_id.get(shot_id)
        if shot is None:
            shot = {"id": shot_id, "x": shot_x, "y": shot_y, "scan": scan, "marks": []}
            shots_by_id[shot_id] = shot
        elif (shot["x"], shot["y"], shot["scan"]) != (shot_x, shot_y, scan):
            errors.append(f"{line_number}行目: Shot {shot_id} の座標かScan方向が前の行と違います。")
            continue
        if any(mark["markNo"] == int(mark_no) for mark in shot["marks"]):
            errors.append(f"{line_number}行目: Shot {shot_id} の Mark {int(mark_no)} が重複しています。")
            continue
        shot["marks"].append({"markNo": int(mark_no), "localX": mark_x, "localY": mark_y})
    if errors:
        raise ValueError("\n".join(errors))
    if not shots_by_id:
        raise ValueError("データの行がありません。")
    wafer_map = build_map(list(shots_by_id.values()), options)
    if not wafer_map["shots"]:
        raise ValueError("有効範囲に入るMarkがありません。座標の単位（mm）と有効半径を確認してください。")
    return wafer_map


def _round_for_csv(value):
    """ブラウザ版の Math.round と同じ丸め（0.5 は大きい方へ。Python の round は偶数へ丸めるので使わない）。"""
    return math.floor(value * 1e6 + 0.5) / 1e6


def map_to_csv(wafer_map):
    """マップをCSV（1行1Mark）にする。読込と同じ列の並び。"""
    lines = [",".join(CSV_COLUMNS)]
    for shot in wafer_map["shots"]:
        for mark_index in shot["markIndices"]:
            mark = wafer_map["marks"][mark_index]
            local_x = _round_for_csv(mark["x"] - shot["x"])
            local_y = _round_for_csv(mark["y"] - shot["y"])
            lines.append(",".join([shot["id"], _number_text(shot["x"]), _number_text(shot["y"]), shot["scan"], str(mark["markNo"]), _number_text(local_x), _number_text(local_y)]))
    return "\r\n".join(lines) + "\r\n"


def _csv_text(value):
    """カンマや引用符を含むShotIdは引用符で囲む。"""
    text = str(value)
    return '"' + text.replace('"', '""') + '"' if any(character in text for character in ',"\r\n') else text


def selection_to_csv(wafer_map, mark_indices):
    """選んだ点（測るMark）の座標をCSV（1行1Mark）にする。マップのCSVの列に Wafer座標（WaferX, WaferY）を足す。"""
    lines = [",".join(SELECTION_CSV_COLUMNS)]
    for mark_index in sorted(set(mark_indices)):
        mark = wafer_map["marks"][mark_index]
        shot = wafer_map["shots"][mark["shotIndex"]]
        values = [_round_for_csv(mark["x"] - shot["x"]), _round_for_csv(mark["y"] - shot["y"]), _round_for_csv(mark["x"]), _round_for_csv(mark["y"])]
        lines.append(",".join([_csv_text(shot["id"]), _number_text(shot["x"]), _number_text(shot["y"]), shot["scan"], str(mark["markNo"])] + [_number_text(value) for value in values]))
    return "\r\n".join(lines) + "\r\n"


def build_map_from_settings(settings, csv_text=None):
    """設定（ブラウザ版の設定JSONの settings）からマップを作る。CSVのときは csv_text が要る。"""
    map_settings = settings["map"]
    if map_settings["source"] == "csv":
        if not csv_text:
            raise ValueError("CSVのマップを使う設定ですが、CSVの内容がありません。")
        return parse_map_csv(csv_text, map_settings)
    return generate_wafer_map(map_settings)
