function data = generateEvaluationData(waferMap, dataSettings)
%GENERATEEVALUATIONDATA 評価データ（乱数のWafer高次傾向と計測ノイズ）を作る。ブラウザ版と同じ乱数の使い方。
%   各Waferのずれ量 = Σ（Zernike項 × 乱数の係数）＋ Scan方向によるずれ（Upは+δ、Downは−δ）
%   計測値 = ずれ量 ＋ 計測ノイズ。ノイズは全Markぶんを先に作る（同じWafer・同じMarkなら、どの選び方でも同じノイズ）。
%   data.truthX などは（Wafer数 × Mark数）の行列。

C = asc.constants();
% 乱数列の用途ごとの番号（ノイズの設定を変えても傾向が変わらないように分ける）
streamTrend = 0;
streamNoise = 1;
streamScan = 2;

waferCount = dataSettings.waferCount;
if ~(isscalar(waferCount) && waferCount == floor(waferCount) && waferCount >= 1 && waferCount <= C.MAX_WAFER_COUNT)
    error('asc:invalidSettings', 'Wafer数は1〜%dの整数にしてください。', C.MAX_WAFER_COUNT);
end
markCount = numel(waferMap.markX);
termSettings = dataSettings.terms;
active = termSettings(arrayfun(@(t) logical(t.enabled) && (t.xValue > 0 || t.yValue > 0), termSettings));
termCount = numel(active);
allTerms = asc.zernikeTerms();

basis = zeros(markCount, termCount);
for i = 1:markCount
    rho = hypot(waferMap.markU(i), waferMap.markV(i));
    theta = atan2(waferMap.markV(i), waferMap.markU(i));
    for k = 1:termCount
        basis(i, k) = asc.zernikeValue(allTerms(active(k).fringeIndex), rho, theta, dataSettings.normalization);
    end
end
scanSign = -ones(1, markCount);
scanSign(strcmp(waferMap.shotScan(waferMap.markShot), C.SCAN_UP)) = 1;

trendRandom = asc.Random(asc.Random.deriveSeed(dataSettings.seed, streamTrend));
noiseRandom = asc.Random(asc.Random.deriveSeed(dataSettings.seed, streamNoise));
scanRandom = asc.Random(asc.Random.deriveSeed(dataSettings.seed, streamScan));
distribution = dataSettings.distribution;

coefficientsX = zeros(waferCount, termCount);
coefficientsY = zeros(waferCount, termCount);
scanOffsets = zeros(waferCount, 2);
noiseX = zeros(waferCount, markCount);
noiseY = zeros(waferCount, markCount);
for wafer = 1:waferCount
    for k = 1:termCount
        coefficientsX(wafer, k) = drawValue(trendRandom, distribution, active(k).xValue, C);
        coefficientsY(wafer, k) = drawValue(trendRandom, distribution, active(k).yValue, C);
    end
    scanOffsets(wafer, 1) = drawValue(scanRandom, distribution, dataSettings.scanOffsetXnm, C);
    scanOffsets(wafer, 2) = drawValue(scanRandom, distribution, dataSettings.scanOffsetYnm, C);
    for i = 1:markCount
        noiseX(wafer, i) = dataSettings.noiseSigmaXnm * noiseRandom.normal();
        noiseY(wafer, i) = dataSettings.noiseSigmaYnm * noiseRandom.normal();
    end
end

data = struct();
data.waferCount = waferCount;
data.markCount = markCount;
data.truthX = coefficientsX * basis' + scanOffsets(:, 1) .* scanSign;
data.truthY = coefficientsY * basis' + scanOffsets(:, 2) .* scanSign;
data.noiseX = noiseX;
data.noiseY = noiseY;
data.fringeIndices = [active.fringeIndex];
data.coefficientsX = coefficientsX;
data.coefficientsY = coefficientsY;
end

function value = drawValue(random, distribution, scale, C)
% 分布の設定に従って乱数を1つ作る。大きさが0なら乱数を使わない（ブラウザ版と同じ）
if scale == 0
    value = 0;
elseif strcmp(distribution, C.DISTRIBUTION_NORMAL)
    value = scale * random.normal();
else
    value = scale * (2 * random.next() - 1);
end
end
