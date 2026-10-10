function free = unconstrainedContext(context)
%UNCONSTRAINEDCONTEXT 条件制約を使わない選び方（D最適・I最適の制約なし）の前提。
%   候補は同じで、制約・中心の1点・強制計測Shotを外す（除外Shotと端のShotの扱いはそのまま）。

free = context;
free.constraints = context.constraints([]);
free.center.enabled = false;
free.center.active = false;
free.mandatoryItems = zeros(1, 0);
end
