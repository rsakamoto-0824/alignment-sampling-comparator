function values = rbfKernel(kernel, r, shape)
%RBFKERNEL RBFの基底関数。r は説明変数の空間での距離、shape は幅。

switch kernel
    case 'gaussian'
        values = exp(-((r / shape).^2));
    case 'multiquadric'
        values = sqrt(1 + (r / shape).^2);
    case 'inverseQuadric'
        values = 1 ./ (1 + (r / shape).^2);
    otherwise  % thin plate spline
        values = zeros(size(r));
        positive = r > 0;
        values(positive) = r(positive).^2 .* log(r(positive));
end
end
