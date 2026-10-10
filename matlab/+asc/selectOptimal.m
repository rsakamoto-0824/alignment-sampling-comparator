function selection = selectOptimal(context, random, criterion, termSets, startCount)
%SELECTOPTIMAL D最適（criterion='D'）・I最適（'I'）。選べなければ []。
%   開始点（ハード制約を満たす無作為な選択）ごとに入れ替え法（Fedorov）を行い、目的が最も良いものを使う。
%   I最適は、D最適の入れ替えで整えてから探す。termSets は X と Y の多項式の項（0始まりの番号）の cell。
%   制約付きは context、制約なしは asc.unconstrainedContext(context) を渡す。選んだShotの有効なMarkをすべて測る。

models = buildModels(context, termSets);
best = [];
bestObjective = -Inf;
for start = 1:startCount
    state = asc.findFeasibleState(context, random);
    if isempty(state)
        continue
    end
    if strcmp(criterion, 'I')
        state = exchangeOptimize(context, models, 'D', state);
    end
    state = exchangeOptimize(context, models, criterion, state);
    value = objective(context, models, criterion, state);
    if asc.isClearlyGreater(value, bestObjective)
        best = state;
        bestObjective = value;
    end
end
if isempty(best)
    selection = [];
    return
end
selection = struct('items', best.List, 'markIndices', asc.measuredMarks(context, best.List));
end

function models = buildModels(context, termSets)
% 補正多項式ごとの計算材料（XとYで項が同じなら1つにまとめる）。
% blocks は候補（Shot）ごとの、測るMarkでの多項式の値（k × p × 候補数）。Shotごとに有効なMarkの数が違う
% （Markが揃わない端のShot）ので、最も多いMark数 k まで0の行で埋める。0の行は情報行列に何も足さず、
% 入れ替えの計算（Woodbury）でも結果を変えない
uniqueTerms = {};
for k = 1:numel(termSets)
    terms = termSets{k}(:)';
    if ~any(cellfun(@(entry) isequal(entry, terms), uniqueTerms))
        uniqueTerms{end + 1} = terms; %#ok<AGROW>
    end
end
uv = [context.map.markU, context.map.markV];
itemCount = numel(context.items);
most = max(arrayfun(@(item) numel(item.marks), context.items));
models = struct('terms', uniqueTerms, 'p', [], 'weight', [], 'blocks', []);
for m = 1:numel(models)
    terms = models(m).terms;
    allDesign = asc.polynomialDesign(uv, terms);
    models(m).p = numel(terms);
    models(m).weight = allDesign' * allDesign / size(uv, 1);
    blocks = zeros(most, numel(terms), itemCount);
    for item = 1:itemCount
        marks = context.items(item).marks;
        blocks(1:numel(marks), :, item) = asc.polynomialDesign(uv(marks, :), terms);
    end
    models(m).blocks = blocks;
end
end

function prepared = prepareExchange(model, selectedItems, useWeight)
% 現在の選択での前計算（A = M⁻¹、候補ごとの Q = A Fᵀ、G = F A Fᵀ、I最適用に S = W Q、H = Qᵀ W Q）
C = asc.constants();
p = model.p;
blocks = model.blocks;
stacked = reshape(permute(blocks(:, :, selectedItems), [1, 3, 2]), [], p);
information = stacked' * stacked + C.INFORMATION_RIDGE * eye(p);
[upper, failed] = chol(information);
if failed
    information = information + 1e-6 * eye(p);
    upper = chol(information);
