function table = readTableFile(path)
%READTABLEFILE 表のファイル（.csv か .xlsx）を読み、シートごとの「行の一覧」にする（ブラウザ版の table-reader.js と同じ形）。
%   table.sheets(k).name   シートの名前（CSVは空）
%   table.sheets(k).rows   行の構造体配列（line: 元のファイルの行番号、cells: 各列の文字の cell。前後の空白は除く）
%   table.date1904         xlsxの日付が1904年基準か（CSVは false）
%   空の行は入れない。xlsx はZIPを展開してXMLを読む（Excelがなくても読める。数式は計算済みの値を使う）。

path = char(path);
[~, ~, extension] = fileparts(path);
switch lower(extension)
    case '.csv'
        table = readCsv(path);
    case '.xlsx'
        table = readXlsx(path);
    otherwise
        error('asc:invalidFile', '読めるのは .csv と .xlsx のファイルです。Excelのファイルは「Excel ブック（*.xlsx）」で保存してください。');
end
end

% ---- CSV --------------------------------------------------------------------

function table = readCsv(path)
bytes = readBytes(path);
% UTF-8（BOMの有無どちらも）で読めなければ、日本語版Excelの既定の Shift_JIS として読む
text = native2unicode(bytes, 'UTF-8');
if any(text == char(65533))
    text = native2unicode(bytes, 'Shift_JIS');
end
table = asc.readTableFileText(text);
end

function bytes = readBytes(path)
fid = fopen(path, 'r');
if fid < 0
    error('asc:invalidFile', 'ファイル %s を開けません。', path);
end
cleanup = onCleanup(@() fclose(fid));
bytes = fread(fid, Inf, '*uint8')';
end

% ---- xlsx -------------------------------------------------------------------

function table = readXlsx(path)
bytes = readBytes(path);
if numel(bytes) < 4 || bytes(1) ~= uint8('P') || bytes(2) ~= uint8('K')
    error('asc:invalidFile', 'xlsxファイルではありません。Excelで「Excel ブック（*.xlsx）」として保存したファイルを選んでください（古い .xls は読めません）。');
end
folder = tempname;
cleanup = onCleanup(@() removeFolder(folder));
try
    unzip(path, folder);
catch
    error('asc:invalidFile', 'xlsxファイルの中身を読めません（ZIPの形になっていません）。Excelで開いて、xlsxで保存し直してください。');
end
workbook = readUtf8(fullfile(folder, 'xl', 'workbook.xml'));
relations = readUtf8(fullfile(folder, 'xl', '_rels', 'workbook.xml.rels'));
if isempty(workbook) || isempty(relations)
    error('asc:invalidFile', 'xlsxファイルにシートの情報がありません。Excelで開いて、xlsxで保存し直してください。');
end
targets = containers.Map('KeyType', 'char', 'ValueType', 'char');
for match = regexp(relations, '<Relationship(?=[\s/>])([^>]*?)/?>', 'tokens')
    attributes = attributesOf(match{1}{1});
    if isKey(attributes, 'Id') && isKey(attributes, 'Target')
        targets(attributes('Id')) = attributes('Target');
    end
end
date1904 = false;
properties = regexp(workbook, '<workbookPr(?=[\s/>])([^>]*?)/?>', 'tokens', 'once');
if ~isempty(properties)
    attributes = attributesOf(properties{1});
    date1904 = isKey(attributes, 'date1904') && any(strcmp(attributes('date1904'), {'1', 'true'}));
end
sharedStrings = sharedStringsOf(readUtf8(fullfile(folder, 'xl', 'sharedStrings.xml')));

sheets = struct('name', {}, 'rows', {});
for match = regexp(workbook, '<sheet(?=[\s/>])([^>]*?)/?>', 'tokens')
    attributes = attributesOf(match{1}{1});
    if ~isKey(attributes, 'id') || ~isKey(targets, attributes('id'))
        continue
    end
    target = targets(attributes('id'));
    if startsWith(target, '/')
        sheetFile = fullfile(folder, target(2:end));
    else
        sheetFile = fullfile(folder, 'xl', strrep(target, './', ''));
    end
    xml = readUtf8(sheetFile);
    if isempty(xml)
        continue
    end
    if isKey(attributes, 'name')
        name = attributes('name');
    else
        name = sprintf('Sheet%d', numel(sheets) + 1);
    end
    sheets(end + 1) = struct('name', name, 'rows', sheetRows(xml, sharedStrings)); %#ok<AGROW>
end
if isempty(sheets)
    error('asc:invalidFile', 'xlsxファイルにシートがありません。');
end
table = struct('sheets', sheets, 'date1904', date1904);
end

function removeFolder(folder)
if isfolder(folder)
    rmdir(folder, 's');
end
end

function text = readUtf8(path)
if ~isfile(path)
    text = '';
    return
end
fid = fopen(path, 'r', 'n', 'UTF-8');
cleanup = onCleanup(@() fclose(fid));
text = fread(fid, Inf, '*char')';
end

