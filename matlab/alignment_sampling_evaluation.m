%% アライメント計測Markの選び方の比較（MATLAB版）
% ブラウザ版（index.html）・Python版と*同じ計算・同じ乱数*で評価します。
% 同じ設定なら、同じ点が選ばれ、同じ残差になります（tests/testCrossLanguage.m で照合）。
%
% 使い方: このファイルを MATLAB エディターで開き、セクション（%%）ごとに「セクションの実行」で進めます。
%
% 流れ
%   1. 準備  2. 設定  3. Waferマップと評価データ  4. 手動プラン  5. 評価
%   6. 表（残差・D/I基準と制約・推定精度）  7. 図  8. 計測点数のスイープ  9. CSVで保存
%
% 番号（Shot・Mark・選び方など）は MATLAB 版ではすべて1始まりです。

%% 1. 準備
% matlab フォルダをパスに加えます（asc パッケージの関数を asc.○○ で呼べるようになります）。
scriptFolder = fileparts(mfilename('fullpath'));
if isempty(scriptFolder)
    scriptFolder = pwd;
end
addpath(scriptFolder);
outputFolder = fullfile(scriptFolder, 'output');  % CSVの保存先（Gitの管理外）
if ~isfolder(outputFolder)
    mkdir(outputFolder);
end

%% 2. 設定
% 初期設定はアプリの初期設定と同じです（Wafer 100枚、Shot 20個 × Mark 2個、試行30回、制約はすべてハード）。
% アプリの「設定をJSONで保存」で作ったファイルがあれば、settingsFile に置き場所を書くと、そのまま読み込みます
% （CSVのマップや手動プランも入ります）。
settingsFile = '';  % 例: fullfile(scriptFolder, '設定_20261004-1200.json')

if isempty(settingsFile)
    settings = asc.defaultSettings();
    waferMap = asc.generateWaferMap(settings.map);
    plansFromFile = [];
else
    loaded = asc.loadSettingsFile(settingsFile);
    settings = loaded.settings;
    waferMap = asc.mapFromLoaded(loaded);
    plansFromFile = asc.manualPlanInputs(loaded.manual, waferMap);
end

