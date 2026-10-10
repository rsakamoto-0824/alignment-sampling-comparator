function waferMap = buildMap(records, options)
%BUILDMAP Shot・Markの記録からWaferマップを組み立てる（生成とCSV読込で共通）。
%   records(k): id, x, y, scan, marks（markNo, localX, localY の構造体配列）
%   有効範囲（r < 有効半径）のMarkだけを入れる。番号はすべて1始まり。
%
%   waferMap のおもな項目
%     shotIds（cell）, shotX, shotY, shotScan（cell, 'Up'/'Down'）, shotMarkIndices（cell）  … Shotごと
%     shotDefinedMarkCount  … Shotに定義したMarkの数（有効範囲外も含む）。有効なMarkより多ければ「Markが揃わない端のShot」
%     markX, markY（Wafer座標 [mm]）, markU, markV（正規化座標）, markShot, markNo  … Markごと

C = asc.constants();
validRadius = options.validRadiusMm;
shotIds = {};
shotX = [];
shotY = [];
shotScan = {};
shotMarkIndices = {};
shotDefinedMarkCount = [];
markX = [];
markY = [];
markShot = [];
markNo = [];
excludedMarks = 0;
excludedShots = 0;
for k = 1:numel(records)
    record = records(k);
    x = record.x + [record.marks.localX];
    y = record.y + [record.marks.localY];
    valid = hypot(x, y) < validRadius;
    if ~any(valid)
        excludedShots = excludedShots + 1;
        continue
    end
    excludedMarks = excludedMarks + numel(record.marks) - nnz(valid);
    numbers = [record.marks.markNo];
    numbers = numbers(valid);
    x = x(valid);
    y = y(valid);
    [numbers, order] = sort(numbers);
    shotIndex = numel(shotIds) + 1;
    first = numel(markX) + 1;
    shotIds{end + 1, 1} = char(string(record.id)); %#ok<AGROW>
    shotX(end + 1, 1) = record.x; %#ok<AGROW>
    shotY(end + 1, 1) = record.y; %#ok<AGROW>
    shotScan{end + 1, 1} = record.scan; %#ok<AGROW>
    shotMarkIndices{end + 1, 1} = first:first + numel(numbers) - 1; %#ok<AGROW>
    shotDefinedMarkCount(end + 1, 1) = numel(record.marks); %#ok<AGROW>
    markX = [markX; x(order)']; %#ok<AGROW>
    markY = [markY; y(order)']; %#ok<AGROW>
    markShot = [markShot; repmat(shotIndex, numel(numbers), 1)]; %#ok<AGROW>
    markNo = [markNo; numbers']; %#ok<AGROW>
end
waferMap = struct();
waferMap.shotIds = shotIds;
waferMap.shotX = shotX;
waferMap.shotY = shotY;
waferMap.shotScan = shotScan;
waferMap.shotMarkIndices = shotMarkIndices;
waferMap.shotDefinedMarkCount = shotDefinedMarkCount;
waferMap.markX = markX;
waferMap.markY = markY;
waferMap.markU = markX / C.NORMALIZATION_RADIUS_MM;
waferMap.markV = markY / C.NORMALIZATION_RADIUS_MM;
waferMap.markShot = markShot;
waferMap.markNo = markNo;
waferMap.markNumbers = unique(markNo)';
waferMap.validRadiusMm = validRadius;
waferMap.shotWidthMm = fieldOr(options, 'shotWidthMm', []);
waferMap.shotHeightMm = fieldOr(options, 'shotHeightMm', []);
waferMap.excludedMarkCount = excludedMarks;
waferMap.excludedShotCount = excludedShots;
end

function value = fieldOr(options, name, fallback)
if isfield(options, name)
    value = options.(name);
else
    value = fallback;
end
end
