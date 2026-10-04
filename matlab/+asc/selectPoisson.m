function selection = selectPoisson(context, random)
%SELECTPOISSON ポアソンディスク: Shot中心の最小間隔をできるだけ広げて無作為に選ぶ（間隔を二分法で探す）。
%   追加のMarkは、すでに測るMarkから最も遠いMarkを順に選ぶ。選べなければ []。

C = asc.constants();
low = 0;
high = 2 * sqrt(pi * C.WAFER_RADIUS_MM^2 / context.shotCount);
best = [];
drawSeed = floor(random.next() * 4294967296);
for step = 0:C.POISSON_BISECTION_STEPS - 1
    distance = (low + high) / 2;
    stepRandom = asc.Random(asc.Random.deriveSeed(drawSeed, step));
    state = [];
    for attempt = 1:3
        state = asc.constructSequential(context, stepRandom, distance);
        if ~isempty(state)
            break
        end
    end
    if ~isempty(state)
        best = state;
        low = distance;
    else
        high = distance;
    end
end
if isempty(best)
    best = asc.findFeasibleState(context, random);
    if isempty(best)
        selection = [];
        return
    end
end
measured = asc.measuredMarks(context, best.List);
selection = struct('items', best.List, 'markIndices', [measured, extrasFarthest(context, best.List, measured, random)]);
end

function chosen = extrasFarthest(context, selectedItems, measured, random)
% すでに測るMarkから最も遠いMarkを順に選ぶ（同じ距離はごく小さな乱数で崩す）
chosen = zeros(1, 0);
if context.extraMarkCount <= 0
    return
end
markX = context.map.markX;
markY = context.map.markY;
[remaining, forced] = asc.extraCandidates(context, selectedItems);
chosen = forced;
current = [measured, forced];
while numel(chosen) < context.extraMarkCount && ~isempty(remaining)
    bestPosition = 1;
    bestDistance = -1;
    for position = 1:numel(remaining)
        markIndex = remaining(position);
        nearest = Inf;
        for other = current
            nearest = min(nearest, hypot(markX(markIndex) - markX(other), markY(markIndex) - markY(other)));
        end
        nearest = nearest + random.next() * 1e-6;
        if nearest > bestDistance
            bestDistance = nearest;
            bestPosition = position;
        end
    end
    picked = remaining(bestPosition);
    remaining(bestPosition) = [];
    chosen(end + 1) = picked; %#ok<AGROW>
    current(end + 1) = picked; %#ok<AGROW>
end
chosen = chosen(1:min(context.extraMarkCount, numel(chosen)));
end
