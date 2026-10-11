function ax = plotResidualBoxes(output, axisName, metric, ax, logScale)
%PLOTRESIDUALBOXES 選び方ごとに、補正（HOWA・RBF・GPRの式内と予測・計測値＋HOWA）の残差の分布を並べる（ブラウザ版の評価結果の図と同じ見た目）。
%   各行に、分布の形（薄い山。値が20個より少なければ値の点）、5〜95%点の線、25〜75%点の太い棒、中央値の白丸を重ねる。
%   色は補正の系統ごとで、RBF・GPRの式内は25〜75%点の棒を薄い塗りにする。縦の破線は全点計測（基準）の中央値。logScale = true で横軸を対数にする（値の小さい選び方どうしの差が見やすい）。
%   統計の追加機能は使わずに描く（分布の形はガウス核の密度推定を自前で計算する）。

if nargin < 2, axisName = 'x'; end
if nargin < 3, metric = 'rms'; end
if nargin < 4 || isempty(ax), ax = gca; end
if nargin < 5, logScale = false; end
colors = asc.plotColors();
style = chartStyle();

% 行（選び方 × 補正）と最後の全点計測の行を、上から順に並べる
rows = struct('group', {}, 'label', {}, 'color', {}, 'values', {}, 'stats', {}, 'outlined', {});
groupLabels = {};
for m = 1:numel(output.methods)
    methodSets = output.sets(strcmp({output.sets.method}, output.methods(m).key));
    groupLabels{end + 1} = asc.methodLabel(output, output.methods(m).key); %#ok<AGROW>
    for v = 1:numel(output.variants)
        values = cell2mat(arrayfun(@(s) reshape(s.results(v).(axisName).(metric), [], 1), methodSets(:), 'UniformOutput', false));
        variant = output.variants(v);
        rows(end + 1) = struct('group', m, 'label', variant.label, 'color', colors.series.(variant.family), 'values', values, ...
            'stats', asc.summarizeValues(values), 'outlined', strcmp(variant.mode, 'embedded')); %#ok<AGROW>
    end
end
baselineValues = reshape(output.baselines.allMarks.(axisName).(metric), [], 1);
groupLabels{end + 1} = '全点計測（基準）';
rows(end + 1) = struct('group', numel(groupLabels), 'label', 'HOWA', 'color', colors.series.howa, ...
    'values', baselineValues, 'stats', asc.summarizeValues(baselineValues), 'outlined', false);

% 横軸の範囲（5〜95%点。点で描く行は全部の値）
[low, high] = valueRange(rows, style, logScale);
% 縦の位置: 行は1ずつ下へ。選び方の名前を書く見出しの行を、各群の上に置く
positions = zeros(numel(rows), 1);
groupTops = zeros(numel(groupLabels), 1);
position = 0;
for k = 1:numel(rows)
    if k == 1 || rows(k).group ~= rows(k - 1).group
        position = position - style.groupHeaderHeight;
        groupTops(rows(k).group) = position + style.groupHeaderHeight;
        position = position - 0.5;
    end
    positions(k) = position;
    position = position - 1;
end
bottom = position + 0.5;

cla(ax);
hold(ax, 'on');
if logScale
    set(ax, 'XScale', 'log');
end
xlim(ax, [low, high]);
ylim(ax, [bottom - 0.2, 0.2]);
% 選び方ごとの帯（1つおきに薄い色を敷き、区切り線を使わずに群を分ける）
for g = 1:numel(groupLabels)
    groupRows = positions([rows.group] == g);
    groupBottom = min(groupRows) - 0.5;
    if mod(g, 2) == 0
        patch(ax, [low, high, high, low], [groupBottom, groupBottom, groupTops(g), groupTops(g)], colors.band, 'EdgeColor', 'none');
    end
    text(ax, low, groupTops(g) - style.groupHeaderHeight / 2, ['  ' groupLabels{g}], 'FontWeight', 'bold', 'FontSize', 9, ...
        'VerticalAlignment', 'middle', 'Color', colors.ink);
end
baselineMedian = rows(end).stats.median;
plot(ax, [baselineMedian, baselineMedian], [bottom, 0], '--', 'Color', colors.inkSecondary, 'LineWidth', 1);
text(ax, baselineMedian, 0.2, sprintf(' 全点計測の中央値 %.3g nm', baselineMedian), 'VerticalAlignment', 'bottom', 'FontSize', 8, 'Color', colors.inkSecondary);
for k = 1:numel(rows)
    if isfinite(rows(k).stats.median)
        drawDistribution(ax, rows(k), positions(k), style, logScale);
    end
end
set(ax, 'YTick', flip(positions), 'YTickLabel', flip({rows.label}), 'FontSize', 8, 'TickLength', [0, 0], 'YColor', colors.inkSecondary);
xlabel(ax, sprintf('Waferごとの残差 %s（%s）[nm]', metric, upper(axisName)));
grid(ax, 'on');
set(ax, 'YGrid', 'off', 'GridColor', colors.grid, 'GridAlpha', 1, 'Layer', 'top', 'Box', 'off');
if logScale
    % 対数の目盛りは 1・2・5 × 10のべき に、数字はそのまま（0.2 など）で書く
    ticks = niceLogTicks(low, high);
    set(ax, 'XTick', ticks, 'XTickLabel', arrayfun(@(value) sprintf('%g', value), ticks, 'UniformOutput', false), 'XMinorTick', 'off', 'XMinorGrid', 'off');
