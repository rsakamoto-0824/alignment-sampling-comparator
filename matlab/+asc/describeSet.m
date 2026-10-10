function entry = describeSet(context, modelSettings, plan, selection)
%DESCRIBESET 選んだ点の情報（Shot数・Mark数・最小間隔・D/I基準・制約の満たし具合）をまとめる。
%   plan は method と draw を持つ構造体。制約の満たし具合は、制約なしの選び方でも context の制約で判定する。

markIndices = unique(selection.markIndices);
warnings = {};
if isfield(selection, 'notEligible') && ~isempty(selection.notEligible)
    warnings{end + 1} = sprintf('手動プランの、選べないShot（除外Shot・Markが揃わない端のShot）%d個は、評価から外しました。', numel(selection.notEligible));
end
shotIndices = [context.items(selection.items).shotIndex];
entry = struct('method', plan.method, 'draw', plan.draw, 'items', selection.items, 'shotIndices', shotIndices, ...
    'markIndices', markIndices(:)', 'minSpacingMm', asc.minimumShotSpacing(context, selection.items), ...
    'criteria', criteriaOf(context.map, markIndices, modelSettings), ...
    'status', asc.describeStatus(context, selection.items, markIndices), ...
    'results', [], 'estimation', [], 'estimationSquares', [], 'gpChoices', []);
entry.warnings = warnings;
end

function criteria = criteriaOf(waferMap, markIndices, modelSettings)
% X・YのD基準・I基準（項が同じなら同じ計算を使い回す）
x = asc.designCriteria(waferMap, markIndices, modelSettings.termsX(:)');
same = isequal(modelSettings.termsX(:), modelSettings.termsY(:));
if same
    y = x;
else
    y = asc.designCriteria(waferMap, markIndices, modelSettings.termsY(:)');
end
criteria = struct('x', x, 'y', y, 'sameTerms', same);
end
