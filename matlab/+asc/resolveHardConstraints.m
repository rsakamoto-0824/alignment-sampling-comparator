function [context, relaxed] = resolveHardConstraints(context, seed)
%RESOLVEHARDCONSTRAINTS ハード制約を同時に満たせるか確かめ、満たせなければ優先度の低い順にソフトへ切り替える。
%   relaxed: ソフトに切り替えた制約（key, label, reason）

C = asc.constants();
relaxed = struct('key', {}, 'label', {}, 'reason', {});
for index = 1:numel(context.constraints)
    constraint = context.constraints(index);
    if constraint.hard && ~asc.hasCapacity(constraint, context.shotCount)
        context.constraints(index).hard = false;
        relaxed(end + 1) = struct('key', constraint.key, 'label', constraint.label, ...
            'reason', '区画によっては選べるShotが目標の数に足りないため'); %#ok<AGROW>
    end
end
reason = 'ほかのハード制約と同時に満たす選び方が見つからないため';
for attempt = 0:numel(context.constraints) + 1
    random = asc.Random(asc.Random.deriveSeed(seed, 7919 + attempt));
    if ~isempty(asc.findFeasibleState(context, random))
        return
    end
    % 候補: ハードの制約（並び順）と、中心の1点。優先度の数字が最も大きい（優先度が低い）ものを切り替える
    candidates = find([context.constraints.hard]);
    priorities = [context.constraints(candidates).priority];
    if context.center.active
        candidates(end + 1) = 0; %#ok<AGROW>
        priorities(end + 1) = context.center.priority; %#ok<AGROW>
    end
    if isempty(candidates)
        return
    end
    lowest = 1;
    for k = 2:numel(candidates)
        if priorities(k) > priorities(lowest)
            lowest = k;
        end
    end
    if candidates(lowest) == 0
        context.center.active = false;
        relaxed(end + 1) = struct('key', 'center', 'label', C.CONSTRAINT_LABELS.center, 'reason', reason); %#ok<AGROW>
    else
        context.constraints(candidates(lowest)).hard = false;
        constraint = context.constraints(candidates(lowest));
        relaxed(end + 1) = struct('key', constraint.key, 'label', constraint.label, 'reason', reason); %#ok<AGROW>
    end
end
end
