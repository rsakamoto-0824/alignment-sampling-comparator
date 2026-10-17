function C = constants()
%CONSTANTS 定数。ブラウザ版（src/js/constants.js）と同じ値にする。
%   値が食い違わないことは tests/test_cross_language.m で確かめる。

persistent cached
if ~isempty(cached)
    C = cached;
    return
end

% ---- Wafer・座標 ----
C.WAFER_RADIUS_MM = 150;
% Zernikeと多項式の座標を割る半径。座標を -1〜1 にそろえ、5次の多項式でも計算を安定させる
C.NORMALIZATION_RADIUS_MM = 150;

% ---- Scan方向 ----
C.SCAN_UP = 'Up';
C.SCAN_DOWN = 'Down';
% 一筆書き（露光順）の開始の角。行ごとに蛇行し、1 Shot進むごとにUp/Downを交互にする
C.SERPENTINE_STARTS = {'topLeft', 'topRight', 'bottomLeft', 'bottomRight'};

% ---- 評価データの用意のしかた ----
% zernike: Zernike項の乱数で作る。file: 計測データのファイル（csv・xlsx）を読む（Waferマップもファイルから作る）
C.DATA_SOURCE_ZERNIKE = 'zernike';
C.DATA_SOURCE_FILE = 'file';

% ---- 計測データのファイル（アライメント・OVL計測の標準の表）----
% 項目名は大文字・小文字を区別する。必須の列がないと読めない
C.MEASUREMENT_REQUIRED_COLUMNS = {'Wafer', 'shotNo', 'Direction', 'Xmm', 'Ymm', 'markNo', 'markXmm', 'markYmm', 'measX', 'measY'};
C.MEASUREMENT_OPTIONAL_COLUMNS = {'DateTime', 'Radius', 'StsX', 'StsY'};
% Direction の値（1, 2）とScan方向
C.MEASUREMENT_DIRECTIONS = {'Up', 'Down'};
% StsX・StsY でこの値だけが有効（-1 は未測定。それ以外も有効とみなさない）
C.MEASUREMENT_VALID_STATUS = 0;
% 同じShot・Markの座標が行によって違うとみなす差 [mm]
C.MEASUREMENT_COORDINATE_TOLERANCE_MM = 1e-6;
% Radius の列と sqrt(Xmm^2 + Ymm^2) の差がこれより大きければ知らせる [mm]
C.MEASUREMENT_RADIUS_TOLERANCE_MM = 1e-3;
% 誤りの説明を並べる上限
C.MEASUREMENT_MAX_ERRORS = 20;

% ---- Zernike ----
C.MAX_FRINGE_INDEX = 36;
% この次数以下のZernike項は、5次までの多項式（21項）で正確に表せる
C.MAX_POLYNOMIAL_ORDER = 5;
C.NORMALIZATION_RMS = 'rms';
C.DISTRIBUTION_NORMAL = 'normal';
C.MAX_WAFER_COUNT = 5000;

% ---- 補正（比べる補正値の求め方）----
% 補正値はどれも X,Y の高次多項式（HOWAの項）。違いは多項式の係数の決め方:
%   howa      計測したMarkに最小二乗で当てはめる
%   RBF・GPR（mode）
%     embedded（式内）  RBF・GPRの式の中に多項式を入れて計測値を表し、その多項式の部分を補正値にする
%     predict（予測）   RBF・GPRで未計測Markのずれを予測して全Markを埋め、全Markに多項式を当てはめる
%   measured  測ったMarkは計測値そのものを補正値にし、測っていないMarkだけHOWAの多項式で補正する
% family は色を決める系統（式内と予測は同じ色）。並び順は結果の表やグラフの並び順
C.CORRECTIONS = struct( ...
    'key', {'howa', 'rbfXY', 'rbfXYPredict', 'rbfXYR', 'rbfXYRPredict', 'gpXY', 'gpXYPredict', 'gpXYR', 'gpXYRPredict', 'measured'}, ...
    'type', {'howa', 'rbf', 'rbf', 'rbf', 'rbf', 'gp', 'gp', 'gp', 'gp', 'measured'}, ...
    'mode', {'', 'embedded', 'predict', 'embedded', 'predict', 'embedded', 'predict', 'embedded', 'predict', ''}, ...
    'family', {'howa', 'rbfXY', 'rbfXY', 'rbfXYR', 'rbfXYR', 'gpXY', 'gpXY', 'gpXYR', 'gpXYR', 'measured'}, ...
    'features', {'', 'xy', 'xy', 'xyr', 'xyr', 'xy', 'xy', 'xyr', 'xyr', ''}, ...
    'label', {'HOWA', 'RBF（X,Y）式内', 'RBF（X,Y）予測', 'RBF（X,Y,半径）式内', 'RBF（X,Y,半径）予測', ...
        'GPR（X,Y）式内', 'GPR（X,Y）予測', 'GPR（X,Y,半径）式内', 'GPR（X,Y,半径）予測', '計測値＋HOWA'}, ...
    'longLabel', {'HOWA（計測したMarkに最小二乗で多項式を当てはめる）', 'RBF（説明変数 X,Y）の式の中の多項式', ...
        'RBF（説明変数 X,Y）の全Markの予測に多項式を当てはめる', 'RBF（説明変数 X,Y,半径）の式の中の多項式', ...
        'RBF（説明変数 X,Y,半径）の全Markの予測に多項式を当てはめる', 'GPR（説明変数 X,Y）の式の中の多項式（一般化最小二乗）', ...
        'GPR（説明変数 X,Y）の全Markの予測に多項式を当てはめる', 'GPR（説明変数 X,Y,半径）の式の中の多項式（一般化最小二乗）', ...
        'GPR（説明変数 X,Y,半径）の全Markの予測に多項式を当てはめる', '計測値＋HOWA（測ったMarkは計測値、測っていないMarkはHOWA）'});
