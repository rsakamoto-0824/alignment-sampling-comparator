function variants = buildVariants(modelSettings)
%BUILDVARIANTS 比べる補正の一覧（HOWAのみ ＋ 補正の流れ × 推定手法）。
%   key は 'howa' か '流れ:推定手法'（例 'estimateThenHowa:gpXYR'）。estimator は推定手法の情報（HOWAのみは []）。

C = asc.constants();
variants = struct('key', {}, 'flowType', {}, 'estimator', {}, 'label', {});
if modelSettings.flows.howa
    variants(end + 1) = struct('key', 'howa', 'flowType', 'howa', 'estimator', [], 'label', 'HOWAのみ');
end
for flow = C.FLOW_TYPES
    if strcmp(flow.key, 'howa') || ~isfield(modelSettings.flows, flow.key) || ~modelSettings.flows.(flow.key)
        continue
    end
    for estimator = C.ESTIMATORS
        if ~isfield(modelSettings.estimators, estimator.key) || ~modelSettings.estimators.(estimator.key)
            continue
        end
        if strcmp(flow.key, 'estimateThenHowa')
            label = [estimator.label '→HOWA'];
        else
            label = ['HOWA＋' estimator.label];
        end
        variants(end + 1) = struct('key', [flow.key ':' estimator.key], 'flowType', flow.key, ...
            'estimator', estimator, 'label', label); %#ok<AGROW>
    end
end
end
