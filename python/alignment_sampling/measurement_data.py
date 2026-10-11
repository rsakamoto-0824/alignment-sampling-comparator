"""計測データのファイル（アライメント・OVL計測の標準の表。csv・xlsx）から、Waferマップと評価データを作る。

ブラウザ版（src/js/table-reader.js・src/js/measurement-data.js）と同じ手順で、同じファイルなら同じマップ・同じ値になる。
xlsx は標準ライブラリ（zipfile・xml）だけで読む（追加のパッケージは要らない）。

列（項目名は大文字・小文字も含めてこのとおり。1行1Mark）:
  必須: Wafer, shotNo, Direction, Xmm, Ymm, markNo, markXmm, markYmm, measX, measY
  任意: DateTime, Radius, StsX, StsY
- Wafer と DateTime の組を1枚の評価Waferにする（ファイルに出てくる順）
- Direction は 1 = Up、2 = Down
- StsX・StsY は 0 だけを有効とし、それ以外（-1 = 未測定）の値は使わない（0 とみなさない）。列がなければ、数値があれば有効
- Wafer・DateTime・Shot・Mark が同じ行は重複とみなし、X・Yそれぞれ有効な値を平均する
- どれかのWaferで、XかYが測れていない（無効の値か、行がない）Markは「無効マーク」にする（計測の対象にせず、評価にも使わない）
- 評価データの形は乱数のデータと同じで、真のずれ（truthX, truthY）にファイルの計測値を入れ、ノイズは0にする

主な使い方:
    result = load_measurement_file("計測.xlsx", settings["map"])
    output = run_evaluation(result["map"], result["data"], settings)
"""

import datetime
import io
import math
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import numpy as np

from . import constants as C
from .evaluation_data import MAX_WAFER_COUNT
from .wafer_map import build_map

# 数値とみなす文字（"1,000" や "inf" などは数値にしない。ブラウザ版・MATLAB版と同じ判定にする）
NUMBER_PATTERN = re.compile(r"[-+]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][-+]?[0-9]+)?")
SECONDS_PER_DAY = 86400
# Excelの日付の数値の起点（1900年基準は 1899-12-30、1904年基準は 1904-01-01）
EXCEL_EPOCH_1900 = datetime.datetime(1899, 12, 30)
EXCEL_EPOCH_1904 = datetime.datetime(1904, 1, 1)
XLSX_SIGNATURE = b"PK"


# ---- 表のファイルを読む ------------------------------------------------------


def split_csv_line(line):
    """CSVの1行をカンマで分ける（ダブルクォートで囲んだ値にも対応。ブラウザ版の splitCsvLine と同じ）。"""
    cells, current, quoted, index = [], "", False, 0
    while index < len(line):
        character = line[index]
        if quoted:
            if character == '"' and index + 1 < len(line) and line[index + 1] == '"':
                current += '"'
                index += 1
            elif character == '"':
                quoted = False
            else:
                current += character
        elif character == '"':
            quoted = True
        elif character == ",":
            cells.append(current.strip())
            current = ""
        else:
            current += character
        index += 1
    cells.append(current.strip())
    return cells


def parse_csv_text(text):
    """CSVの文字を表にする（シートは1つ。シートの名前はない）。"""
    lines = re.split(r"\r\n|\n|\r", text.removeprefix("﻿"))
    rows = [{"line": index + 1, "cells": split_csv_line(line)} for index, line in enumerate(lines) if line.strip() != ""]
    return {"sheets": [{"name": None, "rows": rows}], "date1904": False}


def _decode_csv_bytes(content):
    """UTF-8 で読めなければ、日本語版Excelの既定の Shift_JIS（cp932）として読む。"""
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return content.decode("cp932")


def _local_name(name):
    """名前空間を外した名前（{...}row → row、r:id の属性 → id）。"""
    return name.rsplit("}", 1)[-1]


def _attribute(element, name):
    for key, value in element.attrib.items():
        if _local_name(key) == name:
            return value
    return None


