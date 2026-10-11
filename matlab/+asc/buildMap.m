function waferMap = buildMap(records, options)
%BUILDMAP Shot・Markの記録からWaferマップを組み立てる（生成・CSV読込・計測データのファイルで共通）。
%   records(k): id, x, y, scan, marks（markNo, localX, localY の構造体配列。invalid があれば無効マークか）
%   有効範囲（r < 有効半径）の、無効でないMarkだけを入れる。番号はすべて1始まり。
%
%   waferMap のおもな項目
%     shotIds（cell）, shotX, shotY, shotScan（cell, 'Up'/'Down'）, shotMarkIndices（cell）  … Shotごと
%     shotDefinedMarkCount  … Shotに定義したMarkの数（有効範囲外も含む）。有効なMarkより多ければ「Markが揃わない端のShot」
%     markX, markY（Wafer座標 [mm]）, markU, markV（正規化座標）, markShot, markNo  … Markごと
%     invalidMarkShotIds（cell）, invalidMarkNo, invalidMarkX, invalidMarkY  … 無効マーク（計測データのファイルで、
%       どれかのWaferで測れていないMark。計測の対象にせず、表示だけ）
%     inactiveShotIds（cell）, inactiveShotX, inactiveShotY  … 有効範囲の中のMarkがすべて無効マークのShot（表示だけ）

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
invalidMarkShotIds = cell(0, 1);
invalidMarkNo = zeros(0, 1);
invalidMarkX = zeros(0, 1);
invalidMarkY = zeros(0, 1);
inactiveShotIds = cell(0, 1);
inactiveShotX = zeros(0, 1);
inactiveShotY = zeros(0, 1);
excludedMarks = 0;
excludedShots = 0;
for k = 1:numel(records)
    record = records(k);
    x = record.x + [record.marks.localX];
    y = record.y + [record.marks.localY];
    inside = hypot(x, y) < validRadius;
    if isfield(record.marks, 'invalid')
        invalid = logical([record.marks.invalid]);
    else
        invalid = false(size(inside));
    end
    valid = inside & ~invalid;
    invalidInside = inside & invalid;
    if any(invalidInside)
        [invalidNumbers, invalidOrder] = sort([record.marks(invalidInside).markNo]);
        invalidX = x(invalidInside);
        invalidY = y(invalidInside);
        invalidMarkShotIds = [invalidMarkShotIds; repmat({char(string(record.id))}, numel(invalidNumbers), 1)]; %#ok<AGROW>
        invalidMarkNo = [invalidMarkNo; invalidNumbers(:)]; %#ok<AGROW>
        invalidMarkX = [invalidMarkX; reshape(invalidX(invalidOrder), [], 1)]; %#ok<AGROW>
        invalidMarkY = [invalidMarkY; reshape(invalidY(invalidOrder), [], 1)]; %#ok<AGROW>
    end
    if ~any(valid)
        if any(invalidInside)
            inactiveShotIds{end + 1, 1} = char(string(record.id)); %#ok<AGROW>
            inactiveShotX(end + 1, 1) = record.x; %#ok<AGROW>
            inactiveShotY(end + 1, 1) = record.y; %#ok<AGROW>
        else
            excludedShots = excludedShots + 1;
        end
        continue
    end
    excludedMarks = excludedMarks + numel(record.marks) - nnz(valid) - nnz(invalidInside);
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
waferMap.invalidMarkShotIds = invalidMarkShotIds;
waferMap.invalidMarkNo = invalidMarkNo;
waferMap.invalidMarkX = invalidMarkX;
waferMap.invalidMarkY = invalidMarkY;
waferMap.inactiveShotIds = inactiveShotIds;
waferMap.inactiveShotX = inactiveShotX;
waferMap.inactiveShotY = inactiveShotY;
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
