/**
 * 補正: 補正値はどれも X,Y の高次多項式（HOWAの項）。違いは多項式の係数の決め方。
 *
 *   HOWA          計測したMarkに最小二乗で当てはめる
 *   RBF（X,Y［,半径］）  計測値を「多項式＋距離の基底関数（RBF）」で表し、その多項式の部分を補正値にする。
 *                 多項式で表せない局所的な成分はRBFの部分が受け持つので、係数がそれに引きずられにくい
 *   GPR（X,Y［,半径］）  平均が多項式のガウス過程回帰。点どうしの空間のつながり（共分散）を考えた
 *                 一般化最小二乗で係数を決める（点が固まった場所の重みが下がる）。調整値はWaferごとに学習する
 *   計測値＋HOWA   測ったMarkは計測値そのものを補正値にし、測っていないMarkだけHOWAの多項式で補正する
 * RBF・GPRの係数の決め方は2通りある（設定で選んで並べる）:
 *   式内   上のとおり、RBF・GPRの式の中の多項式をそのまま補正値にする
 *   予測   RBF・GPR（平均は説明変数の1次式）で未計測Markのずれを予測して全Markを埋め、全Markに多項式を
 *          当てはめた係数を補正値にする（全Markの予測値から多項式の係数を決める）
 * HOWA・RBF・計測値＋HOWA は「計測値（n点）→ 全Mark（M点）の補正量」が線形なので、選んだ点ごとに M×n の行列を
 * 1回だけ作り、全Waferに掛ける。GPRはWaferごとに調整値を選ぶので、Waferごとに係数を計算する。
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

  /** RBF・GPRの説明変数。xy は (u, v)、xyr は (u, v, 半径)。どれも正規化座標（1 = 150 mm）。 */
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
   * RBFで多項式の係数を決める行列 C（項数 p × 計測点数 n）。係数 = C × 計測値。
   * 計測値を f(x) = Σ cₖ Pₖ(u, v) + Σ wⱼ φ(|q(x) − q(xⱼ)|) で表す（Pₖ はHOWAの多項式の項、q は説明変数
   * X,Y か X,Y,半径）。条件 Σ wⱼ Pₖ(xⱼ) = 0 のもとで解き、多項式の部分の係数 c だけを補正に使う。
   * 緩和パラメータ λ は基底の値の大きさを掛けて使い、座標の単位や点の密度に左右されないようにする。
   * sampleDesign は計測点での多項式の値（n × p）。
   */
  function rbfPolynomialOperator(marks, sampleIndices, sampleDesign, p, rbfSettings, features) {
    const n = sampleIndices.length;
    if (n < p) {
      return { operator: null, error: `計測点（${n}点）が多項式の項（${p}項）より少ないので、RBFで係数を決められません。` };
    }
    const samplePoints = sampleIndices.map((index) => featureVector(marks[index], features));
    const size = n + p;
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
      for (let k = 0; k < p; k++) {
        system[i * size + n + k] = sampleDesign[i * p + k];
        system[(n + k) * size + i] = sampleDesign[i * p + k];
      }
    }
    const kernelScale = n > 1 ? absoluteSum / (n * (n - 1)) : 1;
    for (let i = 0; i < n; i++) {
      system[i * size + i] += rbfSettings.lambda * kernelScale;
    }
    const decomposition = M.luDecompose(system, size);
    if (!decomposition) {
      return { operator: null, error: "RBFの連立方程式が解けません。計測点が多項式の項に対して偏っている可能性があります。" };
    }
    // 右辺 [I; 0] を解くと、計測値から重み w と係数 c を求める行列になる。c の行（後ろの p 行）だけを使う
    const rightHandSide = new Float64Array(size * n);
    for (let i = 0; i < n; i++) {
      rightHandSide[i * n + i] = 1;
    }
    const solution = M.luSolve(decomposition, rightHandSide, n);
    return { operator: solution.slice(n * n, size * n), error: null };
  }

  /**
   * RBF補間の演算子 G（全Mark数×計測点数）。「予測」で未計測Markのずれを予測するのに使う。
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

  // ---- GPR（ガウス過程回帰）------------------------------------------------

  // QR分解の対角の比がこれより小さければ、係数が決まらない（点が偏っている）とみなす
  const GPR_RANK_TOLERANCE = 1e-10;

  /** GPRの共分散関数（信号の分散を1としたもの）。d は説明変数の空間での距離、length は相関の長さ。 */
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
   * GPRの共分散の前準備（選んだ点・説明変数ごとに1回。多項式の項によらない）。
   * 相関の長さの候補ごとに、計測点どうしの共分散行列 K を固有値分解しておく（K = VΛVᵀ）。
   */
  function prepareGprKernel(marks, sampleIndices, features, kernel) {
    const n = sampleIndices.length;
    const samplePoints = sampleIndices.map((index) => featureVector(marks[index], features));
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
      // 固有ベクトルを行に並べ替えて持つ（Vᵀy の計算でメモリを連続して読むため）
      const rows = new Float64Array(n * n);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          rows[i * n + j] = eigen.vectors[j * n + i];
        }
      }
      return { length, values: eigen.values, rows };
    });
    return { n, scales };
  }

  /**
   * GPRで多項式の係数を決める前準備（選んだ点・説明変数・多項式の項ごとに1回）。
   * モデル: 計測値 y = Pβ + f + ε。f は共分散 σ²K_ℓ のガウス過程、ε はノイズ（分散 σ²α）。
   * 係数は一般化最小二乗 β = (PᵀK⁻¹P)⁻¹PᵀK⁻¹y（K = K_ℓ + αI）。K⁻¹ = V diag(1/(λ+α)) Vᵀ なので、
   * 重み付けした X̃ = diag(1/√(λ+α)) VᵀP の細いQR分解（X̃ = QR）を候補（ℓ, α）ごとに作っておくと、
   * β = R⁻¹ Qᵀ diag(1/√(λ+α)) Vᵀy で求まり、正規方程式を作らないので精度も落ちにくい。
   * QR分解は、Waferで選ばれた候補の分だけ、必要になったときに作る（gprCandidateQr）。
   */
  function prepareGprPolynomial(kernelPart, sampleDesign, p) {
    const n = kernelPart.n;
    if (n < p + 2) {
      return { error: `GPRには、多項式の項（${p}項）より2点以上多い計測点が必要です（今は${n}点）。` };
    }
    const noiseRatios = logSpace(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS);
    const projectedByScale = [];
    const candidates = [];
    kernelPart.scales.forEach((scale, scaleIndex) => {
      // VᵀP（n × p）
      const projected = new Float64Array(n * p);
      for (let i = 0; i < n; i++) {
        const rowOffset = i * n;
        for (let j = 0; j < n; j++) {
          const value = scale.rows[rowOffset + j];
          for (let k = 0; k < p; k++) {
            projected[i * p + k] += value * sampleDesign[j * p + k];
          }
        }
      }
      projectedByScale.push(projected);
      for (const ratio of noiseRatios) {
        const inverse = new Float64Array(n);
        let logDeterminant = 0;
        for (let i = 0; i < n; i++) {
          inverse[i] = 1 / (scale.values[i] + ratio);
          logDeterminant += Math.log(scale.values[i] + ratio);
        }
        candidates.push({ scaleIndex, length: scale.length, ratio, inverse, logDeterminant, qr: null });
      }
    });
    return { error: null, n, p, candidates, projectedByScale };
  }

  /** 候補（ℓ, α）の重み付きの多項式 X̃ の細いQR分解（必要になったときに作り、使い回す）。係数が決まらなければ null。 */
  function gprCandidateQr(prepared, candidate) {
    if (candidate.qr === null) {
      const { n, p } = prepared;
      const projected = prepared.projectedByScale[candidate.scaleIndex];
      const scaleFactors = new Float64Array(n);
      const weighted = new Float64Array(n * p);
      for (let i = 0; i < n; i++) {
        scaleFactors[i] = Math.sqrt(candidate.inverse[i]);
        for (let k = 0; k < p; k++) {
          weighted[i * p + k] = projected[i * p + k] * scaleFactors[i];
        }
      }
      const { q, r } = M.householderQr(weighted, n, p);
      let smallest = Infinity;
      let largest = 0;
      for (let k = 0; k < p; k++) {
        const diagonal = Math.abs(r[k * p + k]);
        smallest = Math.min(smallest, diagonal);
        largest = Math.max(largest, diagonal);
      }
      candidate.qr = smallest > largest * GPR_RANK_TOLERANCE ? { q, r, scaleFactors } : false;
    }
    return candidate.qr || null;
  }

  /**
   * 1枚のWaferの計測値から、GPRで多項式の係数を求める（2段階）。
   *   1. 調整値（相関の長さ ℓ・ノイズ比 α）は、HOWA（最小二乗）の残差 e での周辺尤度
   *      log L = −½ [ n log(eᵀK⁻¹e / n) + log det K ] が最大の候補を選ぶ（信号の分散は式で求まるので探索しない）
   *   2. 選んだ ℓ, α の共分散で、一般化最小二乗の係数を求める
   * olsResidual は計測点でのHOWAの残差、olsCoefficients はHOWAの係数。exactFit が true（計測値が多項式で
   * ほぼ完全に表せる）なら、どの共分散でも係数は同じなので、HOWAの係数をそのまま使う。
   * 戻り値: { coefficients（長さ p）, length（相関の長さ。正規化座標）, noiseRatio }
   */
  function gprFit(kernelPart, prepared, measured, olsResidual, olsCoefficients, exactFit) {
    const { n, p, candidates } = prepared;
    if (exactFit) {
      return { coefficients: Float64Array.from(olsCoefficients), length: NaN, noiseRatio: NaN };
    }
    const scales = kernelPart.scales;
    const projectedResidual = scales.map((scale) => projectRows(scale.rows, olsResidual, n));
    let best = null;
    for (const candidate of candidates) {
      const z = projectedResidual[candidate.scaleIndex];
      let quadratic = 0;
      for (let i = 0; i < n; i++) {
        quadratic += z[i] * z[i] * candidate.inverse[i];
      }
      const logLikelihood = -0.5 * (n * Math.log(quadratic / n) + candidate.logDeterminant);
      if (!best || M.isClearlyGreater(logLikelihood, best.logLikelihood, C.TIE_TOLERANCE)) {
        best = { logLikelihood, candidate };
      }
    }
    const qr = gprCandidateQr(prepared, best.candidate);
    if (!qr) {
      // 選んだ共分散では係数が決まらない（点が偏っている）。HOWAの係数を使う
      return { coefficients: Float64Array.from(olsCoefficients), length: best.candidate.length, noiseRatio: best.candidate.ratio };
    }
    // γ = Qᵀ diag(s) Vᵀy、β = R⁻¹γ（後退代入）
    const z = projectRows(scales[best.candidate.scaleIndex].rows, measured, n);
    const gamma = new Float64Array(p);
    for (let i = 0; i < n; i++) {
      const value = z[i] * qr.scaleFactors[i];
      for (let k = 0; k < p; k++) {
        gamma[k] += qr.q[i * p + k] * value;
      }
    }
    const coefficients = new Float64Array(p);
    for (let k = p - 1; k >= 0; k--) {
      let sum = gamma[k];
      for (let j = k + 1; j < p; j++) {
        sum -= qr.r[k * p + j] * coefficients[j];
      }
      coefficients[k] = sum / qr.r[k * p + k];
    }
    return { coefficients, length: best.candidate.length, noiseRatio: best.candidate.ratio };
  }

  /** Vᵀv（rows は固有ベクトルを行に並べたもの）。 */
  function projectRows(rows, values, n) {
    const output = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const offset = i * n;
      for (let j = 0; j < n; j++) {
        sum += rows[offset + j] * values[j];
      }
      output[i] = sum;
    }
    return output;
  }

  // ---- GPRの予測（「予測」で使う。平均は説明変数の1次式）----------------------

  /**
   * GPRの予測の前準備（選んだ点ごとに1回。「予測」で使う）。
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

  /**
   * 「予測」の多項式の係数を速く計算するための前計算（選んだ点・説明変数・多項式の項ごと）。
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

  /** 「予測」の多項式の係数（長さ p）を、全Markの推定値を作らずに求める。 */
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

  // ---- 補正の一覧と、線形の補正の演算子 --------------------------------------

  /** 比べる補正の一覧（設定で選んだもの。並びは C.CORRECTIONS の順）。結果の表やグラフの並び順にもなる。 */
  function buildVariants(modelSettings) {
    return C.CORRECTIONS.filter((correction) => modelSettings.corrections[correction.key]).map((correction) => ({
      key: correction.key,
      type: correction.type,
      mode: correction.mode,
      family: correction.family,
      features: correction.features,
      label: correction.label,
      longLabel: correction.longLabel,
    }));
  }

  /**
   * 1つの軸（XかY）のHOWAの部品。
   *   sampleDesign: 計測点での多項式の値（n × p）
   *   leastSquares: 計測値 → 係数（p × n）
   *   howa: 計測値 → 全Markの補正量（M × n）
   *   allLeastSquares: 全Markの値 → 係数（p × M。「予測」で使う。渡されたときだけ）
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
    if (allLeastSquares && allLeastSquares.rankDeficient) {
      warnings.push("全Markの数が多項式の項数より少ないため、「予測」の結果は不安定です。");
    }
    return {
      p,
      allDesign,
      allLeastSquares: allLeastSquares ? allLeastSquares.operator : null,
      sampleDesign,
      leastSquares: leastSquares.operator,
      howa: M.multiply(allDesign, markCount, p, leastSquares.operator, n),
      warnings,
    };
  }

  /**
   * 計測値＋HOWA の演算子（M × n）: 測ったMarkの行は計測値そのもの（単位行列の行）、
   * 測っていないMarkの行はHOWAの補正量。
   */
  function measuredOperator(howaOperator, sampleIndices, markCount) {
    const n = sampleIndices.length;
    const operator = Float64Array.from(howaOperator);
    sampleIndices.forEach((markIndex, j) => {
      const offset = markIndex * n;
      operator.fill(0, offset, offset + n);
      operator[offset + j] = 1;
    });
    return operator;
  }

  /**
   * RBFの「予測」の演算子（M×n）: X_all B_all E
   * （E は計測Markの行が単位行列、未計測Markの行がRBFの予測）。
   */
  function estimateThenHowaOperator(howaParts, estimate, sampleIndices, markCount) {
    const n = sampleIndices.length;
    const p = howaParts.p;
    const filled = Float64Array.from(estimate);
    sampleIndices.forEach((markIndex, j) => {
      const offset = markIndex * n;
      filled.fill(0, offset, offset + n);
      filled[offset + j] = 1;
    });
    const coefficients = M.multiply(howaParts.allLeastSquares, p, markCount, filled, n);
    return M.multiply(howaParts.allDesign, markCount, p, coefficients, n);
  }

  ASC.correction = {
    POLYNOMIAL_TERMS,
    polynomialDesign,
    leastSquaresOperator,
    featureVector,
    kernelValue,
    rbfPolynomialOperator,
    rbfOperator,
    gpKernelValue,
    prepareGprKernel,
    prepareGprPolynomial,
    gprFit,
    prepareGp,
    gpFit,
    gpHowaProjector,
    gpThenHowaCoefficients,
    buildVariants,
    prepareHowa,
    measuredOperator,
    estimateThenHowaOperator,
  };
})(typeof window !== "undefined" ? window : globalThis);
