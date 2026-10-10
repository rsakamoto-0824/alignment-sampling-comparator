"""定数と初期設定。ブラウザ版（src/js/constants.js）と同じ値にする。

値が食い違わないことは tests/test_cross_language.py で確かめる。
設定は、ブラウザ版の設定JSONと同じキー名の辞書で持つ（アプリで保存した設定をそのまま使えるように）。
"""

import copy

# ---- Wafer・座標 ----
WAFER_RADIUS_MM = 150
# Zernikeと多項式の座標を割る半径。座標を -1〜1 にそろえ、5次の多項式でも計算を安定させる
NORMALIZATION_RADIUS_MM = 150

# ---- Scan方向 ----
SCAN_UP = "Up"
SCAN_DOWN = "Down"
# 一筆書き（露光順）の開始の角。行ごとに蛇行し、1 Shot進むごとにUp/Downを交互にする
SERPENTINE_STARTS = ["topLeft", "topRight", "bottomLeft", "bottomRight"]

# ---- Zernike ----
MAX_FRINGE_INDEX = 36
# この次数以下のZernike項は、5次までの多項式（21項）で正確に表せる
MAX_POLYNOMIAL_ORDER = 5
NORMALIZATION_RMS = "rms"
DISTRIBUTION_NORMAL = "normal"

# ---- 補正の流れと推定手法 ----
FLOW_TYPES = [
    {"key": "howa", "label": "HOWAのみ"},
    {"key": "estimateThenHowa", "label": "推定→HOWA"},
]
ESTIMATORS = [
    {"key": "rbfXY", "type": "rbf", "features": "xy", "label": "RBF（X,Y）", "longLabel": "RBF（説明変数 X,Y）"},
    {"key": "rbfXYR", "type": "rbf", "features": "xyr", "label": "RBF（X,Y,半径）", "longLabel": "RBF（説明変数 X,Y,半径）"},
    {"key": "gpXY", "type": "gp", "features": "xy", "label": "GP（X,Y）", "longLabel": "ガウス過程回帰（説明変数 X,Y）"},
    {"key": "gpXYR", "type": "gp", "features": "xyr", "label": "GP（X,Y,半径）", "longLabel": "ガウス過程回帰（説明変数 X,Y,半径）"},
]

# ---- ガウス過程回帰の調整値の探索範囲（相関の長さは正規化座標、ノイズ比は ノイズの分散 ÷ 信号の分散）----
GP_LENGTH_SCALE_MIN = 0.05
GP_LENGTH_SCALE_MAX = 2
GP_LENGTH_SCALE_STEPS = 10
GP_NOISE_RATIO_MIN = 1e-4
GP_NOISE_RATIO_MAX = 10
GP_NOISE_RATIO_STEPS = 11

# ---- 選び方 ----
# constrained: 条件制約を守って選ぶか。criterion: D最適・I最適の基準。並び順は乱数列の番号にも使う
METHODS = [
    {"key": "random", "label": "ランダム", "usesDraws": True, "constrained": True, "criterion": None},
    {"key": "poisson", "label": "ポアソンディスク", "usesDraws": True, "constrained": True, "criterion": None},
    {"key": "dOptimal", "label": "D最適（制約なし）", "usesDraws": False, "constrained": False, "criterion": "D"},
    {"key": "iOptimal", "label": "I最適（制約なし）", "usesDraws": False, "constrained": False, "criterion": "I"},
    {"key": "constrainedD", "label": "制約付きD最適", "usesDraws": False, "constrained": True, "criterion": "D"},
    {"key": "constrainedI", "label": "制約付きI最適", "usesDraws": False, "constrained": True, "criterion": "I"},
]
# 「計画を作成」で選ぶ方法（評価データを使わずに、選んだ点だけを出す）
PLAN_METHOD_KEYS = ["constrainedD", "constrainedI"]
MANUAL_PREFIX = "manual:"

# ---- 条件制約 ----
CONSTRAINT_KEYS = ["center", "scan", "quadrant", "zone"]
CONSTRAINT_LABELS = {"center": "中心の1点", "scan": "Scan方向", "quadrant": "4象限", "zone": "同心円の3領域", "mandatory": "強制計測Shot"}
ALLOCATION_PROPORTIONAL = "proportional"
# 優先度ごとのソフト制約の重み。優先度が1つ上がるごとに2倍にする
PRIORITY_WEIGHTS = {1: 8, 2: 4, 3: 2, 4: 1}
# D・I最適で、ソフト制約1件分のずれを「効率の対数」何個分とみなすか（強さ1のとき）
SOFT_PENALTY_LOG_EFFICIENCY = 0.1
# ランダム・ポアソンで、ソフト制約1件分のずれが選ばれる確率を下げる強さ（強さ1のとき）
SOFT_PENALTY_SELECTION = 3
# 1つずつ選ぶとき、目標に足りない区画の候補を選びやすくする強さ
SEQUENTIAL_URGENCY_BOOST = 100

