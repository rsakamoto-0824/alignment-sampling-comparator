function waferMap = generateWaferMap(mapSettings)
%GENERATEWAFERMAP 設定からWaferマップを生成する。Shotは上の行から下へ、各行は左から右へ番号（'1','2',…）を付ける。

C = asc.constants();
width = mapSettings.shotWidthMm;
height = mapSettings.shotHeightMm;
if ~(width > 0 && height > 0)
    error('asc:invalidSettings', 'Shotの幅と高さは0より大きい値にしてください。');
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
waferMap.shotIds = arrayfun(@(index) sprintf('%d', index), (1:numel(waferMap.shotIds))', 'UniformOutput', false);
if isempty(waferMap.shotIds)
    error('asc:invalidSettings', '有効範囲に入るMarkがありません。Shotの配置か有効半径を見直してください。');
end
end

function scan = scanFromPattern(pattern, column, row, C)
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
