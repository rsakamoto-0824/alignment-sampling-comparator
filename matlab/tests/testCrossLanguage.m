function tests = testCrossLanguage
%TESTCROSSLANGUAGE ブラウザ版（JavaScript）と同じ結果になるかの照合。
%   基準データ tests/reference/scenario_*.json は `node tools/export_reference.js` で作る。
%   選んだ点（Shot・Mark）は完全に一致し、残差などの数値は丸め誤差の範囲（相対 1e-9）で一致することを確かめる。
%   実行（matlab フォルダで）: results = runtests('tests'); table(results)
%   番号は MATLAB 版が1始まり、基準データが0始まり（比べるときに1を引く）。
tests = functiontests(localfunctions);
end

function setupOnce(testCase)
here = fileparts(mfilename('fullpath'));
addpath(fileparts(here));
referenceDirectory = fullfile(fileparts(fileparts(here)), 'tests', 'reference');
for name = {'a', 'b', 'c'}
    reference = jsondecode(fileread(fullfile(referenceDirectory, ['scenario_' name{1} '.json'])));
    settings = reference.settings;
    scenario.reference = reference;
    scenario.map = asc.generateWaferMap(settings.map);
    scenario.data = asc.generateEvaluationData(scenario.map, settings.evaluationData);
    scenario.plans = asc.planFromShotIds('手動の例', reference.manualShotIds, scenario.map, 'manual:1');
    started = tic;
    scenario.output = asc.runEvaluation(scenario.map, scenario.data, settings, scenario.plans);
    fprintf('場面%s: 評価 %.1f 秒\n', upper(name{1}), toc(started));
    testCase.TestData.(name{1}) = scenario;
end
end

function testRandomSameAsJavaScript(testCase)
random = asc.Random(1);
values = [random.next(), random.next(), random.normal(), random.normal(), random.normal()];
expected = [0.6270739405881613, 0.002735721180215478, 1.1231041937525543, -0.1343525350713427, -0.049227862786499016];
verifyLessThanOrEqual(testCase, max(abs(values - expected)), 1e-15);
verifyEqual(testCase, [asc.Random.deriveSeed(1, 0), asc.Random.deriveSeed(1, 1000), asc.Random.deriveSeed(4294967295, 7919)], ...
    [2980047484, 2214279594, 1482834068]);
end

function testScenarioAMapAndData(testCase)
checkMapAndData(testCase, testCase.TestData.a);
end

function testScenarioASelections(testCase)
checkSelections(testCase, testCase.TestData.a);
end

function testScenarioASummary(testCase)
checkSummary(testCase, testCase.TestData.a);
end

function testScenarioASweep(testCase)
checkSweep(testCase, testCase.TestData.a);
end

function testScenarioAPlan(testCase)
checkPlan(testCase, testCase.TestData.a);
end

function testScenarioBPlan(testCase)
checkPlan(testCase, testCase.TestData.b);
end

function testScenarioCPlan(testCase)
checkPlan(testCase, testCase.TestData.c);
end

function testScenarioBMapAndData(testCase)
checkMapAndData(testCase, testCase.TestData.b);
end

function testScenarioBSelections(testCase)
checkSelections(testCase, testCase.TestData.b);
end

function testScenarioBSummary(testCase)
checkSummary(testCase, testCase.TestData.b);
end

function testScenarioCMapAndData(testCase)
checkMapAndData(testCase, testCase.TestData.c);
end

function testScenarioCSummary(testCase)
checkSummary(testCase, testCase.TestData.c);
end

function testScenarioCSelections(testCase)
checkSelections(testCase, testCase.TestData.c);
end

function testScenarioCSweep(testCase)
% 一筆書きを右下から・強制計測Shot・スイープで選ぶ選び方を絞る（端のShotでMark数が選び方ごとに違う）
checkSweep(testCase, testCase.TestData.c);
end

function testDefaultSettingsMatchBrowser(testCase)
reference = testCase.TestData.a.reference.settings;
settings = asc.defaultSettings();
for section = {'map', 'zones', 'model', 'constraints'}
    verifyEqual(testCase, settings.(section{1}), reference.(section{1}), [section{1} ' の初期設定が違います']);
