function ok = hasCapacity(constraint, total)
%HASCAPACITY 区画ごとの選べるShotの数で、目標の幅を満たせるか。

[floorCounts, ceilCounts] = asc.targetsFor(constraint, total);
available = constraint.available;
ok = ~any(available < floorCounts) && sum(min(available, ceilCounts)) >= total;
end
