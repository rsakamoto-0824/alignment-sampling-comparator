/**
 * Zernike多項式（Fringe番号 Z1〜Z36）の計算。
 * zernike-visualizer と wafer-map-generator と同じ番号付け・正規化にしている。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;

  // Fringe 36項に含まれる放射次数の上限
  const MAX_RADIAL_ORDER = 10;

  function factorial(number) {
    let result = 1;
    for (let i = 2; i <= number; i++) {
      result *= i;
    }
    return result;
  }

  /** 放射多項式 R_n^|m|(ρ) を「累乗と係数の一覧」として求める。 */
  function buildRadialCoefficients(n, absoluteM) {
    const coefficients = [];
    for (let k = 0; k <= (n - absoluteM) / 2; k++) {
      const sign = k % 2 === 0 ? 1 : -1;
      const denominator =
        factorial(k) *
        factorial((n + absoluteM) / 2 - k) *
        factorial((n - absoluteM) / 2 - k);
      coefficients.push({ power: n - 2 * k, coefficient: (sign * factorial(n - k)) / denominator });
    }
    return coefficients;
  }

  /**
   * (n, m) からFringe番号を求める。
   * (n+|m|)/2 が小さい順、同じ組では|m|が大きい順、cos項（m≧0）が先。
   */
  function fringeIndexOf(n, m) {
    const absoluteM = Math.abs(m);
    const group = (n + absoluteM) / 2;
    return Math.pow(1 + group, 2) - 2 * absoluteM + (m >= 0 ? 0 : 1);
  }

  /** Fringe番号順の項の一覧（Z1〜Z36）。 */
  function buildTerms() {
    const terms = [];
    for (let n = 0; n <= MAX_RADIAL_ORDER; n++) {
      for (let absoluteM = n % 2; absoluteM <= n; absoluteM += 2) {
        const signedValues = absoluteM === 0 ? [0] : [absoluteM, -absoluteM];
        for (const m of signedValues) {
          const fringeIndex = fringeIndexOf(n, m);
          if (fringeIndex > C.MAX_FRINGE_INDEX) {
            continue;
          }
          terms.push({
            fringeIndex,
            n,
            m,
            // 5次以下の項は、21項の多項式で正確に表せる
            polynomialExpressible: n <= C.MAX_POLYNOMIAL_ORDER,
            radialCoefficients: buildRadialCoefficients(n, absoluteM),
          });
        }
      }
    }
    terms.sort((left, right) => left.fringeIndex - right.fringeIndex);
    return terms;
  }

  const TERMS = buildTerms();

  /** RMS正規化では単位円内のRMSが1になる。 */
  function normalizationFactor(term, normalization) {
    if (normalization !== C.NORMALIZATION_RMS) {
      return 1;
    }
    return term.m === 0 ? Math.sqrt(term.n + 1) : Math.sqrt(2 * (term.n + 1));
  }

  /** 1つの項の値（係数は掛けない）。rho は正規化半径で割った半径。 */
  function evaluateTerm(term, rho, theta, normalization) {
    let radial = 0;
    for (const item of term.radialCoefficients) {
      radial += item.coefficient * Math.pow(rho, item.power);
    }
    let angular = 1;
    if (term.m > 0) {
      angular = Math.cos(term.m * theta);
    } else if (term.m < 0) {
      angular = Math.sin(-term.m * theta);
    }
    return normalizationFactor(term, normalization) * radial * angular;
  }

  function binomial(n, k) {
    return factorial(n) / (factorial(k) * factorial(n - k));
  }

  /**
   * 項を x, y の多項式に展開したときに現れる単項式（xᵃyᵇ）の一覧。
   * ρᵏ·cos(mθ) = Re((x+iy)ᵐ)·(x²+y²)^((k−m)/2)、sin は Im を使う。
   * 選んだ多項式の項がこの一覧を含んでいれば、その項は多項式で正確に補正できる。
   */
  function monomialsOf(term) {
    const absoluteM = Math.abs(term.m);
    const coefficients = new Map();
    const addTo = (powerX, powerY, value) => {
      const key = powerX + "," + powerY;
      coefficients.set(key, (coefficients.get(key) || 0) + value);
    };
    // (x+iy)^m の実部（cos）または虚部（sin）
    const angular = [];
    for (let j = 0; j <= absoluteM; j++) {
      const isRealPart = j % 2 === 0;
      if ((term.m >= 0) !== isRealPart) {
        continue;
      }
      const sign = Math.floor(j / 2) % 2 === 0 ? 1 : -1;
      angular.push({ powerX: absoluteM - j, powerY: j, value: sign * binomial(absoluteM, j) });
    }
    for (const radial of term.radialCoefficients) {
      const q = (radial.power - absoluteM) / 2;
      for (let l = 0; l <= q; l++) {
        const factor = radial.coefficient * binomial(q, l);
        for (const part of angular) {
          addTo(part.powerX + 2 * l, part.powerY + 2 * (q - l), factor * part.value);
        }
      }
    }
    const monomials = [];
    for (const [key, value] of coefficients) {
      if (Math.abs(value) > 1e-9) {
        const [powerX, powerY] = key.split(",").map(Number);
        monomials.push({ powerX, powerY });
      }
    }
    return monomials;
  }

  /** Fringe番号から項を探す。 */
  function termByFringe(fringeIndex) {
    return TERMS.find((term) => term.fringeIndex === fringeIndex) || null;
  }

  ASC.zernike = { TERMS, fringeIndexOf, evaluateTerm, normalizationFactor, termByFringe, monomialsOf };
})(typeof window !== "undefined" ? window : globalThis);
