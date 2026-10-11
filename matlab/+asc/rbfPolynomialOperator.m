function coefficients = rbfPolynomialOperator(uv, sampleIndices, sampleDesign, rbfSettings, features)
%RBFPOLYNOMIALOPERATOR RBFの式内: 多項式の係数を決める行列 C（項数×計測点数）。係数 = C × 計測値。
%   計測値を f(x) = Σ cₖ Pₖ(u, v) + Σ wⱼ φ(|q(x) − q(xⱼ)|) で表し（Pₖ はHOWAの多項式の項、q は説明変数）、
%   条件 Σ wⱼ Pₖ(xⱼ) = 0 のもとで解いた c を補正に使う。点が項数より少ないか解けないときは []。
%   緩和パラメータ λ は、基底の値の平均の大きさ（対角以外の |φ| の平均）を掛けて使う。

allPoints = asc.featureMatrix(uv, features);
samplePoints = allPoints(sampleIndices, :);
[n, p] = size(sampleDesign);
coefficients = [];
if n < p
    return
end
shape = max(rbfSettings.shapeFactor, 1e-6) * asc.meanNearestDistance(samplePoints);
kernelSample = asc.rbfKernel(rbfSettings.kernel, asc.pairDistances(samplePoints, samplePoints), shape);
offDiagonal = sum(abs(kernelSample(:))) - sum(abs(diag(kernelSample)));
if n > 1
    kernelScale = offDiagonal / (n * (n - 1));
else
    kernelScale = 1;
end
system = zeros(n + p);
system(1:n, 1:n) = kernelSample + rbfSettings.lambda * kernelScale * eye(n);
system(1:n, n + 1:end) = sampleDesign;
system(n + 1:end, 1:n) = sampleDesign';
right = zeros(n + p, n);
right(1:n, 1:n) = eye(n);
solution = asc.solveQuietly(system, right);
if ~all(isfinite(solution(:)))
    return
end
coefficients = solution(n + 1:end, :);
end
