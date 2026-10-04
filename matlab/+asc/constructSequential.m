function state = constructSequential(context, random, minDistanceMm)
%CONSTRUCTSEQUENTIAL 1つずつ無作為に加えて選ぶ。行き詰まったら []。
%   候補の少ない区画を優先し、ハード制約を守れない候補と、選んだShotに minDistanceMm より近い候補は選ばない。

C = asc.constants();
state = asc.SelectionState(context, context.shotCount);
positions = context.itemXY;
nearest = Inf(size(positions, 1), 1);
if context.center.active
    addItem(context.center.itemIndex);
end
penaltyScale = context.softStrength * C.SOFT_PENALTY_SELECTION;
while numel(state.List) < context.shotCount
    feasible = ~state.Selected & nearest >= minDistanceMm & state.canAddHardAll();
    weights = exp(-penaltyScale * state.softOverfillAll());
    weights(~feasible) = 0;
    for index = 1:numel(context.constraints)
        constraint = context.constraints(index);
        if ~constraint.hard
            continue
        end
        classes = constraint.classOf;
        supply = zeros(constraint.classCount, 1);
        for c = 1:constraint.classCount
            supply(c) = nnz(feasible & classes == c);
        end
        need = max(state.Floors{index} - state.Counts{index}, 0);
        if any(need > supply)
            state = [];
            return
        end
        urgency = zeros(constraint.classCount, 1);
        short = need > 0;
        urgency(short) = need(short) ./ max(supply(short), 1);
        weights = weights .* (1 + C.SEQUENTIAL_URGENCY_BOOST * urgency(classes));
        weights(~feasible) = 0;
    end
    picked = random.pickWeighted(weights);
    if picked == 0
        state = [];
        return
    end
    addItem(picked);
end

    function addItem(item)
        state.add(item);
        nearest = min(nearest, hypot(positions(:, 1) - positions(item, 1), positions(:, 2) - positions(item, 2)));
    end
end
