function spacing = minimumShotSpacing(context, selectedItems)
%MINIMUMSHOTSPACING 選んだShotの中心どうしの最小間隔 [mm]。

positions = context.itemXY(selectedItems, :);
if size(positions, 1) < 2
    spacing = Inf;
    return
end
distances = hypot(positions(:, 1) - positions(:, 1)', positions(:, 2) - positions(:, 2)');
distances(logical(eye(size(positions, 1)))) = Inf;
spacing = min(distances(:));
end