% MATLAB の正規表現の注意: \b は単語の区切りにならない（バックスペース）ので、タグ名の後ろは (?=[\s/>]) で区切る。
% また「/> か > … </tag>」のような選択肢の中の取り出し（トークン）は返らないので、要素全体を 'match' で取り出してから分ける

function attributes = attributesOf(text)
% タグの属性を名前 → 値 にする（名前空間の接頭辞は外す。r:id は id になる）
attributes = containers.Map('KeyType', 'char', 'ValueType', 'char');
for match = regexp(text, '([\w:.-]+)\s*=\s*"([^"]*)"', 'tokens')
    name = match{1}{1};
    colon = find(name == ':', 1, 'last');
    if ~isempty(colon)
        name = name(colon + 1:end);
    end
    attributes(name) = decodeXml(match{1}{2});
end
end

function text = decodeXml(text)
% XMLの文字の参照（&amp; や &#12354; など）を戻す。&amp; は最後に戻す（&amp;lt; を < にしないため）
if ~contains(text, '&')
    return
end
text = regexprep(text, '&#x([0-9a-fA-F]+);', '${char(hex2dec($1))}');
text = regexprep(text, '&#([0-9]+);', '${char(str2double($1))}');
text = strrep(text, '&lt;', '<');
text = strrep(text, '&gt;', '>');
text = strrep(text, '&quot;', '"');
text = strrep(text, '&apos;', '''');
text = strrep(text, '&amp;', '&');
end

function text = textOfRuns(xml)
% 要素の中の <t> の文字をつなげる。ふりがな（<rPh>）は値ではないので外す
xml = regexprep(xml, '<rPh(?=[\s/>]).*?</rPh>', '');
text = '';
for match = regexp(xml, '<t(?=[\s/>])[^>]*?(?<!/)>(.*?)</t>', 'tokens')
    text = [text, decodeXml(match{1}{1})]; %#ok<AGROW>
end
end

function strings = sharedStringsOf(xml)
strings = {};
if isempty(xml)
    return
end
% 中身のない <si/> も1つと数える（番号がずれないように）
matches = regexp(xml, '<si(?=[\s/>])[^>]*?(/>|>.*?</si>)', 'match');
strings = cellfun(@textOfRuns, matches, 'UniformOutput', false);
end

function index = columnIndexOf(reference)
% セル番号の列の文字（A, B, …, AA）を1始まりの番号にする
letters = regexp(reference, '^[A-Z]+', 'match', 'once');
index = 0;
for letter = letters
    index = index * 26 + (double(letter) - 64);
end
end

function value = cellValue(attributes, inner, sharedStrings)
raw = regexp(inner, '<v(?=[\s/>])[^>]*>(.*?)</v>', 'tokens', 'once');
if isempty(raw)
    raw = '';
else
    raw = decodeXml(raw{1});
end
cellType = '';
if isKey(attributes, 't')
    cellType = attributes('t');
end
switch cellType
    case 's'
        if isempty(raw)
            value = '';
        else
            value = sharedStrings{str2double(raw) + 1};
        end
    case 'inlineStr'
        inline = regexp(inner, '<is(?=[\s/>])[^>]*>(.*?)</is>', 'tokens', 'once');
        if isempty(inline)
            value = '';
        else
            value = textOfRuns(inline{1});
        end
    case 'b'
        if strcmp(raw, '1')
            value = 'TRUE';
        else
            value = 'FALSE';
        end
    otherwise
        value = raw;
end
end

function [attributes, inner] = splitElement(element, name)
% 要素全体（<name ...>…</name> か <name .../>）を、属性と中身に分ける
opening = regexp(element, ['^<' name '([^>]*?)/?>'], 'tokens', 'once');
attributes = attributesOf(opening{1});
content = regexp(element, ['^<' name '[^>]*?(?<!/)>(.*)</' name '>$'], 'tokens', 'once');
if isempty(content)
    inner = '';
else
    inner = content{1};
end
end

function rows = sheetRows(xml, sharedStrings)
rows = struct('line', {}, 'cells', {});
previousLine = 0;
for rowMatch = regexp(xml, '<row(?=[\s/>])[^>]*?(/>|>.*?</row>)', 'match')
    [rowAttributes, rowInner] = splitElement(rowMatch{1}, 'row');
    if isKey(rowAttributes, 'r')
        line = str2double(rowAttributes('r'));
    else
        line = previousLine + 1;
    end
    previousLine = line;
    cells = {};
    for cellMatch = regexp(rowInner, '<c(?=[\s/>])[^>]*?(/>|>.*?</c>)', 'match')
        [attributes, inner] = splitElement(cellMatch{1}, 'c');
        if isKey(attributes, 'r')
            column = columnIndexOf(attributes('r'));
        else
            column = numel(cells) + 1;
        end
        cells(numel(cells) + 1:column - 1) = {''};
        cells{column} = strtrim(cellValue(attributes, inner, sharedStrings));
    end
    if any(~cellfun(@isempty, cells))
        rows(end + 1) = struct('line', line, 'cells', {cells}); %#ok<AGROW>
    end
end
end
