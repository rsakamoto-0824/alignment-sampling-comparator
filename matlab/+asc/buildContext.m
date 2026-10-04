function context = buildContext(waferMap, settings)
%BUILDCONTEXT 候補・区画・中心の1点をまとめた「サンプリングの前提」。設定の誤りはエラーで知らせる。
%   候補（item）: 選べるShot（必ず測るMarkがすべて有効範囲にあるShot）
%   区画（class）: 制約ごとの分け方。制約は「選んだShotの数」で数え、区画はShot中心で判定する
%   番号（item・Mark・Shot・区画）はすべて1始まり。

C = asc.constants();
sampling = settings.sampling;
zones = settings.zones;
errors = {};
if ~(zones.innerRadiusMm > 0 && zones.outerRadiusMm > zones.innerRadiusMm && zones.outerRadiusMm < waferMap.validRadiusMm)
    errors{end + 1} = sprintf('同心円の区切りは 0 < 内側 < 外側 < 有効半径（%g mm）にしてください。', waferMap.validRadiusMm);
end
if isempty(sampling.designatedMarkNos)
    errors{end + 1} = '必ず測るMarkを1つ以上選んでください。';
end
priorities = [];
for k = 1:numel(C.CONSTRAINT_KEYS)
    setting = settings.constraints.(C.CONSTRAINT_KEYS{k});
    if setting.enabled
        priorities(end + 1) = setting.priority; %#ok<AGROW>
    end
end
if numel(unique(priorities)) ~= numel(priorities)
    errors{end + 1} = 'オンにした制約の優先度が重複しています。';
end
raiseIfAny(errors);

designatedNos = unique(sampling.designatedMarkNos(:))';
items = struct('shotIndex', {}, 'x', {}, 'y', {}, 'scan', {}, 'designatedMarks', {}, 'otherMarks', {});
for shot = 1:numel(waferMap.shotIds)
    shotMarks = waferMap.shotMarkIndices{shot};
    [present, location] = ismember(designatedNos, waferMap.markNo(shotMarks));
    if ~all(present)
        continue
    end
    designated = shotMarks(location);
    others = shotMarks(~ismember(shotMarks, designated));
    items(end + 1) = struct('shotIndex', shot, 'x', waferMap.shotX(shot), 'y', waferMap.shotY(shot), ...
        'scan', waferMap.shotScan{shot}, 'designatedMarks', designated, 'otherMarks', others); %#ok<AGROW>
end

shotCount = sampling.shotCount;
exact = strcmp(sampling.markMode, 'exact');
perShot = numel(designatedNos);
if exact
    total = shotCount * perShot;
else
    total = sampling.totalMarkCount;
end
extra = total - shotCount * perShot;
if isempty(items)
    errors{end + 1} = '必ず測るMarkがすべて有効範囲にあるShotがありません。';
elseif shotCount > numel(items)
    errors{end + 1} = sprintf('計測Shot数（%d）が選べるShot数（%d）を超えています。', shotCount, numel(items));
end
if ~exact && extra < 0
    errors{end + 1} = sprintf('総Mark数は「計測Shot数 × 必ず測るMarkの数」（%d）以上にしてください。', shotCount * perShot);
end
raiseIfAny(errors);

context = struct();
context.map = waferMap;
context.items = items;
context.itemXY = [[items.x]', [items.y]'];
context.designatedNos = designatedNos;
context.markCountPerShot = perShot;
context.shotCount = shotCount;
context.totalMarkCount = total;
context.extraMarkCount = extra;
context.exactMode = exact;
context.constraints = buildBalanceConstraints(items, settings, C);
context.center = buildCenter(waferMap, items, settings.constraints.center, extra > 0);
context.softStrength = settings.constraints.softStrength;
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

function center = buildCenter(waferMap, items, setting, allowExtra)
% 中心に最も近いMark（追加のMarkを測らないときは必ず測るMarkの中から）
center = struct('enabled', logical(setting.enabled), 'active', logical(setting.enabled), 'hard', true, ...
    'priority', setting.priority, 'itemIndex', 0, 'markIndex', 0, 'isDesignated', false);
if ~setting.enabled
    return
end
bestDistance = Inf;
for itemIndex = 1:numel(items)
    candidates = items(itemIndex).designatedMarks;
    if allowExtra
        candidates = [candidates, items(itemIndex).otherMarks]; %#ok<AGROW>
    end
    for markIndex = candidates
        distance = hypot(waferMap.markX(markIndex), waferMap.markY(markIndex));
        if distance < bestDistance
            bestDistance = distance;
            center.itemIndex = itemIndex;
            center.markIndex = markIndex;
            center.isDesignated = ismember(markIndex, items(itemIndex).designatedMarks);
        end
    end
end
end
