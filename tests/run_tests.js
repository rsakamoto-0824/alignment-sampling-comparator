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
  return status.rows.every((row) => row.ok) && (!status.center || status.center.ok);
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
    const map = defaultMap();
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

  await test("補正の流れ: HOWA＋RBF（λ=0）は計測点で残差0、全点計測のRBF→HOWAはHOWAと同じ", () => {
    const map = defaultMap();
    const terms = allIndices(10);
    const all = allIndices(map.marks.length);
    const values = map.marks.map((mark) => Math.sin(4 * mark.u) + mark.v ** 6);
    const random = ASC.math.createRandom(9);
    const sample = random.shuffle(all.slice()).slice(0, 40);
    const rbf = ASC.correction.rbfOperator(map.marks, sample, { kernel: "tps", lambda: 0, shapeFactor: 2 }, "xy").operator;
    const parts = howaPartsFor(map.marks, sample, terms);
    const plus = ASC.correction.linearFlowOperator(parts, rbf, sample, "howaPlusEstimate", map.marks.length);
    const n = sample.length;
    sample.forEach((markIndex) => {
      let correction = 0;
      for (let k = 0; k < n; k++) {
        correction += plus[markIndex * n + k] * values[sample[k]];
      }
      assertClose(correction, values[markIndex], 1e-7, "HOWA＋RBFの計測点での補正量");
    });
    const subsetMarks = all.slice(0, 200).map((index) => map.marks[index]);
    const subsetAll = allIndices(subsetMarks.length);
    const subsetRbf = ASC.correction.rbfOperator(subsetMarks, subsetAll, { kernel: "tps", lambda: 0, shapeFactor: 2 }, "xy").operator;
    const fullParts = howaPartsFor(subsetMarks, subsetAll, terms);
    const then = ASC.correction.linearFlowOperator(fullParts, subsetRbf, subsetAll, "estimateThenHowa", subsetMarks.length);
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
        assert(selection.markIndices.length === context.totalMarkCount, `${name}: Mark数が違います`);
        const status = ASC.constraints.describeStatus(context, selection.items, selection.markIndices);
        assert(statusAllOk(status), `${name}（シード${seed}）: 制約を満たしていません ` + JSON.stringify(status.rows.map((row) => [row.key, row.classes.map((c) => c.count)])));
      }
    }
  });

  await test("k個以上: 総Mark数にそろい、選んだShotには必ず測るMarkが入る。中心のMarkも測る", () => {
    const map = defaultMap();
    const { context, settings } = contextFor(map, (s) => {
      s.sampling.markMode = "atLeast";
      s.sampling.totalMarkCount = 52;
    });
    const termSets = [settings.model.termsX, settings.model.termsY];
    const random = ASC.math.createRandom(4);
    for (const selection of [
      ASC.sampling.selectRandom(context, random),
      ASC.sampling.selectPoisson(context, random),
      ASC.sampling.selectOptimal(context, random, "D", termSets, 1),
      ASC.sampling.selectOptimal(context, random, "I", termSets, 1),
    ]) {
      assert(selection.markIndices.length === 52, `Mark数が52ではありません（${selection.markIndices.length}）`);
      assert(new Set(selection.markIndices).size === 52, "同じMarkを2回選んでいます");
      for (const item of selection.items) {
        for (const markIndex of context.items[item].designatedMarks) {
          assert(selection.markIndices.includes(markIndex), "必ず測るMarkが抜けています");
        }
      }
      const shotsOfMarks = new Set(selection.markIndices.map((markIndex) => map.marks[markIndex].shotIndex));
      assert(shotsOfMarks.size === context.shotCount, "選んでいないShotのMarkが入っています");
      assert(selection.markIndices.includes(context.center.markIndex), "中心のMarkが入っていません");
    }
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

  await test("手動選択: 選べないShotは外し、k個以上のときだけ追加Markを入れる", () => {
    const map = defaultMap();
    const { context } = contextFor(map);
    const notEligibleShot = map.shots.findIndex((_, shotIndex) => !context.items.some((item) => item.shotIndex === shotIndex));
    const first = context.items[0];
    const manual = ASC.sampling.manualSelection(context, [first.shotIndex, notEligibleShot].filter((i) => i >= 0), [first.otherMarks[0]]);
    assert(manual.items.length === 1, "選べるShotの数が違います");
    assert(manual.markIndices.length === context.markCountPerShot, "ちょうどk個なのに追加Markが入りました");
    if (notEligibleShot >= 0) {
      assert(manual.notEligible.includes(notEligibleShot), "選べないShotを知らせていません");
    }
  });

  await test("評価全体: 多項式で表せる成分だけでノイズなしなら、HOWAの残差はほぼ0", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 5, highOrderAmplitudeNm: 0, noiseSigmaXnm: 0, noiseSigmaYnm: 0 });
    settings.sampling.draws = 2;
    settings.sampling.optimalStarts = 1;
    settings.sampling.shotCount = 16;
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const output = await ASC.evaluator.runEvaluation({ map, data, settings, manual: { shotIndices: [], extraMarkIndices: [] } }, () => {}, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    for (const methodKey of ["random", "poisson", "dOptimal", "iOptimal"]) {
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
      { map, data, settings, manual: { shotIndices: manualShots, extraMarkIndices: [] } },
      (done, total) => {
        lastProgress = done / total;
      },
      () => false
    );
    const elapsed = Date.now() - started;
    assert(output.errors.length === 0, output.errors.join(" / "));
    assert(lastProgress === 1, "進み具合が100%になりません");
    assert(output.variants.length === 9, `比べる補正が9通り（HOWAのみ＋2つの流れ×4つの推定手法）ではありません（${output.variants.length}）`);
    for (const method of ASC.constants.METHODS) {
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
    for (const method of ASC.constants.METHODS) {
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

  await test("スイープ: 計測Shot数ごとに評価し、Mark数はShot数×k。点を増やすとD最適のHOWAの残差は小さくなる", async () => {
    const map = defaultMap();
    const settings = ASC.defaultSettings();
    settings.evaluationData = defaultEvaluationSettings({ waferCount: 10 });
    settings.sampling.optimalStarts = 1;
    settings.model.estimators = { rbfXY: true, rbfXYR: false, gpXY: true, gpXYR: false };
    const data = ASC.evaluationData.generateEvaluationData(map, settings.evaluationData).data;
    const sweep = { startShots: 12, endShots: 36, stepShots: 12, draws: 2 };
    let lastFraction = 0;
    const output = await ASC.evaluator.runSweep({ map, data, settings }, sweep, (done, total) => {
      lastFraction = done / total;
    }, () => false);
    assert(output.errors.length === 0, output.errors.join(" / "));
    assert(output.points.length === 3, `点の数が3ではありません（${output.points.length}）`);
    assert(Math.abs(lastFraction - 1) < 1e-9, "進み具合が100%になりません");
    output.points.forEach((point) => {
      assert(point.markCounts.dOptimal === point.shotCount * 2, `Shot ${point.shotCount}: Mark数がShot数×2ではありません`);
      assert(!point.summary.manual, "スイープに手動選択が入っています");
      assert(point.summary.random.estimation.gpXY, "スイープに推定精度がありません");
    });
    const first = output.points[0].summary.dOptimal.variants.howa.x.rms.all.mean;
    const lastValue = output.points[2].summary.dOptimal.variants.howa.x.rms.all.mean;
    assert(lastValue < first, `点を増やしても残差が減りません（${first} → ${lastValue}）`);
    const invalid = await ASC.evaluator.runSweep({ map, data, settings }, { startShots: 10, endShots: 500, stepShots: 10, draws: 2 }, () => {}, () => false);
    assert(invalid.errors.some((text) => text.includes("選べるShot数")), "選べるShot数を超える範囲を知らせていません");
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
