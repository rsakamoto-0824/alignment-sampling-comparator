function text = mapToCsv(waferMap)
%MAPTOCSV WaferマップをCSV（1行1Mark）の文字列にする。読込（asc.parseMapCsv）と同じ列の並び。

lines = {'ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY'};
for shot = 1:numel(waferMap.shotIds)
    for markIndex = waferMap.shotMarkIndices{shot}
        % 丸めはブラウザ版の Math.round と同じ（0.5 は大きい方へ）
        localX = floor((waferMap.markX(markIndex) - waferMap.shotX(shot)) * 1e6 + 0.5) / 1e6;
        localY = floor((waferMap.markY(markIndex) - waferMap.shotY(shot)) * 1e6 + 0.5) / 1e6;
        lines{end + 1} = strjoin({waferMap.shotIds{shot}, asc.csvNumberText(waferMap.shotX(shot)), asc.csvNumberText(waferMap.shotY(shot)), ...
            waferMap.shotScan{shot}, sprintf('%d', waferMap.markNo(markIndex)), asc.csvNumberText(localX), asc.csvNumberText(localY)}, ','); %#ok<AGROW>
    end
end
text = [strjoin(lines, sprintf('\r\n')), sprintf('\r\n')];
end
