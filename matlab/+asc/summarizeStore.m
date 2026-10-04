function result = summarizeStore(store)
%SUMMARIZESTORE 1つの基準（全Markで補正したときなど。x, y ごとに rms, mean3sigma, max の Wafer数×1）を集計する。

result = struct();
for axisName = {'x', 'y'}
    for metric = {'rms', 'mean3sigma', 'max'}
        result.(axisName{1}).(metric{1}) = asc.summarizeValues(store.(axisName{1}).(metric{1}));
    end
end
end
