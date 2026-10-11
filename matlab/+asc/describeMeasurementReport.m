function lines = describeMeasurementReport(waferMap, report)
%DESCRIBEMEASUREMENTREPORT 計測データのファイルの読み込みの結果を、短い文の一覧（cell）にする（ブラウザ版の画面の説明と同じ）。

sheet = '';
if ~isempty(report.sheetName)
    sheet = sprintf('、シート「%s」', report.sheetName);
end
lines = {sprintf('Wafer %d枚、Shot %d個、有効なMark %d個（%d行%s）', numel(report.waferNames), numel(waferMap.shotIds), numel(waferMap.markX), report.rowCount, sheet)};
if ~isempty(report.invalidMarks)
    lines{end + 1} = sprintf('無効マーク %d個（どれかのWaferでXかYが測れていないMark。計測の対象にしません）', numel(report.invalidMarks));
end
if ~isempty(waferMap.inactiveShotIds)
    lines{end + 1} = sprintf('Markがすべて無効マークのShot %d個は選べません', numel(waferMap.inactiveShotIds));
end
if ~isempty(report.waferMissing)
    [~, order] = sort([report.waferMissing.count], 'descend');
    worst = report.waferMissing(order(1:min(3, numel(order))));
    parts = arrayfun(@(entry) sprintf('%s: %d個', entry.name, entry.count), worst, 'UniformOutput', false);
    lines{end + 1} = sprintf('測れていないMarkのあるWafer %d枚（多い順に %s）', numel(report.waferMissing), strjoin(parts, '、'));
end
if waferMap.excludedMarkCount > 0
    lines{end + 1} = sprintf('有効半径の外のMark %d個は使いません', waferMap.excludedMarkCount);
end
if report.duplicateRows > 0
    lines{end + 1} = sprintf('同じWafer・Markの重複行 %d行は、X・Yそれぞれ平均しました', report.duplicateRows);
end
if report.radiusMismatch > 0
    lines{end + 1} = sprintf('Radius が sqrt(Xmm^2 + Ymm^2) と合わない行が %d行あります（計算には使っていません）', report.radiusMismatch);
end
end
