function ax = plotEstimationErrorMap(output, methodKey, estimationKey, axisName, scaleMax, ax)
%PLOTESTIMATIONERRORMAP 未計測Markごとの推定誤差（全WaferのRMS）を色で示す（計測Markは小さい点）。
%   estimationKey は output.estimationKeys の1つ（'howa' は多項式の予測）。ランダム系は最初の試行を使う。

if nargin < 4, axisName = 'x'; end
if nargin < 5, scaleMax = []; end
if nargin < 6 || isempty(ax), ax = gca; end
C = asc.constants();
colors = asc.plotColors();
entry = output.sets(find(strcmp({output.sets.method}, methodKey), 1));
e = find(strcmp(output.estimationKeys, estimationKey), 1);
rms = sqrt(entry.estimationSquares(e).(axisName) / output.waferCount);
waferMap = output.map;
finite = isfinite(rms);
if isempty(scaleMax)
    stats = asc.summarizeValues(rms(finite));
    scaleMax = stats.p95;
end
hold(ax, 'on');
scatter(ax, waferMap.markX(finite), waferMap.markY(finite), 40, min(rms(finite), scaleMax), 'filled', ...
    'MarkerEdgeColor', colors.shotEdge, 'LineWidth', 0.3);
plot(ax, waferMap.markX(~finite), waferMap.markY(~finite), '.', 'Color', colors.measured, 'MarkerSize', 6);
blues = interp1([0; 1], [0.97, 0.98, 1.0; 0.03, 0.19, 0.42], linspace(0, 1, 256)');
colormap(ax, blues);
caxis(ax, [0, scaleMax]);
bar = colorbar(ax);
bar.Label.String = '推定誤差RMS [nm]（上限は95%点）';
angle = linspace(0, 2 * pi, 361);
plot(ax, C.WAFER_RADIUS_MM * cos(angle), C.WAFER_RADIUS_MM * sin(angle), '-', 'Color', colors.waferEdge);
limit = C.WAFER_RADIUS_MM + 12;
axis(ax, 'equal');
xlim(ax, [-limit, limit]);
ylim(ax, [-limit, limit]);
xlabel(ax, 'X [mm]');
ylabel(ax, 'Y [mm]');
box(ax, 'on');
title(ax, sprintf('%s・推定誤差（%s、%s）', asc.methodLabel(output, methodKey), asc.estimationLabel(estimationKey), upper(axisName)));
hold(ax, 'off');
end
