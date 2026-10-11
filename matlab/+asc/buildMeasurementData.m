function [waferMap, data, report] = buildMeasurementData(table, mapOptions)
%BUILDMEASUREMENTDATA 表（asc.readTableFile の形）から、Waferマップと評価データを作る（ブラウザ版の measurement-data.js と同じ）。
%   mapOptions: shotWidthMm, shotHeightMm, validRadiusMm（設定の map をそのまま渡せる）
%   誤りがあれば、行番号つきの説明でエラーにする。
%
%   列（項目名は大文字・小文字も含めてこのとおり。1行1Mark）:
%     必須: Wafer, shotNo, Direction, Xmm, Ymm, markNo, markXmm, markYmm, measX, measY
%     任意: DateTime, Radius, StsX, StsY
%   - Wafer と DateTime の組を1枚の評価Waferにする（ファイルに出てくる順）。Direction は 1 = Up、2 = Down
%   - StsX・StsY は 0 だけを有効とし、それ以外（-1 = 未測定）の値は使わない（0 とみなさない）
%   - Wafer・DateTime・Shot・Mark が同じ行は重複とみなし、X・Yそれぞれ有効な値を平均する
%   - どれかのWaferで、XかYが測れていないMarkは「無効マーク」にする（計測の対象にせず、評価にも使わない）
%   - data は乱数のデータと同じ形で、truthX・truthY（Wafer数 × Mark数）に計測値を入れ、ノイズは0にする
%
%   report: sheetName, rowCount, waferNames, duplicateRows, unmeasuredValues, radiusMismatch,
%           invalidMarks（shotId, markNo, missingWafers の構造体配列）, waferMissing（name, count の構造体配列）

C = asc.constants();
if ~(mapOptions.shotWidthMm > 0 && mapOptions.shotHeightMm > 0)
    error('asc:invalidSettings', 'Shotの幅と高さは0より大きい値にしてください。');
end
if ~(mapOptions.validRadiusMm > 0 && mapOptions.validRadiusMm <= C.WAFER_RADIUS_MM)
    error('asc:invalidSettings', '有効半径は0より大きく%d mm以下にしてください。', C.WAFER_RADIUS_MM);
end
[sheet, columnIndex] = findSheet(table, C);
errors = struct('messages', {{}}, 'count', 0);
[records, counts, errors] = readRecords(sheet, columnIndex, table.date1904, errors, C);
[grouped, errors] = groupRecords(records, errors, C);
if errors.count > 0
    messages = errors.messages;
    if errors.count > numel(messages)
        messages{end + 1} = sprintf('ほかに%d件の誤りがあります。', errors.count - numel(messages));
    end
    error('asc:invalidMeasurement', '%s', strjoin(messages, newline));
end
waferCount = numel(grouped.wafers);
if waferCount == 0
    error('asc:invalidMeasurement', 'データの行がありません。2行目から1行1Markで計測値を書いてください。');
end
if waferCount > C.MAX_WAFER_COUNT
    error('asc:invalidMeasurement', 'Waferが%d枚あります。%d枚以下にしてください。', waferCount, C.MAX_WAFER_COUNT);
end

