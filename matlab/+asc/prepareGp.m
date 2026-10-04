function prepared = prepareGp(uv, sampleIndices, features, kernel)
%PREPAREGP ガウス過程回帰の前準備（選んだ点ごとに1回）。点が足りなければ []。
%   平均は説明変数の1次式で、最小二乗で先に取り除く。相関の長さの候補ごとに共分散行列を固有値分解し、
%   ノイズ比の候補ごとの 1/(λ+α) と log det を先に求める。kernel は 'squaredExponential' か 'matern52'。

C = asc.constants();
allPoints = asc.featureMatrix(uv, features);
samplePoints = allPoints(sampleIndices, :);
n = numel(sampleIndices);
trendSize = 1 + size(samplePoints, 2);
if n < trendSize + 2
    prepared = [];
    return
end
trendSample = [ones(n, 1), samplePoints];
trendAll = [ones(size(allPoints, 1), 1), allPoints];
trendOperator = asc.leastSquaresOperator(trendSample);
ratios = logSpace(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS)';
sampleDistances = asc.pairDistances(samplePoints, samplePoints);
allDistances = asc.pairDistances(allPoints, samplePoints);
lengths = logSpace(C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_MAX, C.GP_LENGTH_SCALE_STEPS);
scales = struct('length', num2cell(lengths), 'vectors', [], 'inverse', [], 'logDet', [], 'cross', []);
for s = 1:numel(lengths)
    covariance = asc.gpKernel(kernel, sampleDistances, lengths(s));
    [vectors, values] = eig(covariance, 'vector');
    [values, order] = sort(max(values, 0));
    scales(s).vectors = vectors(:, order);
    scales(s).inverse = 1 ./ (values' + ratios);          % ノイズ比の候補 × 固有値
    scales(s).logDet = sum(log(values' + ratios), 2);
    scales(s).cross = asc.gpKernel(kernel, allDistances, lengths(s));
end
prepared = struct('n', n, 'trendOperator', trendOperator, 'trendSample', trendSample, 'trendAll', trendAll, ...
    'ratios', ratios, 'scales', scales);
end

function values = logSpace(minimum, maximum, steps)
if steps <= 1
    values = minimum;
    return
end
values = minimum * (maximum / minimum).^((0:steps - 1) / (steps - 1));
end