def _children(element, name):
    return [child for child in element if _local_name(child.tag) == name]


def _text_of_runs(element):
    """要素の中の <t> の文字をつなげる。ふりがな（<rPh>）は値ではないので外す。"""
    text = ""
    for child in element:
        name = _local_name(child.tag)
        if name == "rPh":
            continue
        if name == "t":
            text += child.text or ""
        else:
            text += _text_of_runs(child)
    return text


def _column_index(reference):
    """セル番号の列の文字（A, B, …, AA）を0始まりの番号にする。"""
    match = re.match(r"[A-Z]+", reference)
    if not match:
        return -1
    index = 0
    for letter in match.group(0):
        index = index * 26 + (ord(letter) - 64)
    return index - 1


def _cell_value(cell, shared_strings):
    value_elements = _children(cell, "v")
    raw = (value_elements[0].text or "") if value_elements else ""
    cell_type = cell.get("t")
    if cell_type == "s":
        return shared_strings[int(raw)] if raw != "" else ""
    if cell_type == "inlineStr":
        inline = _children(cell, "is")
        return _text_of_runs(inline[0]) if inline else ""
    if cell_type == "b":
        return "TRUE" if raw == "1" else "FALSE"
    return raw


def _sheet_rows(root, shared_strings):
    rows, previous_line = [], 0
    for sheet_data in _children(root, "sheetData"):
        for row in _children(sheet_data, "row"):
            line = int(row.get("r")) if row.get("r") else previous_line + 1
            previous_line = line
            cells = []
            for cell in _children(row, "c"):
                column = _column_index(cell.get("r")) if cell.get("r") else len(cells)
                while len(cells) < column:
                    cells.append("")
                value = _cell_value(cell, shared_strings).strip()
                if column < len(cells):
                    cells[column] = value
                else:
                    cells.append(value)
            if any(cell != "" for cell in cells):
                rows.append({"line": line, "cells": cells})
    return rows


def _sheet_path(target):
    if target.startswith("/"):
        return target[1:]
    return f"xl/{target}".replace("/./", "/")


def read_xlsx_bytes(content):
    """xlsxのバイト列を表にする（シートごとの行の一覧）。"""
    if content[:2] != XLSX_SIGNATURE:
        raise ValueError("xlsxファイルではありません。Excelで「Excel ブック（*.xlsx）」として保存したファイルを選んでください（古い .xls は読めません）。")
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as error:
        raise ValueError("xlsxファイルの中身を読めません（ZIPの形になっていません）。Excelで開いて、xlsxで保存し直してください。") from error
    with archive:
        names = set(archive.namelist())
        if "xl/workbook.xml" not in names or "xl/_rels/workbook.xml.rels" not in names:
            raise ValueError("xlsxファイルにシートの情報がありません。Excelで開いて、xlsxで保存し直してください。")
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relations = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {element.get("Id"): element.get("Target") for element in relations if _local_name(element.tag) == "Relationship"}
        properties = _children(workbook, "workbookPr")
        date1904 = bool(properties) and properties[0].get("date1904") in ("1", "true")
        shared_strings = []
        if "xl/sharedStrings.xml" in names:
            shared_root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [_text_of_runs(item) for item in _children(shared_root, "si")]
        sheets = []
        for sheets_element in _children(workbook, "sheets"):
            for sheet in _children(sheets_element, "sheet"):
                target = targets.get(_attribute(sheet, "id"))
                if not target or _sheet_path(target) not in names:
                    continue
                root = ET.fromstring(archive.read(_sheet_path(target)))
                sheets.append({"name": sheet.get("name") or f"Sheet{len(sheets) + 1}", "rows": _sheet_rows(root, shared_strings)})
    if not sheets:
        raise ValueError("xlsxファイルにシートがありません。")
    return {"sheets": sheets, "date1904": date1904}


