/**
 * 計測データのファイル（アライメント・OVL計測の標準の表）から、Waferマップと評価データを作る。
 *
 * 列（項目名は大文字・小文字も含めてこのとおり。1行1Mark）:
 *   必須: Wafer, shotNo, Direction, Xmm, Ymm, markNo, markXmm, markYmm, measX, measY
 *   任意: DateTime, Radius, StsX, StsY
 * - Wafer と DateTime の組を1枚の評価Waferにする（ファイルに出てくる順）
 * - Direction は 1 = Up、2 = Down
 * - StsX・StsY は 0 だけを有効とし、それ以外（-1 = 未測定）の値は使わない（0 とみなさない）。列がなければ、数値があれば有効
 * - Wafer・DateTime・Shot・Mark が同じ行は重複とみなし、X・Yそれぞれ有効な値を平均する
 * - どれかのWaferで、XかYが測れていない（無効の値か、行がない）Markは「無効マーク」にする。
 *   計測の対象にせず、評価（残差）にも使わない。マップには印を変えて表示する
 * - Shot番号は shotNo、Shotは shotNo の小さい順に並べる。Mark座標はShot中心からの値（Wafer座標 = Xmm + markXmm）
 *
 * 評価データの形は乱数のデータと同じで、真のずれ（truthX, truthY）にファイルの計測値を入れ、ノイズは0にする
 * （計測値そのものを「真のずれ」とみなし、選んだMarkの計測値から補正した残差を全Markで求める）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;

  // 数値とみなす文字（"1,000" や "inf" などは数値にしない。Python版・MATLAB版と同じ判定にする）
  const NUMBER_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
  const SECONDS_PER_DAY = 86400;
  // Excelの日付の数値の起点（1900年基準は 1899-12-30、1904年基準は 1904-01-01）
  const EXCEL_EPOCH_1900_MS = Date.UTC(1899, 11, 30);
  const EXCEL_EPOCH_1904_MS = Date.UTC(1904, 0, 1);

  function parseNumber(text) {
    return NUMBER_PATTERN.test(text) ? Number(text) : NaN;
  }

  function pad(value, width) {
    return String(value).padStart(width, "0");
  }

  /** Excelの日付の数値を「yyyy/mm/dd hh:mm:ss」にする（秒に丸める）。 */
  function excelSerialText(serial, date1904) {
    const epoch = date1904 ? EXCEL_EPOCH_1904_MS : EXCEL_EPOCH_1900_MS;
    const date = new Date(epoch + Math.floor(serial * SECONDS_PER_DAY + 0.5) * 1000);
    return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1, 2)}/${pad(date.getUTCDate(), 2)} ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  }

  /** DateTime の値。xlsxの日付は数値で入っているので、日時の文字に直す。 */
  function dateTimeText(text, date1904) {
    return NUMBER_PATTERN.test(text) ? excelSerialText(Number(text), date1904) : text;
  }

  /** 見出しの行から列の位置を決める。必須の列がすべてあるシートのうち、最初のものを使う。 */
  function findSheet(table) {
    const allColumns = C.MEASUREMENT_REQUIRED_COLUMNS.concat(C.MEASUREMENT_OPTIONAL_COLUMNS);
    let firstMissing = null;
    for (const sheet of table.sheets) {
      if (sheet.rows.length === 0) {
        continue;
      }
      const header = sheet.rows[0].cells;
      const columnIndex = {};
      for (const name of allColumns) {
        columnIndex[name] = header.indexOf(name);
      }
      const missing = C.MEASUREMENT_REQUIRED_COLUMNS.filter((name) => columnIndex[name] < 0);
      if (missing.length === 0) {
        return { sheet, columnIndex, errors: [] };
      }
      if (!firstMissing) {
        firstMissing = { sheet, missing };
      }
    }
    if (!firstMissing) {
      return { sheet: null, errors: ["ファイルにデータの行がありません。1行目に見出し、2行目から1行1Markで計測値を書いてください。"] };
    }
    const where = table.sheets.length > 1 ? "どのシートの1行目にも" : "1行目に";
    return {
      sheet: null,
      errors: [
        `${where}列「${firstMissing.missing.join("」「")}」がありません。`,
        `見出しは ${C.MEASUREMENT_REQUIRED_COLUMNS.join(", ")}（任意で ${C.MEASUREMENT_OPTIONAL_COLUMNS.join(", ")}）にしてください。大文字・小文字も同じにします。`,
      ],
    };
  }

  /** 誤りの説明をためる（多すぎるときは件数だけにする）。 */
  function createErrorList() {
    const messages = [];
    let count = 0;
    return {
      add(message) {
        count++;
        if (messages.length < C.MEASUREMENT_MAX_ERRORS) {
          messages.push(message);
        }
      },
      list() {
        return count > messages.length ? messages.concat([`ほかに${count - messages.length}件の誤りがあります。`]) : messages;
      },
      get count() {
        return count;
      },
    };
  }

  /** 状態の列と値から、その値を使えるか（列がなければ値が数値なら使う）。 */
  function isUsable(statusText, hasStatus, value) {
    if (hasStatus && parseNumber(statusText) !== C.MEASUREMENT_VALID_STATUS) {
      return false;
    }
    return Number.isFinite(value);
  }

  /** 表の行を読み、1行1Markの記録にする。 */
  function readRecords(sheet, columnIndex, date1904) {
    const errors = createErrorList();
    const records = [];
    const counts = { unmeasuredValues: 0, radiusMismatch: 0 };
    const hasColumn = (name) => columnIndex[name] >= 0;
    for (const row of sheet.rows.slice(1)) {
      const read = (name) => (hasColumn(name) ? row.cells[columnIndex[name]] ?? "" : "");
      const line = row.line;
      let rowHasError = false;
      const wafer = read("Wafer");
      if (wafer === "") {
        errors.add(`${line}行目: Wafer が空です。Waferを区別する値を入れてください。`);
        rowHasError = true;
      }
      const numbers = {};
      for (const name of ["shotNo", "Xmm", "Ymm", "markNo", "markXmm", "markYmm"]) {
        numbers[name] = parseNumber(read(name));
        if (!Number.isFinite(numbers[name])) {
          errors.add(`${line}行目: ${name} の「${read(name)}」が数値ではありません。半角の数値を入れてください。`);
          rowHasError = true;
        }
      }
      if (Number.isFinite(numbers.shotNo) && !Number.isInteger(numbers.shotNo)) {
        errors.add(`${line}行目: shotNo は整数にしてください。`);
        rowHasError = true;
      }
      if (Number.isFinite(numbers.markNo) && (!Number.isInteger(numbers.markNo) || numbers.markNo < 1)) {
        errors.add(`${line}行目: markNo は1以上の整数にしてください。`);
        rowHasError = true;
      }
      const scan = C.MEASUREMENT_DIRECTIONS[parseNumber(read("Direction"))];
      if (!scan) {
        errors.add(`${line}行目: Direction の「${read("Direction")}」が読めません。1（Up）か 2（Down）にしてください。`);
        rowHasError = true;
      }
      if (rowHasError) {
        continue;
      }
      const measX = parseNumber(read("measX"));
      const measY = parseNumber(read("measY"));
      const validX = isUsable(read("StsX"), hasColumn("StsX"), measX);
      const validY = isUsable(read("StsY"), hasColumn("StsY"), measY);
      counts.unmeasuredValues += (validX ? 0 : 1) + (validY ? 0 : 1);
      const radius = parseNumber(read("Radius"));
      if (Number.isFinite(radius) && Math.abs(radius - Math.hypot(numbers.Xmm, numbers.Ymm)) > C.MEASUREMENT_RADIUS_TOLERANCE_MM) {
        counts.radiusMismatch++;
      }
      records.push({
        line,
        wafer,
        dateTime: dateTimeText(read("DateTime"), date1904),
        shotNo: numbers.shotNo,
        scan,
        x: numbers.Xmm,
        y: numbers.Ymm,
        markNo: numbers.markNo,
        markX: numbers.markXmm,
        markY: numbers.markYmm,
        measX: validX ? measX : NaN,
        measY: validY ? measY : NaN,
      });
    }
    return { records, errors, counts };
  }

  function sameCoordinate(left, right) {
    return Math.abs(left - right) <= C.MEASUREMENT_COORDINATE_TOLERANCE_MM;
  }

  /** 記録をWafer・Shot・Markにまとめる（同じShot・Markの座標とScan方向が行で違えば誤り）。 */
  function groupRecords(records, errors) {
    const wafers = [];
    const waferIndexByKey = new Map();
    const shotsByNo = new Map();
    const values = new Map();
    let duplicateRows = 0;
    for (const record of records) {
      const waferKey = `${record.wafer}\u0000${record.dateTime}`;
      if (!waferIndexByKey.has(waferKey)) {
        waferIndexByKey.set(waferKey, wafers.length);
        wafers.push({ wafer: record.wafer, dateTime: record.dateTime });
      }
      let shot = shotsByNo.get(record.shotNo);
      if (!shot) {
        shot = { shotNo: record.shotNo, x: record.x, y: record.y, scan: record.scan, line: record.line, marks: new Map() };
        shotsByNo.set(record.shotNo, shot);
      } else if (!sameCoordinate(shot.x, record.x) || !sameCoordinate(shot.y, record.y) || shot.scan !== record.scan) {
        errors.add(`${record.line}行目: shotNo ${record.shotNo} の Xmm・Ymm か Direction が${shot.line}行目と違います。同じShotでは同じ値にしてください。`);
        continue;
      }
      let mark = shot.marks.get(record.markNo);
      if (!mark) {
        mark = { markNo: record.markNo, localX: record.markX, localY: record.markY, line: record.line };
        shot.marks.set(record.markNo, mark);
      } else if (!sameCoordinate(mark.localX, record.markX) || !sameCoordinate(mark.localY, record.markY)) {
        errors.add(`${record.line}行目: shotNo ${record.shotNo} の markNo ${record.markNo} の markXmm・markYmm が${mark.line}行目と違います。同じMarkでは同じ値にしてください。`);
        continue;
      }
      const key = `${waferIndexByKey.get(waferKey)}|${record.shotNo}|${record.markNo}`;
      let entry = values.get(key);
      if (!entry) {
        entry = { sumX: 0, countX: 0, sumY: 0, countY: 0 };
        values.set(key, entry);
      } else {
        duplicateRows++;
      }
      if (Number.isFinite(record.measX)) {
        entry.sumX += record.measX;
        entry.countX++;
      }
      if (Number.isFinite(record.measY)) {
        entry.sumY += record.measY;
        entry.countY++;
      }
    }
    return { wafers, shotsByNo, values, duplicateRows };
  }

  /** そのWaferで、そのMarkのX・Yがどちらも測れているか。 */
  function isMeasured(values, waferIndex, shotNo, markNo) {
    const entry = values.get(`${waferIndex}|${shotNo}|${markNo}`);
    return Boolean(entry) && entry.countX > 0 && entry.countY > 0;
  }

  /** 同じWaferが日時違いで複数あれば、名前に日時を添える。 */
  function waferNamesOf(wafers) {
    const dateCounts = new Map();
    for (const entry of wafers) {
      dateCounts.set(entry.wafer, (dateCounts.get(entry.wafer) || 0) + 1);
    }
    return wafers.map((entry) => (dateCounts.get(entry.wafer) > 1 ? `${entry.wafer} ${entry.dateTime}` : entry.wafer));
  }

  function validateMapOptions(options) {
    const errors = [];
    if (!(options.shotWidthMm > 0) || !(options.shotHeightMm > 0)) {
      errors.push("Shotの幅と高さは0より大きい値にしてください。");
    }
    if (!(options.validRadiusMm > 0) || options.validRadiusMm > C.WAFER_RADIUS_MM) {
      errors.push(`有効半径は0より大きく${C.WAFER_RADIUS_MM} mm以下にしてください。`);
    }
    return errors;
  }

  /**
   * 表（ASC.tableReader の形）から、Waferマップと評価データを作る。
   * mapOptions: { shotWidthMm, shotHeightMm, validRadiusMm }（マップの描画と有効範囲）
   * 戻り値: { map, data, report, errors }。誤りがあれば map と data は null
   *   report: { sheetName, rowCount, waferNames, duplicateRows, unmeasuredValues, radiusMismatch,
   *             invalidMarks: [{ shotId, markNo, missingWafers }], waferMissing: [{ name, count }] }
   */
  function buildFromTable(table, mapOptions) {
    const optionErrors = validateMapOptions(mapOptions);
    if (optionErrors.length > 0) {
      return { map: null, data: null, report: null, errors: optionErrors };
    }
    const found = findSheet(table);
    if (!found.sheet) {
      return { map: null, data: null, report: null, errors: found.errors };
    }
    const { records, errors, counts } = readRecords(found.sheet, found.columnIndex, table.date1904);
    const grouped = groupRecords(records, errors);
    if (errors.count > 0) {
      return { map: null, data: null, report: null, errors: errors.list() };
    }
    const waferCount = grouped.wafers.length;
    if (waferCount === 0) {
      return { map: null, data: null, report: null, errors: ["データの行がありません。2行目から1行1Markで計測値を書いてください。"] };
    }
    if (waferCount > ASC.evaluationData.MAX_WAFER_COUNT) {
      return { map: null, data: null, report: null, errors: [`Waferが${waferCount}枚あります。${ASC.evaluationData.MAX_WAFER_COUNT}枚以下にしてください。`] };
    }

    // Markごとに、測れていないWaferの数を数える（有効範囲の外のMarkは使わないので数えない）
    const waferMissing = new Array(waferCount).fill(0);
    const missingByMark = new Map();
    const shotNos = Array.from(grouped.shotsByNo.keys()).sort((a, b) => a - b);
    const shotRecords = shotNos.map((shotNo) => {
      const shot = grouped.shotsByNo.get(shotNo);
      const marks = Array.from(shot.marks.values()).sort((a, b) => a.markNo - b.markNo);
      return {
        id: String(shotNo),
        x: shot.x,
        y: shot.y,
        scan: shot.scan,
        marks: marks.map((mark) => {
          const inside = Math.hypot(shot.x + mark.localX, shot.y + mark.localY) < mapOptions.validRadiusMm;
          let missing = 0;
          for (let wafer = 0; wafer < waferCount; wafer++) {
            if (!isMeasured(grouped.values, wafer, shotNo, mark.markNo)) {
              missing++;
              if (inside) {
                waferMissing[wafer]++;
              }
            }
          }
          missingByMark.set(`${shotNo}|${mark.markNo}`, missing);
          return { markNo: mark.markNo, localX: mark.localX, localY: mark.localY, invalid: missing > 0 };
        }),
      };
    });

    const map = ASC.waferMap.buildMap(shotRecords, mapOptions);
    if (map.shots.length === 0) {
      return {
        map: null,
        data: null,
        report: null,
        errors: ["有効なMarkがありません（有効範囲の中のMarkが、どれかのWaferで測れていないか、範囲の外です）。座標の単位（mm）と有効半径、StsX・StsY を確かめてください。"],
      };
    }

    const markCount = map.marks.length;
    const truthX = new Float64Array(waferCount * markCount);
    const truthY = new Float64Array(waferCount * markCount);
    for (let wafer = 0; wafer < waferCount; wafer++) {
      map.marks.forEach((mark, markIndex) => {
        const entry = grouped.values.get(`${wafer}|${map.shots[mark.shotIndex].id}|${mark.markNo}`);
        truthX[wafer * markCount + markIndex] = entry.sumX / entry.countX;
        truthY[wafer * markCount + markIndex] = entry.sumY / entry.countY;
      });
    }
    const waferNames = waferNamesOf(grouped.wafers);
    const data = {
      source: C.DATA_SOURCE_FILE,
      waferCount,
      markCount,
      truthX,
      truthY,
      noiseX: new Float64Array(waferCount * markCount),
      noiseY: new Float64Array(waferCount * markCount),
      waferNames,
    };
    const report = {
      sheetName: found.sheet.name,
      rowCount: records.length,
      waferNames,
      duplicateRows: grouped.duplicateRows,
      unmeasuredValues: counts.unmeasuredValues,
      radiusMismatch: counts.radiusMismatch,
      invalidMarks: map.invalidMarks.map((mark) => ({ shotId: mark.shotId, markNo: mark.markNo, missingWafers: missingByMark.get(`${mark.shotId}|${mark.markNo}`) })),
      waferMissing: waferNames.map((name, index) => ({ name, count: waferMissing[index] })).filter((entry) => entry.count > 0),
    };
    return { map, data, report, errors: [] };
  }

  /** 読み込みの結果を、画面に出す短い文の一覧にする。 */
  function describeReport(map, report) {
    const lines = [
      `Wafer ${report.waferNames.length}枚、Shot ${map.shots.length}個、有効なMark ${map.marks.length}個（${report.rowCount}行${report.sheetName ? `、シート「${report.sheetName}」` : ""}）`,
    ];
    if (report.invalidMarks.length > 0) {
      lines.push(`無効マーク ${report.invalidMarks.length}個（どれかのWaferでXかYが測れていないMark。計測の対象にしません）`);
    }
    if (map.inactiveShots.length > 0) {
      lines.push(`Markがすべて無効マークのShot ${map.inactiveShots.length}個は選べません`);
    }
    if (report.waferMissing.length > 0) {
      const worst = report.waferMissing.slice().sort((a, b) => b.count - a.count).slice(0, 3);
      lines.push(`測れていないMarkのあるWafer ${report.waferMissing.length}枚（多い順に ${worst.map((entry) => `${entry.name}: ${entry.count}個`).join("、")}）`);
    }
    if (map.excludedMarkCount > 0) {
      lines.push(`有効半径の外のMark ${map.excludedMarkCount}個は使いません`);
    }
    if (report.duplicateRows > 0) {
      lines.push(`同じWafer・Markの重複行 ${report.duplicateRows}行は、X・Yそれぞれ平均しました`);
    }
    if (report.radiusMismatch > 0) {
      lines.push(`Radius が sqrt(Xmm² + Ymm²) と合わない行が ${report.radiusMismatch}行あります（計算には使っていません）`);
    }
    return lines;
  }

  ASC.measurementData = { buildFromTable, describeReport, excelSerialText, parseNumber };
})(typeof window !== "undefined" ? window : globalThis);
