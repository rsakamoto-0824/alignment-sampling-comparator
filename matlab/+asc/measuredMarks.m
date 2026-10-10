function marks = measuredMarks(context, selectedItems)
%MEASUREDMARKS 選んだShot（候補番号）で測るMark（Shotの有効なMarkすべて。選んだ順）。

marks = zeros(1, 0);
for item = selectedItems(:)'
    marks = [marks, context.items(item).marks]; %#ok<AGROW>
end
end
