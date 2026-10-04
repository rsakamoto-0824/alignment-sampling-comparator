classdef SelectionState < handle
    %SELECTIONSTATE 選択の状態。区画ごとの数を持ち、追加・削除・入れ替えでの制約の変化を求める。
    %   ブラウザ版の createState と同じ働き。List は選んだ順の候補番号（1始まり）。

    properties
        Context
        Total
        Selected
        List
        Counts
        Floors
        Ceils
    end

    methods
        function obj = SelectionState(context, total)
            obj.Context = context;
            obj.Total = total;
            obj.Selected = false(numel(context.items), 1);
            obj.List = zeros(1, 0);
            constraintCount = numel(context.constraints);
            obj.Counts = cell(1, constraintCount);
            obj.Floors = cell(1, constraintCount);
            obj.Ceils = cell(1, constraintCount);
            for index = 1:constraintCount
                constraint = context.constraints(index);
                obj.Counts{index} = zeros(constraint.classCount, 1);
                [obj.Floors{index}, obj.Ceils{index}] = asc.targetsFor(constraint, total);
            end
        end

        function add(obj, item)
            obj.Selected(item) = true;
            obj.List(end + 1) = item;
            for index = 1:numel(obj.Context.constraints)
                classIndex = obj.Context.constraints(index).classOf(item);
                obj.Counts{index}(classIndex) = obj.Counts{index}(classIndex) + 1;
            end
        end

        function remove(obj, item)
            obj.Selected(item) = false;
            obj.List(find(obj.List == item, 1)) = [];
            for index = 1:numel(obj.Context.constraints)
                classIndex = obj.Context.constraints(index).classOf(item);
                obj.Counts{index}(classIndex) = obj.Counts{index}(classIndex) - 1;
            end
        end

        function total = violation(obj, hard)
            %VIOLATION ハード（hard=true）またはソフト（重み付き）の制約の外れ量。
            total = 0;
            for index = 1:numel(obj.Context.constraints)
                constraint = obj.Context.constraints(index);
                if constraint.hard == hard
                    value = asc.violationOf(obj.Counts{index}, obj.Floors{index}, obj.Ceils{index});
                    if hard
                        total = total + value;
                    else
                        total = total + value * constraint.weight;
                    end
                end
            end
        end

        function ok = canAddHardAll(obj)
            %CANADDHARDALL 全候補について、加えても残りの枠でハード制約を満たせる見込みがあるか（論理の列）。
            remainingAfter = obj.Total - numel(obj.List) - 1;
            ok = true(numel(obj.Context.items), 1);
            for index = 1:numel(obj.Context.constraints)
                constraint = obj.Context.constraints(index);
                if ~constraint.hard
                    continue
                end
                counts = obj.Counts{index};
                deficit = max(obj.Floors{index} - counts, 0);
                classes = constraint.classOf;
                over = counts(classes) + 1 > obj.Ceils{index}(classes);
                % その区画に加えると、その区画の不足が1減る（不足していれば）
                deficitAfter = sum(deficit) - (deficit(classes) > 0);
                ok = ok & ~over & (deficitAfter <= remainingAfter);
            end
        end

        function total = softOverfillAll(obj)
            %SOFTOVERFILLALL 全候補について、加えたときにソフト制約の区画が上限を超える量（重み付き）。
            total = zeros(numel(obj.Context.items), 1);
            for index = 1:numel(obj.Context.constraints)
                constraint = obj.Context.constraints(index);
                if constraint.hard
                    continue
                end
                classes = constraint.classOf;
                total = total + (obj.Counts{index}(classes) + 1 > obj.Ceils{index}(classes)) * constraint.weight;
            end
        end

        function delta = swapDeltaAll(obj, removed, hard)
            %SWAPDELTAALL removed を外して各候補を入れたときの、ハード（hard=true）またはソフトの外れ量の変化（候補数×1）。
            delta = zeros(numel(obj.Context.items), 1);
            for index = 1:numel(obj.Context.constraints)
                constraint = obj.Context.constraints(index);
                if constraint.hard ~= hard
                    continue
                end
                classes = constraint.classOf;
                source = classes(removed);
                counts = obj.Counts{index};
                floors = obj.Floors{index};
                ceils = obj.Ceils{index};
                before = classViolation(counts(source), floors(source), ceils(source)) ...
                    + classViolation(counts(classes), floors(classes), ceils(classes));
                after = classViolation(counts(source) - 1, floors(source), ceils(source)) ...
                    + classViolation(counts(classes) + 1, floors(classes), ceils(classes));
                change = after - before;
                change(classes == source) = 0;
                if hard
                    delta = delta + change;
                else
                    delta = delta + change * constraint.weight;
                end
            end
        end
    end
end

function value = classViolation(count, floorCount, ceilCount)
value = max(count - ceilCount, 0) + max(floorCount - count, 0);
end
