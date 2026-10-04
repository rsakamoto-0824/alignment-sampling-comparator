function settings = defaultTermSettings(lowOrderAmplitudeNm, highOrderAmplitudeNm)
%DEFAULTTERMSETTINGS Zernike各項の初期設定（36×1 の構造体）。5次以下と6次以上で大きさを分ける。

terms = asc.zernikeTerms();
settings = struct('fringeIndex', cell(numel(terms), 1), 'enabled', true, 'xValue', 0, 'yValue', 0);
for k = 1:numel(terms)
    if terms(k).polynomialExpressible
        amplitude = lowOrderAmplitudeNm;
    else
        amplitude = highOrderAmplitudeNm;
    end
    settings(k).fringeIndex = terms(k).fringeIndex;
    settings(k).enabled = true;
    settings(k).xValue = amplitude;
    settings(k).yValue = amplitude;
end
end