% Markごとに、測れていないWaferの数を数える（有効範囲の外のMarkは使わないので数えない）
measured = grouped.countX > 0 & grouped.countY > 0;   % （値の番号）
waferMissing = zeros(waferCount, 1);
missingByMark = containers.Map('KeyType', 'char', 'ValueType', 'double');
[shotNos, shotOrder] = sort(grouped.shotNo);
records = struct('id', {}, 'x', {}, 'y', {}, 'scan', {}, 'marks', {});
for s = 1:numel(shotNos)
    shot = shotOrder(s);
    markRows = find(grouped.markShot == shot);
    [~, order] = sort(grouped.markNo(markRows));
    markRows = markRows(order);
    marks = struct('markNo', {}, 'localX', {}, 'localY', {}, 'invalid', {});
    for markRow = markRows(:)'
        inside = hypot(grouped.shotX(shot) + grouped.markLocalX(markRow), grouped.shotY(shot) + grouped.markLocalY(markRow)) < mapOptions.validRadiusMm;
        missing = 0;
        for wafer = 1:waferCount
            valueIndex = grouped.valueIndex(wafer, markRow);
            if valueIndex == 0 || ~measured(valueIndex)
                missing = missing + 1;
                if inside
                    waferMissing(wafer) = waferMissing(wafer) + 1;
                end
            end
        end
        missingByMark(sprintf('%d|%d', shotNos(s), grouped.markNo(markRow))) = missing;
        marks(end + 1) = struct('markNo', grouped.markNo(markRow), 'localX', grouped.markLocalX(markRow), ...
            'localY', grouped.markLocalY(markRow), 'invalid', missing > 0); %#ok<AGROW>
    end
    records(end + 1) = struct('id', sprintf('%d', shotNos(s)), 'x', grouped.shotX(shot), 'y', grouped.shotY(shot), ...
        'scan', grouped.shotScan{shot}, 'marks', marks); %#ok<AGROW>
end
waferMap = asc.buildMap(records, mapOptions);
if isempty(waferMap.shotIds)
    error('asc:invalidMeasurement', ['有効なMarkがありません（有効範囲の中のMarkが、どれかのWaferで測れていないか、範囲の外です）。' ...
        '座標の単位（mm）と有効半径、StsX・StsY を確かめてください。']);
end

markCount = numel(waferMap.markX);
truthX = zeros(waferCount, markCount);
truthY = zeros(waferCount, markCount);
markRowOf = containers.Map(grouped.markKeys, num2cell(1:numel(grouped.markKeys)));
for i = 1:markCount
    markRow = markRowOf(sprintf('%s|%d', waferMap.shotIds{waferMap.markShot(i)}, waferMap.markNo(i)));
    for wafer = 1:waferCount
        valueIndex = grouped.valueIndex(wafer, markRow);
        truthX(wafer, i) = grouped.sumX(valueIndex) / grouped.countX(valueIndex);
        truthY(wafer, i) = grouped.sumY(valueIndex) / grouped.countY(valueIndex);
    end
end
names = waferNamesOf(grouped.wafers);
data = struct();
data.source = C.DATA_SOURCE_FILE;
data.waferCount = waferCount;
data.markCount = markCount;
data.truthX = truthX;
data.truthY = truthY;
data.noiseX = zeros(waferCount, markCount);
data.noiseY = zeros(waferCount, markCount);
data.waferNames = names;

invalidMarks = struct('shotId', {}, 'markNo', {}, 'missingWafers', {});
for k = 1:numel(waferMap.invalidMarkNo)
    shotId = waferMap.invalidMarkShotIds{k};
    number = waferMap.invalidMarkNo(k);
    invalidMarks(end + 1) = struct('shotId', shotId, 'markNo', number, 'missingWafers', missingByMark(sprintf('%s|%d', shotId, number))); %#ok<AGROW>
end
missingWafers = find(waferMissing > 0);
report = struct();
report.sheetName = sheet.name;
report.rowCount = numel(grouped.recordLines);
report.waferNames = names;
report.duplicateRows = grouped.duplicateRows;
report.unmeasuredValues = counts.unmeasuredValues;
report.radiusMismatch = counts.radiusMismatch;
report.invalidMarks = invalidMarks;
report.waferMissing = struct('name', names(missingWafers), 'count', num2cell(waferMissing(missingWafers)));
end

% ---- 見出しと行 ---------------------------------------------------------------

