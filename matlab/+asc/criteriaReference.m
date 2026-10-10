function reference = criteriaReference(sets)
%CRITERIAREFERENCE 効率の基準: 全部の選び方・試行の中で、D基準が最大のものとI基準が最小のもの（軸ごと。なければ []）。

reference = struct();
for axisCell = {'x', 'y'}
    usable = [];
    for s = 1:numel(sets)
        criteria = sets(s).criteria.(axisCell{1});
        if ~criteria.singular
            usable = [usable; criteria.logDet, criteria.trace]; %#ok<AGROW>
        end
    end
    if isempty(usable)
        reference.(axisCell{1}) = [];
    else
        reference.(axisCell{1}) = struct('logDet', max(usable(:, 1)), 'trace', min(usable(:, 2)));
    end
end
end
