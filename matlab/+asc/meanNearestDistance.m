function distance = meanNearestDistance(points)
%MEANNEARESTDISTANCE 点どうしの最近傍距離の平均（説明変数の空間）。RBFの幅の基準にする。

if size(points, 1) < 2
    distance = 1;
    return
end
distances = asc.pairDistances(points, points);
distances(logical(eye(size(points, 1)))) = Inf;
distance = mean(min(distances, [], 2));
end
