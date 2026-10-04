function loaded = loadSettingsFile(path)
%LOADSETTINGSFILE ブラウザ版の「設定をJSONで保存」で作ったファイルを読む。
%   loaded.settings（初期設定に重ねたもの）, loaded.csvText（CSVのマップ。なければ ''）, loaded.manual（手動プランのJSONのまま）
%   マップは asc.mapFromLoaded(loaded)、手動プランは asc.manualPlanInputs(loaded.manual, waferMap) で作る。

readableVersions = [1, 2];
content = jsondecode(fileread(path));
if ~isstruct(content) || ~isfield(content, 'version') || ~any(content.version == readableVersions) || ~isfield(content, 'settings')
    error('asc:invalidSettings', 'このアプリで保存した設定ファイルではありません。');
end
settings = mergeSettings(asc.defaultSettings(), content.settings);
terms = settings.evaluationData.terms;
if ~isstruct(terms) || numel(terms) ~= 36 || ~all(isfield(terms, {'fringeIndex', 'enabled', 'xValue', 'yValue'}))
    defaults = asc.defaultSettings();
    settings.evaluationData.terms = defaults.evaluationData.terms;
end
csvText = '';
if isfield(content, 'csvText') && ischar(content.csvText)
    csvText = content.csvText;
end
manual = [];
if isfield(content, 'manual')
    manual = content.manual;
end
loaded = struct('settings', settings, 'csvText', csvText, 'manual', manual);
end

function merged = mergeSettings(base, value)
% 読み込んだ設定を初期設定に重ねる（ブラウザ版の mergeSettings と同じ。型が違う値や知らない項目は使わない）
if isstruct(base) && isscalar(base)
    merged = base;
    if ~(isstruct(value) && isscalar(value))
        return
    end
    for name = fieldnames(base)'
        if isfield(value, name{1})
            merged.(name{1}) = mergeSettings(base.(name{1}), value.(name{1}));
        end
    end
elseif isempty(base) && ~ischar(base)
    merged = value;  % 初期値がない項目（Zernike項など）はそのまま使う
elseif islogical(base)
    if islogical(value) && isscalar(value)
        merged = value;
    else
        merged = base;
    end
elseif isnumeric(base) && isscalar(base)
    if isnumeric(value) && isscalar(value)
        merged = value;
    else
        merged = base;
    end
elseif isnumeric(base)
    if isnumeric(value) && (isempty(value) || isvector(value))
        merged = value(:);
    else
        merged = base;
    end
elseif ischar(base)
    if ischar(value)
        merged = value;
    else
        merged = base;
    end
elseif isstruct(base)
    if isstruct(value)
        merged = value;
    else
        merged = base;
    end
else
    merged = value;
end
end
