function waferMap = buildMapFromSettings(settings, csvText)
%BUILDMAPFROMSETTINGS 設定（ブラウザ版の設定JSONの settings）からWaferマップを作る。CSVのときは csvText が要る。

if strcmp(settings.map.source, 'csv')
    if nargin < 2 || isempty(csvText)
        error('asc:invalidSettings', 'CSVのマップを使う設定ですが、CSVの内容がありません。');
    end
    waferMap = asc.parseMapCsv(csvText, settings.map);
else
    waferMap = asc.generateWaferMap(settings.map);
end
end
