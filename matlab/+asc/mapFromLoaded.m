function waferMap = mapFromLoaded(loaded)
%MAPFROMLOADED 読み込んだ設定（asc.loadSettingsFile）からWaferマップを作る（CSVのマップならファイルに含まれるCSVを使う）。

waferMap = asc.buildMapFromSettings(loaded.settings, loaded.csvText);
end
