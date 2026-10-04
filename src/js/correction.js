/**
 * 補正モデル（HOWA多項式）と、未計測Markを推定する手法（RBF・ガウス過程回帰）、補正の流れ。
 *
 * 補正の流れ:
 *   HOWAのみ     計測したMarkに多項式を当てはめる
 *   推定→HOWA    未計測Markのずれを推定して全Markを埋め、全Markに多項式を当てはめる（補正量は多項式だけ）
 *   HOWA＋推定   多項式で補正し、計測Markでの取り残しを推定手法で全Markに広げて足す
 * HOWAとRBFは「計測値（n点）→ 全Mark（M点）の補正量」が線形なので、選んだ点ごとに M×n の行列を
 * 1回だけ作り、全Waferに掛ける。ガウス過程回帰はWaferごとに調整値を学習するので、Waferごとに計算する。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const M = ASC.math;

  /** 5次までの多項式の21項。並びは次数の低い順、同じ次数では x の次数の高い順。 */
  const POLYNOMIAL_TERMS = (function () {
    const terms = [];
    for (let order = 0; order <= C.MAX_POLYNOMIAL_ORDER; order++) {
      for (let powerY = 0; powerY <= order; powerY++) {
        const powerX = order - powerY;
        terms.push({ powerX, powerY, order, label: monomialLabel(powerX, powerY) });
      }
    }
    return terms;
  })();

  function monomialLabel(powerX, powerY) {
    const superscripts = ["", "", "²", "³", "⁴", "⁵"];
    if (powerX === 0 && powerY === 0) {
      return "1";
    }
    const xPart = powerX === 0 ? "" : "x" + superscripts[powerX];
    const yPart = powerY === 0 ? "" : "y" + superscripts[powerY];
    return xPart + yPart;
  }

  /**
   * 指定したMarkでの多項式の値の表（行=Mark、列=項）。座標は正規化座標 u, v を使う。
   */
  function polynomialDesign(marks, markIndices, termIndices) {
    const rows = markIndices.length;
    const cols = termIndices.length;
    const design = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      const mark = marks[markIndices[r]];
      for (let c = 0; c < cols; c++) {
        const term = POLYNOMIAL_TERMS[termIndices[c]];
        design[r * cols + c] = Math.pow(mark.u, term.powerX) * Math.pow(mark.v, term.powerY);
      }
    }
    return design;
  }

  /**
   * 最小二乗の係数を求める行列 B = (XᵀX)⁻¹Xᵀ（項数×点数）。
   * 点が項数より少ないなど XᵀX が正則でないときは、小さな値を足して解き、rankDeficient で知らせる。
   */
  function leastSquaresOperator(design, rows, cols) {
    const normal = M.gram(design, rows, cols);
    let trace = 0;
    for (let i = 0; i < cols; i++) {
      trace += normal[i * cols + i];
    }
    let lower = rows >= cols ? M.cholesky(normal, cols) : null;
    let rankDeficient = false;
    if (!lower || conditionTooLarge(lower, cols)) {
      rankDeficient = true;
      const ridge = Math.max(trace / cols, 1) * C.LEAST_SQUARES_RIDGE;
      for (let i = 0; i < cols; i++) {
        normal[i * cols + i] += ridge;
      }
      lower = M.cholesky(normal, cols);
    }
    // Xᵀ（項数×点数）を作って解く
    const designTransposed = new Float64Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        designTransposed[c * rows + r] = design[r * cols + c];
      }
    }
    return { operator: M.choleskySolve(lower, cols, designTransposed, rows), rankDeficient };
  }

  /** コレスキー因子の対角の比が大きすぎる（ほぼ特異）かどうか。 */
  function conditionTooLarge(lower, size) {
    let minimum = Infinity;
    let maximum = 0;
    for (let i = 0; i < size; i++) {
      const value = lower[i * size + i];
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    return minimum / maximum < 1e-7;
  }


  // ---- 説明変数 -----------------------------------------------------------

  /** 推定手法の説明変数。xy は (u, v)、xyr は (u, v, 半径)。どれも正規化座標（1 = 150 mm）。 */
  function featureVector(mark, features) {
    if (features === "xyr") {
      return [mark.u, mark.v, Math.hypot(mark.u, mark.v)];
    }
    return [mark.u, mark.v];
  }

  function featureDistance(left, right) {
    let sum = 0;
    for (let i = 0; i < left.length; i++) {
      sum += (left[i] - right[i]) * (left[i] - right[i]);
    }
    return Math.sqrt(sum);
  }

  /** 計測点どうしの最近傍距離の平均（説明変数の空間）。RBFの幅の基準にする。 */
  function meanNearestDistance(points) {
    if (points.length < 2) {
      return 1;
    }
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      let nearest = Infinity;
      for (let j = 0; j < points.length; j++) {
        if (i !== j) {
          nearest = Math.min(nearest, featureDistance(points[i], points[j]));
        }
      }
      sum += nearest;
    }
    return sum / points.length;
  }

  // ---- RBF ---------------------------------------------------------------

  /** RBFの基底関数。r は説明変数の空間での距離、shape は幅。 */
  function kernelValue(kernel, r, shape) {
    switch (kernel) {
      case "gaussian":
        return Math.exp(-(r / shape) * (r / shape));
      case "multiquadric":
        return Math.sqrt(1 + (r / shape) * (r / shape));
      case "inverseQuadric":
        return 1 / (1 + (r / shape) * (r / shape));
      default:
        // 薄板スプライン。r = 0 では 0（極限値）
        return r > 0 ? r * r * Math.log(r) : 0;
    }
  }

  /**
   * RBF補間の演算子 G（全Mark数×計測点数）。
   * 補間関数 f(p) = a₀ + Σ aₖ·pₖ + Σ wⱼ φ(|p − pⱼ|)。p は説明変数（X,Y または X,Y,半径）。
   * X,Y のときは US20120218533A1 の「1次多項式＋RBF」と同じ形になる。
   * 緩和パラメータ λ は基底の値の大きさを掛けて使い、座標の単位や点の密度に左右されないようにする。
   */
  function rbfOperator(marks, sampleIndices, rbfSettings, features) {
    const n = sampleIndices.length;
    const samplePoints = sampleIndices.map((index) => featureVector(marks[index], features));
    const dimension = samplePoints.length > 0 ? samplePoints[0].length : 2;
    const polynomialSize = 1 + dimension;
    const size = n + polynomialSize;
    const shape = Math.max(rbfSettings.shapeFactor, 1e-6) * meanNearestDistance(samplePoints);
    const system = new Float64Array(size * size);

    let absoluteSum = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const value = kernelValue(rbfSettings.kernel, featureDistance(samplePoints[i], samplePoints[j]), shape);
        system[i * size + j] = value;
        if (i !== j) {
          absoluteSum += Math.abs(value);
        }
      }
      const basis = [1].concat(samplePoints[i]);
      for (let k = 0; k < polynomialSize; k++) {
        system[i * size + n + k] = basis[k];
        system[(n + k) * size + i] = basis[k];
      }
    }
    const kernelScale = n > 1 ? absoluteSum / (n * (n - 1)) : 1;
    for (let i = 0; i < n; i++) {
      system[i * size + i] += rbfSettings.lambda * kernelScale;
    }

    const decomposition = M.luDecompose(system, size);
    if (!decomposition) {
      return { operator: null, error: "RBFの連立方程式が解けません。計測点が少なすぎるか、一直線に並んでいる可能性があります。" };
    }
    // 右辺 [I; 0] を解くと、計測値から重み w と多項式の係数 a を求める行列になる
    const rightHandSide = new Float64Array(size * n);
    for (let i = 0; i < n; i++) {
      rightHandSide[i * n + i] = 1;
    }
    const weights = M.luSolve(decomposition, rightHandSide, n);

    const markCount = marks.length;
    const operator = new Float64Array(markCount * n);
    const kernelRow = new Float64Array(size);
    for (let a = 0; a < markCount; a++) {
      const point = featureVector(marks[a], features);
      for (let j = 0; j < n; j++) {
        kernelRow[j] = kernelValue(rbfSettings.kernel, featureDistance(point, samplePoints[j]), shape);
      }
      const basis = [1].concat(point);
      for (let k = 0; k < polynomialSize; k++) {
        kernelRow[n + k] = basis[k];
      }
      const rowOffset = a * n;
      for (let k = 0; k < size; k++) {
        const value = kernelRow[k];
        if (value === 0) {
          continue;
        }
        const weightOffset = k * n;
        for (let j = 0; j < n; j++) {
          operator[rowOffset + j] += value * weights[weightOffset + j];
        }
      }
    }
    return { operator, error: null };
  }

  // ---- ガウス過程回帰 ------------------------------------------------------

  /** ガウス過程回帰の共分散関数（信号の分散を1としたもの）。d は説明変数の空間での距離、length は相関の長さ。 */
  function gpKernelValue(kernel, d, length) {
    if (kernel === "matern52") {
      const scaled = (Math.sqrt(5) * d) / length;
      return (1 + scaled + (scaled * scaled) / 3) * Math.exp(-scaled);
    }
    return Math.exp(-(d * d) / (2 * length * length));
  }

  /** 対数で等間隔の値の一覧。 */
  function logSpace(minimum, maximum, steps) {
    if (steps <= 1) {
      return [minimum];
    }
    const values = [];
    for (let i = 0; i < steps; i++) {
      values.push(minimum * Math.pow(maximum / minimum, i / (steps - 1)));
    }
    return values;
  }

  /**
   * ガウス過程回帰の前準備（選んだ点ごとに1回）。
   * 平均は説明変数の1次式（定数＋X,Y［＋半径］）とし、最小二乗で先に取り除く。
   * 相関の長さの候補ごとに、計測点どうしの共分散行列を固有値分解しておく。
   * これで、Waferごとにノイズ比と信号の分散を選び直す計算が、行列を解き直さずに済む。
   */
  function prepareGp(marks, sampleIndices, features, kernel) {
    const n = sampleIndices.length;
    const samplePoints = sampleIndices.map((index) => featureVector(marks[index], features));
    const allPoints = marks.map((mark) => featureVector(mark, features));
    const trendSize = 1 + (samplePoints.length > 0 ? samplePoints[0].length : 2);
    if (n < trendSize + 2) {
      return { error: `ガウス過程回帰には計測点が${trendSize + 2}点以上必要です。` };
    }
    const toTrendRows = (points) => {
      const rows = new Float64Array(points.length * trendSize);
      points.forEach((point, index) => {
        rows[index * trendSize] = 1;
        point.forEach((value, k) => {
          rows[index * trendSize + 1 + k] = value;
        });
      });
      return rows;
    };
    const trendSample = toTrendRows(samplePoints);
    const trendAll = toTrendRows(allPoints);
    const trendFit = leastSquaresOperator(trendSample, n, trendSize);
    const noiseRatios = logSpace(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS);

    const scales = logSpace(C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_MAX, C.GP_LENGTH_SCALE_STEPS).map((length) => {
      const covariance = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = i; j < n; j++) {
          const value = gpKernelValue(kernel, featureDistance(samplePoints[i], samplePoints[j]), length);
          covariance[i * n + j] = value;
          covariance[j * n + i] = value;
        }
      }
      const eigen = M.symmetricEigen(covariance, n);
      // 丸め誤差で負になった固有値は0にそろえる（共分散行列は本来、半正定値）
      for (let i = 0; i < n; i++) {
        eigen.values[i] = Math.max(eigen.values[i], 0);
      }
      // Waferによらない部分（1/(λ+α) と log det）は、ノイズ比の候補ごとに先に求めておく
      const candidates = noiseRatios.map((ratio) => {
        const inverse = new Float64Array(n);
        let logDeterminant = 0;
        for (let i = 0; i < n; i++) {
          inverse[i] = 1 / (eigen.values[i] + ratio);
          logDeterminant += Math.log(eigen.values[i] + ratio);
        }
        return { ratio, inverse, logDeterminant };
      });
      // 固有ベクトルを行に並べ替えて持つ（射影の計算でメモリを連続して読むため）
      const rows = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          rows[i * n + j] = eigen.vectors[j * n + i];
        }
      }
      return { length, values: eigen.values, rows, candidates, cross: null };
    });

    return {
      error: null,
      kernel,
      n,
      markCount: marks.length,
      samplePoints,
      allPoints,
      trendSize,
      trendAll,
      trendOperator: trendFit.operator,
      scales,
    };
  }

  /** 全Markと計測点の共分散（Mark数×計測点数）。使われた相関の長さの分だけ、必要になったときに作る。 */
  function crossCovariance(prepared, scale) {
    if (!scale.cross) {
      const n = prepared.n;
      const cross = new Float64Array(prepared.markCount * n);
      for (let a = 0; a < prepared.markCount; a++) {
        for (let j = 0; j < n; j++) {
          cross[a * n + j] = gpKernelValue(prepared.kernel, featureDistance(prepared.allPoints[a], prepared.samplePoints[j]), scale.length);
        }
      }
      scale.cross = cross;
    }
    return scale.cross;
  }

  /**
   * 1枚のWaferの計測値にガウス過程回帰を当てはめる（学習）。
   * 調整値（相関の長さ・ノイズ比）は、このWaferの計測点での周辺尤度が最大になるものを候補から選ぶ。
   * 信号の分散は周辺尤度を最大にする値が式で求まるので、探索しない。
   * 戻り値: { trend（1次式の係数）, weights（(K+αI)⁻¹r、残りがなければ null）, scale, scaleIndex, length, noiseRatio }
   */
  function gpFit(prepared, measured) {
    const { n, trendSize, scales } = prepared;
    // 1次式の平均を取り除く
    const trend = new Float64Array(trendSize);
    for (let k = 0; k < trendSize; k++) {
      let sum = 0;
      const offset = k * n;
      for (let j = 0; j < n; j++) {
        sum += prepared.trendOperator[offset + j] * measured[j];
      }
      trend[k] = sum;
    }
    const residual = new Float64Array(n);
    for (let j = 0; j < n; j++) {
      residual[j] = measured[j] - trendValue(prepared.samplePoints[j], trend);
    }

    // 固有ベクトルの向きに分けた残り z = Vᵀ r で、周辺尤度を候補ごとに比べる
    let best = null;
    const projected = new Float64Array(n);
    const squared = new Float64Array(n);
    for (let scaleIndex = 0; scaleIndex < scales.length; scaleIndex++) {
      const scale = scales[scaleIndex];
      projectOnto(scale.rows, residual, projected, n);
      for (let i = 0; i < n; i++) {
        squared[i] = projected[i] * projected[i];
      }
      for (const candidate of scale.candidates) {
        let quadratic = 0;
        for (let i = 0; i < n; i++) {
          quadratic += squared[i] * candidate.inverse[i];
        }
        if (!(quadratic > 1e-300)) {
          // 1次式で完全に表せる（残りが0）。どの候補でも推定は1次式だけになる
          return { trend, weights: null, scale: null, scaleIndex: -1, length: NaN, noiseRatio: NaN };
        }
        const logLikelihood = -0.5 * n * Math.log(quadratic / n) - 0.5 * candidate.logDeterminant;
        if (!best || M.isClearlyGreater(logLikelihood, best.logLikelihood, C.TIE_TOLERANCE)) {
          best = { logLikelihood, scaleIndex, candidate };
        }
      }
    }

    // (K + αI)⁻¹ r を固有値分解から作る: V diag(1/(λ+α)) Vᵀ r
    const scale = scales[best.scaleIndex];
    projectOnto(scale.rows, residual, projected, n);
    const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const scaled = projected[i] * best.candidate.inverse[i];
      const offset = i * n;
      for (let j = 0; j < n; j++) {
        weights[j] += scale.rows[offset + j] * scaled;
      }
    }
    return { trend, weights, scale, scaleIndex: best.scaleIndex, length: scale.length, noiseRatio: best.candidate.ratio };
  }

  /** 学習結果から全Markの推定値（事後平均 = 1次式 + K*·weights）を求める。 */
  function gpPredictAll(prepared, fit) {
    const values = trendOnly(prepared, fit.trend);
    if (!fit.weights) {
      return values;
    }
    const n = prepared.n;
    const cross = crossCovariance(prepared, fit.scale);
    for (let a = 0; a < prepared.markCount; a++) {
      let sum = 0;
      const offset = a * n;
      for (let j = 0; j < n; j++) {
        sum += cross[offset + j] * fit.weights[j];
      }
      values[a] += sum;
    }
    return values;
  }

  /** 1枚のWaferの計測値から、全Markのずれを推定する（学習と推定をまとめたもの）。 */
  function gpPredict(prepared, measured) {
    const fit = gpFit(prepared, measured);
    return { values: gpPredictAll(prepared, fit), length: fit.length, noiseRatio: fit.noiseRatio };
  }

  /**
   * 推定→HOWA を速く計算するための前計算（選んだ点・推定手法・多項式の項ごと）。
   * 全Markの値 f から多項式の係数を求める B_all f を、計測Mark（S）と未計測Mark（U）に分けると
   *   係数 = B_S y + (B_U T_U) β + (B_U K*_U) w
   * になる（y は計測値、β は1次式の係数、w = (K+αI)⁻¹r）。B_U K*_U は相関の長さごとに必要になったときに作る。
   */
  function gpHowaProjector(prepared, howaParts, sampleIndices) {
    const p = howaParts.p;
    const markCount = prepared.markCount;
    const n = prepared.n;
    const q = prepared.trendSize;
    const measuredSet = new Set(sampleIndices);
    const unmeasured = [];
    for (let i = 0; i < markCount; i++) {
      if (!measuredSet.has(i)) {
        unmeasured.push(i);
      }
    }
    const allLeastSquares = howaParts.allLeastSquares;
    const sampleColumns = new Float64Array(p * n);
    const trendColumns = new Float64Array(p * q);
    for (let k = 0; k < p; k++) {
      const offset = k * markCount;
      sampleIndices.forEach((markIndex, j) => {
        sampleColumns[k * n + j] = allLeastSquares[offset + markIndex];
      });
      for (const markIndex of unmeasured) {
        const coefficient = allLeastSquares[offset + markIndex];
        for (let t = 0; t < q; t++) {
          trendColumns[k * q + t] += coefficient * prepared.trendAll[markIndex * q + t];
        }
      }
    }
    return { p, n, q, unmeasured, allLeastSquares, markCount, sampleColumns, trendColumns, crossColumns: new Map() };
  }

  /** 推定→HOWA の多項式の係数（長さ p）を、全Markの推定値を作らずに求める。 */
  function gpThenHowaCoefficients(prepared, projector, fit, measured, output) {
    const { p, n, q } = projector;
    let crossColumns = null;
    if (fit.weights) {
      crossColumns = projector.crossColumns.get(fit.scaleIndex);
      if (!crossColumns) {
        const cross = crossCovariance(prepared, fit.scale);
        crossColumns = new Float64Array(p * n);
        for (let k = 0; k < p; k++) {
          const offset = k * projector.markCount;
          for (const markIndex of projector.unmeasured) {
            const coefficient = projector.allLeastSquares[offset + markIndex];
            const crossOffset = markIndex * n;
            for (let j = 0; j < n; j++) {
              crossColumns[k * n + j] += coefficient * cross[crossOffset + j];
            }
          }
        }
        projector.crossColumns.set(fit.scaleIndex, crossColumns);
      }
    }
    for (let k = 0; k < p; k++) {
      let sum = 0;
      for (let j = 0; j < n; j++) {
        sum += projector.sampleColumns[k * n + j] * measured[j];
      }
      for (let t = 0; t < q; t++) {
        sum += projector.trendColumns[k * q + t] * fit.trend[t];
      }
      if (crossColumns) {
        for (let j = 0; j < n; j++) {
          sum += crossColumns[k * n + j] * fit.weights[j];
        }
      }
      output[k] = sum;
    }
    return output;
  }

  function trendValue(point, coefficients) {
    let value = coefficients[0];
    for (let k = 0; k < point.length; k++) {
      value += coefficients[k + 1] * point[k];
    }
    return value;
  }

  function trendOnly(prepared, coefficients) {
    const values = new Float64Array(prepared.markCount);
    for (let a = 0; a < prepared.markCount; a++) {
      values[a] = trendValue(prepared.allPoints[a], coefficients);
    }
    return values;
  }

  /** z = Vᵀ r（rows は固有ベクトルを行に並べたもの）。 */
  function projectOnto(rows, residual, output, n) {
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const offset = i * n;
      for (let j = 0; j < n; j++) {
        sum += rows[offset + j] * residual[j];
      }
      output[i] = sum;
    }
  }

  // ---- 補正の流れ ----------------------------------------------------------

  /**
   * 比べる補正の一覧（HOWAのみ ＋ 補正の流れ × 推定手法）。結果の表やグラフの並び順にもなる。
   * key は "howa" または "流れ:推定手法"（例 "estimateThenHowa:gpXY"）。
   */
  function buildVariants(modelSettings) {
    const variants = [];
    if (modelSettings.flows.howa) {
      variants.push({ key: "howa", flowType: "howa", estimator: null, label: "HOWAのみ" });
    }
    for (const flow of C.FLOW_TYPES) {
      if (flow.key === "howa" || !modelSettings.flows[flow.key]) {
        continue;
      }
      for (const estimator of C.ESTIMATORS) {
        if (!modelSettings.estimators[estimator.key]) {
          continue;
        }
        const label = flow.key === "estimateThenHowa" ? `${estimator.label}→HOWA` : `HOWA＋${estimator.label}`;
        variants.push({ key: `${flow.key}:${estimator.key}`, flowType: flow.key, estimator, label });
      }
    }
    return variants;
  }

  /**
   * 1つの軸（XかY）のHOWAの部品。
   *   howa: 計測値 → 全Markの補正量（M×n）
   *   fitted: 計測値 → 計測点での当てはめ値（n×n）
   *   allLeastSquares: 全Markの値 → 多項式の係数（p×M。推定→HOWA で使う）
   */
  function prepareHowa(marks, sampleIndices, termIndices, allDesign, allLeastSquares) {
    const markCount = marks.length;
    const n = sampleIndices.length;
    const p = termIndices.length;
    const warnings = [];
    const sampleDesign = polynomialDesign(marks, sampleIndices, termIndices);
    const leastSquares = leastSquaresOperator(sampleDesign, n, p);
    if (leastSquares.rankDeficient) {
      warnings.push(`計測点（${n}点）に対して多項式の項（${p}項）が多すぎるか、点の並びが偏っています。`);
    }
    if (allLeastSquares.rankDeficient) {
      warnings.push("全Markの数が多項式の項数より少ないため、推定→HOWAの結果は不安定です。");
    }
    return {
      p,
      allDesign,
      allLeastSquares: allLeastSquares.operator,
      howa: M.multiply(allDesign, markCount, p, leastSquares.operator, n),
      fitted: M.multiply(sampleDesign, n, p, leastSquares.operator, n),
      warnings,
    };
  }

  /**
   * 線形の推定手法（RBF）を使う流れの演算子（M×n）。
   *   推定→HOWA: X_all B_all E（E は計測Markの行が単位行列、未計測Markの行が推定）
   *   HOWA＋推定: P_howa + G (I − H_s)
   */
  function linearFlowOperator(howaParts, estimate, sampleIndices, flowType, markCount) {
    const n = sampleIndices.length;
    const p = howaParts.p;
    if (flowType === "estimateThenHowa") {
      const filled = Float64Array.from(estimate);
      sampleIndices.forEach((markIndex, j) => {
        const offset = markIndex * n;
        filled.fill(0, offset, offset + n);
        filled[offset + j] = 1;
      });
      const coefficients = M.multiply(howaParts.allLeastSquares, p, markCount, filled, n);
      return M.multiply(howaParts.allDesign, markCount, p, coefficients, n);
    }
    const combined = Float64Array.from(howaParts.howa);
    for (let a = 0; a < markCount; a++) {
      const rowOffset = a * n;
      for (let k = 0; k < n; k++) {
        const g = estimate[rowOffset + k];
        if (g === 0) {
          continue;
        }
        combined[rowOffset + k] += g;
        const fittedOffset = k * n;
        for (let j = 0; j < n; j++) {
          combined[rowOffset + j] -= g * howaParts.fitted[fittedOffset + j];
        }
      }
    }
    return combined;
  }

  ASC.correction = {
    POLYNOMIAL_TERMS,
    polynomialDesign,
    leastSquaresOperator,
    featureVector,
    kernelValue,
    rbfOperator,
    gpKernelValue,
    prepareGp,
    gpFit,
    gpPredictAll,
    gpPredict,
    gpHowaProjector,
    gpThenHowaCoefficients,
    buildVariants,
    prepareHowa,
    linearFlowOperator,
  };
})(typeof window !== "undefined" ? window : globalThis);
