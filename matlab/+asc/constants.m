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

% ---- Zernike ----
C.MAX_FRINGE_INDEX = 36;
% この次数以下のZernike項は、5次までの多項式（21項）で正確に表せる
C.MAX_POLYNOMIAL_ORDER = 5;
C.NORMALIZATION_RMS = 'rms';
C.DISTRIBUTION_NORMAL = 'normal';
C.MAX_WAFER_COUNT = 5000;

% ---- 補正の流れと推定手法 ----
C.FLOW_TYPES = struct( ...
    'key', {'howa', 'estimateThenHowa', 'howaPlusEstimate'}, ...
    'label', {'HOWAのみ', '推定→HOWA', 'HOWA＋推定'});
C.ESTIMATORS = struct( ...
    'key', {'rbfXY', 'rbfXYR', 'gpXY', 'gpXYR'}, ...
    'type', {'rbf', 'rbf', 'gp', 'gp'}, ...
    'features', {'xy', 'xyr', 'xy', 'xyr'}, ...
    'label', {'RBF（X,Y）', 'RBF（X,Y,半径）', 'GP（X,Y）', 'GP（X,Y,半径）'}, ...
    'longLabel', {'RBF（説明変数 X,Y）', 'RBF（説明変数 X,Y,半径）', 'ガウス過程回帰（説明変数 X,Y）', 'ガウス過程回帰（説明変数 X,Y,半径）'});

% ---- ガウス過程回帰の調整値の探索範囲（相関の長さは正規化座標、ノイズ比は ノイズの分散 ÷ 信号の分散）----
C.GP_LENGTH_SCALE_MIN = 0.05;
C.GP_LENGTH_SCALE_MAX = 2;
C.GP_LENGTH_SCALE_STEPS = 10;
C.GP_NOISE_RATIO_MIN = 1e-4;
C.GP_NOISE_RATIO_MAX = 10;
C.GP_NOISE_RATIO_STEPS = 11;

% ---- 選び方 ----
C.METHODS = struct( ...
    'key', {'random', 'poisson', 'dOptimal', 'iOptimal'}, ...
    'label', {'ランダム', 'ポアソンディスク', 'D最適', 'I最適'}, ...
    'usesDraws', {true, true, false, false});
C.MANUAL_PREFIX = 'manual:';
% 選び方の乱数列の番号（評価データとは別）
C.STREAM_METHOD_BASE = 1000;

% ---- 条件制約 ----
C.CONSTRAINT_KEYS = {'center', 'scan', 'quadrant', 'zone'};
C.CONSTRAINT_LABELS = struct('center', '中心の1点', 'scan', 'Scan方向', 'quadrant', '4象限', 'zone', '同心円の3領域');
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

cached = C;
end
