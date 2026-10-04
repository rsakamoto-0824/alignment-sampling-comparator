function result = isClearlyGreater(value, best)
%ISCLEARLYGREATER value が best より「はっきり」大きいか。差が相対 TIE_TOLERANCE 以下なら同点（先に調べた候補を残す）。
%   言語ごとの丸め誤差で、同じ良さの候補（Waferの対称性で生じる）の選び方が変わらないようにする。

persistent tolerance
if isempty(tolerance)
    C = asc.constants();
    tolerance = C.TIE_TOLERANCE;
end
if best == -Inf
    result = value > best;
else
    result = value > best + tolerance * max(1, abs(best));
end
end
