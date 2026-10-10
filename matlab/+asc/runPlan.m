function plan = runPlan(waferMap, settings)
%RUNPLAN 制約付きD最適・I最適の「計画」だけを作る（評価データと補正は使わない）。
%   同じ設定なら、評価（asc.runEvaluation）の制約付きD最適・I最適と同じ点を選ぶ（アプリの「計画を作成」と同じ）。
%
%   plan.methods(m)      選んだ選び方（key, label, usesDraws, manual）
%   plan.sets(s)         選んだ点（method, draw, shotIndices, markIndices, criteria, status など。評価の値は持たない）
%   plan.relaxed         ソフトに切り替えた制約
%   plan.failedMethods   制約を満たす点を選べなかった選び方の名前（cell）

C = asc.constants();
[context, freeContext, relaxed] = asc.prepareContext(waferMap, settings);
termSets = {settings.model.termsX(:)', settings.model.termsY(:)'};
methods = struct('key', {}, 'label', {}, 'usesDraws', {}, 'manual', {});
sets = {};
failedMethods = cell(1, 0);
for key = C.PLAN_METHOD_KEYS
    method = C.METHODS(strcmp({C.METHODS.key}, key{1}));
    selection = asc.selectByMethod(key{1}, context, freeContext, settings, 0, termSets);
    if isempty(selection) || isempty(selection.markIndices)
        failedMethods{end + 1} = method.label; %#ok<AGROW>
        continue
    end
    methods(end + 1) = struct('key', key{1}, 'label', method.label, 'usesDraws', false, 'manual', false); %#ok<AGROW>
    sets{end + 1} = asc.describeSet(context, settings.model, struct('method', key{1}, 'draw', 0), selection); %#ok<AGROW>
end
sets = [sets{:}];
plan = struct();
plan.context = context;
plan.relaxed = relaxed;
plan.failedMethods = failedMethods;
plan.methods = methods;
plan.sets = sets;
plan.criteriaReference = asc.criteriaReference(sets);
plan.criteriaSameTerms = isequal(settings.model.termsX(:), settings.model.termsY(:));
plan.map = waferMap;
end
