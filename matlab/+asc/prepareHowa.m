function parts = prepareHowa(uv, sampleIndices, terms, allDesign, allLeastSquares)
%PREPAREHOWA 1つの軸のHOWAの部品。
%   howa: 計測値 → 全Markの補正量（全Mark数×計測点数）、allLeastSquares: 全Markの値 → 多項式の係数（推定→HOWA で使う）

sampleDesign = asc.polynomialDesign(uv(sampleIndices, :), terms);
[operator, rankDeficient] = asc.leastSquaresOperator(sampleDesign);
warnings = {};
if rankDeficient
    warnings{end + 1} = sprintf('計測点（%d点）に対して多項式の項（%d項）が多すぎるか、点の並びが偏っています。', numel(sampleIndices), numel(terms));
end
parts = struct('allDesign', allDesign, 'allLeastSquares', allLeastSquares, 'howa', allDesign * operator);
parts.warnings = warnings;
end
