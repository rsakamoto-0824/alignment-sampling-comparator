/**
 * 数値計算の共通処理（乱数・行列・統計）。
 * 画面には依存しない。ブラウザでもNode.js（テスト）でも同じコードを使う。
 *
 * 行列は Float64Array の行優先（row-major）で持ち、行数・列数を別に渡す。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});

  // ---- 乱数 -------------------------------------------------------------

  // 32bit整数の範囲。乱数を [0, 1) に直すときに使う。
  const UINT32_RANGE = 4294967296;

  /**
   * シード付きの乱数を作る（mulberry32）。
   * Math.random はシードを指定できず結果を再現できないため、自前で持つ。
   */
  function createRandom(seed) {
    let state = seed >>> 0 || 1;
    let spareNormal = null;

    function next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    }

    /** 標準正規分布の乱数（Box-Muller法。2つ目の値は次回に使う）。 */
    function normal() {
      if (spareNormal !== null) {
        const value = spareNormal;
        spareNormal = null;
        return value;
      }
      let u1 = next();
      while (u1 <= 0) {
        u1 = next();
      }
      const u2 = next();
      const radius = Math.sqrt(-2 * Math.log(u1));
      spareNormal = radius * Math.sin(2 * Math.PI * u2);
      return radius * Math.cos(2 * Math.PI * u2);
    }

    /** 0以上 count 未満の整数。 */
    function integer(count) {
      return Math.floor(next() * count);
    }

    /** 配列をその場で並べ替える（Fisher-Yates）。 */
    function shuffle(array) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = integer(i + 1);
        const keep = array[i];
        array[i] = array[j];
        array[j] = keep;
      }
      return array;
    }

    /** 重みに比例した確率で添字を1つ選ぶ。重みがすべて0なら -1。 */
    function pickWeighted(weights) {
      let total = 0;
      for (let i = 0; i < weights.length; i++) {
        total += weights[i];
      }
      if (!(total > 0)) {
        return -1;
      }
      let threshold = next() * total;
      for (let i = 0; i < weights.length; i++) {
        threshold -= weights[i];
        if (threshold < 0 && weights[i] > 0) {
          return i;
        }
      }
      // 丸め誤差で最後まで来たときは、重みが正の最後の要素を返す
      for (let i = weights.length - 1; i >= 0; i--) {
        if (weights[i] > 0) {
          return i;
        }
      }
      return -1;
    }

    return { next, normal, integer, shuffle, pickWeighted };
  }

  /**
   * 元のシードと番号から、別の乱数列用のシードを作る。
   * 試行ごとに独立した乱数列を使い、どの試行も単独で再現できるようにする。
   */
  function deriveSeed(seed, index) {
    let hash = (seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b1);
    hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
    hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
    return (hash ^ (hash >>> 16)) >>> 0;
  }

  // ---- 行列 -------------------------------------------------------------

  /** A (rows×inner) と B (inner×cols) の積。 */
  function multiply(a, rows, inner, b, cols) {
    const result = new Float64Array(rows * cols);
    for (let i = 0; i < rows; i++) {
      const rowOffset = i * inner;
      const resultOffset = i * cols;
      for (let k = 0; k < inner; k++) {
        const aik = a[rowOffset + k];
        if (aik === 0) {
          continue;
        }
        const bOffset = k * cols;
        for (let j = 0; j < cols; j++) {
          result[resultOffset + j] += aik * b[bOffset + j];
        }
      }
    }
    return result;
  }

  /** Aᵀ A（A は rows×cols）。情報行列の計算に使う。 */
  function gram(a, rows, cols) {
    const result = new Float64Array(cols * cols);
    for (let r = 0; r < rows; r++) {
      const offset = r * cols;
      for (let i = 0; i < cols; i++) {
        const ai = a[offset + i];
        if (ai === 0) {
          continue;
        }
        for (let j = i; j < cols; j++) {
          result[i * cols + j] += ai * a[offset + j];
        }
      }
    }
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < i; j++) {
        result[i * cols + j] = result[j * cols + i];
      }
    }
    return result;
  }

  /** Aᵀ B（A は rows×colsA、B は rows×colsB）。 */
  function transposeMultiply(a, rows, colsA, b, colsB) {
    const result = new Float64Array(colsA * colsB);
    for (let r = 0; r < rows; r++) {
      const aOffset = r * colsA;
      const bOffset = r * colsB;
      for (let i = 0; i < colsA; i++) {
        const ai = a[aOffset + i];
        if (ai === 0) {
          continue;
        }
        const resultOffset = i * colsB;
        for (let j = 0; j < colsB; j++) {
          result[resultOffset + j] += ai * b[bOffset + j];
        }
      }
    }
    return result;
  }

  /**
   * 対称正定値行列のコレスキー分解 A = L Lᵀ。
   * 正定値でない（ピボットが0以下）ときは null を返す。
   */
  function cholesky(a, size) {
    const lower = new Float64Array(size * size);
    for (let j = 0; j < size; j++) {
      let diagonal = a[j * size + j];
      for (let k = 0; k < j; k++) {
        diagonal -= lower[j * size + k] * lower[j * size + k];
      }
      if (!(diagonal > 0)) {
        return null;
      }
      const pivot = Math.sqrt(diagonal);
      lower[j * size + j] = pivot;
      for (let i = j + 1; i < size; i++) {
        let sum = a[i * size + j];
        for (let k = 0; k < j; k++) {
          sum -= lower[i * size + k] * lower[j * size + k];
        }
        lower[i * size + j] = sum / pivot;
      }
    }
    return lower;
  }

  /** コレスキー分解の結果から log(det A) を求める。 */
  function logDetFromCholesky(lower, size) {
    let sum = 0;
    for (let i = 0; i < size; i++) {
      sum += Math.log(lower[i * size + i]);
    }
    return 2 * sum;
  }

  /**
   * コレスキー分解を使って A X = B を解く（B は size×cols）。
   */
  function choleskySolve(lower, size, b, cols) {
    const x = Float64Array.from(b);
    for (let c = 0; c < cols; c++) {
      // 前進代入 L y = b
      for (let i = 0; i < size; i++) {
        let sum = x[i * cols + c];
        for (let k = 0; k < i; k++) {
          sum -= lower[i * size + k] * x[k * cols + c];
        }
        x[i * cols + c] = sum / lower[i * size + i];
      }
      // 後退代入 Lᵀ x = y
      for (let i = size - 1; i >= 0; i--) {
        let sum = x[i * cols + c];
        for (let k = i + 1; k < size; k++) {
          sum -= lower[k * size + i] * x[k * cols + c];
        }
        x[i * cols + c] = sum / lower[i * size + i];
      }
    }
    return x;
  }

  /** 単位行列。 */
  function identity(size) {
    const result = new Float64Array(size * size);
    for (let i = 0; i < size; i++) {
      result[i * size + i] = 1;
    }
    return result;
  }

  /**
   * 対称正定値行列の逆行列。正定値でなければ null。
   */
  function inverseSymmetric(a, size) {
    const lower = cholesky(a, size);
    if (!lower) {
      return null;
    }
    return choleskySolve(lower, size, identity(size), size);
  }

  /**
   * 部分ピボット選択つきLU分解。RBFの連立方程式（正定値でない）に使う。
   * 特異（ピボットがほぼ0）なら null を返す。
   */
  function luDecompose(a, size) {
    const lu = Float64Array.from(a);
    const pivots = new Int32Array(size);
    let maxAbs = 0;
    for (let i = 0; i < lu.length; i++) {
      maxAbs = Math.max(maxAbs, Math.abs(lu[i]));
    }
    const singularThreshold = maxAbs * 1e-14;

    for (let k = 0; k < size; k++) {
      let pivotRow = k;
      let pivotAbs = Math.abs(lu[k * size + k]);
      for (let i = k + 1; i < size; i++) {
        const value = Math.abs(lu[i * size + k]);
        if (value > pivotAbs) {
          pivotAbs = value;
          pivotRow = i;
        }
      }
      if (!(pivotAbs > singularThreshold)) {
        return null;
      }
      pivots[k] = pivotRow;
      if (pivotRow !== k) {
        for (let j = 0; j < size; j++) {
          const keep = lu[k * size + j];
          lu[k * size + j] = lu[pivotRow * size + j];
          lu[pivotRow * size + j] = keep;
        }
      }
      const pivot = lu[k * size + k];
      for (let i = k + 1; i < size; i++) {
        const factor = (lu[i * size + k] /= pivot);
        if (factor === 0) {
          continue;
        }
        for (let j = k + 1; j < size; j++) {
          lu[i * size + j] -= factor * lu[k * size + j];
        }
      }
    }
    return { lu, pivots, size };
  }

  /** LU分解の結果で A X = B を解く（B は size×cols）。 */
  function luSolve(decomposition, b, cols) {
    const { lu, pivots, size } = decomposition;
    const x = Float64Array.from(b);
    for (let k = 0; k < size; k++) {
      const p = pivots[k];
      if (p !== k) {
        for (let c = 0; c < cols; c++) {
          const keep = x[k * cols + c];
          x[k * cols + c] = x[p * cols + c];
          x[p * cols + c] = keep;
        }
      }
    }
    for (let c = 0; c < cols; c++) {
      for (let i = 1; i < size; i++) {
        let sum = x[i * cols + c];
        for (let k = 0; k < i; k++) {
          sum -= lu[i * size + k] * x[k * cols + c];
        }
        x[i * cols + c] = sum;
      }
      for (let i = size - 1; i >= 0; i--) {
        let sum = x[i * cols + c];
        for (let k = i + 1; k < size; k++) {
          sum -= lu[i * size + k] * x[k * cols + c];
        }
        x[i * cols + c] = sum / lu[i * size + i];
      }
    }
    return x;
  }

  /**
   * 小さい一般の正方行列の行列式（ガウス消去）。D最適の入れ替え計算で使う。
   */
  function determinant(a, size) {
    const work = Float64Array.from(a);
    let det = 1;
    for (let k = 0; k < size; k++) {
      let pivotRow = k;
      for (let i = k + 1; i < size; i++) {
        if (Math.abs(work[i * size + k]) > Math.abs(work[pivotRow * size + k])) {
          pivotRow = i;
        }
      }
      const pivot = work[pivotRow * size + k];
      if (pivot === 0) {
        return 0;
      }
      if (pivotRow !== k) {
        for (let j = 0; j < size; j++) {
          const keep = work[k * size + j];
          work[k * size + j] = work[pivotRow * size + j];
          work[pivotRow * size + j] = keep;
        }
        det = -det;
      }
      det *= pivot;
      for (let i = k + 1; i < size; i++) {
        const factor = work[i * size + k] / pivot;
        for (let j = k; j < size; j++) {
          work[i * size + j] -= factor * work[k * size + j];
        }
      }
    }
    return det;
  }

  /**
   * 対称行列の固有値分解 A = V diag(λ) Vᵀ（ハウスホルダー三重対角化＋QL法。JAMA と同じ手順）。
   * ガウス過程回帰で、相関の長さごとに1回だけ分解し、ノイズ比を変えた計算を軽くするために使う。
   * 戻り値: { values: λ（長さ size）, vectors: V（行優先 size×size、列が固有ベクトル）}
   */
  function symmetricEigen(a, size) {
    const n = size;
    const v = [];
    for (let i = 0; i < n; i++) {
      v.push(Float64Array.from(a.subarray(i * n, (i + 1) * n)));
    }
    const d = new Float64Array(n);
    const e = new Float64Array(n);
    tridiagonalize(v, d, e, n);
    diagonalizeTridiagonal(v, d, e, n);
    const vectors = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      vectors.set(v[i], i * n);
    }
    return { values: d, vectors };
  }

  /** ハウスホルダー変換で対称行列を三重対角にする（JAMA の tred2）。 */
  function tridiagonalize(v, d, e, n) {
    for (let j = 0; j < n; j++) {
      d[j] = v[n - 1][j];
    }
    for (let i = n - 1; i > 0; i--) {
      let scale = 0;
      let h = 0;
      for (let k = 0; k < i; k++) {
        scale += Math.abs(d[k]);
      }
      if (scale === 0) {
        e[i] = d[i - 1];
        for (let j = 0; j < i; j++) {
          d[j] = v[i - 1][j];
          v[i][j] = 0;
          v[j][i] = 0;
        }
      } else {
        for (let k = 0; k < i; k++) {
          d[k] /= scale;
          h += d[k] * d[k];
        }
        let f = d[i - 1];
        let g = Math.sqrt(h);
        if (f > 0) {
          g = -g;
        }
        e[i] = scale * g;
        h -= f * g;
        d[i - 1] = f - g;
        for (let j = 0; j < i; j++) {
          e[j] = 0;
        }
        for (let j = 0; j < i; j++) {
          f = d[j];
          v[j][i] = f;
          g = e[j] + v[j][j] * f;
          for (let k = j + 1; k <= i - 1; k++) {
            g += v[k][j] * d[k];
            e[k] += v[k][j] * f;
          }
          e[j] = g;
        }
        f = 0;
        for (let j = 0; j < i; j++) {
          e[j] /= h;
          f += e[j] * d[j];
        }
        const hh = f / (h + h);
        for (let j = 0; j < i; j++) {
          e[j] -= hh * d[j];
        }
        for (let j = 0; j < i; j++) {
          f = d[j];
          g = e[j];
          for (let k = j; k <= i - 1; k++) {
            v[k][j] -= f * e[k] + g * d[k];
          }
          d[j] = v[i - 1][j];
          v[i][j] = 0;
        }
      }
      d[i] = h;
    }
    for (let i = 0; i < n - 1; i++) {
      v[n - 1][i] = v[i][i];
      v[i][i] = 1;
      const h = d[i + 1];
      if (h !== 0) {
        for (let k = 0; k <= i; k++) {
          d[k] = v[k][i + 1] / h;
        }
        for (let j = 0; j <= i; j++) {
          let g = 0;
          for (let k = 0; k <= i; k++) {
            g += v[k][i + 1] * v[k][j];
          }
          for (let k = 0; k <= i; k++) {
            v[k][j] -= g * d[k];
          }
        }
      }
      for (let k = 0; k <= i; k++) {
        v[k][i + 1] = 0;
      }
    }
    for (let j = 0; j < n; j++) {
      d[j] = v[n - 1][j];
      v[n - 1][j] = 0;
    }
    v[n - 1][n - 1] = 1;
    e[0] = 0;
  }

  /** 三重対角行列を QL 法で対角にする（JAMA の tql2）。 */
  function diagonalizeTridiagonal(v, d, e, n) {
    for (let i = 1; i < n; i++) {
      e[i - 1] = e[i];
    }
    e[n - 1] = 0;
    let f = 0;
    let tst1 = 0;
    const eps = Math.pow(2, -52);
    for (let l = 0; l < n; l++) {
      tst1 = Math.max(tst1, Math.abs(d[l]) + Math.abs(e[l]));
      let m = l;
      while (m < n) {
        if (Math.abs(e[m]) <= eps * tst1) {
          break;
        }
        m++;
      }
      if (m > l) {
        do {
          let g = d[l];
          let p = (d[l + 1] - g) / (2 * e[l]);
          let r = Math.hypot(p, 1);
          if (p < 0) {
            r = -r;
          }
          d[l] = e[l] / (p + r);
          d[l + 1] = e[l] * (p + r);
          const dl1 = d[l + 1];
          let h = g - d[l];
          for (let i = l + 2; i < n; i++) {
            d[i] -= h;
          }
          f += h;
          p = d[m];
          let c = 1;
          let c2 = c;
          let c3 = c;
          const el1 = e[l + 1];
          let s = 0;
          let s2 = 0;
          for (let i = m - 1; i >= l; i--) {
            c3 = c2;
            c2 = c;
            s2 = s;
            g = c * e[i];
            h = c * p;
            r = Math.hypot(p, e[i]);
            e[i + 1] = s * r;
            s = e[i] / r;
            c = p / r;
            p = c * d[i] - s * g;
            d[i + 1] = h + s * (c * g + s * d[i]);
            for (let k = 0; k < n; k++) {
              h = v[k][i + 1];
              v[k][i + 1] = s * v[k][i] + c * h;
              v[k][i] = c * v[k][i] - s * h;
            }
          }
          p = (-s * s2 * c3 * el1 * e[l]) / dl1;
          e[l] = s * p;
          d[l] = c * p;
        } while (Math.abs(e[l]) > eps * tst1);
      }
      d[l] += f;
      e[l] = 0;
    }
  }

  // ---- 統計 -------------------------------------------------------------

  function mean(values) {
    if (values.length === 0) {
      return NaN;
    }
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
    }
    return sum / values.length;
  }

  /**
   * パーセント点（線形補間）。sortedValues は昇順に並べたもの。
   */
  function percentileOfSorted(sortedValues, percent) {
    const count = sortedValues.length;
    if (count === 0) {
      return NaN;
    }
    const position = ((count - 1) * percent) / 100;
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.min(count - 1, lowerIndex + 1);
    const fraction = position - lowerIndex;
    return (
      sortedValues[lowerIndex] +
      (sortedValues[upperIndex] - sortedValues[lowerIndex]) * fraction
    );
  }

  /** 平均・パーセント点・最大をまとめて求める。計算できなかった値（NaN）は除く。 */
  function summarize(values) {
    const sorted = Float64Array.from(Array.prototype.filter.call(values, Number.isFinite)).sort();
    return {
      count: sorted.length,
      mean: mean(sorted),
      p5: percentileOfSorted(sorted, 5),
      p25: percentileOfSorted(sorted, 25),
      median: percentileOfSorted(sorted, 50),
      p75: percentileOfSorted(sorted, 75),
      p95: percentileOfSorted(sorted, 95),
      min: sorted.length ? sorted[0] : NaN,
      max: sorted.length ? sorted[sorted.length - 1] : NaN,
    };
  }

  ASC.math = {
    createRandom,
    deriveSeed,
    multiply,
    gram,
    transposeMultiply,
    cholesky,
    logDetFromCholesky,
    choleskySolve,
    identity,
    inverseSymmetric,
    luDecompose,
    luSolve,
    determinant,
    symmetricEigen,
    mean,
    percentileOfSorted,
    summarize,
  };
})(typeof window !== "undefined" ? window : globalThis);
