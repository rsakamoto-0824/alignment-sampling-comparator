function operator = measuredOperator(howaOperator, sampleIndices)
%MEASUREDOPERATOR 計測値＋HOWA の演算子（全Mark数×計測点数）。
%   測ったMarkの行は計測値そのもの（単位行列の行）、測っていないMarkの行はHOWAの補正量。

n = numel(sampleIndices);
operator = howaOperator;
operator(sampleIndices, :) = 0;
operator(sub2ind(size(operator), sampleIndices(:)', 1:n)) = 1;
end
