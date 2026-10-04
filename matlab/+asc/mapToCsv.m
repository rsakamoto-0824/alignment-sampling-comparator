function text = mapToCsv(waferMap)
%MAPTOCSV WaferマップをCSV（1行1Mark）の文字列にする。読込（asc.parseMapCsv）と同じ列の並び。

lines = {'ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY'};
for shot = 1:numel(waferMap.shotIds)
    for markIndex = waferMap.shotMarkIndices{shot}
        % 丸めはブラウザ版の Math.round と同じ（0.5 は大きい方へ）
        localX = floor((waferMap.markX(markIndex) - waferMap.shotX(shot)) * 1e6 + 0.5) / 1e6;
        localY = floor((waferMap.markY(markIndex) - waferMap.shotY(shot)) * 1e6 + 0.5) / 1e6;
        lines{end + 1} = strjoin({waferMap.shotIds{shot}, numberText(waferMap.shotX(shot)), numberText(waferMap.shotY(shot)), ...
            waferMap.shotScan{shot}, sprintf('%d', waferMap.markNo(markIndex)), numberText(localX), numberText(localY)}, ','); %#ok<AGROW>
    end
end
text = [strjoin(lines, sprintf('\r\n')), sprintf('\r\n')];
end

function text = numberText(value)
% 整数は小数点なし、それ以外は元の値に戻る最短に近い桁数
if value == floor(value)
    text = sprintf('%d', value);
    return
end
for digits = 15:17
    text = sprintf('%.*g', digits, value);
    if str2double(text) == value
        return
    end
end
end
