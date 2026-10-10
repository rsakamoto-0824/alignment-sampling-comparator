function selection = selectPoisson(context, random)
%SELECTPOISSON ポアソンディスク: Shot中心の最小間隔をできるだけ広げて無作為に選ぶ（間隔を二分法で探す）。
%   選んだShotの有効なMarkをすべて測る。選べなければ []。

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
selection = struct('items', best.List, 'markIndices', asc.measuredMarks(context, best.List));
end