function [sheet, columnIndex] = findSheet(table, C)
% 必須の列がすべてあるシートのうち、最初のものと列の位置（列の位置は0なら「列がない」）
allColumns = [C.MEASUREMENT_REQUIRED_COLUMNS, C.MEASUREMENT_OPTIONAL_COLUMNS];
firstMissing = {};
for k = 1:numel(table.sheets)
    sheet = table.sheets(k);
    if isempty(sheet.rows)
        continue
    end
    header = sheet.rows(1).cells;
    columnIndex = struct();
    for name = allColumns
        position = find(strcmp(header, name{1}), 1);
        if isempty(position)
            position = 0;
        end
        columnIndex.(name{1}) = position;
    end
    missing = C.MEASUREMENT_REQUIRED_COLUMNS(cellfun(@(name) columnIndex.(name) == 0, C.MEASUREMENT_REQUIRED_COLUMNS));
    if isempty(missing)
        return
    end
    if isempty(firstMissing)
        firstMissing = missing;
    end
end
if isempty(firstMissing)
    error('asc:invalidMeasurement', 'ファイルにデータの行がありません。1行目に見出し、2行目から1行1Markで計測値を書いてください。');
end
if numel(table.sheets) > 1
    where = 'どのシートの1行目にも';
else
    where = '1行目に';
end
error('asc:invalidMeasurement', '%s列「%s」がありません。\n見出しは %s（任意で %s）にしてください。大文字・小文字も同じにします。', ...
    where, strjoin(firstMissing, '」「'), strjoin(C.MEASUREMENT_REQUIRED_COLUMNS, ', '), strjoin(C.MEASUREMENT_OPTIONAL_COLUMNS, ', '));
end

function errors = addError(errors, message, C)
errors.count = errors.count + 1;
if numel(errors.messages) < C.MEASUREMENT_MAX_ERRORS
    errors.messages{end + 1} = message;
end
end

function value = parseNumber(text)
% 数値とみなす文字だけを数値にする（"1,000" や "inf" などは数値にしない。ブラウザ版・Python版と同じ判定）
if ~isempty(regexp(text, '^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$', 'once'))
    value = str2double(text);
else
    value = NaN;
end
end

function text = dateTimeText(text, date1904)
% DateTime の値。xlsxの日付は数値で入っているので、日時の文字（yyyy/mm/dd hh:mm:ss）に直す
value = parseNumber(text);
if ~isnan(value)
    text = asc.excelSerialText(value, date1904);
end
end

function usable = isUsable(statusText, hasStatus, value, C)
usable = ~isnan(value) && isfinite(value);
if hasStatus && parseNumber(statusText) ~= C.MEASUREMENT_VALID_STATUS
    usable = false;
end
end

function [records, counts, errors] = readRecords(sheet, columnIndex, date1904, errors, C)
counts = struct('unmeasuredValues', 0, 'radiusMismatch', 0);
rowCount = numel(sheet.rows) - 1;
records = struct('line', cell(rowCount, 1), 'wafer', '', 'dateTime', '', 'shotNo', 0, 'scan', '', 'x', 0, 'y', 0, ...
    'markNo', 0, 'markX', 0, 'markY', 0, 'measX', NaN, 'measY', NaN);