def read_table_bytes(file_name, content):
    """ファイルのバイト列を表にする（拡張子で読み方を決める）。"""
    lower = str(file_name).lower()
    if lower.endswith(".csv"):
        return parse_csv_text(_decode_csv_bytes(content))
    if lower.endswith(".xlsx"):
        return read_xlsx_bytes(content)
    raise ValueError("読めるのは .csv と .xlsx のファイルです。Excelのファイルは「Excel ブック（*.xlsx）」で保存してください。")


# ---- 表からマップと評価データを作る ------------------------------------------


def parse_number(text):
    return float(text) if NUMBER_PATTERN.fullmatch(text) else math.nan


def excel_serial_text(serial, date1904=False):
    """Excelの日付の数値を「yyyy/mm/dd hh:mm:ss」にする（秒に丸める。ブラウザ版と同じ丸め）。"""
    epoch = EXCEL_EPOCH_1904 if date1904 else EXCEL_EPOCH_1900
    moment = epoch + datetime.timedelta(seconds=math.floor(serial * SECONDS_PER_DAY + 0.5))
    return moment.strftime("%Y/%m/%d %H:%M:%S")


def _date_time_text(text, date1904):
    return excel_serial_text(float(text), date1904) if NUMBER_PATTERN.fullmatch(text) else text


class _ErrorList:
    """誤りの説明をためる（多すぎるときは件数だけにする）。"""

    def __init__(self):
        self.messages, self.count = [], 0

    def add(self, message):
        self.count += 1
        if len(self.messages) < C.MEASUREMENT_MAX_ERRORS:
            self.messages.append(message)

    def as_list(self):
        if self.count > len(self.messages):
            return self.messages + [f"ほかに{self.count - len(self.messages)}件の誤りがあります。"]
        return self.messages


def _find_sheet(table):
    """必須の列がすべてあるシートのうち、最初のものと列の位置。"""
    all_columns = C.MEASUREMENT_REQUIRED_COLUMNS + C.MEASUREMENT_OPTIONAL_COLUMNS
    first_missing = None
    for sheet in table["sheets"]:
        if not sheet["rows"]:
            continue
        header = sheet["rows"][0]["cells"]
        column_index = {name: header.index(name) if name in header else -1 for name in all_columns}
        missing = [name for name in C.MEASUREMENT_REQUIRED_COLUMNS if column_index[name] < 0]
        if not missing:
            return sheet, column_index
        if first_missing is None:
            first_missing = missing
    if first_missing is None:
        raise ValueError("ファイルにデータの行がありません。1行目に見出し、2行目から1行1Markで計測値を書いてください。")
    where = "どのシートの1行目にも" if len(table["sheets"]) > 1 else "1行目に"
    raise ValueError(
        f"{where}列「{'」「'.join(first_missing)}」がありません。\n"
        f"見出しは {', '.join(C.MEASUREMENT_REQUIRED_COLUMNS)}（任意で {', '.join(C.MEASUREMENT_OPTIONAL_COLUMNS)}）にしてください。大文字・小文字も同じにします。"
    )


def _is_usable(status_text, has_status, value):
    if has_status and parse_number(status_text) != C.MEASUREMENT_VALID_STATUS:
        return False
    return math.isfinite(value)


