"""シード付きの乱数（mulberry32）。

ブラウザ版（src/js/math-utils.js）と同じ計算にして、同じシードなら同じ乱数列になるようにする。
JavaScript の 32bit 整数演算（Math.imul、>>>）を、Python の整数で 2^32 の剰余として再現する。
"""

import math

UINT32_MASK = 0xFFFFFFFF
UINT32_RANGE = 4294967296


def _imul(a, b):
    """Math.imul と同じ 32bit 掛け算（結果は 0〜2^32−1 の符号なしで持つ）。"""
    return ((a & UINT32_MASK) * (b & UINT32_MASK)) & UINT32_MASK


def derive_seed(seed, index):
    """元のシードと番号から、別の乱数列用のシードを作る（試行ごとに独立した乱数列にする）。"""
    value = (int(seed) & UINT32_MASK) ^ _imul(index + 1, 0x9E3779B1)
    value = _imul(value ^ (value >> 16), 0x85EBCA6B)
    value = _imul(value ^ (value >> 13), 0xC2B2AE35)
    return (value ^ (value >> 16)) & UINT32_MASK


class Random:
    """mulberry32 の乱数。next / normal / integer / shuffle / pick_weighted はブラウザ版と同じ順で乱数を使う。"""

    def __init__(self, seed):
        self._state = (int(seed) & UINT32_MASK) or 1
        self._spare_normal = None

    def next(self):
        """0以上1未満の一様乱数。"""
        self._state = (self._state + 0x6D2B79F5) & UINT32_MASK
        t = self._state
        t = _imul(t ^ (t >> 15), t | 1)
        t = t ^ ((t + _imul(t ^ (t >> 7), t | 61)) & UINT32_MASK)
        return ((t ^ (t >> 14)) & UINT32_MASK) / UINT32_RANGE

    def normal(self):
        """標準正規分布の乱数（Box-Muller法。2つ目の値は次回に使う）。"""
        if self._spare_normal is not None:
            value = self._spare_normal
            self._spare_normal = None
            return value
        u1 = self.next()
        while u1 <= 0:
            u1 = self.next()
        u2 = self.next()
        radius = math.sqrt(-2 * math.log(u1))
        self._spare_normal = radius * math.sin(2 * math.pi * u2)
        return radius * math.cos(2 * math.pi * u2)

    def integer(self, count):
        """0以上 count 未満の整数。"""
        return math.floor(self.next() * count)

    def shuffle(self, values):
        """リストをその場で並べ替える（Fisher-Yates）。"""
        for i in range(len(values) - 1, 0, -1):
            j = self.integer(i + 1)
            values[i], values[j] = values[j], values[i]
        return values

    def pick_weighted(self, weights):
        """重みに比例した確率で添字を1つ選ぶ。重みがすべて0なら -1。

        ブラウザ版と同じく、前から順に足し引きして選ぶ（足す順番で丸め誤差が変わらないように）。
        """
        total = 0.0
        for weight in weights:
            total += weight
        if not total > 0:
            return -1
        threshold = self.next() * total
        for index, weight in enumerate(weights):
            threshold -= weight
            if threshold < 0 and weight > 0:
                return index
        for index in range(len(weights) - 1, -1, -1):
            if weights[index] > 0:
                return index
        return -1
