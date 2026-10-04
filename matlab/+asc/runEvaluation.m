function output = runEvaluation(waferMap, data, settings, manualPlans, progress)
%RUNEVALUATION 評価を実行する（選ぶ → 補正 → 集計）。ブラウザ版と同じ手順・同じ乱数。
%   1. サンプリングの前提を作り、ハード制約を同時に満たせるか確かめる
%   2. 選び方ごとに計測Markを選ぶ（ランダム系は試行回数ぶん）。手動プランも同列に扱う
%   3. 選んだ点ごとに全Waferを補正し、全Markの残差と、未計測Markの推定誤差を求める
%   4. 選び方 × 補正 × 軸 × 指標で集計する
%
%   manualPlans: 手動プランの構造体配列（key, label, shotIndices, extraMarkIndices）。asc.planFromShotIds で作れる
%   progress:    progress(done, total, label) を呼ぶ関数ハンドル（省略可）
%
%   おもな戻り値（番号はすべて1始まり）
%     output.methods(m)                   選び方（key, label, usesDraws, manual）
%     output.variants(v)                  補正（key, flowType, estimator, label）
%     output.summary(m).variants(v).x.rms.all.mean   選び方 m・補正 v の X の RMS のWafer平均
%     output.summary(m).estimation(e)     推定精度（output.estimationKeys{e}）
%     output.summary(m).criteriaX / constraints      D・I基準と制約の満たし具合
%     output.sets(s)                      選んだ点（method, draw, shotIndices, markIndices, results など）

if nargin < 4 || isempty(manualPlans)
    manualPlans = struct('key', {}, 'label', {}, 'shotIndices', {}, 'extraMarkIndices', {});
end
if nargin < 5
    progress = [];
end
C = asc.constants();
axisNames = {'x', 'y'};
context = asc.buildContext(waferMap, settings);
samplingSettings = settings.sampling;
[context, relaxed] = asc.resolveHardConstraints(context, samplingSettings.seed);
variants = asc.buildVariants(settings.model);
cache = asc.modelCache(waferMap);
termSets = {settings.model.termsX(:)', settings.model.termsY(:)'};

plans = manualPlans(arrayfun(@(plan) ~isempty(plan.shotIndices), manualPlans));
methodList = struct('key', {}, 'label', {}, 'usesDraws', {}, 'manual', {});
for method = C.METHODS
    if isfield(samplingSettings.methods, method.key) && samplingSettings.methods.(method.key)
        methodList(end + 1) = struct('key', method.key, 'label', method.label, 'usesDraws', method.usesDraws, 'manual', false); %#ok<AGROW>
    end
end
for plan = plans(:)'
    methodList(end + 1) = struct('key', plan.key, 'label', plan.label, 'usesDraws', false, 'manual', true); %#ok<AGROW>
end
entries = struct('method', {}, 'draw', {}, 'plan', {});
for method = methodList
    if method.manual
        entries(end + 1) = struct('method', method.key, 'draw', 0, 'plan', plans(strcmp({plans.key}, method.key))); %#ok<AGROW>
    else
        drawCount = 1;
        if method.usesDraws
            drawCount = samplingSettings.draws;
        end
        for draw = 0:drawCount - 1
            entries(end + 1) = struct('method', method.key, 'draw', draw, 'plan', []); %#ok<AGROW>
        end
    end
end
totalSteps = numel(entries) * 2 + 2;
done = 0;

sets = {};
for entry = entries
    methodIndex = find(strcmp({C.METHODS.key}, entry.method), 1) - 1;  % 0始まり（手動は −1）
    if isempty(methodIndex)
        methodIndex = -1;
    end
    random = asc.Random(asc.Random.deriveSeed(samplingSettings.seed, C.STREAM_METHOD_BASE + methodIndex * 100000 + entry.draw));
    switch entry.method
        case 'random'
            selection = asc.selectRandom(context, random);
        case 'poisson'
            selection = asc.selectPoisson(context, random);
        case 'dOptimal'
            selection = asc.selectOptimal(context, random, 'D', termSets, samplingSettings.optimalStarts);
        case 'iOptimal'
            selection = asc.selectOptimal(context, random, 'I', termSets, samplingSettings.optimalStarts);
        otherwise
            selection = asc.manualSelection(context, entry.plan.shotIndices, entry.plan.extraMarkIndices);
    end
    done = done + 1;
    report('計測Markを選んでいます');
    if isempty(selection) || isempty(selection.markIndices)
        continue
    end
    sets{end + 1} = describeSet(context, settings.model, entry, selection); %#ok<AGROW>
end

