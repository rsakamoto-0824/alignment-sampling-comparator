classdef Random < handle
    %RANDOM シード付きの乱数（mulberry32）。ブラウザ版（src/js/math-utils.js）と同じ乱数列になる。
    %   JavaScript の 32bit 整数演算（Math.imul、>>>）を、double の整数（0〜2^32−1）で再現する。
    %   next / normal / integer / shuffle / pickWeighted は、ブラウザ版と同じ順で乱数を使う。
    %
    %   random = asc.Random(seed);
    %   value = random.next();             % 0以上1未満
    %   seed2 = asc.Random.deriveSeed(seed, 3);  % 別の乱数列用のシード

    properties (Access = private)
        State
        SpareNormal = []
    end

    methods
        function obj = Random(seed)
            obj.State = mod(floor(seed), 4294967296);
            if obj.State == 0
                obj.State = 1;
            end
        end

        function value = next(obj)
            %NEXT 0以上1未満の一様乱数。
            obj.State = mod(obj.State + 1831565813, 4294967296);  % 0x6D2B79F5
            t = obj.State;
            t = imul32(bitxor(t, bitshift(t, -15)), bitor(t, 1));
            t = bitxor(t, mod(t + imul32(bitxor(t, bitshift(t, -7)), bitor(t, 61)), 4294967296));
            value = bitxor(t, bitshift(t, -14)) / 4294967296;
        end

        function value = normal(obj)
            %NORMAL 標準正規分布の乱数（Box-Muller法。2つ目の値は次回に使う）。
            if ~isempty(obj.SpareNormal)
                value = obj.SpareNormal;
                obj.SpareNormal = [];
                return
            end
            u1 = obj.next();
            while u1 <= 0
                u1 = obj.next();
            end
            u2 = obj.next();
            radius = sqrt(-2 * log(u1));
            obj.SpareNormal = radius * sin(2 * pi * u2);
            value = radius * cos(2 * pi * u2);
        end

        function value = integer(obj, count)
            %INTEGER 0以上 count 未満の整数。
            value = floor(obj.next() * count);
        end

        function values = shuffle(obj, values)
            %SHUFFLE 並べ替えた配列を返す（Fisher-Yates）。
            for i = numel(values):-1:2
                j = obj.integer(i) + 1;
                swapped = values(i);
                values(i) = values(j);
                values(j) = swapped;
            end
        end

        function index = pickWeighted(obj, weights)
            %PICKWEIGHTED 重みに比例した確率で添字（1始まり）を1つ選ぶ。重みがすべて0なら 0。
            %   ブラウザ版と同じく、前から順に足し引きして選ぶ（足す順番で丸め誤差が変わらないように）。
            total = 0;
            for i = 1:numel(weights)
                total = total + weights(i);
            end
            index = 0;
            if ~(total > 0)
                return
            end
            threshold = obj.next() * total;
            for i = 1:numel(weights)
                threshold = threshold - weights(i);
                if threshold < 0 && weights(i) > 0
                    index = i;
                    return
                end
            end
            for i = numel(weights):-1:1
                if weights(i) > 0
                    index = i;
                    return
                end
            end
        end
    end

    methods (Static)
        function value = deriveSeed(seed, index)
            %DERIVESEED 元のシードと番号から、別の乱数列用のシードを作る（試行ごとに独立した乱数列にする）。
            value = bitxor(mod(floor(seed), 4294967296), imul32(index + 1, 2654435761));  % 0x9E3779B1
            value = imul32(bitxor(value, bitshift(value, -16)), 2246822507);            % 0x85EBCA6B
            value = imul32(bitxor(value, bitshift(value, -13)), 3266489909);            % 0xC2B2AE35
            value = bitxor(value, bitshift(value, -16));
        end
    end
end

function product = imul32(a, b)
% Math.imul と同じ 32bit 掛け算（結果は 0〜2^32−1）。double で誤差が出ないよう、a を上下16bitに分けて掛ける。
a = mod(a, 4294967296);
b = mod(b, 4294967296);
high = floor(a / 65536);
low = a - high * 65536;
product = mod(mod(high * b, 65536) * 65536 + low * b, 4294967296);
end
