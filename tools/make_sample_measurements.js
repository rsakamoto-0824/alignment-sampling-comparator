/**
 * 計測データのファイルの見本（samples/sample_measurements.csv）を作る。値は乱数で作った架空のもので、実データではない。
 * 実行: node tools/make_sample_measurements.js
 *
 * 初期設定のWaferマップ（一筆書きのScan方向）に、初期設定のZernike項の大きさで作ったずれ＋ノイズを入れる。
 * 読み込みの確かめのため、次のような行もわざと入れる。
 *   - 有効半径の外のMark（端のShot）: measX・measY は空、StsX・StsY は -1
 *   - Wafer 2 の Shot 30 Mark 3: StsX = -1（measX は 0。0 として使わないことの確かめ）
 *   - Wafer 3 の Shot 45: 4つのMarkすべて StsY = -1（すべて無効マークのShot）
 *   - Wafer 4 の Shot 61 Mark 2: 行がない
 *   - Wafer 1 の Shot 12 Mark 1: 値を少し変えた重複行（X・Yそれぞれ平均する）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
for (const file of ["constants.js", "math-utils.js", "zernike.js", "table-reader.js", "wafer-map.js", "evaluation-data.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, "src", "js", file), "utf8"), { filename: file });
}
const ASC = globalThis.ASC;

const OUTPUT_FILE = path.join(ROOT, "samples", "sample_measurements.csv");
const WAFER_COUNT = 5;
const DATA_SEED = 21;
const LOT_NAME = "SAMPLE01";
const DATE_TIME = "2026/10/01 09:00:00";
const COLUMNS = ["Wafer", "DateTime", "shotNo", "Direction", "Xmm", "Ymm", "Radius", "markNo", "markXmm", "markYmm", "measX", "measY", "StsX", "StsY"];
const STATUS_UNMEASURED = -1;
const DUPLICATE_OFFSET_NM = { x: 0.2, y: -0.1 };
// わざと入れる行の場所（Waferは1始まり）
const UNMEASURED_X = { wafer: 2, shotId: "30", markNo: 3 };
const UNMEASURED_SHOT_Y = { wafer: 3, shotId: "45" };
const MISSING_ROW = { wafer: 4, shotId: "61", markNo: 2 };
const DUPLICATE_ROW = { wafer: 1, shotId: "12", markNo: 1 };

function nm(value) {
  return value.toFixed(3);
}

function main() {
  const settings = ASC.defaultSettings();
  const map = ASC.waferMap.generateWaferMap(settings.map).map;
  const dataSettings = Object.assign({}, settings.evaluationData, { waferCount: WAFER_COUNT, seed: DATA_SEED });
  dataSettings.terms = ASC.evaluationData.defaultTermSettings(dataSettings.lowOrderAmplitudeNm, dataSettings.highOrderAmplitudeNm);
  const data = ASC.evaluationData.generateEvaluationData(map, dataSettings).data;
  const shotIds = new Set(map.shots.map((shot) => shot.id));
  for (const place of [UNMEASURED_X, UNMEASURED_SHOT_Y, MISSING_ROW, DUPLICATE_ROW]) {
    if (!shotIds.has(place.shotId)) {
      throw new Error(`Shot ${place.shotId} がマップにありません`);
    }
  }

  const lines = [COLUMNS.join(",")];
  for (let wafer = 1; wafer <= WAFER_COUNT; wafer++) {
    const waferName = `${LOT_NAME}-${String(wafer).padStart(2, "0")}`;
    for (const shot of map.shots) {
      for (const definition of settings.map.marks) {
        const markIndex = shot.markIndices.find((index) => map.marks[index].markNo === definition.markNo);
        const offset = (wafer - 1) * data.markCount + markIndex;
        const is = (place) => place.wafer === wafer && place.shotId === shot.id && (place.markNo === undefined || place.markNo === definition.markNo);
        if (is(MISSING_ROW)) {
          continue;
        }
        let cells;
        if (markIndex === undefined) {
          cells = { measX: "", measY: "", stsX: STATUS_UNMEASURED, stsY: STATUS_UNMEASURED };
        } else {
          cells = { measX: nm(data.truthX[offset] + data.noiseX[offset]), measY: nm(data.truthY[offset] + data.noiseY[offset]), stsX: 0, stsY: 0 };
        }
        if (is(UNMEASURED_X)) {
          cells.measX = nm(0);
          cells.stsX = STATUS_UNMEASURED;
        }
        if (is(UNMEASURED_SHOT_Y)) {
          cells.stsY = STATUS_UNMEASURED;
        }
        const row = (values) =>
          [waferName, DATE_TIME, shot.id, shot.scan === ASC.constants.SCAN_UP ? 1 : 2, shot.x, shot.y, Math.hypot(shot.x, shot.y).toFixed(7), definition.markNo, definition.x, definition.y, values.measX, values.measY, values.stsX, values.stsY].join(",");
        lines.push(row(cells));
        if (is(DUPLICATE_ROW)) {
          lines.push(row(Object.assign({}, cells, { measX: nm(Number(cells.measX) + DUPLICATE_OFFSET_NM.x), measY: nm(Number(cells.measY) + DUPLICATE_OFFSET_NM.y) })));
        }
      }
    }
  }
  fs.writeFileSync(OUTPUT_FILE, lines.join("\r\n") + "\r\n");
  console.log(`${path.relative(ROOT, OUTPUT_FILE)}: ${lines.length - 1}行`);
}

main();
