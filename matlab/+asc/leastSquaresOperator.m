function [operator, rankDeficient] = leastSquaresOperator(design)
%LEASTSQUARESOPERATOR 最小二乗の係数を求める行列 B = (XᵀX)⁻¹Xᵀ（項数×点数）と、正則でなかったかどうか。
%   点が項数より少ないなど XᵀX が正則でないときは、小さな値（trace/p × 1e-6）を足して解く。

C = asc.constants();
[rows, cols] = size(design);
normalMatrix = design' * design;
rankDeficient = true;
if rows >= cols
    [upper, failed] = chol(normalMatrix);
    if ~failed
        diagonal = diag(upper);
        rankDeficient = min(diagonal) / max(diagonal) < C.SINGULAR_DIAGONAL_RATIO;
    end
end
if rankDeficient
    ridge = max(trace(normalMatrix) / cols, 1) * C.LEAST_SQUARES_RIDGE;
    normalMatrix = normalMatrix + ridge * eye(cols);
end
operator = asc.solveQuietly(normalMatrix, design');
end