end
verifyEqual(testCase, settings.evaluationData.terms, reference.evaluationData.terms);
verifyEqual(testCase, settings.sweep.methods, reference.sweep.methods);
verifyEqual(testCase, sort(fieldnames(settings.sampling)), sort(fieldnames(reference.sampling)));
end

function testOldSettingsFile(testCase)
% 版2の設定ファイル: D最適・I最適は制約付きとして読み、なくなった項目（必ず測るMark・HOWA＋推定）は使わない
old = struct('version', 2, 'settings', struct( ...
    'sampling', struct('shotCount', 12, 'designatedMarkNos', [1, 4], 'markMode', 'atLeast', ...
        'methods', struct('random', false, 'poisson', true, 'dOptimal', true, 'iOptimal', false)), ...
    'model', struct('flows', struct('howa', true, 'estimateThenHowa', false, 'howaPlusEstimate', true))));
path = [tempname '.json'];
cleanup = onCleanup(@() delete(path));
fid = fopen(path, 'w', 'n', 'UTF-8');
fwrite(fid, jsonencode(old), 'char');
fclose(fid);
loaded = asc.loadSettingsFile(path);
verifyEqual(testCase, loaded.settings.sampling.shotCount, 12);
verifyFalse(testCase, isfield(loaded.settings.sampling, 'designatedMarkNos'));
verifyEqual(testCase, loaded.settings.sampling.methods, struct('random', false, 'poisson', true, 'dOptimal', false, 'iOptimal', false, ...
    'constrainedD', true, 'constrainedI', false));
verifyEqual(testCase, loaded.settings.model.flows, struct('howa', true, 'estimateThenHowa', false));
end

function testCsvRoundTrip(testCase)
settings = asc.defaultSettings();
waferMap = asc.generateWaferMap(settings.map);
parsed = asc.parseMapCsv(asc.mapToCsv(waferMap), settings.map);
verifyEqual(testCase, numel(parsed.markX), numel(waferMap.markX));
verifyLessThanOrEqual(testCase, max(abs([parsed.markX - waferMap.markX; parsed.markY - waferMap.markY])), 1e-9);
end

% ---- 照合の部品 ----------------------------------------------------------------

