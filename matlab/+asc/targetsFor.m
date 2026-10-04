function [floorCounts, ceilCounts] = targetsFor(constraint, total)
%TARGETSFOR 選択数 total のときの、区画ごとの目標の幅 [floor, ceil]（区画数×1）。
%   同数配分なら区画どうしの差が1以内と同じ。比例配分なら選べるShotの数に比例させる。

C = asc.constants();
available = constraint.available;
availableSum = sum(available);
floorCounts = zeros(constraint.classCount, 1);
ceilCounts = zeros(constraint.classCount, 1);
for c = 1:constraint.classCount
    if strcmp(constraint.allocation, C.ALLOCATION_PROPORTIONAL) && availableSum > 0
        share = available(c) / availableSum;
    else
        share = 1 / constraint.classCount;
    end
    target = total * share;
    floorCounts(c) = floor(target + 1e-9);
    ceilCounts(c) = ceil(target - 1e-9);
end
end
