function distances = pairDistances(a, b)
%PAIRDISTANCES 点の組ごとの距離（a の点の数 × b の点の数）。列（次元）の順に足す。

squared = zeros(size(a, 1), size(b, 1));
for d = 1:size(a, 2)
    squared = squared + (a(:, d) - b(:, d)').^2;
end
distances = sqrt(squared);
end
