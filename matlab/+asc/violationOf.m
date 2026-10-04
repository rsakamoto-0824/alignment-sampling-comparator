function value = violationOf(counts, floorCounts, ceilCounts)
%VIOLATIONOF 区画ごとの数が目標の幅から外れた数の合計。

value = sum(max(counts - ceilCounts, 0)) + sum(max(floorCounts - counts, 0));
end
