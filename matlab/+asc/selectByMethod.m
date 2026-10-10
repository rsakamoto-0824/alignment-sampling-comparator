function selection = selectByMethod(methodKey, context, freeContext, settings, draw, termSets)
%SELECTBYMETHOD 自動の選び方で1組の点を選ぶ。制約付きは context、制約なしは freeContext を使う。選べなければ []。
%   乱数は選び方の並び順と試行の番号で決める（評価と「計画を作成」で同じ点を選ぶため共通にする）。draw は0始まり。

C = asc.constants();
methodIndex = find(strcmp({C.METHODS.key}, methodKey), 1);
method = C.METHODS(methodIndex);
random = asc.Random(asc.Random.deriveSeed(settings.sampling.seed, C.STREAM_METHOD_BASE + (methodIndex - 1) * 100000 + draw));
switch methodKey
    case 'random'
        selection = asc.selectRandom(context, random);
    case 'poisson'
        selection = asc.selectPoisson(context, random);
    otherwise
        target = freeContext;
        if method.constrained
            target = context;
        end
        selection = asc.selectOptimal(target, random, method.criterion, termSets, settings.sampling.optimalStarts);
end
end
