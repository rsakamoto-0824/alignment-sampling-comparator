function points = featureMatrix(uv, features)
%FEATUREMATRIX 推定手法の説明変数。'xy' は (u, v)、'xyr' は (u, v, 半径)。

if strcmp(features, 'xyr')
    points = [uv, hypot(uv(:, 1), uv(:, 2))];
else
    points = uv;
end
end
