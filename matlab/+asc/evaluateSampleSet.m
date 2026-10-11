function evaluation = evaluateSampleSet(waferMap, data, modelSettings, sampleIndices, variants, cache)
%EVALUATESAMPLESET 1組の計測Markについて、補正ごと・軸ごとの残差の指標と、GPRが選んだ調整値を求める。
%   evaluation.results(v).x / .y   補正 variants(v) の残差の指標（rms, mean3sigma, max。各 Wafer数×1）
%   evaluation.gpChoices(v)        GPRで選んだ相関の長さ [mm] とノイズ比（全Wafer分。GPR以外は空）
%   補正できなかったとき（点が少ないなど）は、0のままだと「残差0」と誤解されるので値なし（NaN）にする。

if nargin < 6 || isempty(cache)
    cache = asc.modelCache(waferMap);
end
C = asc.constants();
uv = cache.uv;
sample = sampleIndices(:);
warnings = {};
nanMetrics = struct('rms', NaN(data.waferCount, 1), 'mean3sigma', NaN(data.waferCount, 1), 'max', NaN(data.waferCount, 1));
rbfSettings = struct('kernel', modelSettings.rbfKernel, 'lambda', modelSettings.rbfLambda, 'shapeFactor', modelSettings.rbfShapeFactor);

% 「予測」で使うRBF・GPRの予測の前準備（説明変数ごとに1回。XとYで共通）
predictors = containers.Map('KeyType', 'char', 'ValueType', 'any');
for v = 1:numel(variants)
    variant = variants(v);
    key = [variant.type ':' variant.features];
    if ~strcmp(variant.mode, 'predict') || isKey(predictors, key)
        continue
    end
    if strcmp(variant.type, 'rbf')
        entry = asc.rbfOperator(uv, sample, rbfSettings, variant.features);
    else
        entry = asc.prepareGp(uv, sample, variant.features, modelSettings.gpKernel);
    end
    predictors(key) = entry;
    if isempty(entry)
        warnings{end + 1} = sprintf('%s: 予測できませんでした（計測点が少なすぎるか、並びが偏っています）。', variant.label); %#ok<AGROW>
    end
end

results = repmat(struct('x', [], 'y', []), 1, numel(variants));
gpChoices = repmat(struct('lengthMm', [], 'noiseRatio', []), 1, numel(variants));
gprKernels = containers.Map('KeyType', 'char', 'ValueType', 'any');
axisCache = containers.Map('KeyType', 'char', 'ValueType', 'any');

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
    if ~isKey(axisCache, termKey)
        axisCache(termKey) = prepareAxisModels(terms);
    end
    models = axisCache(termKey);
    parts = models.parts;
    measured = truth(sample, :) + noise(sample, :);
    ols = [];
    predicted = containers.Map('KeyType', 'char', 'ValueType', 'any');
    for v = 1:numel(variants)
        variant = variants(v);
        model = models.entries{v};
        if ~strcmp(variant.type, 'gp')
            if isempty(model)
                results(v).(axisName) = nanMetrics;
            else
                results(v).(axisName) = asc.residualMetrics(truth - model * measured);
            end
            continue
        end
        if isempty(model)
            results(v).(axisName) = nanMetrics;
            continue
        end
        if strcmp(variant.mode, 'predict')
            % GPRで未計測Markを予測して全Markを埋め、全Markに多項式を当てはめる（学習は説明変数ごとに1回）
            if ~isKey(predicted, variant.features)
                [values, lengths, ratios] = asc.gpPredict(model, measured);
                predicted(variant.features) = {values, lengths, ratios};
            end
            fit = predicted(variant.features);
            [values, lengths, ratios] = fit{:};
            filled = values;
            filled(sample, :) = measured;
            coefficients = parts.allLeastSquares * filled;
        else
            if isempty(ols)
                olsCoefficients = parts.leastSquares * measured;
                residual = measured - parts.sampleDesign * olsCoefficients;
                exact = ~(sum(residual .^ 2, 1) > sum(measured .^ 2, 1) * C.EXACT_FIT_RATIO);
                ols = struct('coefficients', olsCoefficients, 'residual', residual, 'exact', exact);
            end
            [coefficients, lengths, ratios] = asc.gprFit(model.kernelPart, model.prepared, measured, ols.residual, ols.coefficients, ols.exact);
        end
        results(v).(axisName) = asc.residualMetrics(truth - parts.allDesign * coefficients);
        finite = isfinite(lengths);
        gpChoices(v).lengthMm = [gpChoices(v).lengthMm; lengths(finite)' * C.NORMALIZATION_RADIUS_MM];
        gpChoices(v).noiseRatio = [gpChoices(v).noiseRatio; ratios(finite)'];
    end
end
evaluation = struct('results', results, 'gpChoices', gpChoices);
evaluation.warnings = unique(warnings, 'stable');

    function models = prepareAxisModels(terms)
        % 1つの軸の、補正ごとの部品（線形の補正は 計測値 → 全Markの補正量 の行列、GPRは前準備）
        [allDesign, allLeastSquares] = cachedDesign(cache, terms);
        parts = asc.prepareHowa(uv, sample, terms, allDesign, allLeastSquares);
        warnings = [warnings, parts.warnings];
        entries = cell(1, numel(variants));
        for k = 1:numel(variants)
            variant = variants(k);
            switch variant.type
                case 'howa'
                    entries{k} = parts.howa;
                case 'measured'
                    entries{k} = asc.measuredOperator(parts.howa, sample);
                otherwise
                    if strcmp(variant.mode, 'predict')
                        predictor = predictors([variant.type ':' variant.features]);
                        if isempty(predictor) || strcmp(variant.type, 'gp')
                            entries{k} = predictor;
                        else
                            entries{k} = asc.estimateThenHowaOperator(parts, predictor, sample);
                        end
                    elseif strcmp(variant.type, 'rbf')
                        polynomial = asc.rbfPolynomialOperator(uv, sample, parts.sampleDesign, rbfSettings, variant.features);
                        if isempty(polynomial)
                            warnings{end + 1} = sprintf('%s: RBFで多項式の係数を決められません（計測点が少なすぎるか、並びが偏っています）。', variant.label);
                            entries{k} = [];
                        else
                            entries{k} = allDesign * polynomial;
                        end
                    else
                        if ~isKey(gprKernels, variant.features)
                            gprKernels(variant.features) = asc.prepareGprKernel(uv, sample, variant.features, modelSettings.gpKernel);
                        end
                        kernelPart = gprKernels(variant.features);
                        prepared = asc.prepareGprPolynomial(kernelPart, parts.sampleDesign);
                        if isempty(prepared)
                            warnings{end + 1} = sprintf('%s: 多項式の項より2点以上多い計測点が必要です。', variant.label);
                            entries{k} = [];
                        else
                            entries{k} = struct('kernelPart', kernelPart, 'prepared', prepared);
                        end
                    end
            end
        end
        models = struct('parts', parts, 'entries', {entries});
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
