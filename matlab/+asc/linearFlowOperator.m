function operator = linearFlowOperator(howaParts, estimate, sampleIndices, flowType)
%LINEARFLOWOPERATOR 線形の推定手法（RBF）を使う補正の流れの演算子（全Mark数×計測点数）。補正量 = 演算子 × 計測値。
%   推定→HOWA: 未計測Markを推定値で埋め、全Markに多項式を当てはめる（計測Markは計測値のまま）
%   HOWA＋推定: 多項式で補正し、計測Markでの取り残しを推定手法で全Markに広げて足す

n = numel(sampleIndices);
if strcmp(flowType, 'estimateThenHowa')
    filled = estimate;
    filled(sampleIndices, :) = 0;
    filled(sub2ind(size(filled), sampleIndices(:)', 1:n)) = 1;
    operator = howaParts.allDesign * (howaParts.allLeastSquares * filled);
else
    operator = howaParts.howa + estimate * (eye(n) - howaParts.fitted);
end
end
