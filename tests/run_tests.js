/**
 * 計算部分の自動テスト。Node.jsで実行する: node tests/run_tests.js
 * 画面のファイル（ui-*.js, app.js）は読み込まない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const SOURCE_FILES = [
  "constants.js",
  "math-utils.js",
  "zernike.js",
  "table-reader.js",
  "wafer-map.js",
  "evaluation-data.js",
  "measurement-data.js",
  "correction.js",
  "constraints.js",
  "sampling.js",
  "evaluator.js",
  "manual-plans.js",
];
for (const file of SOURCE_FILES) {
  const code = fs.readFileSync(path.join(__dirname, "..", "src", "js", file), "utf8");
  vm.runInThisContext(code, { filename: file });
}
const ASC = globalThis.ASC;

// ---- 小さなテストの仕組み ----------------------------------------------------

const results = [];
async function test(name, body) {
  try {
    await body();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, message: error.message });
  }
}
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
function assertClose(actual, expected, tolerance, label) {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} が ${expected} ±${tolerance} に入りません`);
}

// ---- 共通の準備 --------------------------------------------------------------

const SAMPLE_MEASUREMENTS = path.join(__dirname, "..", "samples", "sample_measurements.csv");
const NUMBER_TEXT = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

function xmlEscape(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 列の番号（0始まり）をExcelの列の文字にする。 */
function columnLetters(index) {
  let letters = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  }
  return letters;
}

/** ZIP（deflate）にまとめる。files: [{ name, text }] */
function makeZip(files) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const raw = Buffer.from(file.text, "utf8");
    const compressed = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    directory.push(entry, name);
    offset += 30 + name.length + compressed.length;
  }
  const directoryBuffer = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directoryBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directoryBuffer, end]));
}

/**
 * 小さなxlsxを作る（テスト用）。sheets: [{ name, rows: [[値]] }]。値は文字か、{ number: "数値の文字" }、
 * { inline: "文字" }（セルの中に直接書く文字）、{ text, phonetic }（ふりがな付きの共有文字列）。
 */
function makeXlsx(sheets) {
  const shared = [];
  const sharedIndex = new Map();
  const sharedOf = (key, xml) => {
    if (!sharedIndex.has(key)) {
      sharedIndex.set(key, shared.length);
      shared.push(xml);
    }
    return sharedIndex.get(key);
  };
  const sheetXml = (rows) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
      .map((row, rowIndex) => {
        const cells = row
          .map((value, columnIndex) => {
            const ref = `${columnLetters(columnIndex)}${rowIndex + 1}`;
            if (value === "" || value === null) {
              return "";
            }
            if (typeof value === "object" && value.number !== undefined) {
              return `<c r="${ref}" s="1"><v>${value.number}</v></c>`;
            }
            if (typeof value === "object" && value.inline !== undefined) {
              return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value.inline)}</t></is></c>`;
            }
            if (typeof value === "object" && value.phonetic !== undefined) {
              const index = sharedOf(`p:${value.text}`, `<si><r><t>${xmlEscape(value.text)}</t></r><rPh sb="0" eb="1"><t>${xmlEscape(value.phonetic)}</t></rPh></si>`);
              return `<c r="${ref}" t="s"><v>${index}</v></c>`;
            }
            const index = sharedOf(`s:${value}`, `<si><t xml:space="preserve">${xmlEscape(value)}</t></si>`);
            return `<c r="${ref}" t="s"><v>${index}</v></c>`;
          })
          .join("");
        return `<row r="${rowIndex + 1}">${cells}</row>`;
      })
      .join("")}</sheetData></worksheet>`;
  const sheetFiles = sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, text: sheetXml(sheet.rows) }));
  return makeZip([
    { name: "[Content_Types].xml", text: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: "xl/workbook.xml",
      text: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr/><sheets>${sheets
        .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      text: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
        .join("")}</Relationships>`,
    },
    ...sheetFiles,
    { name: "xl/sharedStrings.xml", text: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.join("")}</sst>` },
  ]);
}

/** 見本の計測データ（CSV）を表として読む。 */
async function sampleMeasurementTable() {
  return ASC.tableReader.readTableBytes("sample_measurements.csv", new Uint8Array(fs.readFileSync(SAMPLE_MEASUREMENTS)));
}

/** 見本の計測データの値（重複を平均した値）。key: "Wafer|shotNo|markNo" → { x: [値], y: [値] }（有効な値だけ） */
function sampleMeasuredValues() {
  const lines = fs.readFileSync(SAMPLE_MEASUREMENTS, "utf8").trim().split(/\r\n/);
  const header = lines[0].split(",");
  const column = (name) => header.indexOf(name);
  const values = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const key = `${cells[column("Wafer")]}|${cells[column("shotNo")]}|${cells[column("markNo")]}`;
    const entry = values.get(key) || { x: [], y: [] };
    if (cells[column("StsX")] === "0") {
      entry.x.push(Number(cells[column("measX")]));
    }
    if (cells[column("StsY")] === "0") {
      entry.y.push(Number(cells[column("measY")]));
    }
    values.set(key, entry);
  }
  return values;
}

function defaultMap() {
  const settings = ASC.defaultSettings();
  return ASC.waferMap.generateWaferMap(settings.map).map;
}

function defaultEvaluationSettings(overrides) {
  const base = ASC.defaultSettings().evaluationData;
  const settings = Object.assign({}, base, overrides || {});
  settings.terms = ASC.evaluationData.defaultTermSettings(settings.lowOrderAmplitudeNm, settings.highOrderAmplitudeNm);
  return settings;
}

function allIndices(count) {
  return Array.from({ length: count }, (_, i) => i);
}

/** 補正の演算子を真のずれに掛けたときの残差の最大値。 */
function maxResidual(operator, map, sampleIndices, values) {
  const n = sampleIndices.length;
  let maximum = 0;
  for (let i = 0; i < map.marks.length; i++) {
    let correction = 0;
    for (let j = 0; j < n; j++) {
      correction += operator[i * n + j] * values[sampleIndices[j]];
    }
    maximum = Math.max(maximum, Math.abs(values[i] - correction));
  }
  return maximum;
}

function contextFor(map, overrides) {
  const settings = ASC.defaultSettings();
  if (overrides) {
    overrides(settings);
  }
  const built = ASC.constraints.buildContext(map, settings);
  assert(built.errors.length === 0, "前提を作れません: " + built.errors.join(" / "));
  return { context: built.context, settings };
}

function statusAllOk(status) {
  return ASC.constraints.statusRows(status).every((row) => row.ok);
}

/** 選んだ候補のMark（Shotの有効なMarkすべて）の数の合計。 */
function markCountOf(context, items) {
  return items.reduce((sum, item) => sum + context.items[item].marks.length, 0);
}

// ---- テスト本体 --------------------------------------------------------------

