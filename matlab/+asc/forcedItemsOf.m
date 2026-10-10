function forced = forcedItemsOf(context)
%FORCEDITEMSOF 必ず選ぶ候補（中心の1点のShot → 強制計測Shot の順。入れ替えの対象にしない）。

forced = zeros(1, 0);
if context.center.active
    forced = context.center.itemIndex;
end
for item = context.mandatoryItems(:)'
    if ~ismember(item, forced)
        forced(end + 1) = item; %#ok<AGROW>
    end
end
end
