function context = buildContext(waferMap, settings)
%BUILDCONTEXT 候補・区画・中心の1点・強制計測Shotをまとめた「サンプリングの前提」。設定の誤りはエラーで知らせる。
%   候補（item）: 選べるShot（除外Shotと、設定によってはMarkが揃わない端のShotを除いたもの）。
%                 選んだShotでは、そのShotの有効なMarkをすべて測る（items(k).marks）
%   区画（class）: 制約ごとの分け方。制約は「選んだShotの数」で数え、区画はShot中心で判定する
%   強制計測Shot: 必ず選ぶShot（常にハード。context.mandatoryItems）。中心の1点のShotとあわせて入れ替えの対象にしない
%   番号（item・Mark・Shot・区画）はすべて1始まり。

C = asc.constants();
sampling = settings.sampling;
zones = settings.zones;
constraintSettings = settings.constraints;
errors = {};
if ~(zones.innerRadiusMm > 0 && zones.outerRadiusMm > zones.innerRadiusMm && zones.outerRadiusMm < waferMap.validRadiusMm)
    errors{end + 1} = sprintf('同心円の区切りは 0 < 内側 < 外側 < 有効半径（%g mm）にしてください。', waferMap.validRadiusMm);
end
if ~(isscalar(sampling.shotCount) && sampling.shotCount >= 1 && sampling.shotCount == floor(sampling.shotCount))
    errors{end + 1} = '計測Shot数は1以上の整数にしてください。';
end
priorities = [];
for k = 1:numel(C.CONSTRAINT_KEYS)
    setting = constraintSettings.(C.CONSTRAINT_KEYS{k});
    if setting.enabled
        priorities(end + 1) = setting.priority; %#ok<AGROW>
    end
end
if numel(unique(priorities)) ~= numel(priorities)
    errors{end + 1} = 'オンにした制約の優先度が重複しています。';
end
raiseIfAny(errors);

mandatoryIds = asc.shotIdList(fieldOr(constraintSettings, 'mandatoryShotIds', []));
excludedIds = asc.shotIdList(fieldOr(constraintSettings, 'excludedShotIds', []));
labels = {'強制計測Shot', '除外Shot'};
idLists = {mandatoryIds, excludedIds};
for k = 1:2
    unknown = idLists{k}(~ismember(idLists{k}, waferMap.shotIds));
    if ~isempty(unknown)
        errors{end + 1} = sprintf('%sの番号 %s がマップにありません。', labels{k}, strjoin(unknown(1:min(8, end)), ', ')); %#ok<AGROW>
    end
end
[~, excludedShots] = ismember(excludedIds, waferMap.shotIds);
excludedShots = excludedShots(excludedShots > 0);
incomplete = cellfun(@numel, waferMap.shotMarkIndices) < waferMap.shotDefinedMarkCount;

items = struct('shotIndex', {}, 'x', {}, 'y', {}, 'scan', {}, 'marks', {});
itemOfShot = zeros(numel(waferMap.shotIds), 1);
for shot = 1:numel(waferMap.shotIds)
    if ismember(shot, excludedShots) || (sampling.excludeIncompleteShots && incomplete(shot))
        continue
    end
    items(end + 1) = struct('shotIndex', shot, 'x', waferMap.shotX(shot), 'y', waferMap.shotY(shot), ...
        'scan', waferMap.shotScan{shot}, 'marks', waferMap.shotMarkIndices{shot}); %#ok<AGROW>
    itemOfShot(shot) = numel(items);
end

mandatoryItems = zeros(1, 0);
for k = 1:numel(mandatoryIds)
    shot = find(strcmp(waferMap.shotIds, mandatoryIds{k}), 1);
    if isempty(shot)
        continue
    end
    if ismember(shot, excludedShots)
        errors{end + 1} = sprintf('Shot %s が強制計測Shotと除外Shotの両方に入っています。', mandatoryIds{k}); %#ok<AGROW>
    elseif itemOfShot(shot) == 0
        errors{end + 1} = sprintf('強制計測Shot %s はMarkが揃わない端のShotなので選べません。', mandatoryIds{k}); %#ok<AGROW>
    else
        mandatoryItems(end + 1) = itemOfShot(shot); %#ok<AGROW>
    end
end
mandatoryItems = sort(mandatoryItems);

shotCount = sampling.shotCount;
if isempty(items)
    errors{end + 1} = '選べるShotがありません。除外Shotや有効半径を見直してください。';
