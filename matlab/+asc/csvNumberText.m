function text = csvNumberText(value)
%CSVNUMBERTEXT CSVに書く数の文字（ブラウザ版の数の文字にそろえる）。
%   整数は小数点なし、それ以外は元の値に戻る最短に近い桁数。

if value == floor(value)
    text = sprintf('%d', value);
    return
end
for digits = 15:17
    text = sprintf('%.*g', digits, value);
    if str2double(text) == value
        return
    end
end
end
