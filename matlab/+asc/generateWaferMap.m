function waferMap = generateWaferMap(mapSettings)
%GENERATEWAFERMAP 設定からWaferマップを生成する。Shotは上の行から下へ、各行は左から右へ番号（'1','2',…）を付ける。

C = asc.constants();
width = mapSettings.shotWidthMm;
height = mapSettings.shotHeightMm;
if ~(width > 0 && height > 0)
    error('asc:invalidSettings', 'Shotの幅と高さは0より大きい値にしてください。');
end
isSerpentine = strcmp(mapSettings.scanPattern, 'serpentine');
if isSerpentine
    if ~any(strcmp(mapSettings.serpentineStart, C.SERPENTINE_STARTS))
        error('asc:invalidSettings', '一筆書きの開始の角を選んでください。');
    end
    if ~any(strcmp(mapSettings.serpentineFirstScan, {C.SCAN_UP, C.SCAN_DOWN}))
        error('asc:invalidSettings', '一筆書きの最初のScan方向は Up か Down にしてください。');
    end
end
reach = C.WAFER_RADIUS_MM + max(width, height);
columnLimit = ceil((reach + abs(mapSettings.offsetXmm)) / width);
rowLimit = ceil((reach + abs(mapSettings.offsetYmm)) / height);
localMarks = struct('markNo', {mapSettings.marks.markNo}, 'localX', {mapSettings.marks.x}, 'localY', {mapSettings.marks.y});
rows = rowLimit:-1:-rowLimit;
columns = -columnLimit:columnLimit;
records = repmat(struct('id', '', 'x', 0, 'y', 0, 'scan', '', 'marks', localMarks), numel(rows) * numel(columns), 1);
k = 0;
for row = rows
    for column = columns
        k = k + 1;
        records(k).x = mapSettings.offsetXmm + column * width;
        records(k).y = mapSettings.offsetYmm + row * height;
        records(k).scan = scanFromPattern(mapSettings.scanPattern, column, row, C);
    end
end
waferMap = asc.buildMap(records, mapSettings);
waferMap.excludedShotCount = 0;
if isSerpentine
    waferMap.shotScan = serpentineScan(waferMap.shotY, mapSettings.serpentineStart, mapSettings.serpentineFirstScan, C);
end
waferMap.shotIds = arrayfun(@(index) sprintf('%d', index), (1:numel(waferMap.shotIds))', 'UniformOutput', false);
if isempty(waferMap.shotIds)
    error('asc:invalidSettings', '有効範囲に入るMarkがありません。Shotの配置か有効半径を見直してください。');
end
end

function scans = serpentineScan(shotY, start, firstScan, C)
% 一筆書き（露光順）のScan方向（ブラウザ版の assignSerpentineScan と同じ）。
% Shotは生成した順（上の行から下へ、各行は左から右へ）に並んでいる。開始の角の行から、行ごとに進む向きを
% 反転しながらたどり、たどった順に firstScan・その逆・firstScan… と付ける（マップにあるShotだけを数える）
rowStarts = [1; find(diff(shotY) ~= 0) + 1];
rowEnds = [rowStarts(2:end) - 1; numel(shotY)];
rowOrder = 1:numel(rowStarts);
if any(strcmp(start, {'bottomLeft', 'bottomRight'}))
    rowOrder = fliplr(rowOrder);
end
firstLeftToRight = any(strcmp(start, {'topLeft', 'bottomLeft'}));
if strcmp(firstScan, C.SCAN_UP)
    otherScan = C.SCAN_DOWN;
else
    otherScan = C.SCAN_UP;
end
scans = cell(numel(shotY), 1);
order = 0;
for k = 1:numel(rowOrder)
    row = rowStarts(rowOrder(k)):rowEnds(rowOrder(k));
    if mod(k - 1, 2) == 1
        leftToRight = ~firstLeftToRight;
    else
        leftToRight = firstLeftToRight;
    end
    if ~leftToRight
        row = fliplr(row);
    end
    for shot = row
        if mod(order, 2) == 0
            scans{shot} = firstScan;
        else
            scans{shot} = otherScan;
        end
        order = order + 1;
    end
end
end

function scan = scanFromPattern(pattern, column, row, C)
% 格子の位置で決まる並べ方のScan方向（一筆書きは、マップを作ったあとで serpentineScan が決める）
switch pattern
    case 'column'
        isUp = mod(column, 2) == 0;
    case 'row'
        isUp = mod(row, 2) == 0;
    case 'allUp'
        isUp = true;
    otherwise
        isUp = mod(column + row, 2) == 0;
end
if isUp
    scan = C.SCAN_UP;
else
    scan = C.SCAN_DOWN;
end
end
