function result = designCriteria(waferMap, markIndices, terms)
%DESIGNCRITERIA 選んだ点のD基準（log det(XᵀX)）とI基準（全Markで平均した予測分散÷σ²）、κ（I基準の平方根）。
%   点が項数より少ないときは reason='tooFew'、点の並びで多項式が決まらないときは reason='degenerate'。

C = asc.constants();
p = numel(terms);
result = struct('p', p, 'n', numel(markIndices), 'logDet', -Inf, 'trace', Inf, 'kappa', Inf, 'singular', true, 'reason', 'tooFew');
if numel(markIndices) < p
    return
end
result.reason = 'degenerate';
uv = [waferMap.markU, waferMap.markV];
sampleDesign = asc.polynomialDesign(uv(markIndices, :), terms);
information = sampleDesign' * sampleDesign;
[upper, failed] = chol(information);
if failed
    return
end
diagonal = diag(upper);
if min(diagonal) / max(diagonal) < C.SINGULAR_DIAGONAL_RATIO
    return
end
inverse = inv(information);
allDesign = asc.polynomialDesign(uv, terms);
traceValue = sum(sum(inverse .* (allDesign' * allDesign)')) / size(uv, 1);
result.logDet = 2 * sum(log(diagonal));
result.trace = traceValue;
result.kappa = sqrt(traceValue);
result.singular = false;
result.reason = '';
end
