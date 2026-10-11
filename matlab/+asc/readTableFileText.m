function table = readTableFileText(text)
%READTABLEFILETEXT CSVの文字を表にする（シートは1つ。asc.readTableFile と同じ形。ブラウザ版の parseCsvText と同じ）。
%   1行をカンマで分け（ダブルクォートで囲んだ値にも対応）、各値の前後の空白を除く。空の行は入れない。

text = char(text);
if startsWith(text, char(65279))  % BOM
    text = text(2:end);
end
lines = regexp(text, '\r\n|\n|\r', 'split');
rows = struct('line', {}, 'cells', {});
for index = 1:numel(lines)
    if ~isempty(strtrim(lines{index}))
        rows(end + 1) = struct('line', index, 'cells', {splitCsvLine(lines{index})}); %#ok<AGROW>
    end
end
table = struct('sheets', struct('name', '', 'rows', rows), 'date1904', false);
end

function cells = splitCsvLine(line)
if ~any(line == '"')
    % 引用符のない行は、カンマで分けるだけ（1文字ずつ調べるより速い）
    cells = strtrim(strsplit(line, ',', 'CollapseDelimiters', false));
    return
end
cells = {};
current = '';
quoted = false;
index = 1;
while index <= numel(line)
    character = line(index);
    if quoted
        if character == '"' && index < numel(line) && line(index + 1) == '"'
            current(end + 1) = '"'; %#ok<AGROW>
            index = index + 1;
        elseif character == '"'
            quoted = false;
        else
            current(end + 1) = character; %#ok<AGROW>
        end
    elseif character == '"'
        quoted = true;
    elseif character == ','
        cells{end + 1} = strtrim(current); %#ok<AGROW>
        current = '';
    else
        current(end + 1) = character; %#ok<AGROW>
    end
    index = index + 1;
end
cells{end + 1} = strtrim(current);
end
