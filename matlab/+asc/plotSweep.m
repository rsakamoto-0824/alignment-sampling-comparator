function ax = plotSweep(sweep, options)
%PLOTSWEEP 計測Mark数（横軸）と残差（縦軸）のトレードオフカーブ。手動プランは × の点で重ねる。
%   asc.plotSweep(sweep, LogScale=true, Target=0.35) のように指定する。
%   VariantKey（既定 'howa'）, Axis（'x'）, Metric（'rms'）, Statistic（'mean' か 'p95'）, LogScale, Target, Parent,
%   XAxis（'marks' なら計測Mark数＝選び方ごとの試行平均、'shots' なら計測Shot数）
%   制約なしのD最適・I最適は破線と中抜きの印、制約付きは実線と塗りの印で描く。

arguments
    sweep struct
    options.VariantKey char = 'howa'
    options.Axis char = 'x'
    options.Metric char = 'rms'
    options.Statistic char = 'mean'
    options.LogScale logical = false
    options.Target double = []
    options.Parent = []
    options.XAxis char = 'marks'
end
ax = options.Parent;
if isempty(ax), ax = gca; end
colors = asc.plotColors();
hold(ax, 'on');
points = sweep.points(arrayfun(@(point) ~isempty(point.summary), sweep.points));
handles = gobjects(0);
names = {};
for method = sweep.methods(:)'
    xs = NaN(1, numel(points));
    ys = NaN(1, numel(points));
    for k = 1:numel(points)
        m = find(strcmp({points(k).methods.key}, method.key), 1);
        v = find(strcmp({sweep.variants.key}, options.VariantKey), 1);
        if isempty(m) || isempty(v), continue; end
        if strcmp(options.XAxis, 'shots')
            xs(k) = points(k).shotCount;
        else
            xs(k) = points(k).markCounts(m);
        end
        ys(k) = points(k).summary(m).variants(v).(options.Axis).(options.Metric).all.(options.Statistic);
    end
    color = [0, 0, 0];
    marker = 'o';
    lineStyle = '-';
    if isfield(colors.methods, method.key)
        color = colors.methods.(method.key);
        marker = colors.methodMarkers.(method.key);
        lineStyle = colors.methodLines.(method.key);
    end
    face = color;
    if strcmp(lineStyle, '--')
        face = [1, 1, 1];
    end
    handles(end + 1) = plot(ax, xs, ys, [lineStyle marker], 'Color', color, 'MarkerFaceColor', face, 'LineWidth', 2); %#ok<AGROW>
    names{end + 1} = method.label; %#ok<AGROW>
end
if ~isempty(sweep.manual)
    v = find(strcmp({sweep.variants.key}, options.VariantKey), 1);
    for m = 1:numel(sweep.manual.methods)
        if strcmp(options.XAxis, 'shots')
            x = sweep.manual.shotCounts(m);
        else
            x = sweep.manual.markCounts(m);
        end
        y = sweep.manual.summary(m).variants(v).(options.Axis).(options.Metric).all.(options.Statistic);
        plot(ax, x, y, 'kx', 'MarkerSize', 9, 'LineWidth', 1.5);
        text(ax, x, y, ['  ' sweep.manual.methods(m).label '（手動）'], 'FontSize', 8, 'VerticalAlignment', 'middle');
    end
end
guideValues = [];
if ~isempty(sweep.baseline)
    statistic = 'mean';
    if strcmp(options.Statistic, 'p95'), statistic = 'p95'; end
    guideValues(end + 1) = sweep.baseline.(options.Axis).(options.Metric).(statistic);
    handles(end + 1) = yline(ax, guideValues(end), '-', 'Color', colors.waferEdge);
    names{end + 1} = '全点計測';
end
if ~isempty(options.Target)
    guideValues(end + 1) = options.Target;
    handles(end + 1) = yline(ax, options.Target, ':', 'Color', colors.waferEdge);
    names{end + 1} = sprintf('目標 %g', options.Target);
end
if options.LogScale
    set(ax, 'YScale', 'log');
end
% 水平線（全点計測・目標）が縦軸の範囲の外に隠れないように広げる
if ~isempty(guideValues)
    limits = ylim(ax);
    ylim(ax, [min(limits(1), 0.9 * min(guideValues)), max(limits(2), 1.1 * max(guideValues))]);
end
statisticLabel = 'Wafer平均';
if strcmp(options.Statistic, 'p95'), statisticLabel = '95%点'; end
if strcmp(options.XAxis, 'shots')
    xlabel(ax, '計測Shot数');
else
    xlabel(ax, '計測Mark数（計測コスト）');
end
ylabel(ax, sprintf('残差 %s（%s、%s）[nm]', options.Metric, upper(options.Axis), statisticLabel));
grid(ax, 'on');
legend(ax, handles, names, 'Location', 'northeast', 'FontSize', 8);
hold(ax, 'off');
end
