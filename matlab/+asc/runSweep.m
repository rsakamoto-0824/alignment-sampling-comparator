function sweep = runSweep(waferMap, data, settings, sweepSettings, manualPlans, progress)
%RUNSWEEP 計測Shot数を変えながら評価する（計測コストと精度のトレードオフ）。
%   sweepSettings: startShots, endShots, stepShots, draws, methods（省略時は settings.sweep）
%   比べる選び方は sweepSettings.methods（なければ評価の選び方）。計測Mark数は選んだShotの有効なMarkの数の合計の
%   試行平均（端のShotを選べば選び方ごとに少し違う）。手動プランは1回だけ評価して点として返す（sweep.manual）。
%
%   sweep.points(k): shotCount, methods, markCounts（methods ごとの平均Mark数）, summary（runEvaluation と同じ形）, errors
%   sweep.manual:    手動プランの methods, summary, markCounts（なければ []）

if nargin < 4 || isempty(sweepSettings)
    sweepSettings = settings.sweep;
end
if nargin < 5 || isempty(manualPlans)
    manualPlans = struct('key', {}, 'label', {}, 'shotIndices', {});
end
if nargin < 6
    progress = [];
end
context = asc.buildContext(waferMap, settings);
values = sweepShotCounts(sweepSettings, numel(context.items));
plans = manualPlans(arrayfun(@(plan) ~isempty(plan.shotIndices), manualPlans));
steps = numel(values) + double(~isempty(plans));
points = cell(1, numel(values));
last = [];
for index = 1:numel(values)
    shotCount = values(index);
    pointSettings = settings;
    pointSettings.sampling.shotCount = shotCount;
    pointSettings.sampling.draws = sweepSettings.draws;
    if isfield(sweepSettings, 'methods') && ~isempty(sweepSettings.methods)
        pointSettings.sampling.methods = sweepSettings.methods;
    end
    report = [];
    if ~isempty(progress)
        report = @(done, total, label) progress(index - 1 + done / total, steps, sprintf('計測Shot数 %d: %s', shotCount, label));
    end
    try
        output = asc.runEvaluation(waferMap, data, pointSettings, [], report);
    catch err
        if ~startsWith(err.identifier, 'asc:')
            rethrow(err);
        end
        points{index} = struct('shotCount', shotCount, 'methods', [], 'markCounts', [], 'summary', [], 'relaxed', [], ...
            'failedMethods', {{}}, 'warnings', {{}}, 'errors', {{err.message}});
        continue
    end
    markCounts = arrayfun(@(entry) entry.markCount.mean, output.summary);
    points{index} = struct('shotCount', shotCount, 'methods', output.methods, 'markCounts', markCounts, 'summary', output.summary, ...
        'relaxed', output.relaxed, 'failedMethods', {output.failedMethods}, 'warnings', {unique([output.sets.warnings], 'stable')}, 'errors', {{}});
    last = output;
end
points = [points{:}];

manual = [];
if ~isempty(plans)
    manualSettings = settings;
    for key = fieldnames(manualSettings.sampling.methods)'
        manualSettings.sampling.methods.(key{1}) = false;
    end
    output = asc.runEvaluation(waferMap, data, manualSettings, plans);
    manual = struct('methods', output.methods, 'summary', output.summary, ...
        'shotCounts', arrayfun(@(entry) entry.shotCount.mean, output.summary), ...
        'markCounts', arrayfun(@(entry) entry.markCount.mean, output.summary));
end
sweep = struct('points', points, 'manual', manual, 'waferCount', data.waferCount, 'draws', sweepSettings.draws);
if isempty(last)
    sweep.methods = [];
    sweep.variants = [];
    sweep.estimationKeys = {};
    sweep.baseline = [];
    sweep.uncorrected = [];
else
    sweep.methods = last.methods;
    sweep.variants = last.variants;
    sweep.estimationKeys = last.estimationKeys;
    sweep.baseline = asc.summarizeStore(last.baselines.allMarks);
    sweep.uncorrected = asc.summarizeStore(last.baselines.uncorrected);
end
end

function values = sweepShotCounts(sweepSettings, eligibleCount)
% スイープする計測Shot数の一覧。設定の誤りはエラー
startShots = sweepSettings.startShots;
endShots = sweepSettings.endShots;
stepShots = sweepSettings.stepShots;
if ~(startShots >= 1 && stepShots >= 1 && endShots >= startShots)
    error('asc:invalidSettings', '計測Shot数の範囲は「1 ≦ 開始 ≦ 終了」、刻みは1以上の整数にしてください。');
end
if endShots > eligibleCount
    error('asc:invalidSettings', '終了の計測Shot数（%d）が選べるShot数（%d）を超えています。', endShots, eligibleCount);
end
values = startShots:stepShots:endShots;
end
