function ax = plotResidualBoxes(output, axisName, metric, ax)
%PLOTRESIDUALBOXES 選び方ごとに、HOWAのみ と推定→HOWA（推定手法ごと）の残差を箱ひげ図で並べる（箱 25〜75%、ひげ 5〜95%）。
%   統計の追加機能は使わずに描く。

if nargin < 2, axisName = 'x'; end
if nargin < 3, metric = 'rms'; end
if nargin < 4 || isempty(ax), ax = gca; end
colors = asc.plotColors();
chosen = 1:numel(output.variants);
hold(ax, 'on');
position = 0;
ticks = [];
labels = {};
for m = 1:numel(output.methods)
    methodSets = output.sets(strcmp({output.sets.method}, output.methods(m).key));
    for v = chosen
        values = cell2mat(arrayfun(@(s) s.results(v).(axisName).(metric), methodSets(:), 'UniformOutput', false));
        stats = asc.summarizeValues(values);
        estimator = output.variants(v).estimator;
        if isempty(estimator)
            color = colors.series.howa;
        else
            color = colors.series.(estimator.key);
        end
        if stats.count > 0
            plot(ax, [stats.p5, stats.p95], [position, position], '-', 'Color', color);
            plot(ax, [stats.p5, stats.p5; stats.p95, stats.p95]', [position - 0.2, position + 0.2; position - 0.2, position + 0.2]', '-', 'Color', color);
            patch(ax, [stats.p25, stats.p75, stats.p75, stats.p25], position + [-0.3, -0.3, 0.3, 0.3], color, 'EdgeColor', color);
            plot(ax, [stats.median, stats.median], position + [-0.3, 0.3], '-', 'Color', 'w', 'LineWidth', 1.5);
        end
        ticks(end + 1) = position; %#ok<AGROW>
        labels{end + 1} = [asc.methodLabel(output, output.methods(m).key) '・' output.variants(v).label]; %#ok<AGROW>
        position = position - 1;
    end
    position = position - 0.6;
end
[ticks, order] = sort(ticks);
set(ax, 'YTick', ticks, 'YTickLabel', labels(order), 'FontSize', 8);
ylim(ax, [min(ticks) - 0.8, max(ticks) + 0.8]);
xlabel(ax, sprintf('Waferごとの残差 %s（%s）[nm]', metric, upper(axisName)));
grid(ax, 'on');
set(ax, 'YGrid', 'off');
hold(ax, 'off');
end
