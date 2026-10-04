function colors = plotColors()
%PLOTCOLORS 図の色（ブラウザ版・Python版と同じ）。RGB は 0〜1。

hex = @(text) sscanf(text(2:end), '%2x%2x%2x', [1, 3]) / 255;
colors.series = struct('howa', hex('#2a78d6'), 'rbfXY', hex('#eb6834'), 'rbfXYR', hex('#1baf7a'), ...
    'gpXY', hex('#eda100'), 'gpXYR', hex('#e87ba4'));
colors.methods = struct('random', hex('#6b6a65'), 'poisson', hex('#008300'), 'dOptimal', hex('#4a3aa7'), 'iOptimal', hex('#e34948'));
colors.methodMarkers = struct('random', 'o', 'poisson', 's', 'dOptimal', '^', 'iOptimal', 'd');
colors.selectedFill = hex('#cfe0f7');
colors.measured = hex('#0d366b');
colors.waferEdge = hex('#4a4945');
colors.guide = hex('#6b6a65');
colors.shotEdge = hex('#a3a29a');
colors.grid = hex('#e1e0d9');
end
