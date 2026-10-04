function [values, lengths, ratios] = gpPredict(prepared, measured)
%GPPREDICT 全Waferの計測値（計測点数×Wafer数）から全Markのずれを推定する（事後平均）。
%   調整値（相関の長さ・ノイズ比）は、Waferごとにその計測点での周辺尤度が最大になる候補を選ぶ。
%   差がごくわずかなら同点とみなし、先の候補を残す（ブラウザ版の isClearlyGreater と同じ）。
%   戻り値: 推定値（全Mark数×Wafer数）、選んだ相関の長さ（1×Wafer数。1次式だけのときは NaN）、ノイズ比

C = asc.constants();
n = prepared.n;
trend = prepared.trendOperator * measured;
residual = measured - prepared.trendSample * trend;
waferCount = size(measured, 2);
best = -Inf(1, waferCount);
bestScale = ones(1, waferCount);
bestRatio = ones(1, waferCount);
zeroResidual = false(1, waferCount);
for s = 1:numel(prepared.scales)
    scale = prepared.scales(s);
    squared = (scale.vectors' * residual).^2;
    quadratic = scale.inverse * squared;
    zeroResidual = zeroResidual | any(quadratic <= 1e-300, 1);
    likelihood = -0.5 * n * log(quadratic / n) - 0.5 * scale.logDet;
    for r = 1:numel(prepared.ratios)
        threshold = best + C.TIE_TOLERANCE * max(1, abs(best));
        threshold(best == -Inf) = -Inf;
        better = likelihood(r, :) > threshold;
        best(better) = likelihood(r, better);
        bestScale(better) = s;
        bestRatio(better) = r;
    end
end
values = prepared.trendAll * trend;
lengths = NaN(1, waferCount);
ratios = NaN(1, waferCount);
for s = 1:numel(prepared.scales)
    chosen = bestScale == s & ~zeroResidual;
    if ~any(chosen)
        continue
    end
    scale = prepared.scales(s);
    projected = scale.vectors' * residual(:, chosen);
    inverse = scale.inverse(bestRatio(chosen), :)';
    weights = scale.vectors * (projected .* inverse);
    values(:, chosen) = values(:, chosen) + scale.cross * weights;
    lengths(chosen) = scale.length;
    ratios(chosen) = prepared.ratios(bestRatio(chosen));
end
end
