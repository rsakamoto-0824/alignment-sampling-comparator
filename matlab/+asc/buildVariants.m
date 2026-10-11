function variants = buildVariants(modelSettings)
%BUILDVARIANTS 比べる補正の一覧（設定で選んだもの。並びは C.CORRECTIONS の順）。
%   variants(v): key, type（howa / rbf / gp / measured）, mode（embedded＝式内 / predict＝予測 / ''）, family, features, label, longLabel

C = asc.constants();
selected = arrayfun(@(entry) isfield(modelSettings.corrections, entry.key) && logical(modelSettings.corrections.(entry.key)), C.CORRECTIONS);
variants = C.CORRECTIONS(selected);
end
