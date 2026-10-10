/**
 * 定数と初期設定。意味を持つ値はここにまとめ、ほかのファイルに直接書かない。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});

  const constants = {
    // ---- Wafer・座標 ----
    WAFER_RADIUS_MM: 150,
    // Zernikeと多項式の座標を割る半径。座標を -1〜1 にそろえ、5次の多項式でも計算を安定させる
    NORMALIZATION_RADIUS_MM: 150,
    NOTCH_SIZE_MM: 4,

    // ---- Scan方向 ----
    SCAN_UP: "Up",
    SCAN_DOWN: "Down",
    SCAN_PATTERNS: {
      serpentine: "一筆書き（露光順に1 Shotごとに交互）",
      checker: "市松（上下左右の隣で交互）",
      column: "列ごとに交互",
      row: "行ごとに交互",
      allUp: "すべてUp",
    },
    // 一筆書きの開始の角。行ごとに蛇行し、1 Shot進むごとにUp/Downを交互にする（露光機のタクトが最小になる順）
    SERPENTINE_STARTS: {
      topLeft: "左上から",
      topRight: "右上から",
      bottomLeft: "左下から",
      bottomRight: "右下から",
    },

    // ---- Zernike ----
    MAX_FRINGE_INDEX: 36,
    // この次数以下のZernike項は、5次までの多項式（21項）で正確に表せる
    MAX_POLYNOMIAL_ORDER: 5,
    NORMALIZATION_NONE: "none",
    NORMALIZATION_RMS: "rms",

    // ---- 乱数の分布 ----
    DISTRIBUTION_UNIFORM: "uniform",
    DISTRIBUTION_NORMAL: "normal",

    // ---- 補正の流れ ----
    // 推定を使う流れ（推定→HOWA）は、下の推定手法ごとに評価する
    FLOW_TYPES: [
      { key: "howa", label: "HOWAのみ" },
      { key: "estimateThenHowa", label: "推定→HOWA" },
    ],

    // ---- 推定手法（未計測Markのずれを推定する方法）----
    // features: 説明変数。xy は (x, y)、xyr は (x, y, 半径)
    ESTIMATORS: [
      { key: "rbfXY", type: "rbf", features: "xy", label: "RBF（X,Y）", longLabel: "RBF（説明変数 X,Y）" },
      { key: "rbfXYR", type: "rbf", features: "xyr", label: "RBF（X,Y,半径）", longLabel: "RBF（説明変数 X,Y,半径）" },
      { key: "gpXY", type: "gp", features: "xy", label: "GP（X,Y）", longLabel: "ガウス過程回帰（説明変数 X,Y）" },
      { key: "gpXYR", type: "gp", features: "xyr", label: "GP（X,Y,半径）", longLabel: "ガウス過程回帰（説明変数 X,Y,半径）" },
    ],

    // ---- RBFの基底 ----
    RBF_KERNELS: {
      tps: "薄板スプライン",
      gaussian: "ガウス",
      multiquadric: "マルチクアドリック",
      inverseQuadric: "逆二次",
    },

    // ---- ガウス過程回帰 ----
    GP_KERNELS: {
      squaredExponential: "二乗指数（ガウス）",
      matern52: "Matérn 5/2",
    },
    // 調整値の探索範囲。相関の長さは正規化座標（1 = 150 mm）、ノイズ比は「ノイズの分散 ÷ 信号の分散」
    GP_LENGTH_SCALE_MIN: 0.05,
    GP_LENGTH_SCALE_MAX: 2,
    GP_LENGTH_SCALE_STEPS: 10,
    GP_NOISE_RATIO_MIN: 1e-4,
    GP_NOISE_RATIO_MAX: 10,
    GP_NOISE_RATIO_STEPS: 11,

    // ---- 選び方 ----
    // 自動で選ぶ方法。人が選ぶ「手動プラン」は別に持ち、キーを "manual:番号" にする
    // constrained: 条件制約（5. 条件制約）を守って選ぶか。criterion: D最適・I最適の基準
    // 並び順は乱数列の番号にも使うので、途中に入れずに末尾へ足す
    METHODS: [
      { key: "random", label: "ランダム", usesDraws: true, constrained: true, criterion: null },
      { key: "poisson", label: "ポアソンディスク", usesDraws: true, constrained: true, criterion: null },
      { key: "dOptimal", label: "D最適（制約なし）", usesDraws: false, constrained: false, criterion: "D" },
      { key: "iOptimal", label: "I最適（制約なし）", usesDraws: false, constrained: false, criterion: "I" },
      { key: "constrainedD", label: "制約付きD最適", usesDraws: false, constrained: true, criterion: "D" },
      { key: "constrainedI", label: "制約付きI最適", usesDraws: false, constrained: true, criterion: "I" },
    ],
    // 「計画を作成」で選ぶ方法（評価データを使わずに、選んだ点だけを出す）
    PLAN_METHOD_KEYS: ["constrainedD", "constrainedI"],
    PLAN_PREFIX: "plan:",
    MANUAL_PREFIX: "manual:",
    MAX_MANUAL_PLANS: 10,
    MAX_PLAN_NAME_LENGTH: 30,

    // ---- 条件制約 ----
    CONSTRAINT_KEYS: ["center", "scan", "quadrant", "zone"],
    CONSTRAINT_LABELS: {
      center: "中心の1点",
      scan: "Scan方向",
      quadrant: "4象限",
      zone: "同心円の3領域",
      mandatory: "強制計測Shot",
    },
    ALLOCATION_EQUAL: "equal",
    ALLOCATION_PROPORTIONAL: "proportional",
    // 優先度ごとのソフト制約の重み。優先度が1つ上がるごとに2倍にする
    PRIORITY_WEIGHTS: { 1: 8, 2: 4, 3: 2, 4: 1 },
    // D・I最適で、ソフト制約1件分のずれを「効率の対数」何個分とみなすか（強さ1のとき）
    SOFT_PENALTY_LOG_EFFICIENCY: 0.1,
    // ランダム・ポアソンで、ソフト制約1件分のずれが選ばれる確率を下げる強さ（強さ1のとき）
    SOFT_PENALTY_SELECTION: 3,
    // 1つずつ選ぶとき、目標に足りない区画の候補を選びやすくする強さ（候補の少ない区画が後回しになって行き詰まるのを防ぐ）
    SEQUENTIAL_URGENCY_BOOST: 100,

    // ---- 探索の回数 ----
    FEASIBLE_ATTEMPTS: 40,
    REPAIR_MAX_ITERATIONS: 300,
    POISSON_BISECTION_STEPS: 14,
    OPTIMAL_MAX_PASSES: 100,
    // D・I最適の情報行列に足す小さな値。点が項数より少なくても計算を止めないため
    INFORMATION_RIDGE: 1e-8,
    // 最小二乗で正規方程式に足す小さな値（項数に対して点が足りないとき用）
    LEAST_SQUARES_RIDGE: 1e-6,
    // 候補の良さを比べるとき、差がこの割合以下なら同点とみなし、先に調べた候補を選ぶ。
    // Waferの対称性で数学的に同じ良さの候補が並ぶとき、丸め誤差で選ぶ候補が変わらないようにする
    // （Python版・MATLAB版と同じ点を選ぶため）
    TIE_TOLERANCE: 1e-9,

  };

  /** 初期設定。画面の入力欄の初期値と、設定JSONの読込の基準に使う。 */
  function defaultSettings() {
    return {
      map: {
        source: "generate",
        shotWidthMm: 26,
        shotHeightMm: 33,
        offsetXmm: 13,
        offsetYmm: 16.5,
        validRadiusMm: 150,
        scanPattern: "serpentine",
        serpentineStart: "topLeft",
        serpentineFirstScan: "Up",
        marks: [
          { markNo: 1, x: -12, y: 15.5 },
          { markNo: 2, x: 12, y: 15.5 },
          { markNo: 3, x: -12, y: -15.5 },
          { markNo: 4, x: 12, y: -15.5 },
        ],
      },
      // 初期のマップで、選べるShotの数が3領域でほぼそろう値（36・32・36個）
      zones: { innerRadiusMm: 95, outerRadiusMm: 135 },
      evaluationData: {
        waferCount: 100,
        seed: 1,
        distribution: constants.DISTRIBUTION_UNIFORM,
        normalization: constants.NORMALIZATION_NONE,
        // 多項式で表せる項（5次以下）と表せない項（6次以上）の初期の大きさ [nm]
        lowOrderAmplitudeNm: 2,
        highOrderAmplitudeNm: 0.5,
        terms: null, // null のときは上の2つの値から作る
        noiseSigmaXnm: 0.3,
        noiseSigmaYnm: 0.3,
        scanOffsetXnm: 0,
        scanOffsetYnm: 0,
      },
      model: {
        // 21項のうち使う項の番号（0始まり）。初期値はすべて使う
        termsX: Array.from({ length: 21 }, (_, i) => i),
        termsY: Array.from({ length: 21 }, (_, i) => i),
        flows: { howa: true, estimateThenHowa: true },
        estimators: { rbfXY: true, rbfXYR: true, gpXY: true, gpXYR: true },
        rbfKernel: "tps",
        rbfLambda: 0,
        rbfShapeFactor: 2,
        gpKernel: "squaredExponential",
      },
      sampling: {
        // 選んだShotでは、そのShotの有効なMarkをすべて測る
        shotCount: 20,
        // true なら、Markが揃わない端のShot（有効半径の外にMarkがはみ出すShot）は選ばない
        excludeIncompleteShots: false,
        draws: 30,
        optimalStarts: 5,
        seed: 1,
        methods: { random: true, poisson: true, dOptimal: true, iOptimal: true, constrainedD: true, constrainedI: true },
      },
      // 計測点数のスイープ（計測Shot数の範囲、ランダム・ポアソンの試行回数、比べる選び方）
      sweep: {
        startShots: 10,
        endShots: 60,
        stepShots: 10,
        draws: 10,
        methods: { random: true, poisson: true, dOptimal: true, iOptimal: true, constrainedD: true, constrainedI: true },
      },
      constraints: {
        center: { enabled: true, priority: 1 },
        scan: { enabled: true, hard: true, priority: 2, allocation: constants.ALLOCATION_EQUAL },
        quadrant: { enabled: true, hard: true, priority: 3, allocation: constants.ALLOCATION_EQUAL },
        zone: { enabled: true, hard: true, priority: 4, allocation: constants.ALLOCATION_EQUAL },
        softStrength: 0.5,
        // 必ず測るShot（強制計測Shot）と、選ばないShot（除外Shot）。Shot番号（ShotId）の文字で持つ
        mandatoryShotIds: [],
        excludedShotIds: [],
      },
    };
  }

  ASC.constants = constants;
  ASC.defaultSettings = defaultSettings;
})(typeof window !== "undefined" ? window : globalThis);