def _read_records(sheet, column_index, date1904, errors):
    records = []
    counts = {"unmeasuredValues": 0, "radiusMismatch": 0}

    def has_column(name):
        return column_index[name] >= 0

    for row in sheet["rows"][1:]:
        cells = row["cells"]

        def read(name):
            index = column_index[name]
            return cells[index] if 0 <= index < len(cells) else ""

        line = row["line"]
        row_has_error = False
        wafer = read("Wafer")
        if wafer == "":
            errors.add(f"{line}行目: Wafer が空です。Waferを区別する値を入れてください。")
            row_has_error = True
        numbers = {}
        for name in ["shotNo", "Xmm", "Ymm", "markNo", "markXmm", "markYmm"]:
            numbers[name] = parse_number(read(name))
            if not math.isfinite(numbers[name]):
                errors.add(f"{line}行目: {name} の「{read(name)}」が数値ではありません。半角の数値を入れてください。")
                row_has_error = True
        if math.isfinite(numbers["shotNo"]) and not numbers["shotNo"].is_integer():
            errors.add(f"{line}行目: shotNo は整数にしてください。")
            row_has_error = True
        if math.isfinite(numbers["markNo"]) and (not numbers["markNo"].is_integer() or numbers["markNo"] < 1):
            errors.add(f"{line}行目: markNo は1以上の整数にしてください。")
            row_has_error = True
        direction = parse_number(read("Direction"))
        scan = C.MEASUREMENT_DIRECTIONS.get(int(direction)) if math.isfinite(direction) and direction.is_integer() else None
        if scan is None:
            errors.add(f"{line}行目: Direction の「{read('Direction')}」が読めません。1（Up）か 2（Down）にしてください。")
            row_has_error = True
        if row_has_error:
            continue
        meas_x, meas_y = parse_number(read("measX")), parse_number(read("measY"))
        valid_x = _is_usable(read("StsX"), has_column("StsX"), meas_x)
        valid_y = _is_usable(read("StsY"), has_column("StsY"), meas_y)
        counts["unmeasuredValues"] += (0 if valid_x else 1) + (0 if valid_y else 1)
        radius = parse_number(read("Radius"))
        if math.isfinite(radius) and abs(radius - math.hypot(numbers["Xmm"], numbers["Ymm"])) > C.MEASUREMENT_RADIUS_TOLERANCE_MM:
            counts["radiusMismatch"] += 1
        records.append(
            {
                "line": line,
                "wafer": wafer,
                "dateTime": _date_time_text(read("DateTime"), date1904),
                "shotNo": int(numbers["shotNo"]),
                "scan": scan,
                "x": numbers["Xmm"],
                "y": numbers["Ymm"],
                "markNo": int(numbers["markNo"]),
                "markX": numbers["markXmm"],
                "markY": numbers["markYmm"],
                "measX": meas_x if valid_x else math.nan,
                "measY": meas_y if valid_y else math.nan,
            }
        )
    return records, counts


def _same_coordinate(left, right):
    return abs(left - right) <= C.MEASUREMENT_COORDINATE_TOLERANCE_MM


def _group_records(records, errors):
    """記録をWafer・Shot・Markにまとめる（同じShot・Markの座標とScan方向が行で違えば誤り）。"""
    wafers, wafer_index_by_key, shots_by_no, values = [], {}, {}, {}
    duplicate_rows = 0
    for record in records:
        wafer_key = (record["wafer"], record["dateTime"])
        if wafer_key not in wafer_index_by_key:
            wafer_index_by_key[wafer_key] = len(wafers)
            wafers.append({"wafer": record["wafer"], "dateTime": record["dateTime"]})
        shot = shots_by_no.get(record["shotNo"])
        if shot is None:
            shot = {"x": record["x"], "y": record["y"], "scan": record["scan"], "line": record["line"], "marks": {}}
            shots_by_no[record["shotNo"]] = shot
        elif not _same_coordinate(shot["x"], record["x"]) or not _same_coordinate(shot["y"], record["y"]) or shot["scan"] != record["scan"]:
            errors.add(f"{record['line']}行目: shotNo {record['shotNo']} の Xmm・Ymm か Direction が{shot['line']}行目と違います。同じShotでは同じ値にしてください。")
            continue
        mark = shot["marks"].get(record["markNo"])
        if mark is None:
            mark = {"markNo": record["markNo"], "localX": record["markX"], "localY": record["markY"], "line": record["line"]}
            shot["marks"][record["markNo"]] = mark
        elif not _same_coordinate(mark["localX"], record["markX"]) or not _same_coordinate(mark["localY"], record["markY"]):
            errors.add(
                f"{record['line']}行目: shotNo {record['shotNo']} の markNo {record['markNo']} の markXmm・markYmm が{mark['line']}行目と違います。同じMarkでは同じ値にしてください。"
            )
            continue
        key = (wafer_index_by_key[wafer_key], record["shotNo"], record["markNo"])
        entry = values.get(key)
        if entry is None:
            entry = {"sumX": 0.0, "countX": 0, "sumY": 0.0, "countY": 0}
            values[key] = entry
        else:
            duplicate_rows += 1
        if math.isfinite(record["measX"]):
            entry["sumX"] += record["measX"]
            entry["countX"] += 1
        if math.isfinite(record["measY"]):
            entry["sumY"] += record["measY"]
            entry["countY"] += 1
    return wafers, shots_by_no, values, duplicate_rows


