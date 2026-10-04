function result = efficiencies(criteria, reference)
%EFFICIENCIES D効率とI効率（%）。reference（評価の中で最も良い log det と予測分散）を100%とする。
%   criteria は logDet, trace, p, singular を持つ構造体。

if isempty(reference) || criteria.singular
    if criteria.singular
        value = 0;
    else
        value = NaN;
    end
    result = struct('d', value, 'i', value);
    return
end
result = struct('d', 100 * exp((criteria.logDet - reference.logDet) / criteria.p), ...
    'i', 100 * reference.trace / criteria.trace);
end
