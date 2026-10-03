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

    for (let wafer = 0; wafer < waferCount; wafer++) {
      for (let k = 0; k < termCount; k++) {
        coefficientsX[wafer * termCount + k] = drawValue(trendRandom, settings.distribution, activeTerms[k].xValue);
        coefficientsY[wafer * termCount + k] = drawValue(trendRandom, settings.distribution, activeTerms[k].yValue);
      }
      const scanOffsetX = drawValue(scanRandom, settings.distribution, settings.scanOffsetXnm);
      const scanOffsetY = drawValue(scanRandom, settings.distribution, settings.scanOffsetYnm);

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
      },
      errors: [],
    };
  }

  ASC.evaluationData = { defaultTermSettings, generateEvaluationData, MAX_WAFER_COUNT };
})(typeof window !== "undefined" ? window : globalThis);
