function values = gpKernel(kernel, d, lengthScale)
%GPKERNEL ガウス過程回帰の共分散関数（信号の分散を1としたもの）。'matern52' か 二乗指数。

if strcmp(kernel, 'matern52')
    scaled = sqrt(5) * d / lengthScale;
    values = (1 + scaled + scaled.^2 / 3) .* exp(-scaled);
else
    values = exp(-(d.^2) / (2 * lengthScale^2));
end
end