elseif shotCount > numel(items)
    errors{end + 1} = sprintf('計測Shot数（%d）が選べるShot数（%d）を超えています。', shotCount, numel(items));
end
raiseIfAny(errors);

center = buildCenter(waferMap, items, constraintSettings.center);
forced = mandatoryItems;
if center.active
    forced = union(forced, center.itemIndex);
end
if numel(forced) > shotCount
    error('asc:invalidSettings', '強制計測Shot（中心の1点のShotを含む）が%d個あり、計測Shot数（%d）を超えています。', numel(forced), shotCount);
end

context = struct();
context.map = waferMap;
context.items = items;
context.itemXY = [[items.x]', [items.y]'];
context.shotCount = shotCount;
context.constraints = buildBalanceConstraints(items, settings, C);
context.center = center;
context.mandatoryItems = mandatoryItems;
context.softStrength = constraintSettings.softStrength;
end

function value = fieldOr(entry, name, fallback)
if isfield(entry, name)
    value = entry.(name);
else
    value = fallback;
end
end

function raiseIfAny(errors)
if ~isempty(errors)
    error('asc:invalidSettings', '%s', strjoin(errors, newline));
end
end

function constraints = buildBalanceConstraints(items, settings, C)
zones = settings.zones;
inner = zones.innerRadiusMm;
outer = zones.outerRadiusMm;
x = [items.x]';
y = [items.y]';
constraints = struct('key', {}, 'label', {}, 'classCount', {}, 'classLabels', {}, 'classShortLabels', {}, ...
    'classOf', {}, 'available', {}, 'allocation', {}, 'hard', {}, 'priority', {}, 'weight', {});
for key = {'scan', 'quadrant', 'zone'}
    setting = settings.constraints.(key{1});
    if ~setting.enabled
        continue
    end
    switch key{1}
        case 'scan'
            labels = {'Up', 'Down'};
            shortLabels = {'Up', 'Down'};
            classes = 2 - strcmp({items.scan}', C.SCAN_UP);
        case 'quadrant'
            labels = {'第1象限（x≧0, y≧0）', '第2象限（x<0, y≧0）', '第3象限（x<0, y<0）', '第4象限（x≧0, y<0）'};
            shortLabels = {'第1', '第2', '第3', '第4'};
            classes = zeros(numel(items), 1);
            classes(y >= 0 & x >= 0) = 1;
            classes(y >= 0 & x < 0) = 2;
            classes(y < 0 & x < 0) = 3;
            classes(y < 0 & x >= 0) = 4;
        otherwise
            labels = {sprintf('内側（r < %g mm）', inner), sprintf('中間（%g〜%g mm）', inner, outer), sprintf('外側（r ≧ %g mm）', outer)};
            shortLabels = {'内側', '中間', '外側'};
            radius = hypot(x, y);
            classes = 1 + (radius >= inner) + (radius >= outer);
    end
    classCount = numel(labels);
    available = zeros(classCount, 1);
    for c = 1:classCount
        available(c) = nnz(classes == c);
    end
    weight = 1;
    if any(setting.priority == 1:numel(C.PRIORITY_WEIGHTS))
        weight = C.PRIORITY_WEIGHTS(setting.priority);
    end
    constraints(end + 1) = struct('key', key{1}, 'label', C.CONSTRAINT_LABELS.(key{1}), 'classCount', classCount, ...
        'classLabels', {labels}, 'classShortLabels', {shortLabels}, 'classOf', classes, 'available', available, ...
        'allocation', setting.allocation, 'hard', logical(setting.hard), 'priority', setting.priority, 'weight', weight); %#ok<AGROW>
end
end

function center = buildCenter(waferMap, items, setting)
% 中心に最も近いMark（選べるShotの全Markから探す）。そのMarkのShotを必ず選ぶ
center = struct('enabled', logical(setting.enabled), 'active', logical(setting.enabled), 'hard', true, ...
    'priority', setting.priority, 'itemIndex', 0, 'markIndex', 0);
if ~setting.enabled
    return
end
bestDistance = Inf;
for itemIndex = 1:numel(items)
    for markIndex = items(itemIndex).marks
        distance = hypot(waferMap.markX(markIndex), waferMap.markY(markIndex));
        if distance < bestDistance
            bestDistance = distance;
            center.itemIndex = itemIndex;
            center.markIndex = markIndex;
        end
    end
end
end