end
inverse = inv(information);
prepared.logDet = 2 * sum(log(diag(upper)));
prepared.traceWeighted = sum(sum(inverse .* model.weight'));
prepared.q = pagemtimes(inverse, permute(blocks, [2, 1, 3]));
prepared.g = pagemtimes(blocks, prepared.q);
if useWeight
    prepared.s = pagemtimes(model.weight, prepared.q);
    prepared.h = pagemtimes(prepared.q, 'transpose', prepared.s, 'none');
end
end

function [logDetChange, traceChange, valid] = swapChanges(model, prepared, removed, useWeight)
% removed を外して各候補を入れたときの変化（Woodburyの公式）。log det の変化、予測分散の和の変化、正則のままか
blocks = model.blocks;
[k, ~, itemCount] = size(blocks);
gRemoved = prepared.g(:, :, removed);
gCross = pagemtimes(blocks, prepared.q(:, :, removed));  % F_added A F_removedᵀ
signFactor = 1 - 2 * mod(k, 2);
identity = eye(k);
logDetChange = NaN(itemCount, 1);
traceChange = zeros(itemCount, 1);
valid = false(itemCount, 1);
if useWeight
    traceChange = NaN(itemCount, 1);
    hCross = pagemtimes(prepared.q, 'transpose', prepared.s(:, :, removed), 'none');  % Q_addedᵀ W Q_removed
    hRemoved = prepared.h(:, :, removed);
end
for item = 1:itemCount
    kernel = [prepared.g(:, :, item) + identity, gCross(:, :, item); gCross(:, :, item)', gRemoved - identity];
    signedDet = signFactor * det(kernel);
    if ~(signedDet > 1e-12)
        continue
    end
    valid(item) = true;
    logDetChange(item) = log(signedDet);
    if useWeight
        weighted = [prepared.h(:, :, item), hCross(:, :, item); hCross(:, :, item)', hRemoved];
        traceChange(item) = -trace(kernel \ weighted);
    end
end
end

function state = exchangeOptimize(context, models, criterion, state)
% D最適またはI最適の入れ替え法。ハード制約を外す入れ替えはしない（調べる順はブラウザ版と同じ）
C = asc.constants();
useWeight = strcmp(criterion, 'I');
totalTerms = sum([models.p]);
penaltyScale = context.softStrength * C.SOFT_PENALTY_LOG_EFFICIENCY;
forced = asc.forcedItemsOf(context);
itemCount = numel(context.items);
for pass = 1:C.OPTIMAL_MAX_PASSES
    prepared = cell(1, numel(models));
    for m = 1:numel(models)
        prepared{m} = prepareExchange(models(m), state.List, useWeight);
    end
    traceTotal = sum(cellfun(@(entry) entry.traceWeighted, prepared));
    bestGain = 1e-9;
    bestSwap = [];
    for removed = state.List
        if ismember(removed, forced)
            continue
        end
        hardDelta = state.swapDeltaAll(removed, true);
        valid = true(itemCount, 1);
        logDetSum = zeros(itemCount, 1);
        traceSum = zeros(itemCount, 1);
        for m = 1:numel(models)
            [logDetChange, traceChange, modelValid] = swapChanges(models(m), prepared{m}, removed, useWeight);
            valid = valid & modelValid;
            logDetSum = logDetSum + logDetChange;
            traceSum = traceSum + traceChange;
        end
        if useWeight
            newTrace = traceTotal + traceSum;
            valid = valid & newTrace > 0;
            gains = NaN(itemCount, 1);
            gains(valid) = log(traceTotal) - log(newTrace(valid));
        else
            gains = logDetSum / totalTerms;
        end
        gains = gains - penaltyScale * state.swapDeltaAll(removed, false);
        for added = 1:itemCount
            if state.Selected(added) || hardDelta(added) > 0 || ~valid(added)
                continue
            end
            if asc.isClearlyGreater(gains(added), bestGain)
                bestGain = gains(added);
                bestSwap = [removed, added];
            end
        end
    end
    if isempty(bestSwap)
        break
    end
    state.remove(bestSwap(1));
    state.add(bestSwap(2));
end
end

function value = objective(context, models, criterion, state)
C = asc.constants();
useWeight = strcmp(criterion, 'I');
penalty = context.softStrength * C.SOFT_PENALTY_LOG_EFFICIENCY * state.violation(false);
logDetTotal = 0;
traceTotal = 0;
for m = 1:numel(models)
    prepared = prepareExchange(models(m), state.List, useWeight);
    logDetTotal = logDetTotal + prepared.logDet;
    traceTotal = traceTotal + prepared.traceWeighted;
end
if useWeight
    value = -log(traceTotal) - penalty;
else
    value = logDetTotal / sum([models.p]) - penalty;
end
end
