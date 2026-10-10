function selection = manualSelection(context, shotIndices)
%MANUALSELECTION 手動の選択（Shotの番号）から、測るMarkの一覧を作る（選んだShotの有効なMarkすべて）。
%   選べないShot（除外Shot、設定によってはMarkが揃わない端のShot）は notEligible で返す。番号はすべて1始まり。

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
selection = struct('items', items, 'markIndices', asc.measuredMarks(context, items), 'notEligible', notEligible);
end
