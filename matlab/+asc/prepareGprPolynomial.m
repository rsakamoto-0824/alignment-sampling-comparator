function prepared = prepareGprPolynomial(kernelPart, sampleDesign)
%PREPAREGPRPOLYNOMIAL GPRの式内の前準備（多項式の項ごと）。点が「項数＋2」より少なければ []。
%   相関の長さの候補ごとに VᵀP、ノイズ比の候補ごとに 1/(λ+α) と log det K を先に求める。

C = asc.constants();
[n, p] = size(sampleDesign);
prepared = [];
if n < p + 2
    return
end
ratios = logSpace(C.GP_NOISE_RATIO_MIN, C.GP_NOISE_RATIO_MAX, C.GP_NOISE_RATIO_STEPS)';
scales = struct('projected', cell(1, numel(kernelPart.scales)), 'inverse', [], 'logDet', []);
for s = 1:numel(kernelPart.scales)
    shifted = kernelPart.scales(s).values' + ratios;      % ノイズ比の候補 × 固有値
    scales(s).projected = kernelPart.scales(s).vectors' * sampleDesign;
    scales(s).inverse = 1 ./ shifted;
    scales(s).logDet = sum(log(shifted), 2);
end
prepared = struct('n', n, 'p', p, 'ratios', ratios, 'scales', scales);
end

function values = logSpace(minimum, maximum, steps)
if steps <= 1
    values = minimum;
    return
end
values = minimum * (maximum / minimum) .^ ((0:steps - 1) / (steps - 1));
end
