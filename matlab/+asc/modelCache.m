function cache = modelCache(waferMap)
%MODELCACHE 全Markでの多項式の当てはめの部品の置き場（選んだ点によらないので、項の組み合わせごとに1回だけ作る）。
%   cache.uv（全Markの正規化座標）と cache.store（containers.Map。項の並びの文字列 → allDesign, allLeastSquares）

cache = struct('uv', [waferMap.markU, waferMap.markV], 'store', containers.Map('KeyType', 'char', 'ValueType', 'any'));
end
