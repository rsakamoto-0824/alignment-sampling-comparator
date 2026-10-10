/**
 * 計算部分の自動テスト。Node.jsで実行する: node tests/run_tests.js
 * 画面のファイル（ui-*.js, app.js）は読み込まない。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SOURCE_FILES = [
  "constants.js",
  "math-utils.js",
  "zernike.js",
  "wafer-map.js",
  "evaluation-data.js",
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

  await test("補正の流れ: HOWAのみ と 推定→HOWA だけ。全点計測のRBF→HOWAはHOWAと同じ", () => {
    const settings = ASC.defaultSettings();
    const keys = ASC.correction.buildVariants(settings.model).map((variant) => variant.key);
    assert(keys.join(",") === "howa,estimateThenHowa:rbfXY,estimateThenHowa:rbfXYR,estimateThenHowa:gpXY,estimateThenHowa:gpXYR", `比べる補正が違います: ${keys}`);
    const map = defaultMap();
    const terms = allIndices(10);
    const all = allIndices(map.marks.length);
    const subsetMarks = all.slice(0, 200).map((index) => map.marks[index]);
    const subsetAll = allIndices(subsetMarks.length);
    const subsetRbf = ASC.correction.rbfOperator(subsetMarks, subsetAll, { kernel: "tps", lambda: 0, shapeFactor: 2 }, "xy").operator;
    const fullParts = howaPartsFor(subsetMarks, subsetAll, terms);
    const then = ASC.correction.estimateThenHowaOperator(fullParts, subsetRbf, subsetAll, subsetMarks.length);
    for (let i = 0; i < fullParts.howa.length; i += 101) {
      assertClose(then[i], fullParts.howa[i], 1e-9, "全点計測でのRBF→HOWAとHOWA");
    }
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

  await test("ガウス過程回帰: 固有値分解を使った推定が、連立方程式を直接解いた推定と一致する（X,Y と X,Y,半径）", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(21);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 35);
    const values = sample.map((index) => Math.sin(3 * map.marks[index].u) + 0.5 * map.marks[index].v ** 2 + 0.05 * random.normal());
    for (const features of ["xy", "xyr"]) {
      for (const kernel of ["squaredExponential", "matern52"]) {
        const length = 0.4;
        const ratio = 0.01;
        const prepared = prepareGpWithFixedValues(map.marks, sample, features, kernel, length, ratio);
        const predicted = ASC.correction.gpPredict(prepared, Float64Array.from(values)).values;
        // 直接の式: 1次式を最小二乗で除き、残りに K*(K + αI)⁻¹ を掛けて戻す
        const points = sample.map((index) => ASC.correction.featureVector(map.marks[index], features));
        const q = points[0].length + 1;
        const trendRows = new Float64Array(sample.length * q);
        points.forEach((point, i) => {
          trendRows[i * q] = 1;
          point.forEach((value, k) => (trendRows[i * q + 1 + k] = value));
        });
        const trend = ASC.math.multiply(ASC.correction.leastSquaresOperator(trendRows, sample.length, q).operator, q, sample.length, Float64Array.from(values), 1);
        const n = sample.length;
        const residual = values.map((value, i) => value - points[i].reduce((sum, p, k) => sum + trend[k + 1] * p, trend[0]));
        const covariance = new Float64Array(n * n);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            const d = Math.sqrt(points[i].reduce((sum, p, k) => sum + (p - points[j][k]) ** 2, 0));
            covariance[i * n + j] = ASC.correction.gpKernelValue(kernel, d, length) + (i === j ? ratio : 0);
          }
        }
        const weights = ASC.math.choleskySolve(ASC.math.cholesky(covariance, n), n, Float64Array.from(residual), 1);
        for (const markIndex of [0, 50, 120, map.marks.length - 1]) {
          const point = ASC.correction.featureVector(map.marks[markIndex], features);
          let expected = point.reduce((sum, p, k) => sum + trend[k + 1] * p, trend[0]);
          points.forEach((samplePoint, j) => {
            const d = Math.sqrt(point.reduce((sum, p, k) => sum + (p - samplePoint[k]) ** 2, 0));
            expected += ASC.correction.gpKernelValue(kernel, d, length) * weights[j];
          });
          assertClose(predicted[markIndex], expected, 1e-8, `${features}・${kernel}: Mark ${markIndex} の推定値`);
        }
      }
    }
  });

  await test("ガウス過程回帰: 1次関数はそのまま再現し、なめらかな形は調整値を学習して全Markを推定できる", () => {
    const map = defaultMap();
    const random = ASC.math.createRandom(8);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 60);
    const prepared = ASC.correction.prepareGp(map.marks, sample, "xy", "squaredExponential");
    const linear = Float64Array.from(sample.map((index) => 2 + map.marks[index].u - 3 * map.marks[index].v));
    const linearPrediction = ASC.correction.gpPredict(prepared, linear).values;
    map.marks.forEach((mark, i) => assertClose(linearPrediction[i], 2 + mark.u - 3 * mark.v, 1e-8, "1次関数の推定"));
    const smooth = (mark) => Math.sin(2.5 * mark.u) * Math.cos(2 * mark.v);
    const prediction = ASC.correction.gpPredict(prepared, Float64Array.from(sample.map((index) => smooth(map.marks[index]))));
    let squareError = 0;
    let squareSignal = 0;
    map.marks.forEach((mark, i) => {
      squareError += (prediction.values[i] - smooth(mark)) ** 2;
      squareSignal += smooth(mark) ** 2;
    });
    assert(Math.sqrt(squareError / squareSignal) < 0.1, `推定の誤差が大きすぎます（相対RMS ${Math.sqrt(squareError / squareSignal)}）`);
    assert(prediction.length > 0.1, `学習した相関の長さ（${prediction.length}）が短すぎます`);
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

  await test("制約の切り替え: 区画の候補が足りないハード制約はソフトになり、理由を返す", () => {
    const map = defaultMap();
    const { context } = contextFor(map, (s) => {
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

  await test("評価全体: 初期設定で全選び方・全補正（推定手法を含む）の結果がそろい、全点計測の基準が最も小さい", async () => {
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
    assert(output.variants.length === 5, `比べる補正が5通り（HOWAのみ＋推定→HOWA×4つの推定手法）ではありません（${output.variants.length}）`);
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
    const gpLength = output.summary.random.gpChoices["estimateThenHowa:gpXY"].lengthMm.median;
    assert(gpLength > 0, "ガウス過程回帰の学習した相関の長さがありません");
    const baseline = ASC.evaluator.summarizeStore(output.baselines.allMarks.howa).x.rms.mean;
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected).x.rms.mean;
    for (const method of output.methods) {
      assert(output.summary[method.key].variants.howa.x.rms.all.mean > baseline, `${method.label} が全点計測より良くなっています`);
    }
    assert(uncorrected > baseline * 3, "補正なしと全点計測の差が小さすぎます");
    console.log(`  （参考）Wafer20枚・試行4回の計算時間: ${elapsed} ms`);
  });

  await test("推定精度: 未計測Markだけで評価し、Markごとの2乗誤差の合計はWaferごとのRMSと整合する", () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    const data = ASC.evaluationData.generateEvaluationData(map, defaultEvaluationSettings({ waferCount: 6 })).data;
    const random = ASC.math.createRandom(31);
    const sample = random.shuffle(allIndices(map.marks.length)).slice(0, 50).sort((a, b) => a - b);
    const variants = ASC.correction.buildVariants(settings.model);
    const evaluation = ASC.evaluator.evaluateSampleSet(map, data, settings.model, sample, variants);
    const keys = Object.keys(evaluation.estimation);
    assert(keys.join(",") === "howa,rbfXY,rbfXYR,gpXY,gpXYR", `推定精度の対象が違います: ${keys}`);
    const unmeasuredCount = map.marks.length - sample.length;
    for (const key of keys) {
      const squares = evaluation.estimationSquares[key].x;
      assert(sample.every((markIndex) => Number.isNaN(squares[markIndex])), `${key}: 計測Markに誤差が入っています`);
      let total = 0;
      squares.forEach((value) => {
        if (Number.isFinite(value)) {
          total += value;
        }
      });
      const rms = evaluation.estimation[key].x.rms;
      const fromWafers = Array.from(rms).reduce((sum, value) => sum + value * value * unmeasuredCount, 0);
      assertClose(total, fromWafers, 1e-6 * fromWafers, `${key}: 2乗誤差の合計`);
    }
    // HOWAの推定誤差は、HOWAのみの補正残差の未計測Mark部分と同じもの（符号違い）
    const howaParts = howaPartsFor(map.marks, sample, settings.model.termsX);
    const measured = sample.map((markIndex) => data.truthX[markIndex] + data.noiseX[markIndex]);
    let sumSquares = 0;
    let count = 0;
    for (let i = 0; i < map.marks.length; i++) {
      if (sample.includes(i)) {
        continue;
      }
      let prediction = 0;
      for (let j = 0; j < sample.length; j++) {
        prediction += howaParts.howa[i * sample.length + j] * measured[j];
      }
      sumSquares += (prediction - data.truthX[i]) ** 2;
      count++;
    }
    assertClose(evaluation.estimation.howa.x.rms[0], Math.sqrt(sumSquares / count), 1e-9, "HOWAの推定誤差（Wafer 1）");
  });

  await test("推定精度: ずれが説明変数の1次式でノイズがなければ、RBF・GPの推定誤差は0", () => {
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
    const sample = random.shuffle(allIndices(markCount)).slice(0, 40);
    const evaluation = ASC.evaluator.evaluateSampleSet(map, data, settings.model, sample, ASC.correction.buildVariants(settings.model));
    for (const key of ["rbfXY", "gpXY", "howa"]) {
      for (const axis of ["x", "y"]) {
        const worst = Math.max(...evaluation.estimation[key][axis].max);
        assert(worst < 1e-7, `${key}・${axis}: 推定誤差が0になりません（${worst}）`);
      }
    }
  });

  await test("スイープ: 計測Shot数ごとに評価し、選んだ選び方だけを比べる。端のShotを選ばなければMark数はShot数×4。点を増やすと残差は小さくなる", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 10 });
    settings.sampling.optimalStarts = 1;
    settings.sampling.excludeIncompleteShots = true;
    settings.model.estimators = { rbfXY: true, rbfXYR: false, gpXY: true, gpXYR: false };
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
      assert(point.summary.random.estimation.gpXY, "スイープに推定精度がありません");
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
    settings.model.estimators = { rbfXY: true, rbfXYR: false, gpXY: false, gpXYR: false };
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
    settings.model.flows = { howa: true, estimateThenHowa: false };
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
    settings.model.flows = { howa: true, estimateThenHowa: false };
    settings.constraints.mandatoryShotIds = ["17"];
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

  await test("計画を作成: 評価データを使わずに制約付きD最適・I最適を選び、評価と同じ点になる", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 2 });
    settings.sampling.optimalStarts = 2;
    settings.sampling.methods = { random: false, poisson: false, dOptimal: false, iOptimal: false, constrainedD: true, constrainedI: true };
    settings.model.flows = { howa: true, estimateThenHowa: false };
    settings.constraints.mandatoryShotIds = ["30", "75"];
    settings.constraints.excludedShotIds = ["52"];
    const plan = ASC.evaluator.runPlan({ map, settings });
    assert(plan.errors.length === 0, plan.errors.join(" / "));
    assert(plan.sets.map((set) => set.method).join(",") === "constrainedD,constrainedI", "計画の選び方が違います");
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manualPlans: [] }, () => {}, () => false);
    for (const set of plan.sets) {
      const evaluated = output.sets.find((entry) => entry.method === set.method);
      assert(set.shotIndices.join(",") === evaluated.shotIndices.join(","), `${set.method}: 計画と評価で選んだShotが違います`);
      assert(ASC.constraints.statusRows(set.status).every((row) => row.ok), `${set.method}: 制約を満たしていません`);
      assert(!set.results, "計画に評価の値が入っています");
    }
    const broken = ASC.evaluator.runPlan({ map, settings: Object.assign({}, settings, { constraints: Object.assign({}, settings.constraints, { mandatoryShotIds: ["0"] }) }) });
    assert(broken.errors.length > 0, "設定の誤りを知らせていません");
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