# ---- 探索の回数と小さな値 ----
FEASIBLE_ATTEMPTS = 40
REPAIR_MAX_ITERATIONS = 300
POISSON_BISECTION_STEPS = 14
OPTIMAL_MAX_PASSES = 100
# D・I最適の情報行列に足す小さな値。点が項数より少なくても計算を止めないため
INFORMATION_RIDGE = 1e-8
# 最小二乗で正規方程式に足す小さな値（項数に対して点が足りないとき用）
LEAST_SQUARES_RIDGE = 1e-6
# 候補の良さの差がこの割合以下なら同点とみなし、先に調べた候補を選ぶ（言語間で丸め誤差による違いを出さない）
TIE_TOLERANCE = 1e-9

_DEFAULT_SETTINGS = {
    "map": {
        "source": "generate",
        "shotWidthMm": 26,
        "shotHeightMm": 33,
        "offsetXmm": 13,
        "offsetYmm": 16.5,
        "validRadiusMm": 150,
        "scanPattern": "serpentine",
        "serpentineStart": "topLeft",
        "serpentineFirstScan": "Up",
        "marks": [
            {"markNo": 1, "x": -12, "y": 15.5},
            {"markNo": 2, "x": 12, "y": 15.5},
            {"markNo": 3, "x": -12, "y": -15.5},
            {"markNo": 4, "x": 12, "y": -15.5},
        ],
    },
    # 初期のマップで、選べるShotの数が3領域でほぼそろう値（36・32・36個）
    "zones": {"innerRadiusMm": 95, "outerRadiusMm": 135},
    "evaluationData": {
        "waferCount": 100,
        "seed": 1,
        "distribution": "uniform",
        "normalization": "none",
        "lowOrderAmplitudeNm": 2,
        "highOrderAmplitudeNm": 0.5,
        "terms": None,
        "noiseSigmaXnm": 0.3,
        "noiseSigmaYnm": 0.3,
        "scanOffsetXnm": 0,
        "scanOffsetYnm": 0,
    },
    "model": {
        "termsX": list(range(21)),
        "termsY": list(range(21)),
        "flows": {"howa": True, "estimateThenHowa": True},
        "estimators": {"rbfXY": True, "rbfXYR": True, "gpXY": True, "gpXYR": True},
        "rbfKernel": "tps",
        "rbfLambda": 0,
        "rbfShapeFactor": 2,
        "gpKernel": "squaredExponential",
    },
    "sampling": {
        # 選んだShotでは、そのShotの有効なMarkをすべて測る
        "shotCount": 20,
        # True なら、Markが揃わない端のShot（有効半径の外にMarkがはみ出すShot）は選ばない
        "excludeIncompleteShots": False,
        "draws": 30,
        "optimalStarts": 5,
        "seed": 1,
        "methods": {"random": True, "poisson": True, "dOptimal": True, "iOptimal": True, "constrainedD": True, "constrainedI": True},
    },
    "sweep": {
        "startShots": 10,
        "endShots": 60,
        "stepShots": 10,
        "draws": 10,
        "methods": {"random": True, "poisson": True, "dOptimal": True, "iOptimal": True, "constrainedD": True, "constrainedI": True},
    },
    "constraints": {
        "center": {"enabled": True, "priority": 1},
        "scan": {"enabled": True, "hard": True, "priority": 2, "allocation": "equal"},
        "quadrant": {"enabled": True, "hard": True, "priority": 3, "allocation": "equal"},
        "zone": {"enabled": True, "hard": True, "priority": 4, "allocation": "equal"},
        "softStrength": 0.5,
        # 必ず測るShot（強制計測Shot）と、選ばないShot（除外Shot）。Shot番号（ShotId）の文字で持つ
        "mandatoryShotIds": [],
        "excludedShotIds": [],
    },
}


def default_settings():
    """初期設定（ブラウザ版の defaultSettings と同じ）。Zernike項の大きさ terms も埋めて返す。"""
    from .evaluation_data import default_term_settings

    settings = copy.deepcopy(_DEFAULT_SETTINGS)
    data = settings["evaluationData"]
    data["terms"] = default_term_settings(data["lowOrderAmplitudeNm"], data["highOrderAmplitudeNm"])
    return settings
