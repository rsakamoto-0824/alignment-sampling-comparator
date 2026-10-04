function value = zernikeValue(term, rho, theta, normalization)
%ZERNIKEVALUE 1つのZernike項の値（係数は掛けない）。rho は正規化半径で割った半径。
%   normalization が 'rms' のときは、単位円内のRMSが1になるように正規化する。

C = asc.constants();
radial = 0;
for k = 1:numel(term.radialPowers)
    radial = radial + term.radialCoefficients(k) * rho^term.radialPowers(k);
end
angular = 1;
if term.m > 0
    angular = cos(term.m * theta);
elseif term.m < 0
    angular = sin(-term.m * theta);
end
factor = 1;
if strcmp(normalization, C.NORMALIZATION_RMS)
    if term.m == 0
        factor = sqrt(term.n + 1);
    else
        factor = sqrt(2 * (term.n + 1));
    end
end
value = factor * radial * angular;
end
