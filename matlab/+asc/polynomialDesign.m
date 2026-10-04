function design = polynomialDesign(uv, termIndices)
%POLYNOMIALDESIGN 多項式の値の表（行 = 点、列 = 項）。
%   uv は正規化座標（点の数×2）。termIndices は5次までの21項の番号（0始まり。ブラウザ版の設定と同じ番号）。
%   21項の並びは次数の低い順、同じ次数では x の次数の高い順: 1, x, y, x², xy, y², x³, …

powers = polynomialPowers();
design = zeros(size(uv, 1), numel(termIndices));
for j = 1:numel(termIndices)
    power = powers(termIndices(j) + 1, :);
    design(:, j) = uv(:, 1).^power(1) .* uv(:, 2).^power(2);
end
end

function powers = polynomialPowers()
persistent cached
if isempty(cached)
    C = asc.constants();
    cached = zeros(0, 2);
    for order = 0:C.MAX_POLYNOMIAL_ORDER
        for powerY = 0:order
            cached(end + 1, :) = [order - powerY, powerY]; %#ok<AGROW>
        end
    end
end
powers = cached;
end