% ここで設定を変えられる（例: Wafer数、試行回数）
settings.evaluationData.waferCount = 100;
settings.sampling.draws = 30;
fprintf('計測Shot数: %d ／ 必ず測るMark: %s\n', settings.sampling.shotCount, mat2str(settings.sampling.designatedMarkNos'));

%% 3. Waferマップと評価データ
% 評価データは、Zernike（Fringe Z1〜Z36）の乱数係数で作るWafer高次傾向と計測ノイズです。
data = asc.generateEvaluationData(waferMap, settings.evaluationData);
fprintf('Shot %d個、有効なMark %d個、Wafer %d枚\n', numel(waferMap.shotIds), numel(waferMap.markX), data.waferCount);
fprintf('真のずれ X のRMS（全Wafer）: %.3f nm\n', sqrt(mean(data.truthX(:).^2)));

%% 4. 手動プラン（現行のサンプリング）を作る
% Shot番号（アプリやCSVの ShotId）の一覧から作ります。実際の現行サンプリングのShot番号に置き換えてください。
% 必ず測るMarkがWaferの有効範囲（半径150mm）の外に出るShotは評価から外れ、警告が出ます。
currentShotIds = {'11', '13', '20', '26', '31', '34', '37', '39', '45', '48', '55', '58', '62', '66', '70', '73', '80', '85', '92', '94'};
manualPlans = asc.planFromShotIds('現行（例）', currentShotIds, waferMap, 'manual:1');
if ~isempty(plansFromFile)
    manualPlans = [manualPlans, plansFromFile];
end

%% 5. 評価を実行する
% 選び方（ランダム・ポアソンディスク・D最適・I最適・手動プラン）× 補正（HOWAのみ、推定→HOWA、HOWA＋推定）で、
% 全Waferの残差を求めます。数秒〜十数秒かかります。
tic;
output = asc.runEvaluation(waferMap, data, settings, manualPlans);
fprintf('評価にかかった時間: %.1f 秒\n', toc);
fprintf('選び方: %s\n', strjoin({output.methods.label}, '、'));
if isempty(output.relaxed)
    fprintf('ソフトに切り替えた制約: なし\n');
else
    fprintf('ソフトに切り替えた制約: %s\n', strjoin({output.relaxed.label}, '、'));
end
allWarnings = unique([output.sets.warnings], 'stable');
for k = 1:numel(allWarnings)
    fprintf('警告: %s\n', allWarnings{k});
end

%% 6-1 表: 残差（RMS・X のWafer平均）
% 行が選び方、列が補正です。小さいほど良い結果です。
methodNames = arrayfun(@(method) asc.methodLabel(output, method.key), output.methods, 'UniformOutput', false);
residualTable = zeros(numel(output.methods), numel(output.variants));
for m = 1:numel(output.methods)
    for v = 1:numel(output.variants)
        residualTable(m, v) = output.summary(m).variants(v).x.rms.all.mean;
    end
end
disp(array2table(round(residualTable, 3), 'RowNames', methodNames, 'VariableNames', {output.variants.label}));
baseline = asc.summarizeStore(output.baselines.allMarks);
fprintf('全点計測（HOWAのみ）: %.3f nm\n', baseline.x.rms.mean);

%% 6-2 表: D基準・I基準と制約の満たし具合
% D基準 log₁₀det(XᵀX) は大きいほど、I基準（予測分散の平均÷σ²）は小さいほど良い選び方です。
% 効率は、この評価の中で最も良いものを100%にした値です。
% 制約は「満たした回数 / 試行の数」と、外れたときのずれ（何個のShotを移せば満たせるか）の平均です。
criteriaRows = cell(numel(output.methods), 5);
for m = 1:numel(output.methods)
    summary = output.summary(m);
    meanCriteria = struct('logDet', summary.criteriaX.logDet.mean, 'trace', summary.criteriaX.trace.mean, ...
        'p', numel(settings.model.termsX), 'singular', summary.criteriaX.singularCount > 0);
    efficiency = asc.efficiencies(meanCriteria, output.criteriaReference.x);
    constraintText = strjoin(arrayfun(@(c) sprintf('%s %d/%d', c.label, c.satisfied, c.total), summary.constraints, 'UniformOutput', false), '、');
    criteriaRows(m, :) = {round(meanCriteria.logDet / log(10), 2), round(efficiency.d), round(meanCriteria.trace, 3), round(efficiency.i), constraintText};
end
disp(cell2table(criteriaRows, 'RowNames', methodNames, 'VariableNames', {'D基準', 'D効率_pct', 'I基準', 'I効率_pct', '制約'}));

%% 6-3 表: 推定精度（未計測Markでの 推定値 − 真のずれ）
% 「HOWA（多項式の予測）」より小さい推定手法なら、未計測Markを当てる力が多項式より上です。
estimationTable = NaN(numel(output.methods), numel(output.estimationKeys));
for m = 1:numel(output.methods)
    for e = 1:numel(output.estimationKeys)
        if ~isempty(output.summary(m).estimation(e).x)
            estimationTable(m, e) = output.summary(m).estimation(e).x.rms.all.mean;
        end
    end
end
estimationNames = cellfun(@asc.estimationLabel, output.estimationKeys, 'UniformOutput', false);
disp(array2table(round(estimationTable, 3), 'RowNames', methodNames, 'VariableNames', estimationNames));

%% 7-1 図: 残差の箱ひげ図（HOWAのみ と 推定→HOWA の各推定手法）
figure('Name', '残差の箱ひげ図', 'Position', [100, 100, 900, 1000]);
asc.plotResidualBoxes(output, 'estimateThenHowa', 'x', 'rms');

%% 7-2 図: 選び方ごとに選んだ点
% ランダム・ポアソンは、残差（HOWAのみ）が中央の試行を表示します。
figure('Name', '選んだ点', 'Position', [100, 100, 1500, 1000]);
layout = tiledlayout(2, 3, 'TileSpacing', 'compact');
for m = 1:numel(output.methods)
    methodSets = output.sets(strcmp({output.sets.method}, output.methods(m).key));
    rmsByDraw = arrayfun(@(s) mean(s.results(1).x.rms, 'omitnan'), methodSets);
    [~, order] = sort(rmsByDraw);
    entry = methodSets(order(ceil(numel(order) / 2)));
    asc.plotSelectionMap(waferMap, entry, sprintf('%s（Mark %d個）', methodNames{m}, numel(entry.markIndices)), settings.zones, nexttile(layout));
end

%% 7-3 図: 推定誤差のマップ
% 未計測Markごとに、全Waferの推定誤差をRMSにして色で示します。Wafer端など、推定を外しやすい場所が分かります。
figure('Name', '推定誤差のマップ', 'Position', [100, 100, 1200, 550]);
layout = tiledlayout(1, 2, 'TileSpacing', 'compact');
asc.plotEstimationErrorMap(output, 'random', 'howa', 'x', [], nexttile(layout));
asc.plotEstimationErrorMap(output, 'random', 'gpXYR', 'x', [], nexttile(layout));

%% 8. 計測点数のスイープ（トレードオフカーブ）
% 計測Shot数を変えながら評価します。手動プランは、そのMark数の位置に × で重ねます。
% 時間を抑えるため、ここでは試行を5回にしています。
sweepSettings = struct('startShots', 10, 'endShots', 60, 'stepShots', 10, 'draws', 5);
targetNm = 0.35;
sweep = asc.runSweep(waferMap, data, settings, sweepSettings, manualPlans);
figure('Name', 'トレードオフカーブ', 'Position', [100, 100, 800, 500]);
asc.plotSweep(sweep, LogScale=true, Target=targetNm);
for method = sweep.methods(:)'
    reached = NaN;
    for point = sweep.points
        m = find(strcmp({point.methods.key}, method.key), 1);
        if ~isempty(m) && point.summary(m).variants(1).x.rms.all.mean <= targetNm
            reached = point.markCounts(m);
            break
        end
    end
    if isnan(reached)
        fprintf('%s: 目標 %.2f nm には範囲内では届かない\n', method.label, targetNm);
    else
        fprintf('%s: 目標 %.2f nm に届く最小の計測Mark数 = %d\n', method.label, targetNm, round(reached));
    end
end

%% 9. 結果をCSVで保存する
% output フォルダに、選び方 × 補正の集計と、選んだ点の一覧を保存します（Gitでは管理しません）。
metricNames = {'rms', 'mean3sigma', 'max'};
summaryRows = {};
for m = 1:numel(output.methods)
    for v = 1:numel(output.variants)
        for axisName = {'x', 'y'}
            for metric = metricNames
                stats = output.summary(m).variants(v).(axisName{1}).(metric{1}).all;
                summaryRows(end + 1, :) = {methodNames{m}, output.variants(v).label, upper(axisName{1}), metric{1}, ...
                    stats.mean, stats.median, stats.p95, stats.max}; %#ok<SAGROW>
            end
        end
    end
end
writetable(cell2table(summaryRows, 'VariableNames', {'Method', 'Correction', 'Axis', 'Metric', 'Mean', 'Median', 'P95', 'Max'}), ...
    fullfile(outputFolder, 'summary.csv'), 'Encoding', 'UTF-8');
selectionRows = {};
for s = 1:numel(output.sets)
    for markIndex = output.sets(s).markIndices
        shot = waferMap.markShot(markIndex);
        selectionRows(end + 1, :) = {output.sets(s).method, output.sets(s).draw + 1, waferMap.shotIds{shot}, ...
            waferMap.markNo(markIndex), waferMap.markX(markIndex), waferMap.markY(markIndex)}; %#ok<SAGROW>
    end
end
writetable(cell2table(selectionRows, 'VariableNames', {'Method', 'Draw', 'ShotId', 'MarkNo', 'X_mm', 'Y_mm'}), ...
    fullfile(outputFolder, 'selections.csv'), 'Encoding', 'UTF-8');
fprintf('保存しました: %s\n', outputFolder);

%% 練習問題
% 1. 必ず測るMarkを4つ（[1; 2; 3; 4]）にし、計測Shot数を10にして評価してください。
%    D最適と現行（例）の残差はどう変わるでしょうか。
% 2. 6次以上のZernike項（多項式で補正できない成分）を大きくすると、推定→HOWA と HOWA＋推定の
%    どちらが効くようになるか試してください（settings.evaluationData.terms(k).xValue を変える）。
%
% 練習問題1の書き方の例（実行すると数秒かかります）:
%   exercise = settings;
%   exercise.sampling.designatedMarkNos = [1; 2; 3; 4];
%   exercise.sampling.shotCount = 10;
%   exercise.sampling.draws = 10;
%   result = asc.runEvaluation(waferMap, data, exercise);
%   for m = 1:numel(result.methods)
%       fprintf('%s %.3f\n', result.methods(m).label, result.summary(m).variants(1).x.rms.all.mean);
%   end
%
% よくある間違い: 計測Mark数が多項式の項数（初期設定では21項）より少ないと、HOWAが不安定になり
% 残差が大きくなります。このときは警告が出ます（output.sets(s).warnings）。
