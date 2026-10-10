function text = selectionToCsv(waferMap, markIndices)
%SELECTIONTOCSV 選んだ点（測るMark）の座標をCSV（1行1Mark）の文字列にする。
%   列はマップのCSVと同じ並びに、Wafer座標（Shot中心＋Mark座標）を足したもの:
%   ShotId, ShotX, ShotY, ScanDir, MarkNo, MarkX, MarkY, WaferX, WaferY
%   Markはマップの並び（Shotの番号順、Shot内はMark番号順）にそろえる。markIndices は1始まり。

roundForCsv = @(value) floor(value * 1e6 + 0.5) / 1e6;  % ブラウザ版の Math.round と同じ（0.5 は大きい方へ）
lines = {'ShotId,ShotX,ShotY,ScanDir,MarkNo,MarkX,MarkY,WaferX,WaferY'};
for markIndex = unique(markIndices(:))'
    shot = waferMap.markShot(markIndex);
    shotId = waferMap.shotIds{shot};
    if any(ismember(shotId, [',', '"', char(13), newline]))
        shotId = ['"' strrep(shotId, '"', '""') '"'];
    end
    values = [roundForCsv(waferMap.markX(markIndex) - waferMap.shotX(shot)), roundForCsv(waferMap.markY(markIndex) - waferMap.shotY(shot)), ...
        roundForCsv(waferMap.markX(markIndex)), roundForCsv(waferMap.markY(markIndex))];
    lines{end + 1} = strjoin([{shotId, asc.csvNumberText(waferMap.shotX(shot)), asc.csvNumberText(waferMap.shotY(shot)), ...
        waferMap.shotScan{shot}, sprintf('%d', waferMap.markNo(markIndex))}, arrayfun(@asc.csvNumberText, values, 'UniformOutput', false)], ','); %#ok<AGROW>
end
text = [strjoin(lines, sprintf('\r\n')), sprintf('\r\n')];
end