def _is_measured(values, wafer, shot_no, mark_no):
    entry = values.get((wafer, shot_no, mark_no))
    return entry is not None and entry["countX"] > 0 and entry["countY"] > 0


def _wafer_names(wafers):
    """同じWaferが日時違いで複数あれば、名前に日時を添える。"""
    counts = {}
    for entry in wafers:
        counts[entry["wafer"]] = counts.get(entry["wafer"], 0) + 1
    return [f"{entry['wafer']} {entry['dateTime']}" if counts[entry["wafer"]] > 1 else entry["wafer"] for entry in wafers]


def build_from_table(table, map_options):
    """表（read_table_bytes の形）から、Waferマップと評価データを作る。誤りは ValueError で知らせる。

    map_options: {"shotWidthMm", "shotHeightMm", "validRadiusMm"}（設定の "map" をそのまま渡せる）
    戻り値: {"map", "data", "report"}
      report: {"sheetName", "rowCount", "waferNames", "duplicateRows", "unmeasuredValues", "radiusMismatch",
               "invalidMarks": [{"shotId", "markNo", "missingWafers"}], "waferMissing": [{"name", "count"}]}
    """
    if not (map_options["shotWidthMm"] > 0 and map_options["shotHeightMm"] > 0):
        raise ValueError("Shotの幅と高さは0より大きい値にしてください。")
    if not 0 < map_options["validRadiusMm"] <= C.WAFER_RADIUS_MM:
        raise ValueError(f"有効半径は0より大きく{C.WAFER_RADIUS_MM} mm以下にしてください。")
    sheet, column_index = _find_sheet(table)
    errors = _ErrorList()
    records, counts = _read_records(sheet, column_index, table["date1904"], errors)
    wafers, shots_by_no, values, duplicate_rows = _group_records(records, errors)
    if errors.count > 0:
        raise ValueError("\n".join(errors.as_list()))
    wafer_count = len(wafers)
    if wafer_count == 0:
        raise ValueError("データの行がありません。2行目から1行1Markで計測値を書いてください。")
    if wafer_count > MAX_WAFER_COUNT:
        raise ValueError(f"Waferが{wafer_count}枚あります。{MAX_WAFER_COUNT}枚以下にしてください。")

    # Markごとに、測れていないWaferの数を数える（有効範囲の外のMarkは使わないので数えない）
    wafer_missing = [0] * wafer_count
    missing_by_mark = {}
    shot_records = []
    for shot_no in sorted(shots_by_no):
        shot = shots_by_no[shot_no]
        marks = []
        for mark in sorted(shot["marks"].values(), key=lambda entry: entry["markNo"]):
            inside = math.hypot(shot["x"] + mark["localX"], shot["y"] + mark["localY"]) < map_options["validRadiusMm"]
            missing = 0
            for wafer in range(wafer_count):
                if not _is_measured(values, wafer, shot_no, mark["markNo"]):
                    missing += 1
                    if inside:
                        wafer_missing[wafer] += 1
            missing_by_mark[(str(shot_no), mark["markNo"])] = missing
            marks.append({"markNo": mark["markNo"], "localX": mark["localX"], "localY": mark["localY"], "invalid": missing > 0})
        shot_records.append({"id": str(shot_no), "x": shot["x"], "y": shot["y"], "scan": shot["scan"], "marks": marks})

    wafer_map = build_map(shot_records, map_options)
    if not wafer_map["shots"]:
        raise ValueError(
            "有効なMarkがありません（有効範囲の中のMarkが、どれかのWaferで測れていないか、範囲の外です）。座標の単位（mm）と有効半径、StsX・StsY を確かめてください。"
        )
    mark_count = len(wafer_map["marks"])
    truth_x = np.zeros((wafer_count, mark_count))
    truth_y = np.zeros((wafer_count, mark_count))
    for wafer in range(wafer_count):
        for index, mark in enumerate(wafer_map["marks"]):
            entry = values[(wafer, int(wafer_map["shots"][mark["shotIndex"]]["id"]), mark["markNo"])]
            truth_x[wafer, index] = entry["sumX"] / entry["countX"]
            truth_y[wafer, index] = entry["sumY"] / entry["countY"]
    names = _wafer_names(wafers)
    data = {
        "source": C.DATA_SOURCE_FILE,
        "waferCount": wafer_count,
        "markCount": mark_count,
        "truthX": truth_x,
        "truthY": truth_y,
        "noiseX": np.zeros((wafer_count, mark_count)),
        "noiseY": np.zeros((wafer_count, mark_count)),
        "waferNames": names,
    }
    report = {
        "sheetName": sheet["name"],
        "rowCount": len(records),
        "waferNames": names,
        "duplicateRows": duplicate_rows,
        "unmeasuredValues": counts["unmeasuredValues"],
        "radiusMismatch": counts["radiusMismatch"],
        "invalidMarks": [
            {"shotId": mark["shotId"], "markNo": mark["markNo"], "missingWafers": missing_by_mark[(mark["shotId"], mark["markNo"])]} for mark in wafer_map["invalidMarks"]
        ],
        "waferMissing": [{"name": name, "count": count} for name, count in zip(names, wafer_missing) if count > 0],
    }
    return {"map": wafer_map, "data": data, "report": report}


