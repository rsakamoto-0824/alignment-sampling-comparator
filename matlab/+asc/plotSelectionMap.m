function ax = plotSelectionMap(waferMap, selectionSet, titleText, zones, ax)
%PLOTSELECTIONMAP Waferマップに、選んだShot（塗り）・測るMark（濃い点）・Scan方向（▲▼）を描く。
%   selectionSet は output.sets(s)（shotIndices, markIndices を持つ構造体）。zones を渡すと同心円の区切りも描く。

if nargin < 3, titleText = ''; end
if nargin < 4, zones = []; end
if nargin < 5 || isempty(ax), ax = gca; end
C = asc.constants();
colors = asc.plotColors();
hold(ax, 'on');
width = waferMap.shotWidthMm;
height = waferMap.shotHeightMm;
selected = false(numel(waferMap.shotIds), 1);
measured = false(numel(waferMap.markX), 1);
if ~isempty(selectionSet)
    selected(selectionSet.shotIndices) = true;
    measured(selectionSet.markIndices) = true;
end
for shot = 1:numel(waferMap.shotIds)
    fill = [1, 1, 1];
    if selected(shot)
        fill = colors.selectedFill;
    end
    rectangle(ax, 'Position', [waferMap.shotX(shot) - width / 2, waferMap.shotY(shot) - height / 2, width, height], ...
        'FaceColor', fill, 'EdgeColor', colors.shotEdge, 'LineWidth', 0.4);
    if strcmp(waferMap.shotScan{shot}, C.SCAN_UP)
        arrow = '▲';
    else
        arrow = '▼';
    end
    text(ax, waferMap.shotX(shot), waferMap.shotY(shot), arrow, 'HorizontalAlignment', 'center', 'FontSize', 5, 'Color', colors.guide);
end
plot(ax, waferMap.markX(~measured), waferMap.markY(~measured), 'o', 'MarkerSize', 2, 'MarkerEdgeColor', colors.guide, 'MarkerFaceColor', 'w');
plot(ax, waferMap.markX(measured), waferMap.markY(measured), 'o', 'MarkerSize', 3.5, 'MarkerEdgeColor', colors.measured, 'MarkerFaceColor', colors.measured);
drawWafer(ax, zones, C, colors);
title(ax, titleText);
hold(ax, 'off');
end

function drawWafer(ax, zones, C, colors)
angle = linspace(0, 2 * pi, 361);
plot(ax, C.WAFER_RADIUS_MM * cos(angle), C.WAFER_RADIUS_MM * sin(angle), '-', 'Color', colors.waferEdge, 'LineWidth', 1);
if ~isempty(zones)
    for radius = [zones.innerRadiusMm, zones.outerRadiusMm]
        plot(ax, radius * cos(angle), radius * sin(angle), '--', 'Color', colors.guide, 'LineWidth', 0.6);
    end
end
limit = C.WAFER_RADIUS_MM + 12;
plot(ax, [-limit, limit], [0, 0], '-', 'Color', colors.guide, 'LineWidth', 0.5);
plot(ax, [0, 0], [-limit, limit], '-', 'Color', colors.guide, 'LineWidth', 0.5);
axis(ax, 'equal');
xlim(ax, [-limit, limit]);
ylim(ax, [-limit, limit]);
xlabel(ax, 'X [mm]');
ylabel(ax, 'Y [mm]');
box(ax, 'on');
end
