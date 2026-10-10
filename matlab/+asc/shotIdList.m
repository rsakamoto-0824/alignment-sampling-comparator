function ids = shotIdList(values)
%SHOTIDLIST Shot番号の並び（文字の cell・数の配列・1つの文字）を、重複のない文字の cell の行にする（順番は入力のまま）。

if isempty(values)
    ids = cell(1, 0);
    return
end
if isnumeric(values)
    texts = arrayfun(@(value) sprintf('%d', value), values(:)', 'UniformOutput', false);
elseif ischar(values)
    texts = {values};
else
    texts = cellfun(@(value) char(string(value)), values(:)', 'UniformOutput', false);
end
texts = strtrim(texts);
texts = texts(~cellfun(@isempty, texts));
[~, first] = unique(texts, 'first');
ids = texts(sort(first));
end