kept = false(rowCount, 1);
for r = 1:rowCount
    row = sheet.rows(r + 1);
    cells = row.cells;
    read = @(name) cellOr(cells, columnIndex.(name));
    line = row.line;
    rowHasError = false;
    wafer = read('Wafer');
    if isempty(wafer)
        errors = addError(errors, sprintf('%d行目: Wafer が空です。Waferを区別する値を入れてください。', line), C);
        rowHasError = true;
    end
    numbers = struct();
    for name = {'shotNo', 'Xmm', 'Ymm', 'markNo', 'markXmm', 'markYmm'}
        numbers.(name{1}) = parseNumber(read(name{1}));
        if isnan(numbers.(name{1}))
            errors = addError(errors, sprintf('%d行目: %s の「%s」が数値ではありません。半角の数値を入れてください。', line, name{1}, read(name{1})), C);
            rowHasError = true;
        end
    end
    if ~isnan(numbers.shotNo) && numbers.shotNo ~= floor(numbers.shotNo)
        errors = addError(errors, sprintf('%d行目: shotNo は整数にしてください。', line), C);
        rowHasError = true;
    end
    if ~isnan(numbers.markNo) && (numbers.markNo ~= floor(numbers.markNo) || numbers.markNo < 1)
        errors = addError(errors, sprintf('%d行目: markNo は1以上の整数にしてください。', line), C);
        rowHasError = true;
    end
    direction = parseNumber(read('Direction'));
    if any(direction == [1, 2])
        scan = C.MEASUREMENT_DIRECTIONS{direction};
    else
        errors = addError(errors, sprintf('%d行目: Direction の「%s」が読めません。1（Up）か 2（Down）にしてください。', line, read('Direction')), C);
        rowHasError = true;
    end
    if rowHasError
        continue
    end
    measX = parseNumber(read('measX'));
    measY = parseNumber(read('measY'));
    validX = isUsable(read('StsX'), columnIndex.StsX > 0, measX, C);
    validY = isUsable(read('StsY'), columnIndex.StsY > 0, measY, C);
    counts.unmeasuredValues = counts.unmeasuredValues + ~validX + ~validY;
    radius = parseNumber(read('Radius'));
    if ~isnan(radius) && abs(radius - hypot(numbers.Xmm, numbers.Ymm)) > C.MEASUREMENT_RADIUS_TOLERANCE_MM
        counts.radiusMismatch = counts.radiusMismatch + 1;
    end
    if ~validX
        measX = NaN;
    end
    if ~validY
        measY = NaN;
    end
    records(r) = struct('line', line, 'wafer', wafer, 'dateTime', dateTimeText(read('DateTime'), date1904), ...
        'shotNo', numbers.shotNo, 'scan', scan, 'x', numbers.Xmm, 'y', numbers.Ymm, 'markNo', numbers.markNo, ...
        'markX', numbers.markXmm, 'markY', numbers.markYmm, 'measX', measX, 'measY', measY);
    kept(r) = true;
end
records = records(kept);
end

function value = cellOr(cells, position)
if position >= 1 && position <= numel(cells)
    value = cells{position};
else
    value = '';
end
end

% ---- Wafer・Shot・Markにまとめる -----------------------------------------------

function [grouped, errors] = groupRecords(records, errors, C)
% 同じShot・Markの座標とScan方向が行で違えば誤り。値は（Wafer, Mark）ごとに有効な値の和と数をためる
waferIndexByKey = containers.Map('KeyType', 'char', 'ValueType', 'double');
shotIndexByNo = containers.Map('KeyType', 'double', 'ValueType', 'double');
markRowByKey = containers.Map('KeyType', 'char', 'ValueType', 'double');
grouped = struct('wafers', {struct('wafer', {}, 'dateTime', {})}, 'shotNo', zeros(0, 1), 'shotX', zeros(0, 1), 'shotY', zeros(0, 1), ...
    'shotScan', {cell(0, 1)}, 'shotLine', zeros(0, 1), 'markShot', zeros(0, 1), 'markNo', zeros(0, 1), 'markLocalX', zeros(0, 1), ...
    'markLocalY', zeros(0, 1), 'markLine', zeros(0, 1), 'markKeys', {cell(1, 0)}, 'valueIndex', zeros(0, 0), ...
    'sumX', zeros(0, 1), 'countX', zeros(0, 1), 'sumY', zeros(0, 1), 'countY', zeros(0, 1), 'duplicateRows', 0, 'recordLines', zeros(0, 1));
