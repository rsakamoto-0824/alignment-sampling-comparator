function marks = measuredMarks(context, selectedItems)
%MEASUREDMARKS 選んだShot（候補番号）で必ず測るMarkの番号（選んだ順）。

marks = zeros(1, 0);
for item = selectedItems(:)'
    marks = [marks, context.items(item).designatedMarks]; %#ok<AGROW>
end
end