% GPRの式内: QR分解の対角の比がこれより小さければ係数が決まらない（点が偏っている）とみなす
C.GPR_RANK_TOLERANCE = 1e-10;
% 計測値が多項式でほぼ完全に表せるとみなす、最小二乗の残差の2乗和の割合（GPRの調整値を選ぶ意味がないとき）
C.EXACT_FIT_RATIO = 1e-20;

% ---- ガウス過程回帰の調整値の探索範囲（相関の長さは正規化座標、ノイズ比は ノイズの分散 ÷ 信号の分散）----
C.GP_LENGTH_SCALE_MIN = 0.05;
C.GP_LENGTH_SCALE_MAX = 2;
C.GP_LENGTH_SCALE_STEPS = 10;
C.GP_NOISE_RATIO_MIN = 1e-4;
C.GP_NOISE_RATIO_MAX = 10;
C.GP_NOISE_RATIO_STEPS = 11;

% ---- 選び方 ----
% constrained: 条件制約を守って選ぶか。criterion: D最適・I最適の基準（ランダム・ポアソンは ''）。並び順は乱数列の番号にも使う
C.METHODS = struct( ...
    'key', {'random', 'poisson', 'dOptimal', 'iOptimal', 'constrainedD', 'constrainedI'}, ...
    'label', {'ランダム', 'ポアソンディスク', 'D最適（制約なし）', 'I最適（制約なし）', '制約付きD最適', '制約付きI最適'}, ...
    'usesDraws', {true, true, false, false, false, false}, ...
    'constrained', {true, true, false, false, true, true}, ...
    'criterion', {'', '', 'D', 'I', 'D', 'I'});
% 「計画を作成」で選ぶ方法（評価データを使わずに、選んだ点だけを出す）。制約なしと制約付きのD最適・I最適
C.PLAN_METHOD_KEYS = {'dOptimal', 'iOptimal', 'constrainedD', 'constrainedI'};
C.MANUAL_PREFIX = 'manual:';
% 選び方の乱数列の番号（評価データとは別）
C.STREAM_METHOD_BASE = 1000;

% ---- 条件制約 ----
C.CONSTRAINT_KEYS = {'center', 'scan', 'quadrant', 'zone'};
C.CONSTRAINT_LABELS = struct('center', '中心の1点', 'scan', 'Scan方向', 'quadrant', '4象限', 'zone', '同心円の3領域', 'mandatory', '強制計測Shot');
C.ALLOCATION_PROPORTIONAL = 'proportional';
% 優先度（1〜4）ごとのソフト制約の重み。優先度が1つ上がるごとに2倍にする
C.PRIORITY_WEIGHTS = [8, 4, 2, 1];
% D・I最適で、ソフト制約1件分のずれを「効率の対数」何個分とみなすか（強さ1のとき）
C.SOFT_PENALTY_LOG_EFFICIENCY = 0.1;
% ランダム・ポアソンで、ソフト制約1件分のずれが選ばれる確率を下げる強さ（強さ1のとき）
C.SOFT_PENALTY_SELECTION = 3;
% 1つずつ選ぶとき、目標に足りない区画の候補を選びやすくする強さ
C.SEQUENTIAL_URGENCY_BOOST = 100;

% ---- 探索の回数と小さな値 ----
C.FEASIBLE_ATTEMPTS = 40;
C.REPAIR_MAX_ITERATIONS = 300;
C.POISSON_BISECTION_STEPS = 14;
C.OPTIMAL_MAX_PASSES = 100;
% D・I最適の情報行列に足す小さな値。点が項数より少なくても計算を止めないため
C.INFORMATION_RIDGE = 1e-8;
% 最小二乗で正規方程式に足す小さな値（項数に対して点が足りないとき用）
C.LEAST_SQUARES_RIDGE = 1e-6;
% コレスキー因子の対角の比がこれより小さければ、多項式が決まらない（ほぼ特異）とみなす
C.SINGULAR_DIAGONAL_RATIO = 1e-7;
% 候補の良さの差がこの割合以下なら同点とみなし、先に調べた候補を選ぶ（言語間で丸め誤差による違いを出さない）
C.TIE_TOLERANCE = 1e-9;
% 同心円の区切りを自動で決めるとき、この差より近い半径は同じ半径とみなす [mm]
C.ZONE_RADIUS_TIE_MM = 1e-6;

cached = C;
end
