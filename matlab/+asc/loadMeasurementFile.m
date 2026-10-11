function [waferMap, data, report] = loadMeasurementFile(path, mapOptions)
%LOADMEASUREMENTFILE 計測データのファイル（.csv か .xlsx）を読み、Waferマップと評価データを作る。
%   [waferMap, data, report] = asc.loadMeasurementFile('計測.xlsx', settings.map)
%   列や扱いは asc.buildMeasurementData を参照。評価は asc.runEvaluation(waferMap, data, settings) で行う。

[waferMap, data, report] = asc.buildMeasurementData(asc.readTableFile(path), mapOptions);
end
