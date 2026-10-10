function operator = estimateThenHowaOperator(howaParts, estimate, sampleIndices)
%ESTIMATETHENHOWAOPERATOR 線形の推定手法（RBF）を使う「推定→HOWA」の演算子（全Mark数×計測点数）。補正量 = 演算子 × 計測値。
%   未計測Markを推定値で埋め（計測Markは計測値のまま）、全Markに多項式を当てはめる。

n = numel(sampleIndices);
filled = estimate;
filled(sampleIndices, :) = 0;
filled(sub2ind(size(filled), sampleIndices(:)', 1:n)) = 1;
operator = howaParts.allDesign * (howaParts.allLeastSquares * filled);
end
