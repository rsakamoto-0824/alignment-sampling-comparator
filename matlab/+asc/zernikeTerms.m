function terms = zernikeTerms()
%ZERNIKETERMS Fringe番号 Z1〜Z36 のZernike項の一覧（ブラウザ版 src/js/zernike.js と同じ番号付け）。
%   terms(k) は fringeIndex, n, m, polynomialExpressible, radialPowers, radialCoefficients を持つ。
%   並びは Fringe番号の順（terms(k).fringeIndex == k）。

persistent cached
if ~isempty(cached)
    terms = cached;
    return
end
C = asc.constants();
maxRadialOrder = 10;  % Fringe 36項に含まれる放射次数の上限
terms = struct('fringeIndex', {}, 'n', {}, 'm', {}, 'polynomialExpressible', {}, 'radialPowers', {}, 'radialCoefficients', {});
for n = 0:maxRadialOrder
    for absoluteM = mod(n, 2):2:n
        if absoluteM == 0
            mValues = 0;
        else
            mValues = [absoluteM, -absoluteM];
        end
        for m = mValues
            fringe = fringeIndexOf(n, m);
            if fringe > C.MAX_FRINGE_INDEX
                continue
            end
            [powers, coefficients] = radialCoefficients(n, absoluteM);
            terms(end + 1) = struct('fringeIndex', fringe, 'n', n, 'm', m, ...
                'polynomialExpressible', n <= C.MAX_POLYNOMIAL_ORDER, ...
                'radialPowers', powers, 'radialCoefficients', coefficients); %#ok<AGROW>
        end
    end
end
[~, order] = sort([terms.fringeIndex]);
terms = terms(order);
cached = terms;
end

function fringe = fringeIndexOf(n, m)
group = (n + abs(m)) / 2;
fringe = (1 + group)^2 - 2 * abs(m) + (m < 0);
end

function [powers, coefficients] = radialCoefficients(n, absoluteM)
% 放射多項式 R_n^|m|(ρ) を（累乗, 係数）の並びにする
count = (n - absoluteM) / 2 + 1;
powers = zeros(1, count);
coefficients = zeros(1, count);
for k = 0:count - 1
    sign = 1 - 2 * mod(k, 2);
    denominator = factorial(k) * factorial((n + absoluteM) / 2 - k) * factorial((n - absoluteM) / 2 - k);
    powers(k + 1) = n - 2 * k;
    coefficients(k + 1) = sign * factorial(n - k) / denominator;
end
end
