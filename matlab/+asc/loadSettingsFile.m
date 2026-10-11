function loaded = loadSettingsFile(path)
%LOADSETTINGSFILE ブラウザ版の「設定をJSONで保存」で作ったファイルを読む。
%   loaded.settings（初期設定に重ねたもの）, loaded.csvText（CSVのマップ。なければ ''）, loaded.manual（手動プランのJSONのまま）
%   マップは asc.mapFromLoaded(loaded)、手動プランは asc.manualPlanInputs(loaded.manual, waferMap) で作る。

readableVersions = [1, 2, 3, 4];
content = jsondecode(fileread(path));
if ~isstruct(content) || ~isfield(content, 'version') || ~any(content.version == readableVersions) || ~isfield(content, 'settings')
    error('asc:invalidSettings', 'このアプリで保存した設定ファイルではありません。');
end
settings = mergeSettings(asc.defaultSettings(), migrateOldSettings(content.settings, content.version));
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

function loaded = migrateOldSettings(loaded, version)
% 以前の版の設定を今の形に読み替える（ブラウザ版の migrateOldSettings と同じ）。
% 版2以前: 以前のD最適・I最適は制約を守る選び方だったので、制約付きD最適・I最適として読む。
%          「必ず測るMark」「k個以上」「HOWA＋推定」は、なくなったので使わない（重ねるときに捨てられる）。
% 版3以前: 補正の流れ「HOWAのみ」は HOWA、「推定→HOWA × 推定手法」は RBF・GPR の予測として読む。
%          選んでいた推定手法は式内も比べる。計測値＋HOWA は比べる。
if ~isstruct(loaded)
    return
end
if version < 3 && isfield(loaded, 'sampling') && isstruct(loaded.sampling) && isfield(loaded.sampling, 'methods') && isstruct(loaded.sampling.methods)
    old = loaded.sampling.methods;
    loaded.sampling.methods = struct('random', ~isequal(fieldOr(old, 'random', true), false), ...
        'poisson', ~isequal(fieldOr(old, 'poisson', true), false), 'dOptimal', false, 'iOptimal', false, ...
        'constrainedD', ~isequal(fieldOr(old, 'dOptimal', true), false), 'constrainedI', ~isequal(fieldOr(old, 'iOptimal', true), false));
end
if version < 4 && isfield(loaded, 'model') && isstruct(loaded.model)
    C = asc.constants();
    flows = fieldOr(loaded.model, 'flows', struct());
    estimators = fieldOr(loaded.model, 'estimators', struct());
    corrections = struct('howa', ~isequal(fieldOr(flows, 'howa', true), false));
    predict = ~isequal(fieldOr(flows, 'estimateThenHowa', true), false);
    for correction = C.CORRECTIONS
        if strcmp(correction.mode, 'embedded')
            selected = ~isequal(fieldOr(estimators, correction.family, true), false);
            corrections.(correction.key) = selected;
            corrections.([correction.key 'Predict']) = selected && predict;
        end
    end
    corrections.measured = true;
    loaded.model.corrections = corrections;
end
end

function value = fieldOr(entry, name, fallback)
if isfield(entry, name)
    value = entry.(name);
else
    value = fallback;
end
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
