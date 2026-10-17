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

    // ---- 評価データの用意のしかた ----
    // zernike: Zernike項の乱数で作る。file: 計測データのファイル（csv・xlsx）を読む（Waferマップもファイルから作る）
    DATA_SOURCE_ZERNIKE: "zernike",
    DATA_SOURCE_FILE: "file",

    // ---- 計測データのファイル（アライメント・OVL計測の標準の表）----
    // 項目名は大文字・小文字を区別する。必須の列がないと読めない
    MEASUREMENT_REQUIRED_COLUMNS: ["Wafer", "shotNo", "Direction", "Xmm", "Ymm", "markNo", "markXmm", "markYmm", "measX", "measY"],
    MEASUREMENT_OPTIONAL_COLUMNS: ["DateTime", "Radius", "StsX", "StsY"],
    // Direction の値とScan方向
    MEASUREMENT_DIRECTIONS: { 1: "Up", 2: "Down" },
    // StsX・StsY でこの値だけが有効（-1 は未測定。それ以外も有効とみなさない）
    MEASUREMENT_VALID_STATUS: 0,
    // 同じShot・Markの座標が行によって違うとみなす差 [mm]
    MEASUREMENT_COORDINATE_TOLERANCE_MM: 1e-6,
    // Radius の列と sqrt(Xmm² + Ymm²) の差がこれより大きければ知らせる [mm]
    MEASUREMENT_RADIUS_TOLERANCE_MM: 1e-3,
    // 誤りの説明を並べる上限（多すぎると読めないので）
    MEASUREMENT_MAX_ERRORS: 20,

    // ---- 乱数の分布 ----
    DISTRIBUTION_UNIFORM: "uniform",
    DISTRIBUTION_NORMAL: "normal",

    // ---- 補正（比べる補正値の求め方）----
    // 補正値はどれも X,Y の高次多項式（HOWAの項）。違いは多項式の係数の決め方:
    //   howa      計測したMarkに最小二乗で当てはめる
    //   RBF・GPR（mode）
    //     embedded（式内）  RBF・GPRの式の中に多項式を入れて計測値を表し、その多項式の部分を補正値にする
    //                      （GPRは空間のつながりを考えた一般化最小二乗。調整値はWaferごとに学習する）
    //     predict（予測）   RBF・GPRで未計測Markのずれを予測して全Markを埋め、全Markに多項式を当てはめる
    //   measured  測ったMarkは計測値そのものを補正値にし、測っていないMarkだけHOWAの多項式で補正する
    // type: 求め方の種類。features: RBF・GPRの距離の説明変数（xy は (x, y)、xyr は (x, y, 半径)）。
    // family: 色を決める系統（式内と予測は同じ色で、図では塗り方で見分ける）
    // 並び順は結果の表やグラフの並び順
    CORRECTIONS: [
      { key: "howa", type: "howa", mode: null, family: "howa", features: null, label: "HOWA", longLabel: "HOWA（計測したMarkに最小二乗で多項式を当てはめる）" },
      { key: "rbfXY", type: "rbf", mode: "embedded", family: "rbfXY", features: "xy", label: "RBF（X,Y）式内", longLabel: "RBF（説明変数 X,Y）の式の中の多項式" },
      { key: "rbfXYPredict", type: "rbf", mode: "predict", family: "rbfXY", features: "xy", label: "RBF（X,Y）予測", longLabel: "RBF（説明変数 X,Y）の全Markの予測に多項式を当てはめる" },
      { key: "rbfXYR", type: "rbf", mode: "embedded", family: "rbfXYR", features: "xyr", label: "RBF（X,Y,半径）式内", longLabel: "RBF（説明変数 X,Y,半径）の式の中の多項式" },
      { key: "rbfXYRPredict", type: "rbf", mode: "predict", family: "rbfXYR", features: "xyr", label: "RBF（X,Y,半径）予測", longLabel: "RBF（説明変数 X,Y,半径）の全Markの予測に多項式を当てはめる" },
      { key: "gpXY", type: "gp", mode: "embedded", family: "gpXY", features: "xy", label: "GPR（X,Y）式内", longLabel: "GPR（説明変数 X,Y）の式の中の多項式（一般化最小二乗）" },
      { key: "gpXYPredict", type: "gp", mode: "predict", family: "gpXY", features: "xy", label: "GPR（X,Y）予測", longLabel: "GPR（説明変数 X,Y）の全Markの予測に多項式を当てはめる" },
      { key: "gpXYR", type: "gp", mode: "embedded", family: "gpXYR", features: "xyr", label: "GPR（X,Y,半径）式内", longLabel: "GPR（説明変数 X,Y,半径）の式の中の多項式（一般化最小二乗）" },
      { key: "gpXYRPredict", type: "gp", mode: "predict", family: "gpXYR", features: "xyr", label: "GPR（X,Y,半径）予測", longLabel: "GPR（説明変数 X,Y,半径）の全Markの予測に多項式を当てはめる" },
      { key: "measured", type: "measured", mode: null, family: "measured", features: null, label: "計測値＋HOWA", longLabel: "計測値＋HOWA（測ったMarkは計測値、測っていないMarkはHOWA）" },
    ],
    // RBF・GPRの係数の決め方の名前（設定欄と説明に使う）
    CORRECTION_MODES: {
      embedded: "式内（RBF・GPRの式の中の多項式）",
      predict: "予測（全Markの予測に多項式を当てはめる）",
    },

    // ---- RBFの基底 ----
    RBF_KERNELS: {
      tps: "薄板スプライン",
      gaussian: "ガウス",
      multiquadric: "マルチクアドリック",
      inverseQuadric: "逆二次",
    },

    // ---- ガウス過程回帰（GPR）----
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
    // kind: 選び方の種類（random・poisson・optimal）。constrained: 条件制約（5. 条件制約）を守って選ぶか。
    // criterion: D最適・I最適の基準
    // unit: 選ぶ単位。shot はShotを選んでそのShotの有効なMarkをすべて測る。mark はShotの括りを考えずに
    //       Markを1つずつ選ぶ（検証用。Python版・MATLAB版にはない）
    // 並び順は乱数列の番号にも使うので、途中に入れずに末尾へ足す
    METHODS: [
      { key: "random", kind: "random", label: "ランダム", usesDraws: true, constrained: true, criterion: null, unit: "shot" },
      { key: "poisson", kind: "poisson", label: "ポアソンディスク", usesDraws: true, constrained: true, criterion: null, unit: "shot" },
      { key: "dOptimal", kind: "optimal", label: "D最適（制約なし）", usesDraws: false, constrained: false, criterion: "D", unit: "shot" },
      { key: "iOptimal", kind: "optimal", label: "I最適（制約なし）", usesDraws: false, constrained: false, criterion: "I", unit: "shot" },
      { key: "constrainedD", kind: "optimal", label: "制約付きD最適", usesDraws: false, constrained: true, criterion: "D", unit: "shot" },
      { key: "constrainedI", kind: "optimal", label: "制約付きI最適", usesDraws: false, constrained: true, criterion: "I", unit: "shot" },
      { key: "markRandom", kind: "random", label: "ランダム（Mark単位）", usesDraws: true, constrained: true, criterion: null, unit: "mark" },
      { key: "markPoisson", kind: "poisson", label: "ポアソンディスク（Mark単位）", usesDraws: true, constrained: true, criterion: null, unit: "mark" },
      { key: "markDOptimal", kind: "optimal", label: "D最適（制約なし・Mark単位）", usesDraws: false, constrained: false, criterion: "D", unit: "mark" },
      { key: "markIOptimal", kind: "optimal", label: "I最適（制約なし・Mark単位）", usesDraws: false, constrained: false, criterion: "I", unit: "mark" },
      { key: "markConstrainedD", kind: "optimal", label: "制約付きD最適（Mark単位）", usesDraws: false, constrained: true, criterion: "D", unit: "mark" },
      { key: "markConstrainedI", kind: "optimal", label: "制約付きI最適（Mark単位）", usesDraws: false, constrained: true, criterion: "I", unit: "mark" },
    ],
    // 選ぶ単位の名前（設定欄の見出しと説明に使う）
    METHOD_UNITS: {
      shot: "Shot単位（選んだShotのMarkをすべて測る）",
      mark: "Mark単位（Shotの括りなし。検証用）",
    },
    // 「計画を作成」で選ぶ方法（評価データを使わずに、選んだ点だけを出す）。制約なしと制約付きのD最適・I最適
    PLAN_METHOD_KEYS: ["dOptimal", "iOptimal", "constrainedD", "constrainedI"],
    // 「計画を作成」で、比べる選び方でオンにしていれば一緒に出すMark単位のD最適・I最適
    MARK_PLAN_METHOD_KEYS: ["markDOptimal", "markIOptimal", "markConstrainedD", "markConstrainedI"],
    // 「計画を作成」のあとで最初に表示する選び方
    PLAN_FIRST_VIEW_KEY: "constrainedD",
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
      // 初期のマップで、選べるShot（Markが揃うShot 64個）の数が3領域でほぼそろう値（20・24・20個）。
      // 区切りはShot中心の半径の間に置く（境界のすぐそばにShotが来ないように）
      zones: { innerRadiusMm: 75, outerRadiusMm: 110 },
      evaluationData: {
        // zernike: Zernike項の乱数で作る。file: 計測データのファイルを読む（ファイルの中身は設定に保存しない）
        source: constants.DATA_SOURCE_ZERNIKE,
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
        // 比べる補正（キーは CORRECTIONS と同じ）
        corrections: {
          howa: true,
          rbfXY: true,
          rbfXYPredict: true,
          rbfXYR: true,
          rbfXYRPredict: true,
          gpXY: true,
          gpXYPredict: true,
          gpXYR: true,
          gpXYRPredict: true,
          measured: true,
        },
        rbfKernel: "tps",
        rbfLambda: 0,
        rbfShapeFactor: 2,
        gpKernel: "squaredExponential",
      },
      sampling: {
        // 選んだShotでは、そのShotの有効なMarkをすべて測る
        shotCount: 20,
        // true なら、Markが揃わない端のShot（有効半径の外にMarkがはみ出すShot、無効マークのあるShot）は選ばない
        excludeIncompleteShots: true,
        // Mark単位（Shotの括りなし）の選び方で選ぶMarkの数。初期値は Shot単位の 20 Shot × 4 Mark と同じ
        markCount: 80,
        draws: 30,
        optimalStarts: 5,
        seed: 1,
        methods: {
          random: true,
          poisson: true,
          dOptimal: true,
          iOptimal: true,
          constrainedD: true,
          constrainedI: true,
          // Mark単位は検証用なので、初期設定ではオフ
          markRandom: false,
          markPoisson: false,
          markDOptimal: false,
          markIOptimal: false,
          markConstrainedD: false,
          markConstrainedI: false,
        },
      },
      // 計測点数のスイープ（計測Shot数の範囲、ランダム・ポアソンの試行回数、比べる選び方）
      sweep: {
        startShots: 10,
        endShots: 60,
        stepShots: 10,
        draws: 10,
        methods: {
          random: true,
          poisson: true,
          dOptimal: true,
          iOptimal: true,
          constrainedD: true,
          constrainedI: true,
          markRandom: false,
          markPoisson: false,
          markDOptimal: false,
          markIOptimal: false,
          markConstrainedD: false,
          markConstrainedI: false,
        },
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
