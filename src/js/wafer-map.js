/**
 * Waferマップ（Shot・Mark・Scan方向）の生成、CSVの読込と書き出し。
 *
 * マップの形:
 *   shots: [{ id, x, y, scan, markIndices, definedMarkCount }]   x, y はShot中心 [mm]
 *     definedMarkCount はShotに定義したMarkの数（有効範囲外も含む）。markIndices の数より多ければ
 *     「Markが揃わない端のShot」
 *
 *   marks: [{ shotIndex, markNo, x, y, u, v }] x, y はWafer座標 [mm]、u, v は正規化座標
 * marks には有効範囲（r < 有効半径）のMarkだけを入れる。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;

  const CSV_COLUMNS = ["ShotId", "ShotX", "ShotY", "ScanDir", "MarkNo", "MarkX", "MarkY"];
  // 選んだ点のCSV: マップのCSVの列に、Wafer座標（Shot中心＋Mark座標）を足す
  const SELECTION_CSV_COLUMNS = CSV_COLUMNS.concat(["WaferX", "WaferY"]);
  const SCAN_ALIASES = {
    up: C.SCAN_UP,
    u: C.SCAN_UP,
    "上": C.SCAN_UP,
    "+1": C.SCAN_UP,
    "1": C.SCAN_UP,
    down: C.SCAN_DOWN,
    d: C.SCAN_DOWN,
    "下": C.SCAN_DOWN,
    "-1": C.SCAN_DOWN,
  };

  /** 負の数でも 0 か 1 を返す偶奇。 */
  function parity(value) {
    return ((value % 2) + 2) % 2;
  }

  /** 格子の位置で決まる並べ方のScan方向（一筆書きは、マップを作ったあとで assignSerpentineScan が決める）。 */
  function scanFromPattern(pattern, column, row) {
    switch (pattern) {
      case "column":
        return parity(column) === 0 ? C.SCAN_UP : C.SCAN_DOWN;
      case "row":
        return parity(row) === 0 ? C.SCAN_UP : C.SCAN_DOWN;
      case "allUp":
        return C.SCAN_UP;
      default:
        return parity(column + row) === 0 ? C.SCAN_UP : C.SCAN_DOWN;
    }
  }

  /** マップ生成の設定を確認し、誤りの説明の一覧を返す（空なら問題なし）。 */
  function validateGenerateSettings(settings) {
    const errors = [];
    if (!(settings.shotWidthMm > 0) || !(settings.shotHeightMm > 0)) {
      errors.push("Shotの幅と高さは0より大きい値にしてください。");
    }
    if (!(settings.validRadiusMm > 0) || settings.validRadiusMm > C.WAFER_RADIUS_MM) {
      errors.push(`有効半径は0より大きく${C.WAFER_RADIUS_MM} mm以下にしてください。`);
    }
    if (settings.scanPattern === "serpentine") {
      if (!C.SERPENTINE_STARTS[settings.serpentineStart]) {
        errors.push("一筆書きの開始の角を選んでください。");
      }
      if (settings.serpentineFirstScan !== C.SCAN_UP && settings.serpentineFirstScan !== C.SCAN_DOWN) {
        errors.push("一筆書きの最初のScan方向は Up か Down にしてください。");
      }
    }
    if (!Array.isArray(settings.marks) || settings.marks.length === 0) {
      errors.push("Shot内のMarkを1つ以上指定してください。");
      return errors;
    }
    const seen = new Set();
    for (const mark of settings.marks) {
      if (!Number.isInteger(mark.markNo) || mark.markNo < 1) {
        errors.push("Mark番号は1以上の整数にしてください。");
      } else if (seen.has(mark.markNo)) {
        errors.push(`Mark番号 ${mark.markNo} が重複しています。番号を変えてください。`);
      }
      seen.add(mark.markNo);
      if (!Number.isFinite(mark.x) || !Number.isFinite(mark.y)) {
        errors.push(`Mark ${mark.markNo} の座標が数値ではありません。`);
      }
    }
    return errors;
  }

  /**
   * Shot・Markの記録からマップを組み立てる（生成とCSV読込で共通）。
   * shotRecords: [{ id, x, y, scan, marks: [{ markNo, localX, localY }] }]
   */
  function buildMap(shotRecords, options) {
    const validRadius = options.validRadiusMm;
    const shots = [];
    const marks = [];
    // 有効範囲外として外したMarkの数（Shotごと外れたものは excludedShotCount で数える）
    let excludedMarkCount = 0;
    let excludedShotCount = 0;
    const markNumberSet = new Set();

    for (const record of shotRecords) {
      const validMarks = [];
      for (const mark of record.marks) {
        const x = record.x + mark.localX;
        const y = record.y + mark.localY;
        if (Math.hypot(x, y) < validRadius) {
          validMarks.push({ markNo: mark.markNo, x, y });
        }
      }
      if (validMarks.length === 0) {
        excludedShotCount++;
        continue;
      }
      excludedMarkCount += record.marks.length - validMarks.length;
      const shotIndex = shots.length;
      const shot = { id: String(record.id), x: record.x, y: record.y, scan: record.scan, markIndices: [], definedMarkCount: record.marks.length };
      validMarks.sort((left, right) => left.markNo - right.markNo);
      for (const mark of validMarks) {
        shot.markIndices.push(marks.length);
        markNumberSet.add(mark.markNo);
        marks.push({
          shotIndex,
          markNo: mark.markNo,
          x: mark.x,
          y: mark.y,
          u: mark.x / C.NORMALIZATION_RADIUS_MM,
          v: mark.y / C.NORMALIZATION_RADIUS_MM,
        });
      }
      shots.push(shot);
    }

    return {
      shots,
      marks,
      markNumbers: Array.from(markNumberSet).sort((a, b) => a - b),
      validRadiusMm: validRadius,
      shotWidthMm: options.shotWidthMm,
      shotHeightMm: options.shotHeightMm,
      excludedMarkCount,
      excludedShotCount,
    };
  }

  /**
   * 一筆書き（露光順）のScan方向を付ける。露光機は行ごとに蛇行して露光し、1 Shot進むごとにScan方向を
   * 反転すると、レチクルステージを戻さずに済む（タクトが最小）。開始の角の行から、行ごとに進む向きを
   * 反転しながらたどり、たどった順に first・その逆・first… と付ける。
   * shots は生成した順（上の行から下へ、各行は左から右へ）に並んでいること。マップにあるShot
   * （有効なMarkが1つ以上あるShot）だけを道順に数える。
   */
  function assignSerpentineScan(shots, start, firstScan) {
    const rows = [];
    for (const shot of shots) {
      const last = rows[rows.length - 1];
      if (last && last[0].y === shot.y) {
        last.push(shot);
      } else {
        rows.push([shot]);
      }
    }
    if (start === "bottomLeft" || start === "bottomRight") {
      rows.reverse();
    }
    const firstLeftToRight = start === "topLeft" || start === "bottomLeft";
    const otherScan = firstScan === C.SCAN_UP ? C.SCAN_DOWN : C.SCAN_UP;
    let order = 0;
    rows.forEach((row, rowIndex) => {
      const leftToRight = rowIndex % 2 === 0 ? firstLeftToRight : !firstLeftToRight;
      const path = leftToRight ? row : row.slice().reverse();
      for (const shot of path) {
        shot.scan = order % 2 === 0 ? firstScan : otherScan;
        order++;
      }
    });
  }

  /**
   * 設定からマップを生成する。Shotは上の行から下へ、各行は左から右へ番号を付ける。
   */
  function generateWaferMap(settings) {
    const errors = validateGenerateSettings(settings);
    if (errors.length > 0) {
      return { map: null, errors };
    }
    const width = settings.shotWidthMm;
    const height = settings.shotHeightMm;
    const reach = C.WAFER_RADIUS_MM + Math.max(width, height);
    const columnLimit = Math.ceil((reach + Math.abs(settings.offsetXmm)) / width);
    const rowLimit = Math.ceil((reach + Math.abs(settings.offsetYmm)) / height);

    const records = [];
    for (let row = rowLimit; row >= -rowLimit; row--) {
      for (let column = -columnLimit; column <= columnLimit; column++) {
        records.push({
          x: settings.offsetXmm + column * width,
          y: settings.offsetYmm + row * height,
          scan: scanFromPattern(settings.scanPattern, column, row),
          marks: settings.marks.map((mark) => ({ markNo: mark.markNo, localX: mark.x, localY: mark.y })),
        });
      }
    }

    const map = buildMap(records, settings);
    // 生成では格子を広めに作るため、Wafer外のShotの数には意味がない
    map.excludedShotCount = 0;
    if (settings.scanPattern === "serpentine") {
      assignSerpentineScan(map.shots, settings.serpentineStart, settings.serpentineFirstScan);
    }
    map.shots.forEach((shot, index) => {
      shot.id = String(index + 1);
    });
    if (map.shots.length === 0) {
      return { map: null, errors: ["有効範囲に入るMarkがありません。Shotの配置か有効半径を見直してください。"] };
    }
    return { map, errors: [] };
  }

  /** CSVの1行をカンマで分ける（ダブルクォートで囲んだ値にも対応）。 */
  function splitCsvLine(line) {
    const cells = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (quoted) {
        if (character === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (character === '"') {
          quoted = false;
        } else {
          current += character;
        }
      } else if (character === '"') {
        quoted = true;
      } else if (character === ",") {
        cells.push(current.trim());
        current = "";
      } else {
        current += character;
      }
    }
    cells.push(current.trim());
    return cells;
  }

  /**
   * CSV（1行1Mark）を読み込んでマップを作る。
   * 誤りは「何行目の何が、どう直せばよいか」を返す。
   */
  function parseMapCsv(text, options) {
    const errors = [];
    const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
    const headerCells = splitCsvLine(lines[0] || "").map((cell) => cell.toLowerCase());
    const columnIndex = {};
    for (const name of CSV_COLUMNS) {
      const index = headerCells.indexOf(name.toLowerCase());
      if (index < 0) {
        errors.push(`1行目に列「${name}」がありません。見出しを ${CSV_COLUMNS.join(", ")} にしてください。`);
      }
      columnIndex[name] = index;
    }
    if (errors.length > 0) {
      return { map: null, errors };
    }

    const shotsById = new Map();
    for (let lineNumber = 2; lineNumber <= lines.length; lineNumber++) {
      const line = lines[lineNumber - 1];
      if (line.trim() === "") {
        continue;
      }
      const cells = splitCsvLine(line);
      const read = (name) => cells[columnIndex[name]] ?? "";
      const shotId = read("ShotId");
      const numbers = {};
      let rowHasError = false;
      for (const name of ["ShotX", "ShotY", "MarkNo", "MarkX", "MarkY"]) {
        const value = Number(read(name));
        if (read(name) === "" || !Number.isFinite(value)) {
          errors.push(`${lineNumber}行目: ${name} の「${read(name)}」が数値ではありません。数値を入れてください。`);
          rowHasError = true;
        }
        numbers[name] = value;
      }
      const scan = SCAN_ALIASES[read("ScanDir").toLowerCase()];
      if (!scan) {
        errors.push(`${lineNumber}行目: ScanDir の「${read("ScanDir")}」が読めません。Up か Down にしてください。`);
        rowHasError = true;
      }
      if (shotId === "") {
        errors.push(`${lineNumber}行目: ShotId が空です。Shotを区別する値を入れてください。`);
        rowHasError = true;
      }
      if (!Number.isInteger(numbers.MarkNo) || numbers.MarkNo < 1) {
        errors.push(`${lineNumber}行目: MarkNo は1以上の整数にしてください。`);
        rowHasError = true;
      }
      if (rowHasError) {
        continue;
      }

      let shot = shotsById.get(shotId);
      if (!shot) {
        shot = { id: shotId, x: numbers.ShotX, y: numbers.ShotY, scan, marks: [], firstLine: lineNumber };
        shotsById.set(shotId, shot);
      } else if (shot.x !== numbers.ShotX || shot.y !== numbers.ShotY || shot.scan !== scan) {
        errors.push(
          `${lineNumber}行目: Shot ${shotId} の座標かScan方向が${shot.firstLine}行目と違います。同じShotでは同じ値にしてください。`
        );
        continue;
      }
      if (shot.marks.some((mark) => mark.markNo === numbers.MarkNo)) {
        errors.push(`${lineNumber}行目: Shot ${shotId} の Mark ${numbers.MarkNo} が重複しています。どちらかの行を消してください。`);
        continue;
      }
      shot.marks.push({ markNo: numbers.MarkNo, localX: numbers.MarkX, localY: numbers.MarkY });
    }

    if (errors.length > 0) {
      return { map: null, errors };
    }
    if (shotsById.size === 0) {
      return { map: null, errors: ["データの行がありません。2行目以降に1行1MarkでShotとMarkを書いてください。"] };
    }
    const map = buildMap(Array.from(shotsById.values()), options);
    if (map.shots.length === 0) {
      return { map: null, errors: ["有効範囲に入るMarkがありません。座標の単位（mm）と有効半径を確認してください。"] };
    }
    return { map, errors: [] };
  }

  /** マップをCSV（1行1Mark）にする。読込と同じ列の並び。 */
  function mapToCsv(map) {
    const rows = [CSV_COLUMNS.join(",")];
    for (const shot of map.shots) {
      for (const markIndex of shot.markIndices) {
        const mark = map.marks[markIndex];
        rows.push(
          [
            shot.id,
            shot.x,
            shot.y,
            shot.scan,
            mark.markNo,
            roundForCsv(mark.x - shot.x),
            roundForCsv(mark.y - shot.y),
          ].join(",")
        );
      }
    }
    return rows.join("\r\n") + "\r\n";
  }

  /** 引き算で出る 0.30000000000000004 のような誤差をCSVに出さない。 */
  function roundForCsv(value) {
    return Math.round(value * 1e6) / 1e6;
  }

  /**
   * 選んだ点（測るMark）の座標をCSV（1行1Mark）にする。列はマップのCSVと同じ並びに、Wafer座標を足したもの。
   * Markはマップの並び（Shotの番号順、Shot内はMark番号順）にそろえる。
   */
  function selectionToCsv(map, markIndices) {
    const rows = [SELECTION_CSV_COLUMNS.join(",")];
    const sorted = Array.from(new Set(markIndices)).sort((a, b) => a - b);
    for (const markIndex of sorted) {
      const mark = map.marks[markIndex];
      const shot = map.shots[mark.shotIndex];
      rows.push(
        [
          csvText(shot.id),
          shot.x,
          shot.y,
          shot.scan,
          mark.markNo,
          roundForCsv(mark.x - shot.x),
          roundForCsv(mark.y - shot.y),
          roundForCsv(mark.x),
          roundForCsv(mark.y),
        ].join(",")
      );
    }
    return rows.join("\r\n") + "\r\n";
  }

  /** カンマや引用符を含むShotIdは引用符で囲む（CSVから読んだマップのShotIdに備える）。 */
  function csvText(value) {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  ASC.waferMap = { CSV_COLUMNS, SELECTION_CSV_COLUMNS, generateWaferMap, parseMapCsv, mapToCsv, selectionToCsv, buildMap, assignSerpentineScan };
})(typeof window !== "undefined" ? window : globalThis);