end
legendHandles = gobjects(numel(output.variants), 1);
for v = 1:numel(output.variants)
    variant = output.variants(v);
    color = colors.series.(variant.family);
    if strcmp(variant.mode, 'embedded')
        legendHandles(v) = patch(ax, NaN, NaN, color, 'FaceAlpha', 0.3, 'EdgeColor', color, 'LineWidth', 1.5);
    else
        legendHandles(v) = patch(ax, NaN, NaN, color, 'EdgeColor', 'none');
    end
end
legend(ax, legendHandles, {output.variants.label}, 'Location', 'southoutside', 'Orientation', 'horizontal', 'Box', 'off', 'FontSize', 8);
hold(ax, 'off');
end

function style = chartStyle()
% 分布の図の寸法（行の間隔を1とした大きさ）と、点で描くかの境目の値の数
style.violinHalfHeight = 0.4;
style.boxHalfHeight = 0.13;
style.dotSpread = 0.3;
style.minViolinCount = 20;
style.densitySteps = 64;
style.groupHeaderHeight = 0.7;
style.paddingRatio = 0.05;
% 点をずらす量を決める数（黄金比の小数部。点が上下に均等に散らばる）
style.goldenFraction = 0.6180339887;
end

function [low, high] = valueRange(rows, style, logScale)
low = Inf;
high = -Inf;
for k = 1:numel(rows)
    stats = rows(k).stats;
    finite = sort(rows(k).values(isfinite(rows(k).values)));
    if numel(finite) < style.minViolinCount && ~isempty(finite)
        low = min(low, finite(1));
        high = max(high, finite(end));
    elseif isfinite(stats.p5)
        low = min(low, stats.p5);
        high = max(high, stats.p95);
    end
end
if ~isfinite(low)
    low = 0;
    high = 1;
elseif logScale && low > 0
    low = low / (1 + style.paddingRatio * 4);
    high = high * (1 + style.paddingRatio * 4);
else
    padding = max((high - low) * style.paddingRatio, eps);
    if low >= 0
        % 残差などの指標は0以上なので、余白で負の側へはみ出さない
        low = max(0, low - padding);
    else
        low = low - padding;
    end
    high = high + padding;
end
end

function ticks = niceLogTicks(low, high)
ticks = [];
for exponent = floor(log10(low)) - 1:ceil(log10(high)) + 1
    for factor = [1, 2, 5]
        value = factor * 10 ^ exponent;
        if value >= low * (1 - 1e-9) && value <= high * (1 + 1e-9)
            ticks(end + 1) = value; %#ok<AGROW>
        end
    end
end
end

function drawDistribution(ax, row, position, style, logScale)
% 1行の分布: 分布の形（薄い山）か値の点、5〜95%点の線、25〜75%点の太い棒、中央値の白丸
color = row.color;
stats = row.stats;
values = sort(row.values(isfinite(row.values)));
if logScale
    values = values(values > 0);
end
if numel(values) >= style.minViolinCount
    if logScale
        transformed = log10(values);
    else
        transformed = values;
    end
    [grid, height] = densityOutline(transformed, style);
    if ~isempty(grid)
        if logScale
            xs = 10 .^ grid;
        else
            xs = grid;
        end
        upper = position + height * style.violinHalfHeight;
        lower = position - height * style.violinHalfHeight;
        patch(ax, [xs, fliplr(xs)], [upper, fliplr(lower)], color, 'FaceAlpha', 0.16, 'EdgeColor', color, 'EdgeAlpha', 0.55, 'LineWidth', 0.8);
    end
else
    offsets = (mod((0:numel(values) - 1) * style.goldenFraction, 1) - 0.5) * 2 * style.dotSpread;
    scatter(ax, values, position + offsets, 14, color, 'filled', 'MarkerFaceAlpha', 0.6, 'MarkerEdgeColor', 'w', 'LineWidth', 0.5);
end
plot(ax, [stats.p5, stats.p95], [position, position], '-', 'Color', color, 'LineWidth', 2);
if row.outlined
    faceAlpha = 0.3;
else
    faceAlpha = 1;
end
patch(ax, [stats.p25, stats.p75, stats.p75, stats.p25], position + style.boxHalfHeight * [-1, -1, 1, 1], color, ...
    'FaceAlpha', faceAlpha, 'EdgeColor', color, 'LineWidth', 1.2);
plot(ax, stats.median, position, 'o', 'MarkerSize', 5, 'MarkerFaceColor', 'w', 'MarkerEdgeColor', color, 'LineWidth', 1.4);
end

function [grid, height] = densityOutline(values, style)
% 分布の形（ガウス核の密度推定）。帯域幅はシルバーマンの目安（標準偏差と四分位範囲の小さいほうを使う）
values = values(:)';
count = numel(values);
grid = [];
height = [];
spread = values(floor(0.75 * (count - 1)) + 1) - values(floor(0.25 * (count - 1)) + 1);
deviation = std(values);
robust = min(deviation, spread / 1.34);
if robust == 0
    robust = deviation;
end
bandwidth = 0.9 * robust * count ^ (-0.2);
if ~(bandwidth > 0) || ~(values(end) > values(1))
    return
end
grid = linspace(values(1), values(end), style.densitySteps + 1);
density = sum(exp(-0.5 * ((grid' - values) / bandwidth) .^ 2), 2)';
height = density / max(density);
end
