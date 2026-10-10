function evaluation = evaluateSampleSet(waferMap, data, modelSettings, sampleIndices, variants, cache, withEstimation)
%EVALUATESAMPLESET 1組の計測Markについて、補正ごと・軸ごとの残差の指標と、推定手法ごとの推定精度を求める。
%   evaluation.results(v).x / .y      補正 variants(v) の残差の指標（rms, mean3sigma, max。各 Wafer数×1）
%   evaluation.estimationKeys          推定精度を求めた推定手法（'howa' は多項式の予測）
%   evaluation.estimation(e).x / .y    未計測Markでの推定誤差の指標
%   evaluation.estimationSquares(e).x  Markごとの推定誤差の2乗和（全Wafer。計測Markは NaN）
%   evaluation.gpChoices(v)            GPの流れで選んだ相関の長さ [mm] とノイズ比（全Wafer分）

if nargin < 6 || isempty(cache)
    cache = asc.modelCache(waferMap);
end
if nargin < 7
    withEstimation = true;
end
C = asc.constants();
uv = cache.uv;
markCount = size(uv, 1);
sample = sampleIndices(:);
unmeasured = setdiff((1:markCount)', sample);
withEstimation = withEstimation && ~isempty(unmeasured);
warnings = {};
nanMetrics = struct('rms', NaN(data.waferCount, 1), 'mean3sigma', NaN(data.waferCount, 1), 'max', NaN(data.waferCount, 1));

selected = C.ESTIMATORS(arrayfun(@(e) isfield(modelSettings.estimators, e.key) && modelSettings.estimators.(e.key), C.ESTIMATORS));
if withEstimation
    estimatorList = selected;
else
    estimatorList = C.ESTIMATORS([]);
end
for v = 1:numel(variants)
    estimator = variants(v).estimator;
    if ~isempty(estimator) && ~any(strcmp({estimatorList.key}, estimator.key))
        estimatorList(end + 1) = estimator; %#ok<AGROW>
    end
end
prepared = struct();
for estimator = estimatorList
    if strcmp(estimator.type, 'rbf')
        rbfSettings = struct('kernel', modelSettings.rbfKernel, 'lambda', modelSettings.rbfLambda, 'shapeFactor', modelSettings.rbfShapeFactor);
        operator = asc.rbfOperator(uv, sample, rbfSettings, estimator.features);
        entry = [];
        if ~isempty(operator)
            entry = struct('type', 'linear', 'operator', operator);
        end
    else
        gp = asc.prepareGp(uv, sample, estimator.features, modelSettings.gpKernel);
        entry = [];
        if ~isempty(gp)
            entry = struct('type', 'gp', 'gp', gp);
        end
    end
    prepared.(estimator.key) = entry;
    if isempty(entry)
        warnings{end + 1} = sprintf('%s: 推定できませんでした（計測点が少なすぎるか、並びが偏っています）。', estimator.longLabel); %#ok<AGROW>
    end
end

if withEstimation
    estimationKeys = [{'howa'}, {selected.key}];
else
    estimationKeys = {};
end
results = repmat(struct('x', [], 'y', []), 1, numel(variants));
estimation = repmat(struct('x', [], 'y', []), 1, numel(estimationKeys));
estimationSquares = repmat(struct('x', [], 'y', []), 1, numel(estimationKeys));
gpChoices = repmat(struct('lengthMm', [], 'noiseRatio', []), 1, numel(variants));
howaCache = containers.Map('KeyType', 'char', 'ValueType', 'any');

for axisCell = {'x', 'y'}
    axisName = axisCell{1};
    if strcmp(axisName, 'x')
        terms = modelSettings.termsX(:)';
        truth = data.truthX';
        noise = data.noiseX';
    else
        terms = modelSettings.termsY(:)';
        truth = data.truthY';
        noise = data.noiseY';
    end
    termKey = sprintf('%d,', terms);
    if ~isKey(howaCache, termKey)
        [allDesign, allLeastSquares] = cachedDesign(cache, terms);
        parts = asc.prepareHowa(uv, sample, terms, allDesign, allLeastSquares);
        warnings = [warnings, parts.warnings]; %#ok<AGROW>
        operators = cell(1, numel(variants));
        for v = 1:numel(variants)
            estimator = variants(v).estimator;
            if isempty(estimator)
                operators{v} = parts.howa;
            elseif ~isempty(prepared.(estimator.key)) && strcmp(prepared.(estimator.key).type, 'linear')
                operators{v} = asc.estimateThenHowaOperator(parts, prepared.(estimator.key).operator, sample);
            end
        end
        howaCache(termKey) = {parts, operators};
    end
    cached = howaCache(termKey);
    [parts, operators] = cached{:};
    measured = truth(sample, :) + noise(sample, :);
    howaCorrection = parts.howa * measured;

    recordEstimation('howa', howaCorrection);
    rawGp = struct();
    for estimator = estimatorList
        entry = prepared.(estimator.key);
        if isempty(entry)
            position = find(strcmp(estimationKeys, estimator.key), 1);
            if ~isempty(position)
                estimation(position).(axisName) = nanMetrics;
            end
            continue
        end
        if strcmp(entry.type, 'gp')
            [values, lengths, ratios] = asc.gpPredict(entry.gp, measured);
            rawGp.(estimator.key) = struct('values', values, 'lengths', lengths, 'ratios', ratios);
            recordEstimation(estimator.key, values);
        else
            recordEstimation(estimator.key, entry.operator * measured);
        end
    end

    for v = 1:numel(variants)
        variant = variants(v);
        if ~isempty(operators{v})
            correction = operators{v} * measured;
        else
            entry = prepared.(variant.estimator.key);
            if isempty(entry)
                results(v).(axisName) = nanMetrics;
                continue
            end
            % 推定→HOWA: 未計測Markを推定値で埋め、全Markに多項式を当てはめる（GPの学習は推定精度と同じ結果を使う）
            raw = rawGp.(variant.estimator.key);
            filled = raw.values;
            filled(sample, :) = measured;
            correction = parts.allDesign * (parts.allLeastSquares * filled);
            lengths = raw.lengths;
            ratios = raw.ratios;
            finite = isfinite(lengths);
            gpChoices(v).lengthMm = [gpChoices(v).lengthMm; lengths(finite)' * C.NORMALIZATION_RADIUS_MM];
            gpChoices(v).noiseRatio = [gpChoices(v).noiseRatio; ratios(finite)'];
        end
        results(v).(axisName) = asc.residualMetrics(truth - correction);
    end
end
evaluation = struct('results', results, 'estimationKeys', {estimationKeys}, 'estimation', estimation, ...
    'estimationSquares', estimationSquares, 'gpChoices', gpChoices);
evaluation.warnings = unique(warnings, 'stable');

    function recordEstimation(name, prediction)
        position = find(strcmp(estimationKeys, name), 1);
        if isempty(position)
            return
        end
        errors = prediction(unmeasured, :) - truth(unmeasured, :);
        squares = NaN(markCount, 1);
        squares(unmeasured) = sum(errors.^2, 2);
        estimationSquares(position).(axisName) = squares;
        estimation(position).(axisName) = asc.residualMetrics(errors);
    end
end

function [allDesign, allLeastSquares] = cachedDesign(cache, terms)
key = sprintf('%d,', terms);
if ~isKey(cache.store, key)
    design = asc.polynomialDesign(cache.uv, terms);
    cache.store(key) = {design, asc.leastSquaresOperator(design)};
end
entry = cache.store(key);
[allDesign, allLeastSquares] = entry{:};
end
