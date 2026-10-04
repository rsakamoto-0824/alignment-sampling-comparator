"""Zernike多項式（Fringe番号 Z1〜Z36）。ブラウザ版（src/js/zernike.js）と同じ番号付け・正規化。"""

import math

from . import constants as C

# Fringe 36項に含まれる放射次数の上限
MAX_RADIAL_ORDER = 10


def _radial_coefficients(n, absolute_m):
    """放射多項式 R_n^|m|(ρ) を（累乗, 係数）の一覧にする。"""
    coefficients = []
    for k in range((n - absolute_m) // 2 + 1):
        sign = 1 if k % 2 == 0 else -1
        denominator = (
            math.factorial(k)
            * math.factorial((n + absolute_m) // 2 - k)
            * math.factorial((n - absolute_m) // 2 - k)
        )
        coefficients.append((n - 2 * k, sign * math.factorial(n - k) / denominator))
    return coefficients


def fringe_index_of(n, m):
    """(n, m) からFringe番号を求める。"""
    absolute_m = abs(m)
    group = (n + absolute_m) // 2
    return (1 + group) ** 2 - 2 * absolute_m + (0 if m >= 0 else 1)


def _build_terms():
    terms = []
    for n in range(MAX_RADIAL_ORDER + 1):
        for absolute_m in range(n % 2, n + 1, 2):
            for m in ([0] if absolute_m == 0 else [absolute_m, -absolute_m]):
                fringe = fringe_index_of(n, m)
                if fringe > C.MAX_FRINGE_INDEX:
                    continue
                terms.append(
                    {
                        "fringeIndex": fringe,
                        "n": n,
                        "m": m,
                        "polynomialExpressible": n <= C.MAX_POLYNOMIAL_ORDER,
                        "radial": _radial_coefficients(n, absolute_m),
                    }
                )
    terms.sort(key=lambda term: term["fringeIndex"])
    return terms


TERMS = _build_terms()
_TERM_BY_FRINGE = {term["fringeIndex"]: term for term in TERMS}


def term_by_fringe(fringe_index):
    return _TERM_BY_FRINGE.get(fringe_index)


def normalization_factor(term, normalization):
    """RMS正規化では単位円内のRMSが1になる。"""
    if normalization != C.NORMALIZATION_RMS:
        return 1
    return math.sqrt(term["n"] + 1) if term["m"] == 0 else math.sqrt(2 * (term["n"] + 1))


def evaluate_term(term, rho, theta, normalization):
    """1つの項の値（係数は掛けない）。rho は正規化半径で割った半径。"""
    radial = 0.0
    for power, coefficient in term["radial"]:
        radial += coefficient * math.pow(rho, power)
    angular = 1.0
    if term["m"] > 0:
        angular = math.cos(term["m"] * theta)
    elif term["m"] < 0:
        angular = math.sin(-term["m"] * theta)
    return normalization_factor(term, normalization) * radial * angular