grouped.recordLines = [records.line]';
for record = records'
    waferKey = [record.wafer, char(0), record.dateTime];
    if ~isKey(waferIndexByKey, waferKey)
        waferIndexByKey(waferKey) = numel(grouped.wafers) + 1;
        grouped.wafers(end + 1) = struct('wafer', record.wafer, 'dateTime', record.dateTime);
    end
    wafer = waferIndexByKey(waferKey);
    if ~isKey(shotIndexByNo, record.shotNo)
        shotIndexByNo(record.shotNo) = numel(grouped.shotNo) + 1;
        grouped.shotNo(end + 1, 1) = record.shotNo;
        grouped.shotX(end + 1, 1) = record.x;
        grouped.shotY(end + 1, 1) = record.y;
        grouped.shotScan{end + 1, 1} = record.scan;
        grouped.shotLine(end + 1, 1) = record.line;
    end
    shot = shotIndexByNo(record.shotNo);
    if ~sameCoordinate(grouped.shotX(shot), record.x, C) || ~sameCoordinate(grouped.shotY(shot), record.y, C) || ~strcmp(grouped.shotScan{shot}, record.scan)
        errors = addError(errors, sprintf('%d行目: shotNo %d の Xmm・Ymm か Direction が%d行目と違います。同じShotでは同じ値にしてください。', ...
            record.line, record.shotNo, grouped.shotLine(shot)), C);
        continue
    end
    markKey = sprintf('%d|%d', record.shotNo, record.markNo);
    if ~isKey(markRowByKey, markKey)
        markRowByKey(markKey) = numel(grouped.markNo) + 1;
        grouped.markShot(end + 1, 1) = shot;
        grouped.markNo(end + 1, 1) = record.markNo;
        grouped.markLocalX(end + 1, 1) = record.markX;
        grouped.markLocalY(end + 1, 1) = record.markY;
        grouped.markLine(end + 1, 1) = record.line;
        grouped.markKeys{end + 1} = markKey;
    end
    markRow = markRowByKey(markKey);
    if ~sameCoordinate(grouped.markLocalX(markRow), record.markX, C) || ~sameCoordinate(grouped.markLocalY(markRow), record.markY, C)
        errors = addError(errors, sprintf('%d行目: shotNo %d の markNo %d の markXmm・markYmm が%d行目と違います。同じMarkでは同じ値にしてください。', ...
            record.line, record.shotNo, record.markNo, grouped.markLine(markRow)), C);
        continue
    end
    if wafer > size(grouped.valueIndex, 1) || markRow > size(grouped.valueIndex, 2) || grouped.valueIndex(wafer, markRow) == 0
        grouped.sumX(end + 1, 1) = 0;
        grouped.countX(end + 1, 1) = 0;
        grouped.sumY(end + 1, 1) = 0;
        grouped.countY(end + 1, 1) = 0;
        grouped.valueIndex(wafer, markRow) = numel(grouped.sumX);
    else
        grouped.duplicateRows = grouped.duplicateRows + 1;
    end
    valueIndex = grouped.valueIndex(wafer, markRow);
    if ~isnan(record.measX)
        grouped.sumX(valueIndex) = grouped.sumX(valueIndex) + record.measX;
        grouped.countX(valueIndex) = grouped.countX(valueIndex) + 1;
    end
    if ~isnan(record.measY)
        grouped.sumY(valueIndex) = grouped.sumY(valueIndex) + record.measY;
        grouped.countY(valueIndex) = grouped.countY(valueIndex) + 1;
    end
end
% 値のない（Wafer, Mark）の欄も0（値なし）で埋めて、Wafer数 × Mark数 の大きさにそろえる
grouped.valueIndex(end + 1:numel(grouped.wafers), :) = 0;
grouped.valueIndex(:, end + 1:numel(grouped.markNo)) = 0;
end

function same = sameCoordinate(left, right, C)
same = abs(left - right) <= C.MEASUREMENT_COORDINATE_TOLERANCE_MM;
end

function names = waferNamesOf(wafers)
% 同じWaferが日時違いで複数あれば、名前に日時を添える
names = cell(numel(wafers), 1);
allWafers = {wafers.wafer};
for k = 1:numel(wafers)
    if nnz(strcmp(allWafers, wafers(k).wafer)) > 1
        names{k} = [wafers(k).wafer, ' ', wafers(k).dateTime];
    else
        names{k} = wafers(k).wafer;
    end
end
end
