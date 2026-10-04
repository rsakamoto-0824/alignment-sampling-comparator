function plans = manualPlanInputs(manual, waferMap, onlyIncluded)
%MANUALPLANINPUTS 設定JSONの手動プラン（loaded.manual）を、評価に渡す形（マップ上の番号）に直す。
%   以前の形式（手動選択1つ: shotIds, marks）も読む。onlyIncluded（既定 true）なら「比較に含める」プランだけ。

C = asc.constants();
if nargin < 3
    onlyIncluded = true;
end
plans = struct('key', {}, 'label', {}, 'shotIndices', {}, 'extraMarkIndices', {});
if isempty(manual) || ~isstruct(manual)
    return
end
if isfield(manual, 'plans')
    entries = manual.plans;
    if isstruct(entries)
        entries = num2cell(entries);
    end
elseif isfield(manual, 'shotIds')
    single = manual;
    single.name = '手動1';
    single.included = true;
    entries = {single};
else
    return
end
for number = 1:numel(entries)
    entry = entries{number};
    if onlyIncluded && isfield(entry, 'included') && isequal(entry.included, false)
        continue
    end
    shotIds = textList(fieldOr(entry, 'shotIds', {}));
    [found, location] = ismember(shotIds, waferMap.shotIds');
    shotIndices = location(found);
    extra = zeros(1, 0);
    marks = fieldOr(entry, 'marks', []);
    if isstruct(marks)
        marks = num2cell(marks);
    end
    for k = 1:numel(marks)
        markShot = textList(marks{k}.shotId);
        shotIndex = find(strcmp(waferMap.shotIds, markShot{1}), 1);
        if isempty(shotIndex) || ~ismember(markShot{1}, shotIds)
            continue
        end
        shotMarks = waferMap.shotMarkIndices{shotIndex};
        extra = [extra, shotMarks(waferMap.markNo(shotMarks) == marks{k}.markNo)]; %#ok<AGROW>
    end
    name = fieldOr(entry, 'name', '');
    if isempty(name)
        name = sprintf('手動%d', number);
    end
    plans(end + 1) = struct('key', sprintf('%s%d', C.MANUAL_PREFIX, number), 'label', name, ...
        'shotIndices', shotIndices, 'extraMarkIndices', extra); %#ok<AGROW>
end
end

function value = fieldOr(entry, name, fallback)
if isfield(entry, name)
    value = entry.(name);
else
    value = fallback;
end
end

function texts = textList(values)
% ShotId の並び（文字や数が混ざっていても文字の cell の行にする）
if isnumeric(values)
    texts = arrayfun(@(value) sprintf('%d', value), values(:)', 'UniformOutput', false);
elseif ischar(values)
    texts = {values};
else
    texts = cellfun(@(value) char(string(value)), values(:)', 'UniformOutput', false);
end
end
