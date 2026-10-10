function [context, freeContext, relaxed] = prepareContext(waferMap, settings)
%PREPARECONTEXT サンプリングの前提を作り、ハード制約を同時に満たせるか確かめる（評価と「計画を作成」で共通）。
%   freeContext は制約なしのD最適・I最適に使う前提（制約・中心の1点・強制計測Shotを外したもの）。

context = asc.buildContext(waferMap, settings);
[context, relaxed] = asc.resolveHardConstraints(context, settings.sampling.seed);
freeContext = asc.unconstrainedContext(context);
end
