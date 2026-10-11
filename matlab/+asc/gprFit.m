function [coefficients, lengths, ratios] = gprFit(kernelPart, prepared, measured, olsResidual, olsCoefficients, exact)
%GPRFIT GPRの式内: 全Waferの計測値（計測点数×Wafer数）から、多項式の係数（項数×Wafer数）を求める（2段階）。
%   1. 調整値（相関の長さ・ノイズ比）は、HOWAの残差 e での周辺尤度 −½[n log(eᵀK⁻¹e/n) + log det K] が最大の候補
%      （候補の並び順も、同じ値のときに前の候補を選ぶのもブラウザ版と同じ）
%   2. 選んだ共分散で一般化最小二乗 β = (PᵀK⁻¹P)⁻¹PᵀK⁻¹y を、重み付きの多項式の細いQR分解で解く
%   exact（Waferごと）が真のWaferは、計測値が多項式でほぼ表せるので、HOWAの係数をそのまま使う。
%   lengths・ratios は選んだ相関の長さ（正規化座標）とノイズ比（HOWAの係数を使ったWaferは NaN）。

C = asc.constants();
n = prepared.n;
waferCount = size(measured, 2);
best = -Inf(1, waferCount);
bestScale = ones(1, waferCount);
bestRatio = ones(1, waferCount);
for s = 1:numel(prepared.scales)
    squared = (kernelPart.scales(s).vectors' * olsResidual) .^ 2;
    quadratic = prepared.scales(s).inverse * squared;      % ノイズ比の候補 × Wafer
    likelihood = -0.5 * (n * log(quadratic / n) + prepared.scales(s).logDet);
    for r = 1:numel(prepared.ratios)
        % 差がごくわずかなら同点とみなし、先の候補を残す（ブラウザ版の isClearlyGreater と同じ）
        threshold = best + C.TIE_TOLERANCE * max(1, abs(best));
        threshold(isinf(best) & best < 0) = -Inf;
        better = likelihood(r, :) > threshold;
        best(better) = likelihood(r, better);
        bestScale(better) = s;
        bestRatio(better) = r;
    end
end
coefficients = olsCoefficients;
lengths = NaN(1, waferCount);
ratios = NaN(1, waferCount);
for s = 1:numel(prepared.scales)
    for r = 1:numel(prepared.ratios)
        chosen = bestScale == s & bestRatio == r & ~exact;
        if ~any(chosen)
            continue
        end
        lengths(chosen) = kernelPart.scales(s).length;
        ratios(chosen) = prepared.ratios(r);
        scaleFactors = sqrt(prepared.scales(s).inverse(r, :))';
        [q, upper] = qr(scaleFactors .* prepared.scales(s).projected, 0);
        diagonal = abs(diag(upper));
        if ~(min(diagonal) > max(diagonal) * C.GPR_RANK_TOLERANCE)
            continue  % 選んだ共分散では係数が決まらない（点が偏っている）。HOWAの係数を使う
        end
        gamma = q' * (scaleFactors .* (kernelPart.scales(s).vectors' * measured(:, chosen)));
        coefficients(:, chosen) = upper \ gamma;
    end
end
end
