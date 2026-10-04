function operator = rbfOperator(uv, sampleIndices, rbfSettings, features)
%RBFOPERATOR RBF補間の演算子 G（全Mark数×計測点数）。推定値 = G × 計測値。
%   f(p) = a₀ + Σ aₖ·pₖ + Σ wⱼ φ(|p − pⱼ|)。rbfSettings は kernel, lambda, shapeFactor。
%   緩和パラメータ λ は、基底の値の平均の大きさ（対角以外の |φ| の平均）を掛けて使う。解けないときは []。

allPoints = asc.featureMatrix(uv, features);
samplePoints = allPoints(sampleIndices, :);
n = numel(sampleIndices);
dimension = size(samplePoints, 2);
systemSize = n + 1 + dimension;
shape = max(rbfSettings.shapeFactor, 1e-6) * meanNearestDistance(samplePoints);
kernelSample = kernelValues(rbfSettings.kernel, asc.pairDistances(samplePoints, samplePoints), shape);
offDiagonal = sum(abs(kernelSample(:))) - sum(abs(diag(kernelSample)));
if n > 1
    kernelScale = offDiagonal / (n * (n - 1));
else
    kernelScale = 1;
end
basis = [ones(n, 1), samplePoints];
system = zeros(systemSize);
system(1:n, 1:n) = kernelSample + rbfSettings.lambda * kernelScale * eye(n);
system(1:n, n + 1:end) = basis;
system(n + 1:end, 1:n) = basis';
right = zeros(systemSize, n);
right(1:n, 1:n) = eye(n);
weights = asc.solveQuietly(system, right);
if ~all(isfinite(weights(:)))
    operator = [];
    return
end
kernelAll = kernelValues(rbfSettings.kernel, asc.pairDistances(allPoints, samplePoints), shape);
basisAll = [ones(size(allPoints, 1), 1), allPoints];
operator = [kernelAll, basisAll] * weights;
end

function distance = meanNearestDistance(points)
if size(points, 1) < 2
    distance = 1;
    return
end
distances = asc.pairDistances(points, points);
distances(logical(eye(size(points, 1)))) = Inf;
distance = mean(min(distances, [], 2));
end

function values = kernelValues(kernel, r, shape)
% RBFの基底関数。r は説明変数の空間での距離、shape は幅
switch kernel
    case 'gaussian'
        values = exp(-((r / shape).^2));
    case 'multiquadric'
        values = sqrt(1 + (r / shape).^2);
    case 'inverseQuadric'
        values = 1 ./ (1 + (r / shape).^2);
    otherwise  % thin plate spline
        values = zeros(size(r));
        positive = r > 0;
        values(positive) = r(positive).^2 .* log(r(positive));
end
end
