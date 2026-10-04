function waferMap = parseMapCsv(text, options)
%PARSEMAPCSV CSV（1行1Mark）を読み込んでWaferマップを作る。誤りは「何行目の何が」をエラーで知らせる。
%   列: ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY（見出しの大文字・小文字は問わない）

C = asc.constants();
columns = {'ShotId', 'ShotX', 'ShotY', 'ScanDir', 'MarkNo', 'MarkX', 'MarkY'};
text = char(text);
if startsWith(text, char(65279))  % BOM
    text = text(2:end);
end
lines = regexp(text, '\r\n|\n|\r', 'split');
if isempty(lines) || all(cellfun(@(line) isempty(strtrim(line)), lines))
    error('asc:invalidCsv', 'CSVが空です。');
end
header = lower(strtrim(splitCells(lines{1})));
position = zeros(1, numel(columns));
for k = 1:numel(columns)
    found = find(strcmp(header, lower(columns{k})), 1);
    if ~isempty(found)
        position(k) = found;
    end
end
if any(position == 0)
    error('asc:invalidCsv', '1行目に列 %s がありません。見出しを %s にしてください。', ...
        strjoin(columns(position == 0), ', '), strjoin(columns, ', '));
end

errors = {};
records = struct('id', {}, 'x', {}, 'y', {}, 'scan', {}, 'marks', {});
for lineNumber = 2:numel(lines)
    cells = strtrim(splitCells(lines{lineNumber}));
    if all(cellfun(@isempty, cells))
        continue
    end
    read = @(k) cellOr(cells, position(k));
    numbers = str2double({read(2), read(3), read(5), read(6), read(7)});
    if any(isnan(numbers))
        errors{end + 1} = sprintf('%d行目: 数値でない値があります。', lineNumber); %#ok<AGROW>
        continue
    end
    [shotX, shotY, markNo, markX, markY] = deal(numbers(1), numbers(2), numbers(3), numbers(4), numbers(5));
    scan = scanAlias(lower(read(4)), C);
    shotId = read(1);
    if isempty(scan) || isempty(shotId) || markNo ~= floor(markNo) || markNo < 1
        errors{end + 1} = sprintf('%d行目: ScanDir（Up/Down）・ShotId・MarkNo（1以上の整数）を確かめてください。', lineNumber); %#ok<AGROW>
        continue
    end
    index = find(strcmp({records.id}, shotId), 1);
    if isempty(index)
        records(end + 1) = struct('id', shotId, 'x', shotX, 'y', shotY, 'scan', scan, ...
            'marks', struct('markNo', {}, 'localX', {}, 'localY', {})); %#ok<AGROW>
        index = numel(records);
    elseif records(index).x ~= shotX || records(index).y ~= shotY || ~strcmp(records(index).scan, scan)
        errors{end + 1} = sprintf('%d行目: Shot %s の座標かScan方向が前の行と違います。', lineNumber, shotId); %#ok<AGROW>
        continue
    end
    if any([records(index).marks.markNo] == markNo)
        errors{end + 1} = sprintf('%d行目: Shot %s の Mark %d が重複しています。', lineNumber, shotId, markNo); %#ok<AGROW>
        continue
    end
    records(index).marks(end + 1) = struct('markNo', markNo, 'localX', markX, 'localY', markY);
end
if ~isempty(errors)
    error('asc:invalidCsv', '%s', strjoin(errors, newline));
end
if isempty(records)
    error('asc:invalidCsv', 'データの行がありません。');
end
waferMap = asc.buildMap(records, options);
if isempty(waferMap.shotIds)
    error('asc:invalidCsv', '有効範囲に入るMarkがありません。座標の単位（mm）と有効半径を確認してください。');
end
end

function cells = splitCells(line)
% 引用符のない単純なCSVの1行を区切る（前後の引用符は外す）
cells = strsplit(line, ',', 'CollapseDelimiters', false);
cells = regexprep(cells, '^\s*"(.*)"\s*$', '$1');
end

function value = cellOr(cells, index)
if index <= numel(cells)
    value = cells{index};
else
    value = '';
end
end

function scan = scanAlias(text, C)
switch text
    case {'up', 'u', '上', '+1', '1'}
        scan = C.SCAN_UP;
    case {'down', 'd', '下', '-1'}
        scan = C.SCAN_DOWN;
    otherwise
        scan = '';
end
end
