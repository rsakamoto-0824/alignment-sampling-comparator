function metrics = residualMetrics(residual)
%RESIDUALMETRICS 残差（Mark数×Wafer数）から、Waferごと（Wafer数×1）の RMS・|平均|+3σ・最大|残差|。

meanValue = mean(residual, 1)';
meanSquare = mean(residual.^2, 1)';
variance = max(0, meanSquare - meanValue.^2);
metrics = struct('rms', sqrt(meanSquare), 'mean3sigma', abs(meanValue) + 3 * sqrt(variance), ...
    'max', max(abs(residual), [], 1)');
end