for s = 1:numel(sets)
    evaluation = asc.evaluateSampleSet(waferMap, data, settings.model, sets{s}.markIndices, variants, cache);
    sets{s}.results = evaluation.results;
    sets{s}.estimation = evaluation.estimation;
    sets{s}.estimationSquares = evaluation.estimationSquares;
    sets{s}.gpChoices = evaluation.gpChoices;
    sets{s}.warnings = [sets{s}.warnings, evaluation.warnings(:)'];
    done = done + 1;
    report('補正して残差を求めています');
end
if isempty(sets)
    error('asc:noSelection', '計測Markを選べた選び方がありません。制約や計測Shot数を見直してください。');
end
sets = [sets{:}];

uncorrected = struct('x', asc.residualMetrics(data.truthX'), 'y', asc.residualMetrics(data.truthY'));
howaOnly = struct('key', 'howa', 'flowType', 'howa', 'estimator', [], 'label', 'HOWAのみ');
allMarks = asc.evaluateSampleSet(waferMap, data, settings.model, 1:numel(waferMap.markX), howaOnly, cache, false);
allMarks = allMarks.results(1);
done = totalSteps;
report('集計しています');
estimationKeys = [{'howa'}, selectedEstimatorKeys(settings.model, C)];
usedMethods = methodList(arrayfun(@(method) any(strcmp({sets.method}, method.key)), methodList));

output = struct();
output.context = context;
output.relaxed = relaxed;
output.sets = sets;
output.variants = variants;
output.criteriaReference = criteriaReference(sets, axisNames);
output.criteriaSameTerms = isequal(settings.model.termsX(:), settings.model.termsY(:));
output.methods = usedMethods;
output.estimationKeys = estimationKeys;
output.summary = summarizeResults(sets, variants, estimationKeys, usedMethods, axisNames);
output.baselines = struct('uncorrected', uncorrected, 'allMarks', allMarks);
output.waferCount = data.waferCount;
output.map = waferMap;

    function report(label)
        if ~isempty(progress)
            progress(done, totalSteps, label);
        end
    end
end

function keys = selectedEstimatorKeys(modelSettings, C)
keys = {};
for estimator = C.ESTIMATORS
    if isfield(modelSettings.estimators, estimator.key) && modelSettings.estimators.(estimator.key)
        keys{end + 1} = estimator.key; %#ok<AGROW>
    end
end
end

function entry = describeSet(context, modelSettings, plan, selection)
markIndices = unique(selection.markIndices);
warnings = {};
if isfield(selection, 'notEligible') && ~isempty(selection.notEligible)
    warnings{end + 1} = sprintf('手動プランの、必ず測るMarkが有効範囲外のShot %d個は、評価から外しました。', numel(selection.notEligible));
end
shotIndices = [context.items(selection.items).shotIndex];
entry = struct('method', plan.method, 'draw', plan.draw, 'items', selection.items, 'shotIndices', shotIndices, ...
    'markIndices', markIndices(:)', 'minSpacingMm', asc.minimumShotSpacing(context, selection.items), ...
    'criteria', criteriaOf(context.map, markIndices, modelSettings), ...
    'status', asc.describeStatus(context, selection.items, markIndices), ...
    'results', [], 'estimation', [], 'estimationSquares', [], 'gpChoices', []);
entry.warnings = warnings;
end

function criteria = criteriaOf(waferMap, markIndices, modelSettings)
% X・YのD基準・I基準（項が同じなら同じ計算を使い回す）
x = asc.designCriteria(waferMap, markIndices, modelSettings.termsX(:)');
same = isequal(modelSettings.termsX(:), modelSettings.termsY(:));
if same
    y = x;
else
    y = asc.designCriteria(waferMap, markIndices, modelSettings.termsY(:)');
end
criteria = struct('x', x, 'y', y, 'sameTerms', same);
end

function reference = criteriaReference(sets, axisNames)
% 効率の基準: 全部の選び方・試行の中で、D基準が最大のものとI基準が最小のもの（軸ごと。なければ []）
reference = struct();
for k = 1:numel(axisNames)
    usable = [];
    for s = 1:numel(sets)
        criteria = sets(s).criteria.(axisNames{k});
        if ~criteria.singular
            usable = [usable; criteria.logDet, criteria.trace]; %#ok<AGROW>
        end
    end
    if isempty(usable)
        reference.(axisNames{k}) = [];
    else
        reference.(axisNames{k}) = struct('logDet', max(usable(:, 1)), 'trace', min(usable(:, 2)));
    end
end
end

function result = summarizeStores(stores, axisNames)
% 複数の試行の指標（Wafer数×1）をまとめる。all は全試行・全Wafer、perDraw は試行ごとの平均の分布
metricKeys = {'rms', 'mean3sigma', 'max'};
result = struct();
for k = 1:numel(axisNames)
    for metric = metricKeys
        values = cellfun(@(store) store.(axisNames{k}).(metric{1}), stores, 'UniformOutput', false);
        drawMeans = cellfun(@meanOfFinite, values);
        result.(axisNames{k}).(metric{1}) = struct('all', asc.summarizeValues(vertcat(values{:})), 'perDraw', asc.summarizeValues(drawMeans));
    end
end
end

function value = meanOfFinite(values)
stats = asc.summarizeValues(values);
value = stats.mean;
end

function summary = summarizeConstraints(methodSets)
% 制約ごとに、満たした試行の数とずれ（何個のShotを移せば満たせるか）の平均・最大
first = methodSets(1).status;
keys = {first.rows.key};
labels = {first.rows.label};
hards = [first.rows.hard];
if ~isempty(first.center)
    keys{end + 1} = 'center';
    labels{end + 1} = first.center.label;
    hards(end + 1) = first.center.hard;
end
summary = struct('key', {}, 'label', {}, 'hard', {}, 'satisfied', {}, 'total', {}, 'meanShift', {}, 'maxShift', {});
for k = 1:numel(keys)
    ok = zeros(numel(methodSets), 1);
    shift = zeros(numel(methodSets), 1);
    for s = 1:numel(methodSets)
        status = methodSets(s).status;
        if strcmp(keys{k}, 'center')
            entry = status.center;
        else
            entry = status.rows(strcmp({status.rows.key}, keys{k}));
        end
        ok(s) = entry.ok;
        shift(s) = entry.shift;
    end
    summary(end + 1) = struct('key', keys{k}, 'label', labels{k}, 'hard', hards(k), 'satisfied', sum(ok), ...
        'total', numel(methodSets), 'meanShift', mean(shift), 'maxShift', max(shift)); %#ok<AGROW>
end
end

function summary = summarizeResults(sets, variants, estimationKeys, methodList, axisNames)
% 選び方 × 補正 × 軸 × 指標ごとに、全試行・全Waferの値をまとめる（methodList と同じ並び）
entries = cell(1, numel(methodList));
for m = 1:numel(methodList)
    methodSets = sets(strcmp({sets.method}, methodList(m).key));
    variantSummary = cell(1, numel(variants));
    gpChoices = struct('key', {}, 'lengthMm', {}, 'noiseRatio', {});
    for v = 1:numel(variants)
        stores = arrayfun(@(s) s.results(v), methodSets, 'UniformOutput', false);
        variantSummary{v} = summarizeStores(stores, axisNames);
        estimator = variants(v).estimator;
        if ~isempty(estimator) && strcmp(estimator.type, 'gp')
            lengths = arrayfun(@(s) s.gpChoices(v).lengthMm, methodSets, 'UniformOutput', false);
            ratios = arrayfun(@(s) s.gpChoices(v).noiseRatio, methodSets, 'UniformOutput', false);
            gpChoices(end + 1) = struct('key', variants(v).key, 'lengthMm', asc.summarizeValues(vertcat(lengths{:})), ...
                'noiseRatio', asc.summarizeValues(vertcat(ratios{:}))); %#ok<AGROW>
        end
    end
    estimationSummary = cell(1, numel(estimationKeys));
    for e = 1:numel(estimationKeys)
        if e <= numel(methodSets(1).estimation) && ~isempty(methodSets(1).estimation(e).x)
            stores = arrayfun(@(s) s.estimation(e), methodSets, 'UniformOutput', false);
            estimationSummary{e} = summarizeStores(stores, axisNames);
        else
            estimationSummary{e} = struct('x', [], 'y', []);
        end
    end
    entry = struct();
    entry.drawCount = numel(methodSets);
    entry.variants = [variantSummary{:}];
    entry.estimation = [estimationSummary{:}];
    entry.gpChoices = gpChoices;
    for k = 1:numel(axisNames)
        criteria = arrayfun(@(s) s.criteria.(axisNames{k}), methodSets, 'UniformOutput', false);
        criteria = [criteria{:}];
        entry.(['criteria' upper(axisNames{k})]) = struct('logDet', asc.summarizeValues([criteria.logDet]), ...
            'trace', asc.summarizeValues([criteria.trace]), 'singularCount', nnz([criteria.singular]));
    end
    entry.constraints = summarizeConstraints(methodSets);
    entry.kappaX = asc.summarizeValues(arrayfun(@(s) s.criteria.x.kappa, methodSets));
    entry.kappaY = asc.summarizeValues(arrayfun(@(s) s.criteria.y.kappa, methodSets));
    entry.minSpacingMm = asc.summarizeValues([methodSets.minSpacingMm]);
    entry.markCount = asc.summarizeValues(arrayfun(@(s) numel(s.markIndices), methodSets));
    entry.shotCount = asc.summarizeValues(arrayfun(@(s) numel(s.shotIndices), methodSets));
    entries{m} = entry;
end
summary = [entries{:}];
end
