function plan = planFromShotIds(name, shotIds, waferMap, key)
%PLANFROMSHOTIDS Shot番号（ShotId）の一覧から手動プランを作る（現行のサンプリングを比べるとき用）。
%   shotIds は文字の cell（{'12', '23'}）か数の配列（[12 23]）。key を省くと 'manual:<name>'。

C = asc.constants();
if nargin < 4 || isempty(key)
    key = [C.MANUAL_PREFIX name];
end
if isnumeric(shotIds)
    shotIds = arrayfun(@(value) sprintf('%d', value), shotIds, 'UniformOutput', false);
end
shotIds = cellstr(shotIds);
[found, shotIndices] = ismember(shotIds(:)', waferMap.shotIds');
if ~all(found)
    unknown = shotIds(~found);
    error('asc:invalidPlan', 'マップにないShot番号があります: %s', strjoin(unknown(1:min(10, end)), ', '));
end
plan = struct('key', key, 'label', name, 'shotIndices', shotIndices, 'extraMarkIndices', zeros(1, 0));
end
