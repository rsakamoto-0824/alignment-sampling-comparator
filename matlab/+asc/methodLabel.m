function label = methodLabel(output, methodKey)
%METHODLABEL 選び方の表示名（手動プランは「（手動）」を付ける）。

index = find(strcmp({output.methods.key}, methodKey), 1);
if isempty(index)
    label = methodKey;
elseif output.methods(index).manual
    label = [output.methods(index).label '（手動）'];
else
    label = output.methods(index).label;
end
end
