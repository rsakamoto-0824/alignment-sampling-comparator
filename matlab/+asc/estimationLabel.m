function label = estimationLabel(key)
%ESTIMATIONLABEL 推定手法の表示名（'howa' は多項式の予測）。

if strcmp(key, 'howa')
    label = 'HOWA（多項式の予測）';
    return
end
C = asc.constants();
label = C.ESTIMATORS(strcmp({C.ESTIMATORS.key}, key)).label;
end