async function main() {
  await test("乱数: 同じシードなら同じ列になり、正規乱数の平均0・標準偏差1", () => {
    const a = ASC.math.createRandom(42);
    const b = ASC.math.createRandom(42);
    for (let i = 0; i < 10; i++) {
      assert(a.next() === b.next(), "同じシードで値が違います");
    }
    const random = ASC.math.createRandom(7);
    const values = Array.from({ length: 20000 }, () => random.normal());
    const mean = ASC.math.mean(values);
    const sd = Math.sqrt(ASC.math.mean(values.map((value) => (value - mean) ** 2)));
    assertClose(mean, 0, 0.03, "平均");
    assertClose(sd, 1, 0.03, "標準偏差");
  });

  await test("行列: コレスキー・LU・行列式・逆行列が正しい", () => {
    const a = Float64Array.from([4, 2, 0.6, 2, 5, 1, 0.6, 1, 3]);
    const b = Float64Array.from([1, 2, 3]);
    const x = ASC.math.choleskySolve(ASC.math.cholesky(a, 3), 3, b, 1);
    const back = ASC.math.multiply(a, 3, 3, x, 1);
    for (let i = 0; i < 3; i++) {
      assertClose(back[i], b[i], 1e-12, "コレスキーの解");
    }
    const general = Float64Array.from([0, 2, 1, 3, 1, 0, 1, 1, 1]);
    const y = ASC.math.luSolve(ASC.math.luDecompose(general, 3), b, 1);
    const back2 = ASC.math.multiply(general, 3, 3, y, 1);
    for (let i = 0; i < 3; i++) {
      assertClose(back2[i], b[i], 1e-12, "LUの解");
    }
    assertClose(ASC.math.determinant(general, 3), -4, 1e-12, "行列式");
    const inverse = ASC.math.inverseSymmetric(a, 3);
    const product = ASC.math.multiply(a, 3, 3, inverse, 3);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        assertClose(product[i * 3 + j], i === j ? 1 : 0, 1e-12, "逆行列");
      }
    }
  });

  await test("Zernike: Fringe Z1〜Z36、Z36は(10,0)、RMS正規化で単位円内のRMSが1、異なる項は直交", () => {
    const terms = ASC.zernike.TERMS;
    assert(terms.length === 36, `項の数が36ではありません（${terms.length}）`);
    assert(terms[35].n === 10 && terms[35].m === 0, "Z36が(10,0)ではありません");
    assert(terms[8].n === 4 && terms[8].m === 0, "Z9が(4,0)ではありません");
    const z16 = ASC.zernike.termByFringe(16);
    assert(!z16.polynomialExpressible, "Z16（6次）が多項式で表せる扱いになっています");
    // 極座標の格子で積分する
    const radialSteps = 400;
    const angleSteps = 256;
    function integrate(f) {
      let sum = 0;
      let area = 0;
      for (let i = 0; i < radialSteps; i++) {
        const rho = (i + 0.5) / radialSteps;
        for (let j = 0; j < angleSteps; j++) {
          const theta = (2 * Math.PI * j) / angleSteps;
          sum += f(rho, theta) * rho;
          area += rho;
        }
      }
      return sum / area;
    }
    for (const index of [4, 7, 9, 16, 25, 36]) {
      const term = ASC.zernike.termByFringe(index);
      const meanSquare = integrate((rho, theta) => ASC.zernike.evaluateTerm(term, rho, theta, "rms") ** 2);
      assertClose(meanSquare, 1, 0.01, `Z${index} のRMS²`);
    }
    const z4 = ASC.zernike.termByFringe(4);
    const z9 = ASC.zernike.termByFringe(9);
    const inner = integrate((rho, theta) => ASC.zernike.evaluateTerm(z4, rho, theta, "rms") * ASC.zernike.evaluateTerm(z9, rho, theta, "rms"));
    assertClose(inner, 0, 0.01, "Z4とZ9の内積");
  });

  await test("多項式: 21項で5次以下のZernike項は正確に表せ、6次以上は表せない", () => {
    const map = defaultMap();
    const terms = allIndices(21);
    const all = allIndices(map.marks.length);
    const design = ASC.correction.polynomialDesign(map.marks, all, terms);
    const fit = ASC.correction.leastSquaresOperator(design, all.length, 21);
    const projection = ASC.math.multiply(design, all.length, 21, fit.operator, all.length);
    for (const index of [2, 9, 14, 20, 26, 16, 25]) {
      const term = ASC.zernike.termByFringe(index);
      const values = map.marks.map((mark) => ASC.zernike.evaluateTerm(term, Math.hypot(mark.u, mark.v), Math.atan2(mark.v, mark.u), "none"));
      const residual = maxResidual(projection, map, all, values);
      if (term.polynomialExpressible) {
        assert(residual < 1e-8, `Z${index}（${term.n}次）が多項式で表せません（残差 ${residual}）`);
      } else {
        assert(residual > 1e-3, `Z${index}（${term.n}次）が多項式で表せてしまいます（残差 ${residual}）`);
      }
    }
  });

  await test("Zernikeの展開: 現れる単項式だけで、その項を正確に表せる（画面の「今の補正」の判定に使う）", () => {
    const map = defaultMap();
    const all = allIndices(map.marks.length);
    const indexOf = new Map(ASC.correction.POLYNOMIAL_TERMS.map((term, index) => [`${term.powerX},${term.powerY}`, index]));
    for (const term of ASC.zernike.TERMS.filter((entry) => entry.polynomialExpressible)) {
      const terms = ASC.zernike.monomialsOf(term).map((monomial) => indexOf.get(`${monomial.powerX},${monomial.powerY}`));
      assert(terms.every((index) => index !== undefined), `Z${term.fringeIndex}: 5次を超える単項式が出ました`);
      const design = ASC.correction.polynomialDesign(map.marks, all, terms);
      const fit = ASC.correction.leastSquaresOperator(design, all.length, terms.length);
      const projection = ASC.math.multiply(design, all.length, terms.length, fit.operator, all.length);
      const values = map.marks.map((mark) => ASC.zernike.evaluateTerm(term, Math.hypot(mark.u, mark.v), Math.atan2(mark.v, mark.u), "none"));
      assert(maxResidual(projection, map, all, values) < 1e-8, `Z${term.fringeIndex}: 展開した単項式だけでは表せません`);
    }
    const z5 = ASC.zernike.monomialsOf(ASC.zernike.termByFringe(5)).map((m) => `${m.powerX},${m.powerY}`).sort();
    assert(z5.join(" ") === "0,2 2,0", `Z5（x²−y²）の展開が違います: ${z5}`);
  });

  await test("集計: 計算できなかった値（NaN）を除いて集計する", () => {
    const summary = ASC.math.summarize([1, NaN, 3, 2]);
    assert(summary.count === 3 && summary.mean === 2 && summary.max === 3, "NaNが集計に入っています");
    const empty = ASC.math.summarize([NaN]);
    assert(empty.count === 0 && Number.isNaN(empty.mean), "全部NaNのときに値が出ています");
  });

  await test("マップ生成: 有効範囲内のMarkだけ、Shot番号は上の行から、4象限のShot数が同じ、市松のScan方向", () => {
    const settings = ASC.defaultSettings();
    settings.map.scanPattern = "checker";
    const map = ASC.waferMap.generateWaferMap(settings.map).map;
    assert(map.shots.length > 50, `Shot数が少なすぎます（${map.shots.length}）`);
    assert(map.marks.every((mark) => Math.hypot(mark.x, mark.y) < 150), "r≧150のMarkが入っています");
    assert(map.shots[0].y >= map.shots[map.shots.length - 1].y, "Shotが上の行から並んでいません");
    const quadrantCounts = [0, 0, 0, 0];
    for (const shot of map.shots) {
      quadrantCounts[ASC.constraints.quadrantOf(shot.x, shot.y)]++;
    }
    assert(new Set(quadrantCounts).size === 1, `4象限のShot数がそろっていません（${quadrantCounts}）`);
    const byPosition = new Map(map.shots.map((shot) => [`${shot.x},${shot.y}`, shot]));
    let checked = 0;
    for (const shot of map.shots) {
      const right = byPosition.get(`${shot.x + 26},${shot.y}`);
      if (right) {
        assert(right.scan !== shot.scan, "左右の隣で同じScan方向です");
        checked++;
      }
    }
    assert(checked > 0, "隣り合うShotがありません");
    const incomplete = map.shots.filter((shot) => ASC.constraints.isIncompleteShot(shot));
    assert(incomplete.length > 0 && incomplete.every((shot) => shot.definedMarkCount === 4 && shot.markIndices.length < 4), "Markが揃わない端のShotを数えられません");
  });

  await test("一筆書きのScan方向: 行ごとに折り返す順で1 Shotごとに交互。開始の角と最初の向きを変えられる", () => {
    const settings = ASC.defaultSettings();
    assert(settings.map.scanPattern === "serpentine", "初期設定が一筆書きではありません");
    /** 開始の角から行ごとに折り返してたどったShotの並び。 */
    function path(map, start) {
      const rows = [];
      for (const shot of map.shots) {
        const last = rows[rows.length - 1];
        if (last && last[0].y === shot.y) {
          last.push(shot);
        } else {
          rows.push([shot]);
        }
      }
      if (start.startsWith("bottom")) {
        rows.reverse();
      }
      const leftFirst = start.endsWith("Left");
      return rows.flatMap((row, index) => ((index % 2 === 0) === leftFirst ? row : row.slice().reverse()));
    }
    for (const start of Object.keys(ASC.constants.SERPENTINE_STARTS)) {
      for (const first of ["Up", "Down"]) {
        settings.map.serpentineStart = start;
        settings.map.serpentineFirstScan = first;
        const map = ASC.waferMap.generateWaferMap(settings.map).map;
        const order = path(map, start);
        assert(order.length === map.shots.length, "道順がすべてのShotを通りません");
        assert(order[0].scan === first, `${start}: 最初のShotのScan方向が ${first} ではありません`);
        for (let i = 1; i < order.length; i++) {
          assert(order[i].scan !== order[i - 1].scan, `${start}: 道順で隣り合うShot ${order[i - 1].id} と ${order[i].id} のScan方向が同じです`);
        }
      }
    }
    settings.map.serpentineStart = "topLeft";
    settings.map.serpentineFirstScan = "Up";
    const map = ASC.waferMap.generateWaferMap(settings.map).map;
    const firstRow = map.shots.filter((shot) => shot.y === map.shots[0].y);
    const secondRow = map.shots.filter((shot) => shot.y === firstRow[0].y - settings.map.shotHeightMm);
    // 1行目は左から右へ、2行目は右端から始まる（1行目の最後と2行目の右端で向きが変わる）
    assert(firstRow[0].scan === "Up" && secondRow[secondRow.length - 1].scan !== firstRow[firstRow.length - 1].scan, "2行目が右端から始まっていません");
    const upCount = map.shots.filter((shot) => shot.scan === "Up").length;
    assert(Math.abs(upCount - (map.shots.length - upCount)) <= 1, "UpとDownの数がそろいません");
    settings.map.serpentineStart = "middle";
    assert(ASC.waferMap.generateWaferMap(settings.map).errors.length > 0, "開始の角の誤りを知らせていません");
  });

  await test("CSV: 書き出して読み込むと同じマップになる。誤りは行番号つきで知らせる", () => {
    const map = defaultMap();
    const csv = ASC.waferMap.mapToCsv(map);
    const options = { validRadiusMm: 150, shotWidthMm: 26, shotHeightMm: 33 };
    const parsed = ASC.waferMap.parseMapCsv(csv, options);
    assert(parsed.errors.length === 0, "読込で誤り: " + parsed.errors.join(" / "));
    assert(parsed.map.shots.length === map.shots.length, "Shot数が違います");
    assert(parsed.map.marks.length === map.marks.length, "Mark数が違います");
    for (let i = 0; i < map.marks.length; i++) {
      assertClose(parsed.map.marks[i].x, map.marks[i].x, 1e-6, "Markのx");
      assertClose(parsed.map.marks[i].y, map.marks[i].y, 1e-6, "Markのy");
    }
    const missing = ASC.waferMap.parseMapCsv("ShotId,ShotX,ShotY,MarkNo,MarkX,MarkY\n1,0,0,1,0,0\n", options);
    assert(missing.errors.some((text) => text.includes("ScanDir")), "列の不足を知らせていません");
    const badNumber = ASC.waferMap.parseMapCsv("ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY\n1,abc,0,Up,1,0,0\n", options);
    assert(badNumber.errors.some((text) => text.startsWith("2行目")), "数値の誤りに行番号がありません");
    const duplicate = ASC.waferMap.parseMapCsv(
      "ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY\n1,0,0,Up,1,0,0\n1,0,0,Up,1,1,1\n",
      options
    );
    assert(duplicate.errors.some((text) => text.includes("重複")), "Markの重複を知らせていません");
    const scanAlias = ASC.waferMap.parseMapCsv("ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY\n1,0,0,下,1,0,0\n", options);
    assert(scanAlias.map && scanAlias.map.shots[0].scan === "Down", "「下」をDownとして読めません");
  });

  await test("評価データ: 同じシードで同じ値。ノイズの設定を変えても傾向は変わらない", () => {
    const map = defaultMap();
    const first = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 5 })).data;
    const second = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 5 })).data;
    const noisier = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 5, noiseSigmaXnm: 2 })).data;
    for (let i = 0; i < first.truthX.length; i += 37) {
      assert(first.truthX[i] === second.truthX[i], "同じシードで値が違います");
      assert(first.truthX[i] === noisier.truthX[i], "ノイズの設定で傾向が変わりました");
    }
    const withScan = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 5, scanOffsetXnm: 1 })).data;
    let differs = false;
    for (let i = 0; i < first.truthX.length; i++) {
      if (Math.abs(withScan.truthX[i] - first.truthX[i]) > 1e-9) {
        differs = true;
      }
    }
    assert(differs, "Scan方向のずれが反映されていません");
  });

  await test("評価データの成分: 5次以下＋6次以上＋Scan方向のずれ＝真のずれ、計測値＝真のずれ＋ノイズ", () => {
    const map = defaultMap();
    const data = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 3, scanOffsetXnm: 1, scanOffsetYnm: 0.5 })).data;
    for (let wafer = 0; wafer < data.waferCount; wafer++) {
      const parts = ASC.evaluationData.waferComponents(data, wafer);
      for (const axis of ["x", "y"]) {
        for (let i = 0; i < data.markCount; i++) {
          const sum = parts.low[axis][i] + parts.high[axis][i] + parts.scan[axis][i];
          assertClose(sum, parts.truth[axis][i], 1e-9, `Wafer ${wafer + 1} Mark ${i} ${axis} の成分の和`);
          assertClose(parts.measured[axis][i], parts.truth[axis][i] + parts.noise[axis][i], 1e-12, "計測値");
          assert(Math.abs(Math.abs(parts.scan[axis][i]) - Math.abs(axis === "x" ? data.scanOffsetsX[wafer] : data.scanOffsetsY[wafer])) < 1e-12, "Scan方向のずれは ±δ");
        }
      }
    }
    assert(ASC.evaluationData.COMPONENTS.map((component) => component.key).join(",") === "truth,low,high,scan,noise,measured", "成分の並び");
  });

  /** HOWAの部品（全Markの当てはめも含む）を作る。 */
  function howaPartsFor(marks, sample, terms) {
    const all = allIndices(marks.length);
    const allDesign = ASC.correction.polynomialDesign(marks, all, terms);
    const allFit = ASC.correction.leastSquaresOperator(allDesign, marks.length, terms.length);
    return ASC.correction.prepareHowa(marks, sample, terms, allDesign, allFit);
  }

  await test("HOWA: 真のずれが選んだ項の多項式なら、どの計測点でも残差は0", () => {
    const map = defaultMap();
    const terms = [0, 1, 2, 3, 5, 6, 10, 15, 20];
    const values = map.marks.map((mark) => 1 + 2 * mark.u - mark.v + 0.5 * mark.u ** 2 + 0.3 * mark.v ** 2 - 0.2 * mark.u ** 3 + 0.1 * mark.u ** 4 + 0.4 * mark.u ** 5 - 0.6 * mark.v ** 5);
    const random = ASC.math.createRandom(3);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 30);
    const parts = howaPartsFor(map.marks, sample, terms);
    assert(maxResidual(parts.howa, map, sample, values) < 1e-8, "残差が0になりません");
  });

  await test("RBF: λ=0なら計測点を正確に通り、説明変数の1次関数はどこでも正確に再現する（X,Y と X,Y,半径）", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(5);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 25);
    for (const features of ["xy", "xyr"]) {
      for (const kernel of ["tps", "gaussian", "multiquadric", "inverseQuadric"]) {
        const result = ASC.correction.rbfOperator(map.marks, sample, { kernel, lambda: 0, shapeFactor: 2 }, features);
        assert(!result.error, result.error);
        const linear = map.marks.map((mark) => 3 - 2 * mark.u + 5 * mark.v + (features === "xyr" ? 4 * Math.hypot(mark.u, mark.v) : 0));
        assert(maxResidual(result.operator, map, sample, linear) < 1e-7, `${features}・${kernel}: 1次の関数を再現できません`);
        const bumpy = map.marks.map((mark) => Math.sin(5 * mark.u) * Math.cos(4 * mark.v));
        const n = sample.length;
        sample.forEach((markIndex) => {
          let value = 0;
          for (let k = 0; k < n; k++) {
            value += result.operator[markIndex * n + k] * bumpy[sample[k]];
          }
          assertClose(value, bumpy[markIndex], 1e-7, `${features}・${kernel}: 計測点での補間値`);
        });
      }
    }
  });

  await test("補正: 10通りの並び。全点計測のRBFの予測はHOWAと同じ、計測値＋HOWAは測ったMarkでは計測値そのもの", () => {
    const settings = ASC.defaultSettings();
    const keys = ASC.correction.buildVariants(settings.model).map((variant) => variant.key);
    assert(
      keys.join(",") === "howa,rbfXY,rbfXYPredict,rbfXYR,rbfXYRPredict,gpXY,gpXYPredict,gpXYR,gpXYRPredict,measured",
      `比べる補正が違います: ${keys}`
    );
    const map = defaultMap();
    const terms = allIndices(10);
    const all = allIndices(map.marks.length);
    const subsetMarks = all.slice(0, 200).map((index) => map.marks[index]);
    const subsetAll = allIndices(subsetMarks.length);
    const subsetRbf = ASC.correction.rbfOperator(subsetMarks, subsetAll, { kernel: "tps", lambda: 0, shapeFactor: 2 }, "xy").operator;
    const fullParts = howaPartsFor(subsetMarks, subsetAll, terms);
    const then = ASC.correction.estimateThenHowaOperator(fullParts, subsetRbf, subsetAll, subsetMarks.length);
    for (let i = 0; i < fullParts.howa.length; i += 101) {
      assertClose(then[i], fullParts.howa[i], 1e-9, "全点計測でのRBFの予測とHOWA");
    }
    const sample = [3, 40, 41, 90, 150, 151, 200, 260, 300, 310, 320, 330, 5, 60, 120, 180, 240, 280, 25, 75, 125, 175, 225];
    const parts = howaPartsFor(map.marks, sample, terms);
    const measured = ASC.correction.measuredOperator(parts.howa, sample, map.marks.length);
    const n = sample.length;
    sample.forEach((markIndex, j) => {
      for (let k = 0; k < n; k++) {
        assert(measured[markIndex * n + k] === (k === j ? 1 : 0), "測ったMarkの行が計測値そのものになっていません");
      }
    });
    const unmeasured = all.find((index) => !sample.includes(index));
    for (let k = 0; k < n; k++) {
      assert(measured[unmeasured * n + k] === parts.howa[unmeasured * n + k], "測っていないMarkの行がHOWAと違います");
    }
  });

  await test("RBFの式内: 多項式だけのずれは係数を正確に戻し、λを大きくするとHOWAの係数に近づく", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(41);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 60);
    const terms = allIndices(21);
    const parts = howaPartsFor(map.marks, sample, terms);
    const p = terms.length;
    const n = sample.length;
    const truthCoefficients = Array.from({ length: p }, (_, k) => Math.sin(k + 1));
    const polynomial = sample.map((_, j) => truthCoefficients.reduce((sum, c, k) => sum + c * parts.sampleDesign[j * p + k], 0));
    const bumpy = sample.map((markIndex) => polynomial[sample.indexOf(markIndex)] + 0.3 * Math.sin(9 * map.marks[markIndex].u) * Math.cos(7 * map.marks[markIndex].v));
    const coefficientsOf = (operator, values) => Array.from({ length: p }, (_, k) => values.reduce((sum, value, j) => sum + operator[k * n + j] * value, 0));
    for (const features of ["xy", "xyr"]) {
      for (const kernel of ["tps", "gaussian"]) {
        const exact = ASC.correction.rbfPolynomialOperator(map.marks, sample, parts.sampleDesign, p, { kernel, lambda: 0, shapeFactor: 2 }, features);
        assert(!exact.error, exact.error);
        coefficientsOf(exact.operator, polynomial).forEach((value, k) => assertClose(value, truthCoefficients[k], 1e-6, `${features}・${kernel}: 係数 ${k}`));
        // λ を大きくすると RBF の部分は 1/λ で小さくなり、係数は最小二乗（HOWA）に近づく
        const smooth = ASC.correction.rbfPolynomialOperator(map.marks, sample, parts.sampleDesign, p, { kernel: "gaussian", lambda: 1e6, shapeFactor: 2 }, features);
        assert(!smooth.error, smooth.error);
        const ols = coefficientsOf(parts.leastSquares, bumpy);
        coefficientsOf(smooth.operator, bumpy).forEach((value, k) => assertClose(value, ols[k], 1e-3 * Math.max(1, Math.abs(ols[k])), `${features}: λを大きくしたときの係数 ${k}`));
      }
    }
    const tooFew = ASC.correction.rbfPolynomialOperator(map.marks, sample.slice(0, 10), parts.sampleDesign, p, { kernel: "tps", lambda: 0, shapeFactor: 2 }, "xy");
    assert(tooFew.error, "点が項数より少ないときに知らせていません");
  });

  await test("GPRの式内: 一般化最小二乗の係数が直接の式と一致し、多項式だけのずれはHOWAの係数になる", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(43);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 50);
    const terms = allIndices(10);
    const parts = howaPartsFor(map.marks, sample, terms);
    const p = terms.length;
    const n = sample.length;
    const values = Float64Array.from(sample.map((index) => Math.sin(3 * map.marks[index].u) + 0.5 * map.marks[index].v ** 2 + 0.05 * random.normal()));
    const C = ASC.constants;
    const keep = [C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_STEPS, C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_STEPS];
    const length = 0.3;
    const ratio = 0.05;
    [C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_STEPS, C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_STEPS] = [length, 1, ratio, 1];
    try {
      for (const features of ["xy", "xyr"]) {
        const kernelPart = ASC.correction.prepareGprKernel(map.marks, sample, features, "squaredExponential");
        const prepared = ASC.correction.prepareGprPolynomial(kernelPart, parts.sampleDesign, p);
        const olsCoefficients = Array.from({ length: p }, (_, k) => values.reduce((sum, value, j) => sum + parts.leastSquares[k * n + j] * value, 0));
        const olsResidual = Float64Array.from(values, (value, j) => value - olsCoefficients.reduce((sum, c, k) => sum + c * parts.sampleDesign[j * p + k], 0));
        const fit = ASC.correction.gprFit(kernelPart, prepared, values, olsResidual, olsCoefficients, false);
        assert(fit.length === length && fit.noiseRatio === ratio, "調整値が候補と違います");
        // 直接の式: β = (PᵀK⁻¹P)⁻¹ PᵀK⁻¹ y（K = K_ℓ + αI）
        const points = sample.map((index) => ASC.correction.featureVector(map.marks[index], features));
        const covariance = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const d = Math.sqrt(points[i].reduce((sum, value, k) => sum + (value - points[j][k]) ** 2, 0));
            covariance[i * n + j] = ASC.correction.gpKernelValue("squaredExponential", d, length) + (i === j ? ratio : 0);
          }
        }
        const lower = ASC.math.cholesky(covariance, n);
        const inverseDesign = ASC.math.choleskySolve(lower, n, parts.sampleDesign, p);
        const inverseValues = ASC.math.choleskySolve(lower, n, values, 1);
        const normal = new Float64Array(p * p);
        const right = new Float64Array(p);
        for (let a = 0; a < p; a++) {
          for (let j = 0; j < n; j++) {
            right[a] += parts.sampleDesign[j * p + a] * inverseValues[j];
            for (let b = 0; b < p; b++) {
              normal[a * p + b] += parts.sampleDesign[j * p + a] * inverseDesign[j * p + b];
            }
          }
        }
        const expected = ASC.math.choleskySolve(ASC.math.cholesky(normal, p), p, right, 1);
        fit.coefficients.forEach((value, k) => assertClose(value, expected[k], 1e-7 * Math.max(1, Math.abs(expected[k])), `${features}: 係数 ${k}`));
        const exact = ASC.correction.gprFit(kernelPart, prepared, values, olsResidual, olsCoefficients, true);
        exact.coefficients.forEach((value, k) => assert(value === olsCoefficients[k], "多項式で表せるときにHOWAの係数になりません"));
      }
    } finally {
      [C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_STEPS, C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_STEPS] = keep;
    }
    const tooFew = ASC.correction.prepareGprPolynomial(ASC.correction.prepareGprKernel(map.marks, sample.slice(0, 11), "xy", "squaredExponential"), parts.sampleDesign, p);
    assert(tooFew.error, "点が項数＋2より少ないときに知らせていません");
  });

  /** 調整値の候補を1つにして、ガウス過程回帰の前準備をする（直接の式と比べるため）。 */
  function prepareGpWithFixedValues(marks, sample, features, kernel, length, ratio) {
    const C = ASC.constants;
    const keep = [C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_STEPS, C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_STEPS];
    C.GP_LENGTH_SCALE_MIN = length;
    C.GP_LENGTH_SCALE_STEPS = 1;
    C.GP_NOISE_RATIO_MIN = ratio;
    C.GP_NOISE_RATIO_STEPS = 1;
    try {
      return ASC.correction.prepareGp(marks, sample, features, kernel);
    } finally {
      [C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_STEPS, C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_STEPS] = keep;
    }
  }

  await test("GPRの予測: 多項式の係数が、直接の式で全Markを予測して当てはめた係数と一致する（X,Y と X,Y,半径）", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(21);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 35);
    const values = sample.map((index) => Math.sin(3 * map.marks[index].u) + 0.5 * map.marks[index].v ** 2 + 0.05 * random.normal());
    const terms = allIndices(10);
    const parts = howaPartsFor(map.marks, sample, terms);
    const p = terms.length;
    const markCount = map.marks.length;
    for (const features of ["xy", "xyr"]) {
      for (const kernel of ["squaredExponential", "matern52"]) {
        const length = 0.4;
        const ratio = 0.01;
        const prepared = prepareGpWithFixedValues(map.marks, sample, features, kernel, length, ratio);
        const fit = ASC.correction.gpFit(prepared, Float64Array.from(values));
        const projector = ASC.correction.gpHowaProjector(prepared, parts, sample);
        const coefficients = ASC.correction.gpThenHowaCoefficients(prepared, projector, fit, Float64Array.from(values), new Float64Array(p));
        // 直接の式: 1次式を最小二乗で除き、残りに K*(K + αI)⁻¹ を掛けて戻す。測ったMarkは計測値のまま
        const points = sample.map((index) => ASC.correction.featureVector(map.marks[index], features));
        const q = points[0].length + 1;
        const trendRows = new Float64Array(sample.length * q);
        points.forEach((point, i) => {
          trendRows[i * q] = 1;
          point.forEach((value, k) => (trendRows[i * q + 1 + k] = value));
        });
        const trend = ASC.math.multiply(ASC.correction.leastSquaresOperator(trendRows, sample.length, q).operator, q, sample.length, Float64Array.from(values), 1);
        const n = sample.length;
        const residual = values.map((value, i) => value - points[i].reduce((sum, value2, k) => sum + trend[k + 1] * value2, trend[0]));
        const covariance = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const d = Math.sqrt(points[i].reduce((sum, value2, k) => sum + (value2 - points[j][k]) ** 2, 0));
            covariance[i * n + j] = ASC.correction.gpKernelValue(kernel, d, length) + (i === j ? ratio : 0);
          }
        }
        const weights = ASC.math.choleskySolve(ASC.math.cholesky(covariance, n), n, Float64Array.from(residual), 1);
        const filled = new Float64Array(markCount);
        for (let markIndex = 0; markIndex < markCount; markIndex++) {
          const sampleIndex = sample.indexOf(markIndex);
          if (sampleIndex >= 0) {
            filled[markIndex] = values[sampleIndex];
            continue;
          }
          const point = ASC.correction.featureVector(map.marks[markIndex], features);
          let expected = point.reduce((sum, value2, k) => sum + trend[k + 1] * value2, trend[0]);
          points.forEach((samplePoint, j) => {
            const d = Math.sqrt(point.reduce((sum, value2, k) => sum + (value2 - samplePoint[k]) ** 2, 0));
            expected += ASC.correction.gpKernelValue(kernel, d, length) * weights[j];
          });
          filled[markIndex] = expected;
        }
        const expectedCoefficients = ASC.math.multiply(parts.allLeastSquares, p, markCount, filled, 1);
        coefficients.forEach((value, k) => assertClose(value, expectedCoefficients[k], 1e-8 * Math.max(1, Math.abs(expectedCoefficients[k])), `${features}・${kernel}: 係数 ${k}`));
      }
    }
  });

  await test("入れ替えの計算（Woodbury）が、行列を作り直した計算と一致する", () => {
    const map = defaultMap();
    const { context } = contextFor(map);
    const models = ASC.sampling.buildModels(context, [allIndices(21), allIndices(21)]);
    const model = models[0];
    const random = ASC.math.createRandom(11);
    const state = ASC.sampling.findFeasibleState(context, random);
    const selected = state.list.slice();
    const prepared = ASC.sampling.prepareExchange(model, selected, true);
    const removed = selected[3];
    const added = context.items.findIndex((_, index) => !selected.includes(index));
    const change = ASC.sampling.swapChange(model, prepared, removed, added, true);
    const swapped = selected.filter((item) => item !== removed).concat([added]);
    const direct = ASC.sampling.prepareExchange(model, swapped, true);
    assertClose(prepared.logDet + change.logDetChange, direct.logDet, 1e-6, "log det");
    assertClose(prepared.traceWeighted + change.traceChange, direct.traceWeighted, 1e-6 * direct.traceWeighted, "予測分散の平均");
  });

  await test("制約: 4つの選び方とも、初期設定のハード制約（Scan・4象限・3領域・中心）を満たす", () => {
    const map = defaultMap();
    const { context, settings } = contextFor(map);
    const termSets = [settings.model.termsX, settings.model.termsY];
    for (let seed = 1; seed <= 8; seed++) {
      const random = ASC.math.createRandom(seed);
      const selections = {
        ランダム: ASC.sampling.selectRandom(context, random),
        ポアソン: ASC.sampling.selectPoisson(context, random),
      };
      if (seed <= 2) {
        selections.D最適 = ASC.sampling.selectOptimal(context, random, "D", termSets, 2);
        selections.I最適 = ASC.sampling.selectOptimal(context, random, "I", termSets, 2);
      }
      for (const [name, selection] of Object.entries(selections)) {
        assert(selection, `${name}: 選べませんでした`);
        assert(selection.items.length === context.shotCount, `${name}: Shot数が${context.shotCount}ではありません`);
        assert(selection.markIndices.length === markCountOf(context, selection.items), `${name}: 選んだShotのMarkをすべて測っていません`);
        const status = ASC.constraints.describeStatus(context, selection.items, selection.markIndices);
        assert(statusAllOk(status), `${name}（シード${seed}）: 制約を満たしていません ` + JSON.stringify(status.rows.map((row) => [row.key, row.classes.map((c) => c.count)])));
      }
    }
  });

  await test("Markの扱い: 選んだShotの有効なMarkをすべて測り、ほかのShotのMarkは測らない。端のShotを選ばない設定もできる", () => {
    const map = defaultMap();
    for (const excludeIncomplete of [false, true]) {
      const { context, settings } = contextFor(map, (s) => {
        s.sampling.excludeIncompleteShots = excludeIncomplete;
        s.constraints.zone.enabled = false;
      });
      const incompleteItems = context.items.filter((item) => ASC.constraints.isIncompleteShot(map.shots[item.shotIndex]));
      assert(excludeIncomplete ? incompleteItems.length === 0 : incompleteItems.length > 0, `端のShotの扱いが違います（選ばない設定: ${excludeIncomplete}）`);
      const termSets = [settings.model.termsX, settings.model.termsY];
      const random = ASC.math.createRandom(4);
      const selections = [
        [ASC.sampling.selectRandom(context, random), true],
        [ASC.sampling.selectPoisson(context, random), true],
        [ASC.sampling.selectOptimal(context, random, "D", termSets, 1), true],
        [ASC.sampling.selectOptimal(ASC.constraints.unconstrainedContext(context), random, "I", termSets, 1), false],
      ];
      for (const [selection, constrained] of selections) {
        const expected = selection.items.flatMap((item) => map.shots[context.items[item].shotIndex].markIndices).sort((a, b) => a - b);
        assert(selection.markIndices.slice().sort((a, b) => a - b).join(",") === expected.join(","), "選んだShotのMarkと測るMarkが一致しません");
        if (constrained) {
          assert(selection.markIndices.includes(context.center.markIndex), "中心のMarkが入っていません");
        }
        if (excludeIncomplete) {
          assert(selection.markIndices.length === selection.items.length * 4, "端のShotを選ばない設定で4Markにそろいません");
        }
      }
    }
  });

  await test("強制計測Shot・除外Shot: 制約付きは強制計測Shotを必ず選び、除外Shotはどの選び方も選ばない", () => {
    const map = defaultMap();
    const mandatory = ["30", "45", "70"];
    const excluded = ["46", "47", "58", "59"];
    const { context, settings } = contextFor(map, (s) => {
      s.constraints.mandatoryShotIds = mandatory;
      s.constraints.excludedShotIds = excluded;
    });
    const shotIdOf = (item) => map.shots[context.items[item].shotIndex].id;
    assert(context.items.every((item) => !excluded.includes(map.shots[item.shotIndex].id)), "除外Shotが候補に入っています");
    assert(context.mandatoryItems.map(shotIdOf).join(",") === mandatory.join(","), "強制計測Shotの候補番号が違います");
    const termSets = [settings.model.termsX, settings.model.termsY];
    const free = ASC.constraints.unconstrainedContext(context);
    for (let seed = 1; seed <= 3; seed++) {
      const random = ASC.math.createRandom(seed);
      const constrained = [
        ASC.sampling.selectRandom(context, random),
        ASC.sampling.selectPoisson(context, random),
        ASC.sampling.selectOptimal(context, random, "D", termSets, 1),
        ASC.sampling.selectOptimal(context, random, "I", termSets, 1),
      ];
      for (const selection of constrained) {
        const ids = selection.items.map(shotIdOf);
        assert(mandatory.every((id) => ids.includes(id)), `強制計測Shotが選ばれていません: ${ids}`);
        const status = ASC.constraints.describeStatus(context, selection.items, selection.markIndices);
        assert(status.mandatory && status.mandatory.ok && status.mandatory.shift === 0, "強制計測Shotの満たし具合が違います");
        assert(statusAllOk(status), "制約を満たしていません");
      }
      const unconstrained = ASC.sampling.selectOptimal(free, random, "D", termSets, 1);
      assert(unconstrained.items.every((item) => !excluded.includes(shotIdOf(item))), "制約なしのD最適が除外Shotを選びました");
    }
    const partial = ASC.constraints.describeStatus(context, [context.mandatoryItems[0]], []);
    assert(!partial.mandatory.ok && partial.mandatory.shift === 2 && partial.mandatory.included === 1, "強制計測Shotが足りないときのずれが違います");
  });

  await test("前提の誤り: マップにない番号、強制と除外の重複、端のShotを選ばない設定での強制、計測Shot数を超える強制", () => {
    const map = defaultMap();
    const errorsOf = (change) => {
      const settings = ASC.defaultSettings();
      change(settings);
      return ASC.constraints.buildContext(map, settings).errors.join(" / ");
    };
    assert(errorsOf((s) => (s.constraints.mandatoryShotIds = ["999"])).includes("999"), "マップにない強制計測Shotを知らせていません");
    assert(errorsOf((s) => (s.constraints.excludedShotIds = ["abc"])).includes("abc"), "マップにない除外Shotを知らせていません");
    assert(errorsOf((s) => {
      s.constraints.mandatoryShotIds = ["40"];
      s.constraints.excludedShotIds = ["40"];
    }).includes("両方"), "強制と除外の重複を知らせていません");
    const edgeId = map.shots.find((shot) => ASC.constraints.isIncompleteShot(shot)).id;
    assert(errorsOf((s) => {
      s.sampling.excludeIncompleteShots = true;
      s.constraints.mandatoryShotIds = [edgeId];
    }).includes("端のShot"), "選べない端のShotの強制を知らせていません");
    assert(errorsOf((s) => {
      s.sampling.shotCount = 3;
      s.constraints.mandatoryShotIds = ["20", "30", "60", "80"];
    }).includes("超えて"), "計測Shot数を超える強制計測Shotを知らせていません");
    assert(errorsOf((s) => (s.constraints.mandatoryShotIds = [20, "30"])) === "", "数で書いたShot番号を読めません");
  });

  await test("選び方の性質: D最適はlog det、I最適はκ、ポアソンは最小間隔がランダムより良い", () => {
    const map = defaultMap();
    const { context, settings } = contextFor(map);
    const terms = settings.model.termsX;
    const termSets = [terms, terms];
    const models = ASC.sampling.buildModels(context, termSets);
    const randomLogDets = [];
    const randomKappas = [];
    const randomSpacings = [];
    const poissonSpacings = [];
    for (let seed = 1; seed <= 15; seed++) {
      const random = ASC.math.createRandom(seed);
      const selection = ASC.sampling.selectRandom(context, random);
      randomLogDets.push(ASC.sampling.prepareExchange(models[0], selection.items, false).logDet);
      randomKappas.push(ASC.sampling.kappaOf(map, selection.markIndices, terms));
      randomSpacings.push(ASC.sampling.minimumShotSpacing(context, selection.items));
      const poisson = ASC.sampling.selectPoisson(context, random);
      poissonSpacings.push(ASC.sampling.minimumShotSpacing(context, poisson.items));
    }
    const median = (values) => ASC.math.summarize(values).median;
    const random = ASC.math.createRandom(99);
    const dSelection = ASC.sampling.selectOptimal(context, random, "D", termSets, 3);
    const iSelection = ASC.sampling.selectOptimal(context, random, "I", termSets, 3);
    const dLogDet = ASC.sampling.prepareExchange(models[0], dSelection.items, false).logDet;
    const iKappa = ASC.sampling.kappaOf(map, iSelection.markIndices, terms);
    assert(dLogDet > Math.max(...randomLogDets), `D最適のlog det（${dLogDet}）がランダムの最大以下です`);
    assert(iKappa < Math.min(...randomKappas), `I最適のκ（${iKappa}）がランダムの最小以上です`);
    assert(median(poissonSpacings) > median(randomSpacings), "ポアソンの最小間隔がランダムより広くありません");
  });

  await test("同心円の区切り（自動）: 候補の数が3領域で最も均等になる半径を、Shot単位はShot中心、Mark単位はMarkの位置で決める", () => {
    // 同じ半径は同じ区画に入れ、隣り合う半径の真ん中に区切りを置く
    const split = ASC.constraints.equalCountZoneRadii([1, 2, 3, 4, 5, 6]);
    assert(split.innerRadiusMm === 2.5 && split.outerRadiusMm === 4.5 && split.counts.join(",") === "2,2,2", "6点を2個ずつに分けていません");
    const tied = ASC.constraints.equalCountZoneRadii([1, 1, 1, 1, 2, 3, 3, 3]);
    assert(tied.counts.join(",") === "4,1,3", "同じ半径の点を別の区画に分けたか、最も均等な組を選んでいません");
    assert(ASC.constraints.equalCountZoneRadii([1, 1, 2, 2]) === null, "半径が2種類しかないのに区切りを返しました");
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    for (const [built, label] of [[ASC.constraints.buildContext(map, settings), "Shot単位"], [ASC.constraints.buildMarkContext(map, settings), "Mark単位"]]) {
      assert(built.errors.length === 0, built.errors.join(" / "));
      const context = built.context;
      const zone = context.constraints.find((constraint) => constraint.key === "zone");
      const available = Array.from(zone.available);
      assert(context.zones.auto && available.join(",") === context.zones.counts.join(","), `${label}: 区画の候補数が自動の区切りの数と違います`);
      // ほかのどの区切り（候補の半径の間）よりも均等か、同じ
      const radii = context.items.map((item) => Math.hypot(item.x, item.y)).sort((a, b) => a - b);
      const total = radii.length;
      const score = (counts) => counts.reduce((sum, count) => sum + (3 * count - total) ** 2, 0);
      const best = score(available);
      for (let i = 1; i < total; i += 3) {
        for (let j = i + 1; j < total; j += 3) {
          if (radii[i] > radii[i - 1] && radii[j] > radii[j - 1]) {
            assert(score([i, j - i, total - j]) >= best, `${label}: もっと均等な区切りがあります`);
          }
        }
      }
    }
    const shotZones = ASC.constraints.buildContext(map, settings).context.zones;
    const markZones = ASC.constraints.buildMarkContext(map, settings).context.zones;
    assert(shotZones.counts.reduce((a, b) => a + b, 0) === 64 && markZones.counts.reduce((a, b) => a + b, 0) === map.marks.length, "自動の区切りの候補の数が違います");
    const manual = ASC.constraints.buildContext(map, Object.assign({}, settings, { zones: { auto: false, innerRadiusMm: 75, outerRadiusMm: 110 } })).context;
    assert(!manual.zones.auto && manual.zones.innerRadiusMm === 75 && manual.zones.outerRadiusMm === 110, "自動をオフにしたとき、入れた区切りを使っていません");
  });

  await test("制約の切り替え: 区画の候補が足りないハード制約はソフトになり、理由を返す", () => {
    const map = defaultMap();
    const { context } = contextFor(map, (s) => {
      s.zones.auto = false; // 区切りを手で入れる
      s.zones.innerRadiusMm = 20; // 内側の領域にShotがほとんど入らない
      s.zones.outerRadiusMm = 123;
    });
    const relaxed = ASC.constraints.resolveHardConstraints(context, 1, (ctx, random) => Boolean(ASC.sampling.findFeasibleState(ctx, random)));
    assert(relaxed.some((entry) => entry.key === "zone"), "同心円の制約がソフトになっていません");
    assert(!context.constraints.find((constraint) => constraint.key === "zone").hard, "context が書き換わっていません");
    assert(context.constraints.find((constraint) => constraint.key === "scan").hard, "関係のない制約までソフトになりました");
  });

  await test("ソフト制約: 強さ0なら偏りを許し、強さを上げると偏りが減る", () => {
    const map = defaultMap();
    function averageViolation(strength) {
      const { context } = contextFor(map, (s) => {
        for (const key of ["scan", "quadrant", "zone"]) {
          s.constraints[key].hard = false;
        }
        s.constraints.softStrength = strength;
      });
      let total = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const state = ASC.sampling.findFeasibleState(context, ASC.math.createRandom(seed));
        total += state.violation(false);
      }
      return total / 30;
    }
    const weak = averageViolation(0);
    const strong = averageViolation(1);
    assert(weak > 0, "強さ0で偏りがありません");
    assert(strong < weak * 0.3, `強さを上げても偏りが減りません（${weak} → ${strong}）`);
  });

  await test("手動選択: 選べないShot（除外Shot）は外し、選んだShotのMarkはすべて測る", () => {
    const map = defaultMap();
    const { context } = contextFor(map, (s) => (s.constraints.excludedShotIds = ["50"]));
    const excludedShot = map.shots.findIndex((shot) => shot.id === "50");
    const first = context.items[0];
    const manual = ASC.sampling.manualSelection(context, [first.shotIndex, excludedShot]);
    assert(manual.items.length === 1, "選べるShotの数が違います");
    assert(manual.markIndices.join(",") === map.shots[first.shotIndex].markIndices.join(","), "選んだShotのMarkをすべて測っていません");
    assert(manual.notEligible.join(",") === String(excludedShot), "選べないShotを知らせていません");
  });

  await test("評価全体: 多項式で表せる成分だけでノイズなしなら、HOWAの残差はほぼ0", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 5, highOrderAmplitudeNm: 0, noiseSigmaXnm: 0, noiseSigmaYnm: 0 });
    settings.sampling.draws = 2;
    settings.sampling.optimalStarts = 1;
    settings.sampling.shotCount = 16;
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    for (const methodKey of ["random", "poisson", "dOptimal", "iOptimal", "constrainedD", "constrainedI"]) {
      const rms = output.summary[methodKey].variants.howa.x.rms.all.max;
      assert(rms < 1e-6, `${methodKey}: HOWAの残差が0になりません（${rms}）`);
    }
  });

  await test("評価全体: 初期設定で全選び方・全補正の結果がそろい、全点計測の基準が最も小さい", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 20 });
    settings.sampling.draws = 4;
    settings.sampling.optimalStarts = 2;
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const manualShots = [];
    const { context } = contextFor(map);
    for (let i = 0; i < 20; i++) {
      manualShots.push(context.items[i * 3].shotIndex);
    }
    let lastProgress = 0;
    const started = Date.now();
    const output = await ASC.evaluator.runEvaluation(
      { map, data, settings, manualPlans: [{ key: "manual:1", label: "手動1", shotIndices: manualShots }] },
      (done, total) => {
        lastProgress = done / total;
      },
      () => false
    );
    const elapsed = Date.now() - started;
    assert(output.errors.length === 0, output.errors.join(" / "));
    assert(lastProgress === 1, "進み具合が100%になりません");
    assert(output.variants.length === 10, `比べる補正が10通り（HOWA・RBF/GPRの式内と予測・計測値＋HOWA）ではありません（${output.variants.length}）`);
    assert(
      output.methods.map((method) => method.key).join(",") === "random,poisson,dOptimal,iOptimal,constrainedD,constrainedI,manual:1",
      `結果の選び方の並びが違います: ${output.methods.map((method) => method.key)}`
    );
    assert(output.failedMethods.length === 0, `選べなかった選び方があります: ${output.failedMethods}`);
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      assert(summary, `${method.label} の結果がありません`);
      for (const variant of output.variants) {
        const value = summary.variants[variant.key].y.mean3sigma.all.mean;
        assert(Number.isFinite(value) && value > 0, `${method.label}・${variant.label} の値が不正です`);
      }
    }
    for (const key of ["gpXY", "gpXYPredict"]) {
      assert(output.summary.random.gpChoices[key].lengthMm.median > 0, `${key}: GPRが選んだ相関の長さがありません`);
    }
    const baseline = ASC.evaluator.summarizeStore(output.baselines.allMarks.howa).x.rms.mean;
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected).x.rms.mean;
    for (const method of output.methods) {
      assert(output.summary[method.key].variants.howa.x.rms.all.mean > baseline, `${method.label} が全点計測より良くなっています`);
    }
    assert(uncorrected > baseline * 3, "補正なしと全点計測の差が小さすぎます");
    console.log(`  （参考）Wafer20枚・試行4回の計算時間: ${elapsed} ms`);
  });

  await test("補正: ずれが1次式でノイズがなければ、どの補正（HOWA・RBF・GPRの式内と予測・計測値＋HOWA）も残差は0", () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    const waferCount = 3;
    const markCount = map.marks.length;
    const data = { waferCount, markCount, truthX: new Float64Array(waferCount * markCount), truthY: new Float64Array(waferCount * markCount), noiseX: new Float64Array(waferCount * markCount), noiseY: new Float64Array(waferCount * markCount) };
    for (let w = 0; w < waferCount; w++) {
      map.marks.forEach((mark, i) => {
        data.truthX[w * markCount + i] = 1 + w + 2 * mark.u - mark.v;
        data.truthY[w * markCount + i] = -1 + 0.5 * mark.u + 3 * mark.v;
      });
    }
    const random = ASC.math.createRandom(32);
    const sample = random.shuffle(allIndices(markCount)).slice(0, 60);
    const variants = ASC.correction.buildVariants(settings.model);
    const evaluation = ASC.evaluator.evaluateSampleSet(map, data, settings.model, sample, variants);
    for (const variant of variants) {
      for (const axis of ["x", "y"]) {
        const worst = Math.max(...evaluation.results[variant.key][axis].max);
        assert(worst < 1e-7, `${variant.key}・${axis}: 残差が0になりません（${worst}）`);
      }
    }
  });

  await test("スイープ: 計測Shot数ごとに評価し、選んだ選び方だけを比べる。端のShotを選ばなければMark数はShot数×4。点を増やすと残差は小さくなる", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 10 });
    settings.sampling.optimalStarts = 1;
    settings.sampling.excludeIncompleteShots = true;
    settings.model.corrections = { howa: true, rbfXY: true, gpXYPredict: true, measured: true };
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const methods = { random: true, poisson: false, dOptimal: true, iOptimal: false, constrainedD: true, constrainedI: false };
    const sweep = { startShots: 12, endShots: 36, stepShots: 12, draws: 2, methods };
    let lastFraction = 0;
    const output = await ASC.evaluator.runSweep({ map, data, settings }, sweep, (done, total) => {
      lastFraction = done / total;
    }, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    assert(output.points.length === 3, `点の数が3ではありません（${output.points.length}）`);
    assert(Math.abs(lastFraction - 1) < 1e-9, "進み具合が100%になりません");
    assert(output.methods.map((method) => method.key).join(",") === "random,dOptimal,constrainedD", `スイープの選び方が違います: ${output.methods.map((method) => method.key)}`);
    output.points.forEach((point) => {
      assert(point.markCounts.constrainedD === point.shotCount * 4, `Shot ${point.shotCount}: Mark数がShot数×4ではありません`);
      assert(Object.keys(point.summary).every((key) => !key.startsWith("manual:")), "スイープの点に手動プランが入っています");
      assert(Object.keys(point.summary.random.variants).join(",") === "howa,rbfXY,gpXYPredict,measured", "スイープの補正が違います");
    });
    const first = output.points[0].summary.constrainedD.variants.howa.x.rms.all.mean;
    const lastValue = output.points[2].summary.constrainedD.variants.howa.x.rms.all.mean;
    assert(lastValue < first, `点を増やしても残差が減りません（${first} → ${lastValue}）`);
    const invalid = await ASC.evaluator.runSweep({ map, data, settings }, { startShots: 10, endShots: 500, stepShots: 10, draws: 2 }, () => {}, () => false);
    assert(invalid.errors.some((text) => text.includes("選べるShot数")), "選べるShot数を超える範囲を知らせていません");
  });

  await test("手動プラン: 複数のプランを別々の選び方として評価し、スイープでは1回だけ評価して点として返す", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 8 });
    settings.sampling.optimalStarts = 1;
    settings.sampling.draws = 2;
    settings.model.corrections = { howa: true, rbfXYPredict: true };
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const { context } = contextFor(map);
    const planA = { key: "manual:1", label: "現行", shotIndices: context.items.slice(0, 15).map((item) => item.shotIndex) };
    const planB = { key: "manual:2", label: "案B", shotIndices: context.items.slice(20, 50).map((item) => item.shotIndex) };
    const empty = { key: "manual:3", label: "空", shotIndices: [] };
    const marksOf = (plan) => plan.shotIndices.reduce((sum, shotIndex) => sum + map.shots[shotIndex].markIndices.length, 0);
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [planA, planB, empty] }, () => {}, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    const keys = output.methods.map((method) => method.key);
    assert(keys.includes("manual:1") && keys.includes("manual:2") && !keys.includes("manual:3"), `手動プランの並びが違います: ${keys}`);
    assert(output.methods.find((method) => method.key === "manual:2").label === "案B", "手動プランの名前が結果にありません");
    assert(output.summary["manual:1"].markCount.mean === marksOf(planA) && output.summary["manual:2"].markCount.mean === marksOf(planB), "手動プランのMark数が選んだShotのMarkの合計ではありません");
    const sweep = await ASC.evaluator.runSweep({ map, data, settings, manualPlans: [planA, planB] }, { startShots: 10, endShots: 20, stepShots: 10, draws: 1 }, () => {}, () => false);
    assert(sweep.errors.length === 0, sweep.errors.join(" / "));
    assert(sweep.manual && sweep.manual.methods.length === 2, "スイープに手動プランの結果がありません");
    assert(sweep.manual.markCounts["manual:2"] === marksOf(planB) && sweep.manual.shotCounts["manual:2"] === 30, "スイープの手動プランのMark数・Shot数が違います");
    assert(sweep.methods.every((method) => !method.manual), "スイープの点の選び方に手動プランが入っています");
  });

  await test("手動プランの管理: Shot番号で指定・切替・複製・保存と読込（以前の形式も）", () => {
    const map = defaultMap();
    const P = ASC.manualPlans;
    const store = P.createStore();
    const plan = P.addPlan(store, "現行", [], true);
    assert(plan.key === "manual:1" && plan.name === "現行", "プランの作成が違います");
    const ids = P.parseShotIdText("10, 11　12\n13、999");
    assert(ids.join(",") === "10,11,12,13,999", `Shot番号の読み取りが違います: ${ids}`);
    const applied = P.applyShotIds(plan, map, ids);
    assert(applied.applied === 4 && applied.unknown.join(",") === "999", "マップにない番号を知らせていません");
    const shotIndex = map.shots.findIndex((shot) => shot.id === "11");
    P.toggleShot(plan, map, shotIndex);
    assert(!plan.shotIds.has("11") && plan.shotIds.size === 3, "Shotを外せません");
    const indices = P.planIndices(plan, map);
    assert(indices.shotIndices.length === 3 && indices.missingShotIds.length === 0, "マップ上の番号に直せません");
    const copy = P.duplicatePlan(store, plan.key);
    assert(copy.name === "現行の複製" && copy.shotIds.size === 3, "複製が違います");
    assert(P.addPlan(store, "現行", [], true).name === "現行 (2)", "同じ名前に番号が付きません");
    const restored = P.fromJson(JSON.parse(JSON.stringify(P.toJson(store))));
    assert(restored.plans.length === 3 && restored.plans[0].name === "現行" && restored.plans[0].shotIds.size === 3, "保存と読込で中身が変わりました");
    const legacy = P.fromJson({ shotIds: ["5", "6"], marks: [{ shotId: "5", markNo: 2 }] });
    assert(legacy.plans.length === 1 && legacy.plans[0].shotIds.size === 2, "以前の形式（手動選択1つ）を読めません");
    assert(P.sortShotIds(["30", "999", "4"], map).join(",") === "4,30,999", "Shot番号の並べ替えが違います");
    while (P.addPlan(store, null, [], true)) {
      // 上限まで足す
    }
    assert(store.plans.length === ASC.constants.MAX_MANUAL_PLANS, "プランの上限が効いていません");
  });

  await test("D基準・I基準: D最適はlog detが最大、I最適は予測分散が最小。効率は基準を100%とし、点が項数より少なければ計算できない扱い", () => {
    const map = defaultMap();
    const { context, settings } = contextFor(map);
    const terms = settings.model.termsX;
    const random = ASC.math.createRandom(41);
    const dSelection = ASC.sampling.selectOptimal(context, random, "D", [terms, terms], 2);
    const iSelection = ASC.sampling.selectOptimal(context, random, "I", [terms, terms], 2);
    const randomSelection = ASC.sampling.selectRandom(context, random);
    const d = ASC.sampling.designCriteria(map, dSelection.markIndices, terms);
    const i = ASC.sampling.designCriteria(map, iSelection.markIndices, terms);
    const r = ASC.sampling.designCriteria(map, randomSelection.markIndices, terms);
    assert(d.logDet > r.logDet && i.trace < r.trace, "D最適・I最適の基準がランダムより良くありません");
    assertClose(r.kappa, ASC.sampling.kappaOf(map, randomSelection.markIndices, terms), 1e-12, "κ と I基準の関係");
    const reference = { logDet: d.logDet, trace: i.trace };
    assertClose(ASC.sampling.efficiencies(d, reference).d, 100, 1e-9, "D最適のD効率");
    assertClose(ASC.sampling.efficiencies(i, reference).i, 100, 1e-9, "I最適のI効率");
    assert(ASC.sampling.efficiencies(r, reference).d < 100, "ランダムのD効率が100%未満になりません");
    const tooFew = ASC.sampling.designCriteria(map, randomSelection.markIndices.slice(0, 10), terms);
    assert(tooFew.singular && tooFew.logDet === -Infinity && ASC.sampling.efficiencies(tooFew, reference).d === 0, "点が項数より少ないときの扱いが違います");
  });

  await test("制約の満たし具合: ずれ（移せば満たせるShot数）と、選び方ごとの満たした回数を出す", async () => {
    const map = defaultMap();
    const { context } = contextFor(map);
    const upItems = context.items.map((item, index) => ({ item, index })).filter((entry) => entry.item.scan === "Up").map((entry) => entry.index);
    const downItems = context.items.map((item, index) => ({ item, index })).filter((entry) => entry.item.scan === "Down").map((entry) => entry.index);
    const chosen = upItems.slice(0, 12).concat(downItems.slice(0, 8));
    const status = ASC.constraints.describeStatus(context, chosen, []);
    const scan = status.rows.find((row) => row.key === "scan");
    assert(!scan.ok && scan.shift === 2, `Up 12・Down 8 のずれが2ではありません（${scan.shift}）`);
    assert(status.center && !status.center.ok && status.center.shift === 1, "中心の1点のずれが違います");
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 3 });
    settings.sampling.draws = 3;
    settings.sampling.optimalStarts = 1;
    settings.model.corrections = { howa: true };
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const plan = { key: "manual:1", label: "偏り", shotIndices: chosen.map((index) => context.items[index].shotIndex) };
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [plan] }, () => {}, () => false);
    const manualScan = output.summary["manual:1"].constraints.find((entry) => entry.key === "scan");
    assert(manualScan.satisfied === 0 && manualScan.meanShift === 2, "手動プランの制約の集計が違います");
    const randomScan = output.summary.random.constraints.find((entry) => entry.key === "scan");
    assert(randomScan.satisfied === 3 && randomScan.total === 3, "ランダム（ハード制約）の満たした回数が違います");
    assert(output.criteriaReference.x && Number.isFinite(output.criteriaReference.x.logDet), "効率の基準がありません");
    assert(output.summary.constrainedD.criteriaX.logDet.mean >= output.summary.random.criteriaX.logDet.max - 1e-9, "制約付きD最適のlog detがランダムの最大以上になりません");
  });

  await test("制約なしと制約付き: 制約付きは制約を満たし、制約なしのD最適のlog detは制約付き以上", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 3 });
    settings.sampling.optimalStarts = 2;
    settings.sampling.methods = { random: false, poisson: false, dOptimal: true, iOptimal: true, constrainedD: true, constrainedI: true };
    settings.model.corrections = { howa: true };
    settings.constraints.mandatoryShotIds = ["22"];
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    for (const key of ["constrainedD", "constrainedI"]) {
      assert(output.summary[key].constraintsMet === 1, `${key}: 制約を満たしていません`);
    }
    assert(output.summary.dOptimal.criteriaX.logDet.mean >= output.summary.constrainedD.criteriaX.logDet.mean - 1e-9, "制約なしのD最適のlog detが制約付きより小さくなりました");
    const freeSet = output.sets.find((set) => set.method === "dOptimal");
    assert(freeSet.status.mandatory && freeSet.status.rows.length === 3, "制約なしの選び方にも制約の満たし具合を出していません");
  });

  await test("計画を作成: 評価データを使わずに制約なし・制約付きのD最適・I最適を選び、評価と同じ点になる", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 2 });
    settings.sampling.optimalStarts = 2;
    settings.sampling.methods = { random: false, poisson: false, dOptimal: true, iOptimal: true, constrainedD: true, constrainedI: true };
    settings.model.corrections = { howa: true };
    settings.constraints.mandatoryShotIds = ["30", "75"];
    settings.constraints.excludedShotIds = ["52"];
    const plan = ASC.evaluator.runPlan({ map, settings });
    assert(plan.errors.length === 0, plan.errors.join(" / "));
    assert(plan.sets.map((set) => set.method).join(",") === "dOptimal,iOptimal,constrainedD,constrainedI", "計画の選び方が違います");
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    for (const set of plan.sets) {
      const evaluated = output.sets.find((entry) => entry.method === set.method);
      assert(set.shotIndices.join(",") === evaluated.shotIndices.join(","), `${set.method}: 計画と評価で選んだShotが違います`);
      if (ASC.constants.METHODS.find((method) => method.key === set.method).constrained) {
        assert(ASC.constraints.statusRows(set.status).every((row) => row.ok), `${set.method}: 制約を満たしていません`);
      }
      assert(!set.results, "計画に評価の値が入っています");
    }
    const broken = ASC.evaluator.runPlan({ map, settings: Object.assign({}, settings, { constraints: Object.assign({}, settings.constraints, { mandatoryShotIds: ["0"] }) }) });
    assert(broken.errors.length > 0, "設定の誤りを知らせていません");
  });

  /** Mark単位の選び方だけをオンにした設定（Shot単位の選び方は keepShotMethods で残せる）。 */
  function markMethodSettings(keys, overrides) {
    const settings = ASC.defaultSettings();
    for (const key of Object.keys(settings.sampling.methods)) {
      settings.sampling.methods[key] = keys.includes(key);
    }
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 2 });
    settings.sampling.draws = 2;
    settings.sampling.optimalStarts = 2;
    settings.model.corrections = { howa: true };
    return Object.assign(settings, overrides || {});
  }

  await test("Mark単位の前提: 候補は有効なMarkすべて（端のShotのMarkも含み、除外ShotのMarkは除く）。強制計測ShotはそのMarkをすべて必ず選ぶ", () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.constraints.excludedShotIds = ["52"];
    settings.constraints.mandatoryShotIds = ["30"];
    const built = ASC.constraints.buildMarkContext(map, settings);
    assert(built.errors.length === 0, built.errors.join(" / "));
    const context = built.context;
    const shotIndexOf = (id) => map.shots.findIndex((shot) => shot.id === id);
    assert(context.unit === "mark" && context.shotCount === 80, "Mark単位の前提の選ぶ数が違います");
    assert(context.items.length === map.marks.length - map.shots[shotIndexOf("52")].markIndices.length, "候補のMark数が違います");
    assert(context.items.every((item) => item.marks.length === 1 && item.marks[0] === item.markIndex), "候補が1つずつのMarkになっていません");
    assert(context.items.some((item) => ASC.constraints.isIncompleteShot(map.shots[item.shotIndex])), "Markが揃わない端のShotのMarkが候補にありません");
    assert(context.mandatoryItems.length === map.shots[shotIndexOf("30")].markIndices.length, "強制計測ShotのMarkの数が違います");
    assert(context.items[context.center.itemIndex].markIndex === context.center.markIndex, "中心の1点がMarkの候補になっていません");
    const zone = context.constraints.find((constraint) => constraint.key === "zone");
    const available = Array.from(zone.available).reduce((sum, value) => sum + value, 0);
    assert(available === context.items.length, "区画をMarkごとに数えていません");
    for (const [markCount, label] of [[0, "0"], [context.items.length + 1, "候補より多い"]]) {
      const broken = ASC.constraints.buildMarkContext(map, Object.assign({}, settings, { sampling: Object.assign({}, settings.sampling, { markCount }) }));
      assert(broken.errors.length > 0, `Mark数が${label}ときの誤りを知らせていません`);
    }
  });

  await test("Mark単位の入れ替えの近道: 1行ずつの式（swapChangeSingle）が、一般の式（swapChange）と同じ値になる", () => {
    const map = defaultMap();
    const context = ASC.constraints.buildMarkContext(map, ASC.defaultSettings()).context;
    const terms = Array.from({ length: 21 }, (_, i) => i);
    const [model] = ASC.sampling.buildModels(context, [terms, terms]);
    const selected = Array.from({ length: 80 }, (_, i) => (i * 37) % context.items.length);
    const prepared = ASC.sampling.prepareExchange(model, selected, true);
    let checked = 0;
    for (const removed of selected.slice(0, 6)) {
      for (let added = 0; added < context.items.length; added += 17) {
        if (selected.includes(added)) {
          continue;
        }
        const general = ASC.sampling.swapChange(model, prepared, removed, added, true);
        const single = ASC.sampling.swapChangeSingle(model, prepared, removed, added, true);
        assert(Boolean(general) === Boolean(single), "正則かどうかの判定が違います");
        if (general) {
          assertClose(single.logDetChange, general.logDetChange, 1e-9 * Math.max(1, Math.abs(general.logDetChange)), "log det の変化");
          assertClose(single.traceChange, general.traceChange, 1e-9 * Math.max(1, Math.abs(general.traceChange)), "予測分散の和の変化");
          checked++;
        }
      }
    }
    assert(checked > 50, `比べた入れ替えが少なすぎます（${checked}）`);
  });

  await test("Mark単位の選び方: 指定のMark数を選び、制約付きはMarkの数で制約を満たす。制約なしのD最適のlog detは同じMark数のShot単位以上", async () => {
    const map = defaultMap();
    const markKeys = ["markRandom", "markPoisson", "markDOptimal", "markIOptimal", "markConstrainedD", "markConstrainedI"];
    const settings = markMethodSettings(["dOptimal"].concat(markKeys));
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    assert(output.errors.length === 0 && output.markErrors.length === 0, output.errors.concat(output.markErrors).join(" / "));
    assert(output.methods.map((method) => method.key).join(",") === ["dOptimal"].concat(markKeys).join(","), "評価した選び方が違います");
    for (const key of markKeys) {
      const sets = output.sets.filter((set) => set.method === key);
      const method = ASC.constants.METHODS.find((entry) => entry.key === key);
      assert(sets.length === (method.usesDraws ? 2 : 1), `${key}: 試行の数が違います`);
      for (const set of sets) {
        assert(set.unit === "mark" && set.markIndices.length === 80, `${key}: Mark数が80になっていません`);
        assert(new Set(set.shotIndices).size === set.shotIndices.length && set.shotIndices.length >= 20, `${key}: Markを測るShotの一覧が違います`);
        if (method.constrained) {
          assert(statusAllOk(set.status), `${key}: Markの数で数えた制約を満たしていません`);
        }
      }
    }
    assert(output.sets.find((set) => set.method === "dOptimal").unit === "shot", "Shot単位の選び方の単位が違います");
    assert(output.summary.markDOptimal.criteriaX.logDet.mean >= output.summary.dOptimal.criteriaX.logDet.mean - 1e-9, "Mark単位のD最適のlog detがShot単位より小さくなりました");
    const shotOnly = await ASC.evaluator.runEvaluation({ map, data, settings: markMethodSettings(["dOptimal"]), manualPlans: [] }, () => {}, () => false);
    assert(shotOnly.markContext === null && shotOnly.sets.every((set) => set.unit === "shot"), "Mark単位を使わないのにMark単位の前提を作っています");
    const tooMany = await ASC.evaluator.runEvaluation({ map, data, settings: markMethodSettings(["dOptimal", "markDOptimal"], { sampling: Object.assign(markMethodSettings([]).sampling, { markCount: 9999, methods: { dOptimal: true, markDOptimal: true } }) }), manualPlans: [] }, () => {}, () => false);
    assert(tooMany.errors.length === 0 && tooMany.markErrors.length > 0 && tooMany.methods.every((method) => method.key === "dOptimal"), "Mark単位の前提を作れないとき、Shot単位だけを評価していません");
  });

  await test("Mark単位の計画とスイープ: 計画にオンにしたMark単位のD最適・I最適が入り評価と同じ点。スイープのMark数は計測Shot数に比例", async () => {
    const map = defaultMap();
    const settings = markMethodSettings(["constrainedD", "markDOptimal", "markConstrainedI"]);
    const plan = ASC.evaluator.runPlan({ map, settings });
    assert(plan.errors.length === 0 && plan.markErrors.length === 0, plan.errors.concat(plan.markErrors).join(" / "));
    assert(plan.sets.map((set) => set.method).join(",") === "dOptimal,iOptimal,constrainedD,constrainedI,markDOptimal,markConstrainedI", "計画の選び方が違います");
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    for (const key of ["markDOptimal", "markConstrainedI"]) {
      const planned = plan.sets.find((set) => set.method === key);
      const evaluated = output.sets.find((set) => set.method === key);
      assert(planned.markIndices.join(",") === evaluated.markIndices.join(","), `${key}: 計画と評価で選んだMarkが違います`);
    }
    const sweepSettings = { startShots: 10, endShots: 20, stepShots: 10, draws: 1, methods: { constrainedD: true, markConstrainedD: true } };
    const sweep = await ASC.evaluator.runSweep({ map, data, settings, manualPlans: [] }, sweepSettings, () => {}, () => false);
    assert(sweep.errors.length === 0, sweep.errors.join(" / "));
    assert(sweep.points.map((point) => point.markCounts.markConstrainedD).join(",") === "40,80", "スイープのMark単位のMark数が計測Shot数に比例していません");
    assert(sweep.points.map((point) => point.markCounts.constrainedD).join(",") === "40,80", "スイープのShot単位のMark数が違います");
  });

  await test("選択点のCSV: 1行1Mark、Wafer座標＝Shot中心＋Mark座標、Shotの並び順", () => {
    const map = defaultMap();
    const shot = map.shots[40];
    const csv = ASC.waferMap.selectionToCsv(map, shot.markIndices.slice().reverse().concat(map.shots[3].markIndices));
    const lines = csv.trim().split("\r\n");
    assert(lines[0] === "ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY,WaferX,WaferY", `見出しが違います: ${lines[0]}`);
    assert(lines.length === 1 + shot.markIndices.length + map.shots[3].markIndices.length, "行の数が違います");
    const rows = lines.slice(1).map((line) => line.split(","));
    assert(rows[0][0] === map.shots[3].id, "Shotの並び順になっていません");
    for (const row of rows) {
      const [shotX, shotY, , , markX, markY, waferX, waferY] = row.slice(1).map(Number);
      assertClose(waferX, shotX + markX, 1e-9, "Wafer座標X");
      assertClose(waferY, shotY + markY, 1e-9, "Wafer座標Y");
    }
    const parsed = ASC.waferMap.parseMapCsv(csv, { validRadiusMm: 150, shotWidthMm: 26, shotHeightMm: 33 });
    assert(parsed.errors.length === 0 && parsed.map.marks.length === rows.length, "選択点のCSVをマップのCSVとして読めません");
  });

  // ---- 計測データのファイル ----

  await test("計測データのファイル（CSV）: マップと評価データを作り、無効マーク・重複行・未測定を扱う", async () => {
    const settings = ASC.defaultSettings();
    const result = ASC.measurementData.buildFromTable(await sampleMeasurementTable(), settings.map);
    assert(result.errors.length === 0, result.errors.join(" / "));
    const { map, data, report } = result;
    assert(data.waferCount === 5 && report.waferNames[0] === "SAMPLE01-01", "Waferの数か名前が違います");
    const invalid = report.invalidMarks.map((mark) => `${mark.shotId}-${mark.markNo}`).join(",");
    assert(invalid === "30-3,45-1,45-2,45-3,45-4,61-2", `無効マークが違います: ${invalid}`);
    assert(map.inactiveShots.length === 1 && map.inactiveShots[0].id === "45", "すべて無効マークのShotを選べないShotにしていません");
    assert(!map.shots.some((shot) => shot.id === "45"), "すべて無効マークのShotがマップに入っています");
    assert(report.duplicateRows === 1, "重複行の数が違います");
    const shot30 = map.shots.find((shot) => shot.id === "30");
    assert(shot30.markIndices.length === 3 && shot30.definedMarkCount === 4 && ASC.constraints.isIncompleteShot(shot30), "無効マークのあるShotをMarkが揃わないShotにしていません");
    assert(!shot30.markIndices.some((index) => map.marks[index].markNo === 3), "無効マークを計測の対象に入れています");
    // 生成したマップ（初期設定）と比べると、無効マークの6個とすべて無効のShotの1個だけ少ない
    const generated = ASC.waferMap.generateWaferMap(settings.map).map;
    assert(map.marks.length === generated.marks.length - 6 && map.shots.length === generated.shots.length - 1, "Mark・Shotの数が違います");
    assert(map.shots.map((shot) => shot.scan).join() === generated.shots.filter((shot) => shot.id !== "45").map((shot) => shot.scan).join(), "Direction（1 = Up、2 = Down）の読み方が違います");
    // 計測値は、有効な値の平均（重複行はX・Yそれぞれ平均）
    const expected = sampleMeasuredValues();
    data.waferNames.forEach((name, wafer) => {
      map.marks.forEach((mark, markIndex) => {
        const entry = expected.get(`${name}|${map.shots[mark.shotIndex].id}|${mark.markNo}`);
        const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
        assertClose(data.truthX[wafer * data.markCount + markIndex], mean(entry.x), 1e-12, `Wafer ${name} Mark ${markIndex} X`);
        assertClose(data.truthY[wafer * data.markCount + markIndex], mean(entry.y), 1e-12, `Wafer ${name} Mark ${markIndex} Y`);
      });
    });
    assert(data.noiseX.every((value) => value === 0), "ファイルの評価データにノイズが入っています");
  });

  await test("計測データのファイル（xlsx）: CSVと同じ値を読む（共有文字列・ふりがな・日時の数値・空のセル・2枚目のシート）", async () => {
    const lines = fs.readFileSync(SAMPLE_MEASUREMENTS, "utf8").trim().split(/\r\n/).slice(0, 600);
    const header = lines[0].split(",");
    const dateColumn = header.indexOf("DateTime");
    // 見本の日時（2026/10/01 09:00:00）をExcelの日付の数値にする
    const serial = String((Date.UTC(2026, 9, 1, 9) - Date.UTC(1899, 11, 30)) / 86400000);
    const rows = lines.map((line, lineIndex) =>
      line.split(",").map((cell, column) => {
        if (lineIndex === 0) {
          return column === 0 ? { text: cell, phonetic: "ウェハ" } : cell;
        }
        if (column === dateColumn) {
          return { number: serial };
        }
        if (column === 0 && lineIndex % 2 === 0) {
          return { inline: cell };
        }
        return NUMBER_TEXT.test(cell) ? { number: cell } : cell;
      })
    );
    const bytes = makeXlsx([
      { name: "メモ", rows: [["このシートは説明です"], ["見出しのない表"]] },
      { name: "data", rows },
    ]);
    const xlsxTable = await ASC.tableReader.readTableBytes("計測.xlsx", bytes);
    const csvTable = ASC.tableReader.parseCsvText(lines.join("\r\n"));
    const settings = ASC.defaultSettings();
    const fromXlsx = ASC.measurementData.buildFromTable(xlsxTable, settings.map);
    const fromCsv = ASC.measurementData.buildFromTable(csvTable, settings.map);
    assert(fromXlsx.errors.length === 0, fromXlsx.errors.join(" / "));
    assert(fromXlsx.report.sheetName === "data", "見出しのあるシートを選んでいません");
    assert(xlsxTable.sheets[1].rows[1].cells[dateColumn] === serial, "日時のセルの値が違います");
    assert(JSON.stringify(fromXlsx.report.waferNames) === JSON.stringify(fromCsv.report.waferNames), "Waferの名前がCSVと違います");
    assert(JSON.stringify(fromXlsx.map.marks) === JSON.stringify(fromCsv.map.marks), "マップがCSVと違います");
    assert(Array.from(fromXlsx.data.truthX).join() === Array.from(fromCsv.data.truthX).join(), "計測値XがCSVと違います");
    assert(Array.from(fromXlsx.data.truthY).join() === Array.from(fromCsv.data.truthY).join(), "計測値YがCSVと違います");
    assert(ASC.measurementData.excelSerialText(45346.939583333, false) === "2024/02/24 22:33:00", "Excelの日付の数値の読み方が違います");
    let rejected = false;
    try {
      await ASC.tableReader.readTableBytes("古い.xls", bytes);
    } catch (error) {
      rejected = true;
    }
    assert(rejected, ".xls を読めないと知らせていません");
  });

  await test("計測データのファイル: 列の不足・読めない値・Shotの座標の食い違いを、行番号つきで知らせる", () => {
    const options = ASC.defaultSettings().map;
    const build = (text) => ASC.measurementData.buildFromTable(ASC.tableReader.parseCsvText(text), options);
    const header = "Wafer,DateTime,shotNo,Direction,Xmm,Ymm,markNo,markXmm,markYmm,measX,measY,StsX,StsY";
    const missing = build("Wafer,shotno,Direction\r\nW1,1,1\r\n");
    assert(missing.errors.some((text) => text.includes("shotNo")), `列の不足を知らせていません: ${missing.errors.join(" / ")}`);
    const badDirection = build(`${header}\r\nW1,,1,3,0,0,1,1,1,0.1,0.2,0,0\r\n`);
    assert(badDirection.errors.some((text) => text.startsWith("2行目") && text.includes("Direction")), "Directionの誤りを知らせていません");
    const moved = build(`${header}\r\nW1,,1,1,0,0,1,1,1,0.1,0.2,0,0\r\nW2,,1,1,5,0,1,1,1,0.1,0.2,0,0\r\n`);
    assert(moved.errors.some((text) => text.startsWith("3行目") && text.includes("Xmm")), "Shotの座標の食い違いを知らせていません");
    const ok = build(`${header}\r\nW1,,1,1,0,0,1,1,1,0.1,0.2,0,0\r\nW1,,1,1,0,0,2,-1,-1,0.3,0.4,0,-1\r\n`);
    assert(ok.errors.length === 0 && ok.map.marks.length === 1 && ok.map.invalidMarks.length === 1, "StsY = -1 のMarkを無効マークにしていません");
  });

  await test("計測データのファイル: 読んだデータで評価と計画ができ、無効マークは選ばない", async () => {
    const settings = ASC.defaultSettings();
    settings.evaluationData.source = ASC.constants.DATA_SOURCE_FILE;
    settings.sampling.draws = 2;
    settings.sampling.optimalStarts = 1;
    settings.model.corrections = { howa: true };
    const { map, data } = ASC.measurementData.buildFromTable(await sampleMeasurementTable(), settings.map);
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    assert(output.waferCount === 5, "Wafer数が違います");
    for (const method of output.methods) {
      const rms = output.summary[method.key].variants.howa.x.rms.all.mean;
      assert(Number.isFinite(rms) && rms > 0, `${method.key}: 残差を計算できていません`);
    }
    const plan = ASC.evaluator.runPlan({ map, settings });
    assert(plan.errors.length === 0 && plan.sets.length === 4, "計画を作れません");
    const shot30 = map.shots.findIndex((shot) => shot.id === "30");
    for (const set of output.sets.concat(plan.sets)) {
      assert(set.markIndices.every((index) => index < map.marks.length), "マップにないMarkを選んでいます");
      if (set.shotIndices.includes(shot30)) {
        assert(set.markIndices.filter((index) => map.marks[index].shotIndex === shot30).length === 3, "無効マークのあるShotで有効なMarkだけを測っていません");
      }
    }
  });

  // ---- 結果の表示 ----
  let failed = 0;
  for (const result of results) {
    if (result.ok) {
      console.log(`✓ ${result.name}`);
    } else {
      failed++;
      console.log(`✗ ${result.name}\n    → ${result.message}`);
    }
  }
  console.log(`\n${results.length}件中 ${results.length - failed}件 成功、${failed}件 失敗`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main();
