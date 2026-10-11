function text = excelSerialText(serial, date1904)
%EXCELSERIALTEXT Excelの日付の数値を「yyyy/mm/dd hh:mm:ss」にする（秒に丸める。ブラウザ版・Python版と同じ丸め）。
%   date1904 が true なら1904年基準（Macの古いExcelの設定）。

if nargin < 2
    date1904 = false;
end
if date1904
    epoch = datetime(1904, 1, 1);
else
    % 1900年基準は 1899-12-30 を起点にする（Excelの1900年のうるう年の扱いに合わせる）
    epoch = datetime(1899, 12, 30);
end
moment = epoch + seconds(floor(serial * 86400 + 0.5));
moment.Format = 'yyyy/MM/dd HH:mm:ss';
text = char(moment);
end
