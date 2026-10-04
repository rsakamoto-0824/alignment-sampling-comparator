function stats = summarizeValues(values)
%SUMMARIZEVALUES 平均・パーセント点・最大（計算できなかった値 NaN・∞ は除く）。
%   パーセント点は numpy の linear と同じ線形補間（統計の追加機能は使わない）。

values = values(:);
finite = sort(values(isfinite(values)));
count = numel(finite);
if count == 0
    stats = struct('count', 0, 'mean', NaN, 'p5', NaN, 'p25', NaN, 'median', NaN, 'p75', NaN, 'p95', NaN, 'min', NaN, 'max', NaN);
    return
end
stats = struct('count', count, 'mean', mean(finite), 'p5', percentile(finite, 5), 'p25', percentile(finite, 25), ...
    'median', percentile(finite, 50), 'p75', percentile(finite, 75), 'p95', percentile(finite, 95), ...
    'min', finite(1), 'max', finite(end));
end

function value = percentile(sorted, percent)
position = (percent / 100) * (numel(sorted) - 1);
lower = floor(position);
fraction = position - lower;
a = sorted(lower + 1);
b = sorted(min(lower + 2, numel(sorted)));
if fraction >= 0.5
    value = b - (b - a) * (1 - fraction);
else
    value = a + (b - a) * fraction;
end
end
