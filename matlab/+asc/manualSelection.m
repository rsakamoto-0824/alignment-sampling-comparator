function selection = manualSelection(context, shotIndices, extraMarkIndices)
%MANUALSELECTION 手動の選択（Shotの番号と追加のMark）から、測るMarkの一覧を作る。
%   選べないShot（必ず測るMarkが有効範囲外）は notEligible で返す。番号はすべて1始まり。

itemOfShot = zeros(numel(context.map.shotIds), 1);
itemOfShot([context.items.shotIndex]) = 1:numel(context.items);
items = zeros(1, 0);
notEligible = zeros(1, 0);
for shot = shotIndices(:)'
    if itemOfShot(shot) > 0
        items(end + 1) = itemOfShot(shot); %#ok<AGROW>
    else
        notEligible(end + 1) = shot; %#ok<AGROW>
    end
end
marks = asc.measuredMarks(context, items);
if ~context.exactMode
    allowed = [context.items(items).otherMarks];
    extras = extraMarkIndices(:)';
    marks = [marks, extras(ismember(extras, allowed))];
end
selection = struct('items', items, 'markIndices', marks, 'notEligible', notEligible);
end
