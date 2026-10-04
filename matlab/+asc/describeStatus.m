function status = describeStatus(context, selectedItems, measuredMarks)
%DESCRIBESTATUS 選択の制約の満たし具合。ずれ = 外れた数の合計 ÷ 2（切り上げ。何個のShotを移せば満たせるか）。
%   status.rows（制約ごと: key, label, hard, priority, ok, shift, classes）と status.center（中心の1点。オフなら []）。

C = asc.constants();
total = numel(selectedItems);
rows = struct('key', {}, 'label', {}, 'hard', {}, 'priority', {}, 'ok', {}, 'shift', {}, 'classes', {});
for index = 1:numel(context.constraints)
    constraint = context.constraints(index);
    counts = zeros(constraint.classCount, 1);
    selectedClasses = constraint.classOf(selectedItems);
    for c = 1:constraint.classCount
        counts(c) = nnz(selectedClasses == c);
    end
    [floorCounts, ceilCounts] = asc.targetsFor(constraint, total);
    inRange = floorCounts <= counts & counts <= ceilCounts;
    classes = struct('label', constraint.classLabels(:), 'shortLabel', constraint.classShortLabels(:), ...
        'count', num2cell(counts), 'floor', num2cell(floorCounts), 'ceil', num2cell(ceilCounts), 'ok', num2cell(inRange));
    rows(end + 1) = struct('key', constraint.key, 'label', constraint.label, 'hard', constraint.hard, ...
        'priority', constraint.priority, 'ok', all(inRange), ...
        'shift', ceil(asc.violationOf(counts, floorCounts, ceilCounts) / 2), 'classes', classes); %#ok<AGROW>
end
center = context.center;
centerRow = [];
if center.enabled
    included = ismember(center.markIndex, measuredMarks);
    centerRow = struct('key', 'center', 'label', C.CONSTRAINT_LABELS.center, 'hard', center.active, ...
        'priority', center.priority, 'ok', included, 'shift', double(~included));
end
status = struct('rows', rows, 'center', centerRow);
end
