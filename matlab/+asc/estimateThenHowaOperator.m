function operator = estimateThenHowaOperator(howaParts, estimate, sampleIndices)
%ESTIMATETHENHOWAOPERATOR RBFの予測の演算子（全Mark数×計測点数）。補正量 = 演算子 × 計測値。
%   未計測MarkをRBFの予測で埋め（計測Markは計測値のまま）、全Markに多項式を当てはめる（補正の「予測」）。

n = numel(sampleIndices);
filled = estimate;
filled(sampleIndices, :) = 0;
filled(sub2ind(size(filled), sampleIndices(:)', 1:n)) = 1;
operator = howaParts.allDesign * (howaParts.allLeastSquares * filled);
end
