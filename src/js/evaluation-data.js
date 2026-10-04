/**
 * 評価データ（乱数のWafer高次傾向と計測ノイズ）の生成。
 *
 * 各Waferのずれ量 = Σ（Zernike項 × 乱数の係数）＋ Scan方向によるずれ
 * 計測値 = ずれ量 ＋ 計測ノイズ
 * ノイズは全Markぶんを先に作っておく。同じWafer・同じMarkなら、どの選び方でも同じノイズになり、
 * 選び方の差だけを比べられる。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const M = ASC.math;

  const MAX_WAFER_COUNT = 5000;

  // 乱数列の用途ごとの番号。用途を分け、ノイズの設定を変えても傾向が変わらないようにする
  const STREAM_TREND = 0;
  const STREAM_NOISE = 1;
  const STREAM_SCAN = 2;

  // 評価データの成分（「評価データ」タブで確かめる用。評価の計算には使わない）
  const COMPONENTS = [
    { key: "truth", label: "真のずれ（全体）", shortLabel: "真のずれ" },
    { key: "low", label: "5次以下のZernike項（5次までの多項式で表せる成分）", shortLabel: "5次以下" },
    { key: "high", label: "6次以上のZernike項（多項式で補正できない成分）", shortLabel: "6次以上" },
    { key: "scan", label: "Scan方向のずれ", shortLabel: "Scan方向" },
    { key: "noise", label: "計測ノイズ", shortLabel: "ノイズ" },
    { key: "measured", label: "計測値（真のずれ＋ノイズ）", shortLabel: "計測値" },
  ];

  /** Zernike各項の初期設定。5次以下と6次以上で大きさを分ける。 */
  function defaultTermSettings(lowOrderAmplitudeNm, highOrderAmplitudeNm) {
    return ASC.zernike.TERMS.map((term) => {
      const amplitude = term.polynomialExpressible ? lowOrderAmplitudeNm : highOrderAmplitudeNm;
      return { fringeIndex: term.fringeIndex, enabled: true, xValue: amplitude, yValue: amplitude };
    });
  }

  function validateSettings(settings) {
    const errors = [];
    if (!Number.isInteger(settings.waferCount) || settings.waferCount < 1 || settings.waferCount > MAX_WAFER_COUNT) {
      errors.push(`Wafer数は1〜${MAX_WAFER_COUNT}の整数にしてください。`);
    }
    for (const term of settings.terms) {
      if (!(term.xValue >= 0) || !(term.yValue >= 0)) {
        errors.push(`Z${term.fringeIndex} の大きさは0以上の数値にしてください。`);
      }
    }
    for (const [name, value] of [
      ["計測ノイズX", settings.noiseSigmaXnm],
      ["計測ノイズY", settings.noiseSigmaYnm],
      ["Scan方向のずれX", settings.scanOffsetXnm],
      ["Scan方向のずれY", settings.scanOffsetYnm],
    ]) {
      if (!(value >= 0)) {
        errors.push(`${name}は0以上の数値にしてください。`);
      }
    }
    return errors;
  }

  /** 分布の設定に従って乱数を1つ作る。scale は一様分布なら ±範囲、正規分布なら標準偏差。 */
  function drawValue(random, distribution, scale) {
    if (scale === 0) {
      return 0;
    }
    if (distribution === C.DISTRIBUTION_NORMAL) {
      return scale * random.normal();
    }
    return scale * (2 * random.next() - 1);
  }

  /**
   * 評価データを作る。
   * 戻り値の truthX などは Float64Array で、並びは [wafer * markCount + markIndex]。
   */
  function generateEvaluationData(map, settings) {
    const errors = validateSettings(settings);
    if (errors.length > 0) {
      return { data: null, errors };
    }
    const waferCount = settings.waferCount;
    const markCount = map.marks.length;
    const activeTerms = settings.terms.filter((term) => term.enabled && (term.xValue > 0 || term.yValue > 0));
    const termCount = activeTerms.length;

    // 全Markでの各Zernike項の値（Mark × 項）
    const basis = new Float64Array(markCount * termCount);
    map.marks.forEach((mark, markIndex) => {
      const rho = Math.hypot(mark.u, mark.v);
      const theta = Math.atan2(mark.v, mark.u);
      activeTerms.forEach((termSetting, termIndex) => {
        const term = ASC.zernike.termByFringe(termSetting.fringeIndex);
        basis[markIndex * termCount + termIndex] = ASC.zernike.evaluateTerm(term, rho, theta, settings.normalization);
      });
    });
    const scanSign = map.marks.map((mark) => (map.shots[mark.shotIndex].scan === C.SCAN_UP ? 1 : -1));

    const trendRandom = M.createRandom(M.deriveSeed(settings.seed, STREAM_TREND));
    const noiseRandom = M.createRandom(M.deriveSeed(settings.seed, STREAM_NOISE));
    const scanRandom = M.createRandom(M.deriveSeed(settings.seed, STREAM_SCAN));

    const truthX = new Float64Array(waferCount * markCount);
    const truthY = new Float64Array(waferCount * markCount);
    const noiseX = new Float64Array(waferCount * markCount);
    const noiseY = new Float64Array(waferCount * markCount);
    const coefficientsX = new Float64Array(waferCount * termCount);
    const coefficientsY = new Float64Array(waferCount * termCount);
    const scanOffsetsX = new Float64Array(waferCount);
    const scanOffsetsY = new Float64Array(waferCount);

    for (let wafer = 0; wafer < waferCount; wafer++) {
      for (let k = 0; k < termCount; k++) {
        coefficientsX[wafer * termCount + k] = drawValue(trendRandom, settings.distribution, activeTerms[k].xValue);
        coefficientsY[wafer * termCount + k] = drawValue(trendRandom, settings.distribution, activeTerms[k].yValue);
      }
      const scanOffsetX = drawValue(scanRandom, settings.distribution, settings.scanOffsetXnm);
      const scanOffsetY = drawValue(scanRandom, settings.distribution, settings.scanOffsetYnm);
      scanOffsetsX[wafer] = scanOffsetX;
      scanOffsetsY[wafer] = scanOffsetY;

      for (let i = 0; i < markCount; i++) {
        let sumX = 0;
        let sumY = 0;
        for (let k = 0; k < termCount; k++) {
          const value = basis[i * termCount + k];
          sumX += value * coefficientsX[wafer * termCount + k];
          sumY += value * coefficientsY[wafer * termCount + k];
        }
        const offset = wafer * markCount + i;
        truthX[offset] = sumX + scanSign[i] * scanOffsetX;
        truthY[offset] = sumY + scanSign[i] * scanOffsetY;
        noiseX[offset] = settings.noiseSigmaXnm * noiseRandom.normal();
        noiseY[offset] = settings.noiseSigmaYnm * noiseRandom.normal();
      }
    }

    return {
      data: {
        waferCount,
        markCount,
        truthX,
        truthY,
        noiseX,
        noiseY,
        fringeIndices: activeTerms.map((term) => term.fringeIndex),
        coefficientsX,
        coefficientsY,
        // 成分に分けて確かめるための材料（Markごとの各項の値、Scanの符号、Waferごとの Scan のずれ）
        basis,
        scanSign,
        scanOffsetsX,
        scanOffsetsY,
      },
      errors: [],
    };
  }

  /**
   * 1枚のWaferのずれを成分に分ける（評価データの確認用。評価の計算には使わない）。
   *   low: 5次以下のZernike項の和（5次までの多項式21項で正確に表せる）、high: 6次以上のZernike項の和、
   *   scan: Scan方向のずれ、truth: 真のずれ（low + high + scan）、noise: 計測ノイズ、measured: 計測値（真のずれ＋ノイズ）
   * それぞれ { x, y }（Mark数の Float64Array）。wafer は0始まり。
   */
  function waferComponents(data, wafer) {
    const markCount = data.markCount;
    const termCount = data.fringeIndices.length;
    const expressible = data.fringeIndices.map((fringe) => ASC.zernike.termByFringe(fringe).polynomialExpressible);
    const result = {};
    for (const component of COMPONENTS) {
      result[component.key] = { x: new Float64Array(markCount), y: new Float64Array(markCount) };
    }
    for (let i = 0; i < markCount; i++) {
      for (let k = 0; k < termCount; k++) {
        const value = data.basis[i * termCount + k];
        const target = expressible[k] ? result.low : result.high;
        target.x[i] += value * data.coefficientsX[wafer * termCount + k];
        target.y[i] += value * data.coefficientsY[wafer * termCount + k];
      }
      const offset = wafer * markCount + i;
      result.scan.x[i] = data.scanSign[i] * data.scanOffsetsX[wafer];
      result.scan.y[i] = data.scanSign[i] * data.scanOffsetsY[wafer];
      result.truth.x[i] = data.truthX[offset];
      result.truth.y[i] = data.truthY[offset];
      result.noise.x[i] = data.noiseX[offset];
      result.noise.y[i] = data.noiseY[offset];
      result.measured.x[i] = data.truthX[offset] + data.noiseX[offset];
      result.measured.y[i] = data.truthY[offset] + data.noiseY[offset];
    }
    return result;
  }

  ASC.evaluationData = { defaultTermSettings, generateEvaluationData, waferComponents, COMPONENTS, MAX_WAFER_COUNT };
})(typeof window !== "undefined" ? window : globalThis);
