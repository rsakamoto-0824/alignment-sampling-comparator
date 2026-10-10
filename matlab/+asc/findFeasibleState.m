function state = findFeasibleState(context, random)
%FINDFEASIBLESTATE ハード制約を満たす無作為な選択を探す。見つからなければ []。
%   まず1つずつ加える方法で探し、行き詰まるときは「無作為に埋めてから入れ替えで直す」方法で探す。

C = asc.constants();
for attempt = 1:C.FEASIBLE_ATTEMPTS
    state = asc.constructSequential(context, random, 0);
    if ~isempty(state)
        return
    end
end
for attempt = 1:C.FEASIBLE_ATTEMPTS
    state = randomFillAndRepair(context, random, C);
    if ~isempty(state)
        return
    end
end
state = [];
end

function state = randomFillAndRepair(context, random, C)
% 無作為に埋めてから、入れ替えでハード制約の外れをなくす
itemCount = numel(context.items);
state = asc.SelectionState(context, context.shotCount);
forced = asc.forcedItemsOf(context);
for item = forced
    state.add(item);
end
for item = random.shuffle(1:itemCount)
    if numel(state.List) >= context.shotCount
        break
    end
    if ~state.Selected(item)
        state.add(item);
    end
end
for iteration = 1:C.REPAIR_MAX_ITERATIONS
    if state.violation(true) == 0
        return
    end
    % 外れが最も減る入れ替えを集め、その中から無作為に1つ選ぶ（調べる順はブラウザ版と同じ）
    bestDelta = 0;
    swaps = zeros(0, 2);
    unselected = find(~state.Selected);
    for removed = state.List
        if ismember(removed, forced)
            continue
        end
        deltas = state.swapDeltaAll(removed, true);
        smallest = min(deltas(unselected));
        if isempty(smallest) || smallest > bestDelta || smallest == 0
            continue
        end
        tied = unselected(deltas(unselected) == smallest);
        if smallest < bestDelta
            bestDelta = smallest;
            swaps = [repmat(removed, numel(tied), 1), tied(:)];
        else
            swaps = [swaps; repmat(removed, numel(tied), 1), tied(:)]; %#ok<AGROW>
        end
    end
    if isempty(swaps)
        state = [];
        return
    end
    swap = swaps(random.integer(size(swaps, 1)) + 1, :);
    state.remove(swap(1));
    state.add(swap(2));
end
if state.violation(true) ~= 0
    state = [];
end
end
