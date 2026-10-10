function selection = selectRandom(context, random)
%SELECTRANDOM ランダム: ハード制約を満たす無作為な選択。選んだShotの有効なMarkをすべて測る。選べなければ []。
%   selection: items（候補番号）, markIndices（測るMarkの番号）

state = asc.findFeasibleState(context, random);
if isempty(state)
    selection = [];
    return
end
selection = struct('items', state.List, 'markIndices', asc.measuredMarks(context, state.List));
end
