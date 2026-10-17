function result = equalCountZoneRadii(radii)
%EQUALCOUNTZONERADII 候補の半径を3つの区画に分けたとき、区画ごとの数ができるだけ均等になる区切りの半径。
%   ブラウザ版の equalCountZoneRadii と同じ手順。区切りは隣り合う半径の真ん中に置き、同じ半径
%   （差 ZONE_RADIUS_TIE_MM 以下）の候補は同じ区画に入れる。数のずれ（3 × 区画の数 − 全体の数）の2乗の和が
%   最も小さい組を選び、同じなら先に調べた（内側が小さい）組を使う。
%   result: innerRadiusMm, outerRadiusMm, counts（区画ごとの数）。半径が3種類より少なければ []。

C = asc.constants();
sorted = sort(radii(:))';
values = zeros(1, 0);
cumulative = zeros(1, 0);
for radius = sorted
    if ~isempty(values) && radius - values(end) <= C.ZONE_RADIUS_TIE_MM
        cumulative(end) = cumulative(end) + 1;
    elseif isempty(cumulative)
        values(end + 1) = radius; %#ok<AGROW>
        cumulative(end + 1) = 1; %#ok<AGROW>
    else
        values(end + 1) = radius; %#ok<AGROW>
        cumulative(end + 1) = cumulative(end) + 1; %#ok<AGROW>
    end
end
total = numel(sorted);
result = [];
if numel(values) < 3
    return
end
bestScore = Inf;
for inner = 1:numel(values) - 2
    for outer = inner + 1:numel(values) - 1
        counts = [cumulative(inner), cumulative(outer) - cumulative(inner), total - cumulative(outer)];
        score = sum((3 * counts - total).^2);
        if score < bestScore
            bestScore = score;
            result = struct('innerRadiusMm', (values(inner) + values(inner + 1)) / 2, ...
                'outerRadiusMm', (values(outer) + values(outer + 1)) / 2, 'counts', counts);
        end
    end
end
end
