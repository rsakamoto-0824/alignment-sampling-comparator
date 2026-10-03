/**
 * 補正モデル（HOWA多項式とRBF）と、3つの補正の流れ。
 *
 * どの流れも「計測値（n点）→ 全Mark（M点）の補正量」は線形の計算になる。
 * そこで、選んだ点ごとに M×n の行列（補正の演算子 P）を一度だけ作り、
 * 全Waferに同じ P を掛けて補正量を求める。
 *   補正量 = P × 計測値、残差 = 真のずれ − 補正量
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

  // ---- RBF ---------------------------------------------------------------

  /** RBFの基底関数。r は正規化座標での距離、shape は幅。 */
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

  /** 計測点の最近傍距離の平均（正規化座標）。ガウスなどの幅の基準にする。 */
  function meanNearestDistance(marks, markIndices) {
    if (markIndices.length < 2) {
      return 1;
    }
    let sum = 0;
    for (const i of markIndices) {
      let nearest = Infinity;
      for (const j of markIndices) {
        if (i !== j) {
          nearest = Math.min(nearest, Math.hypot(marks[i].u - marks[j].u, marks[i].v - marks[j].v));
        }
      }
      sum += nearest;
    }
    return sum / markIndices.length;
  }

  /**
   * RBF補間の演算子 G（全Mark数×計測点数）。
   * 補間関数 f(p) = a0 + a1·u + a2·v + Σ wᵢ φ(|p − pᵢ|)（US20120218533A1 と同じ形）。
   * 緩和パラメータ λ は基底の値の大きさで割った無次元の値として扱い、座標の単位に左右されないようにする。
   */
  function rbfOperator(marks, sampleIndices, rbfSettings) {
    const n = sampleIndices.length;
    const size = n + 3;
    const shape = Math.max(rbfSettings.shapeFactor, 1e-6) * meanNearestDistance(marks, sampleIndices);
    const system = new Float64Array(size * size);

    let absoluteSum = 0;
    for (let i = 0; i < n; i++) {
      const pi = marks[sampleIndices[i]];
      for (let j = 0; j < n; j++) {
        const pj = marks[sampleIndices[j]];
        const value = kernelValue(rbfSettings.kernel, Math.hypot(pi.u - pj.u, pi.v - pj.v), shape);
        system[i * size + j] = value;
        if (i !== j) {
          absoluteSum += Math.abs(value);
        }
      }
      system[i * size + n] = 1;
      system[i * size + n + 1] = pi.u;
      system[i * size + n + 2] = pi.v;
      system[n * size + i] = 1;
      system[(n + 1) * size + i] = pi.u;
      system[(n + 2) * size + i] = pi.v;
    }
    const kernelScale = n > 1 ? absoluteSum / (n * (n - 1)) : 1;
    for (let i = 0; i < n; i++) {
      system[i * size + i] += rbfSettings.lambda * kernelScale;
    }

    const decomposition = M.luDecompose(system, size);
    if (!decomposition) {
      return { operator: null, error: "RBFの連立方程式が解けません。計測点が3点未満か、一直線に並んでいる可能性があります。" };
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
      const point = marks[a];
      for (let j = 0; j < n; j++) {
        const sample = marks[sampleIndices[j]];
        kernelRow[j] = kernelValue(rbfSettings.kernel, Math.hypot(point.u - sample.u, point.v - sample.v), shape);
      }
      kernelRow[n] = 1;
      kernelRow[n + 1] = point.u;
      kernelRow[n + 2] = point.v;
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

  // ---- 3つの補正の流れ ---------------------------------------------------

  /**
   * 1つの軸（XかY）の補正の演算子を流れごとに作る。
   * context: { marks, sampleIndices, termIndices, allDesign, rbf（RBF演算子 or null）, flows }
   */
  function buildAxisOperators(context) {
    const { marks, sampleIndices, termIndices, allDesign, rbf, flows } = context;
    const markCount = marks.length;
    const n = sampleIndices.length;
    const p = termIndices.length;
    const warnings = [];
    const operators = {};

    const sampleDesign = polynomialDesign(marks, sampleIndices, termIndices);
    const leastSquares = leastSquaresOperator(sampleDesign, n, p);
    if (leastSquares.rankDeficient) {
      warnings.push(`計測点（${n}点）に対して多項式の項（${p}項）が多すぎるか、点の並びが偏っています。`);
    }
    // HOWAのみ: P = X_all · B
    const howa = M.multiply(allDesign, markCount, p, leastSquares.operator, n);
    if (flows.howa) {
      operators.howa = howa;
    }

    if (flows.rbfThenHowa && rbf) {
      // 計測したMarkは計測値、未計測のMarkはRBFの推定値を使う行列 E を作る
      const estimate = Float64Array.from(rbf);
      sampleIndices.forEach((markIndex, j) => {
        const offset = markIndex * n;
        estimate.fill(0, offset, offset + n);
        estimate[offset + j] = 1;
      });
      const allLeastSquares = leastSquaresOperator(allDesign, markCount, p);
      const coefficients = M.multiply(allLeastSquares.operator, p, markCount, estimate, n);
      operators.rbfThenHowa = M.multiply(allDesign, markCount, p, coefficients, n);
      if (allLeastSquares.rankDeficient) {
        warnings.push("全Markの数が多項式の項数より少ないため、RBF→HOWAの結果は不安定です。");
      }
    }

    if (flows.howaPlusRbf && rbf) {
      // HOWA＋RBF: P = P_howa + G (I − H_s)。H_s は計測点での多項式の当てはめ値
      const fitted = M.multiply(sampleDesign, n, p, leastSquares.operator, n);
      const combined = Float64Array.from(howa);
      for (let a = 0; a < markCount; a++) {
        const rowOffset = a * n;
        for (let k = 0; k < n; k++) {
          const g = rbf[rowOffset + k];
          if (g === 0) {
            continue;
          }
          combined[rowOffset + k] += g;
          const fittedOffset = k * n;
          for (let j = 0; j < n; j++) {
            combined[rowOffset + j] -= g * fitted[fittedOffset + j];
          }
        }
      }
      operators.howaPlusRbf = combined;
    }
    return { operators, warnings };
  }

  ASC.correction = {
    POLYNOMIAL_TERMS,
    polynomialDesign,
    leastSquaresOperator,
    kernelValue,
    rbfOperator,
    buildAxisOperators,
  };
})(typeof window !== "undefined" ? window : globalThis);
