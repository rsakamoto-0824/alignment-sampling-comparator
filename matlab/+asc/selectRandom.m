function selection = selectRandom(context, random)
%SELECTRANDOM ランダム: ハード制約を満たす無作為な選択。追加のMarkも無作為に選ぶ。選べなければ []。
%   selection: items（候補番号）, markIndices（測るMarkの番号）

state = asc.findFeasibleState(context, random);
if isempty(state)
    selection = [];
    return
end
measured = asc.measuredMarks(context, state.List);
selection = struct('items', state.List, 'markIndices', [measured, extrasRandom(context, state.List, random)]);
end

function extras = extrasRandom(context, selectedItems, random)
extras = zeros(1, 0);
if context.extraMarkCount <= 0
    return
end
[candidates, forced] = asc.extraCandidates(context, selectedItems);
candidates = random.shuffle(candidates);
ordered = [forced, candidates];
extras = ordered(1:min(context.extraMarkCount, numel(ordered)));
end