function checkMapAndData(testCase, scenario)
reference = scenario.reference;
waferMap = scenario.map;
data = scenario.data;
verifyEqual(testCase, numel(waferMap.shotIds), reference.map.shotCount);
verifyEqual(testCase, waferMap.shotIds, reference.map.shotIds);
verifyEqual(testCase, waferMap.shotScan, reference.map.scans);
verifyEqual(testCase, waferMap.shotDefinedMarkCount, reference.map.definedMarkCounts);
marks = [waferMap.markX, waferMap.markY, waferMap.markShot - 1, waferMap.markNo];
verifyLessThanOrEqual(testCase, max(abs(marks(:) - reshape(reference.map.marks, [], 1))), 1e-12);
checkVector(testCase, data.truthX(1, :)', reference.data.truthX0, 1e-9, 'truthX 1枚目');
checkVector(testCase, data.truthY(end, :)', reference.data.truthYLast, 1e-9, 'truthY 最後');
checkVector(testCase, data.noiseX(1, :)', reference.data.noiseX0, 1e-12, 'noiseX 1枚目');
checkVector(testCase, data.noiseY(end, :)', reference.data.noiseYLast, 1e-12, 'noiseY 最後');
end

function checkSelections(testCase, scenario)
output = scenario.output;
reference = scenario.reference;
verifyEqual(testCase, {output.methods.key}', reference.methods);
verifyEqual(testCase, {output.variants.key}', reference.variants);
verifyRelaxed(testCase, output.relaxed, reference.relaxed);
verifyEqual(testCase, numel(output.failedMethods), numel(reference.failedMethods), '選べなかった選び方の数が違います');
verifyEqual(testCase, [output.context.items.shotIndex]' - 1, reference.eligibleShots(:), '選べるShotが違います');
verifyEqual(testCase, output.context.mandatoryItems(:) - 1, reshape(reference.mandatoryItems, [], 1), '強制計測Shotの候補番号が違います');
checkSets(testCase, output.sets, reference.sets);
end

function checkPlan(testCase, scenario)
% 「計画を作成」の点（制約付きD最適・I最適）と、選択点のCSVの文字が同じ
reference = scenario.reference;
plan = asc.runPlan(scenario.map, reference.settings);
verifyRelaxed(testCase, plan.relaxed, reference.plan.relaxed);
checkSets(testCase, plan.sets, reference.plan.sets);
verifyEqual(testCase, asc.selectionToCsv(scenario.map, plan.sets(1).markIndices), reference.selectionCsv, '選択点のCSVが違います');
end

function verifyRelaxed(testCase, actual, expected)
if isempty(expected)
    verifyEmpty(testCase, actual);
else
    verifyEqual(testCase, {actual.key}', cellstr(expected));
end
end

function checkSets(testCase, actualSets, expectedSets)
% 選んだ点（Shot・Mark の完全一致）と、D・I基準・制約の満たし具合を照合する
verifyEqual(testCase, numel(actualSets), numel(expectedSets));
for s = 1:numel(expectedSets)
    actual = actualSets(s);
    expected = expectedSets(s);
    label = sprintf('%s 試行%d', expected.method, expected.draw + 1);
    verifyEqual(testCase, actual.method, expected.method);
    verifyEqual(testCase, actual.shotIndices - 1, expected.shotIndices(:)', [label ': 選んだShotが違います']);
    verifyEqual(testCase, actual.markIndices - 1, expected.markIndices(:)', [label ': 測るMarkが違います']);
    assertClose(testCase, actual.minSpacingMm, expected.minSpacingMm, [label ' 最小間隔']);
    for axisName = {'x', 'y'}
        actualCriteria = actual.criteria.(axisName{1});
        expectedCriteria = expected.criteria.(axisName{1});
        verifyEqual(testCase, actualCriteria.singular, expectedCriteria.singular);
        assertClose(testCase, actualCriteria.logDet, expectedCriteria.logDet, [label ' D基準 ' axisName{1}]);
        assertClose(testCase, actualCriteria.trace, expectedCriteria.trace, [label ' I基準 ' axisName{1}]);
    end
    rows = asc.statusRows(actual.status);
    verifyEqual(testCase, {rows.key}', {expected.shifts.key}', [label ': 制約の並びが違います']);
    verifyEqual(testCase, [rows.shift]', [expected.shifts.shift]', [label ': 制約のずれが違います']);
    verifyEqual(testCase, [rows.ok]', [expected.shifts.ok]', [label ': 制約の満たし具合が違います']);
end
end

function checkSummary(testCase, scenario)
output = scenario.output;
reference = scenario.reference;
for m = 1:numel(output.methods)
    methodKey = output.methods(m).key;
    expected = reference.summary.(matlab.lang.makeValidName(methodKey));
    actual = output.summary(m);
    verifyEqual(testCase, actual.drawCount, expected.drawCount);
    for v = 1:numel(output.variants)
        expectedVariant = expected.variants.(matlab.lang.makeValidName(output.variants(v).key));
        for axisName = {'x', 'y'}
            for metric = {'rms', 'mean3sigma', 'max'}
                stats = actual.variants(v).(axisName{1}).(metric{1}).all;
                values = expectedVariant.(axisName{1}).(metric{1});
                for statistic = {'mean', 'p95', 'max'}
                    assertClose(testCase, stats.(statistic{1}), values.(statistic{1}), ...
                        sprintf('%s %s %s %s %s', methodKey, output.variants(v).key, axisName{1}, metric{1}, statistic{1}));
                end
            end
        end
    end
    for e = 1:numel(output.estimationKeys)
        key = output.estimationKeys{e};
        for axisName = {'x', 'y'}
            values = expected.estimation.(key).(axisName{1});
            assertClose(testCase, actual.estimation(e).(axisName{1}).rms.all.mean, values.rms, sprintf('%s 推定精度 %s %s', methodKey, key, axisName{1}));
            assertClose(testCase, actual.estimation(e).(axisName{1}).max.all.mean, values.max, sprintf('%s 推定精度 %s %s 最大', methodKey, key, axisName{1}));
        end
    end
    for g = 1:numel(actual.gpChoices)
        choice = actual.gpChoices(g);
        values = expected.gpChoices.(matlab.lang.makeValidName(choice.key));
        verifyEqual(testCase, choice.lengthMm.count, values.count);
        assertClose(testCase, choice.lengthMm.median, values.lengthMedian, [methodKey ' ' choice.key ' 相関の長さ']);
        assertClose(testCase, choice.noiseRatio.median, values.ratioMedian, [methodKey ' ' choice.key ' ノイズ比']);
    end
    verifyEqual(testCase, {actual.constraints.key}', {expected.constraints.key}');
    verifyEqual(testCase, [actual.constraints.satisfied]', [expected.constraints.satisfied]');
    verifyEqual(testCase, [actual.constraints.total]', [expected.constraints.total]');
    verifyLessThanOrEqual(testCase, max(abs([actual.constraints.meanShift]' - [expected.constraints.meanShift]')), 1e-12);
end
for axisName = {'x', 'y'}
    for key = {'logDet', 'trace'}
        assertClose(testCase, output.criteriaReference.(axisName{1}).(key{1}), reference.criteriaReference.(axisName{1}).(key{1}), ...
            ['効率の基準 ' axisName{1} ' ' key{1}]);
    end
end
baseline = asc.summarizeStore(output.baselines.allMarks);
assertClose(testCase, baseline.x.rms.mean, reference.baseline, '全点計測');
end

function checkSweep(testCase, scenario)
reference = scenario.reference.sweep;
sweep = asc.runSweep(scenario.map, scenario.data, scenario.reference.settings, [], scenario.plans);
verifyEqual(testCase, [sweep.points.shotCount]', [reference.points.shotCount]');
for k = 1:numel(reference.points)
    point = sweep.points(k);
    expected = reference.points(k);
    for name = fieldnames(expected.markCounts)'
        m = methodIndexOf(point.methods, name{1});
        verifyEqual(testCase, point.markCounts(m), expected.markCounts.(name{1}), sprintf('スイープ Shot %d %s のMark数', point.shotCount, name{1}));
        actual = point.summary(m).variants(1).x.rms.all.mean;
        assertClose(testCase, actual, expected.howaRmsX.(name{1}), sprintf('スイープ Shot %d %s', point.shotCount, name{1}));
    end
end
for name = fieldnames(reference.manual)'
    m = methodIndexOf(sweep.manual.methods, name{1});
    verifyEqual(testCase, sweep.manual.markCounts(m), reference.manual.(name{1}).markCount);
    assertClose(testCase, sweep.manual.summary(m).variants(1).x.rms.all.mean, reference.manual.(name{1}).howaRmsX, 'スイープ 手動プラン');
end
end

function index = methodIndexOf(methods, validName)
index = find(strcmp(cellfun(@matlab.lang.makeValidName, {methods.key}, 'UniformOutput', false), validName), 1);
end

function checkVector(testCase, actual, expected, tolerance, label)
scale = max(1, max(abs(expected)));
verifyLessThanOrEqual(testCase, max(abs(actual - expected)), tolerance * scale, label);
end

function assertClose(testCase, actual, expected, label)
% expected が []（JSON の null）なら、ブラウザ版では計算できない値（MATLAB では NaN か ∞）
relativeTolerance = 1e-9;
if isempty(expected)
    verifyFalse(testCase, isfinite(actual), sprintf('%s: ブラウザ版は計算できない値ですが、%g になりました', label, actual));
    return
end
verifyLessThanOrEqual(testCase, abs(actual - expected), relativeTolerance * max(1, abs(expected)), ...
    sprintf('%s: %.15g と %.15g が違います', label, actual, expected));
end
