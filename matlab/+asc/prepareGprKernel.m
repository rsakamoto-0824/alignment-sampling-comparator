function kernelPart = prepareGprKernel(uv, sampleIndices, features, kernel)
%PREPAREGPRKERNEL GPRの式内の前準備（選んだ点・説明変数ごとに1回。多項式の項によらない）。
%   相関の長さの候補ごとに、計測点どうしの共分散行列を固有値分解しておく（K = VΛVᵀ）。

C = asc.constants();
samplePoints = asc.featureMatrix(uv, features);
samplePoints = samplePoints(sampleIndices, :);
distances = asc.pairDistances(samplePoints, samplePoints);
lengths = logSpace(C.GP_LENGTH_SCALE_MIN, C.GP_LENGTH_SCALE_MAX, C.GP_LENGTH_SCALE_STEPS);
scales = struct('length', num2cell(lengths), 'values', [], 'vectors', []);
for s = 1:numel(lengths)
    [vectors, values] = eig(asc.gpKernel(kernel, distances, lengths(s)), 'vector');
    [values, order] = sort(max(values, 0));
    scales(s).values = values;
    scales(s).vectors = vectors(:, order);
end
kernelPart = struct('n', numel(sampleIndices), 'scales', scales);
end

function values = logSpace(minimum, maximum, steps)
if steps <= 1
    values = minimum;
    return
end
values = minimum * (maximum / minimum) .^ ((0:steps - 1) / (steps - 1));
end