def load_measurement_file(path, map_options):
    """計測データのファイル（.csv か .xlsx）を読み、Waferマップと評価データを作る（build_from_table と同じ戻り値）。"""
    path = Path(path)
    return build_from_table(read_table_bytes(path.name, path.read_bytes()), map_options)


def describe_report(wafer_map, report):
    """読み込みの結果を、短い文の一覧にする（ブラウザ版の画面の説明と同じ）。"""
    sheet = f"、シート「{report['sheetName']}」" if report["sheetName"] else ""
    lines = [f"Wafer {len(report['waferNames'])}枚、Shot {len(wafer_map['shots'])}個、有効なMark {len(wafer_map['marks'])}個（{report['rowCount']}行{sheet}）"]
    if report["invalidMarks"]:
        lines.append(f"無効マーク {len(report['invalidMarks'])}個（どれかのWaferでXかYが測れていないMark。計測の対象にしません）")
    if wafer_map["inactiveShots"]:
        lines.append(f"Markがすべて無効マークのShot {len(wafer_map['inactiveShots'])}個は選べません")
    if report["waferMissing"]:
        worst = sorted(report["waferMissing"], key=lambda entry: -entry["count"])[:3]
        lines.append(f"測れていないMarkのあるWafer {len(report['waferMissing'])}枚（多い順に {'、'.join(f'{entry['name']}: {entry['count']}個' for entry in worst)}）")
    if wafer_map["excludedMarkCount"] > 0:
        lines.append(f"有効半径の外のMark {wafer_map['excludedMarkCount']}個は使いません")
    if report["duplicateRows"] > 0:
        lines.append(f"同じWafer・Markの重複行 {report['duplicateRows']}行は、X・Yそれぞれ平均しました")
    if report["radiusMismatch"] > 0:
        lines.append(f"Radius が sqrt(Xmm² + Ymm²) と合わない行が {report['radiusMismatch']}行あります（計算には使っていません）")
    return lines
