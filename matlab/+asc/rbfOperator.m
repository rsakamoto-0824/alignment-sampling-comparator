function operator = rbfOperator(uv, sampleIndices, rbfSettings, features)
%RBFOPERATOR RBFの予測の演算子 G（全Mark数×計測点数）。予測値 = G × 計測値（補正の「予測」で使う）。
%   f(p) = a₀ + Σ aₖ·pₖ + Σ wⱼ φ(|p − pⱼ|)。rbfSettings は kernel, lambda, shapeFactor。
%   緩和パラメータ λ は、基底の値の平均の大きさ（対角以外の |φ| の平均）を掛けて使う。解けないときは []。

allPoints = asc.featureMatrix(uv, features);
samplePoints = allPoints(sampleIndices, :);
n = numel(sampleIndices);
dimension = size(samplePoints, 2);
systemSize = n + 1 + dimension;
shape = max(rbfSettings.shapeFactor, 1e-6) * asc.meanNearestDistance(samplePoints);
kernelSample = asc.rbfKernel(rbfSettings.kernel, asc.pairDistances(samplePoints, samplePoints), shape);
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
kernelAll = asc.rbfKernel(rbfSettings.kernel, asc.pairDistances(allPoints, samplePoints), shape);
basisAll = [ones(size(allPoints, 1), 1), allPoints];
operator = [kernelAll, basisAll] * weights;
end
