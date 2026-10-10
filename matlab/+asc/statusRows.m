function rows = statusRows(status)
%STATUSROWS 制約の満たし具合の行を、表に出す順（区画の制約 → 中心の1点 → 強制計測Shot）に並べる。
%   rows(k): key, label, hard, ok, shift

rows = struct('key', {}, 'label', {}, 'hard', {}, 'ok', {}, 'shift', {});
for row = status.rows(:)'
    rows(end + 1) = pick(row); %#ok<AGROW>
end
if ~isempty(status.center)
    rows(end + 1) = pick(status.center);
end
if isfield(status, 'mandatory') && ~isempty(status.mandatory)
    rows(end + 1) = pick(status.mandatory);
end
end

function entry = pick(row)
entry = struct('key', row.key, 'label', row.label, 'hard', row.hard, 'ok', row.ok, 'shift', row.shift);
end
