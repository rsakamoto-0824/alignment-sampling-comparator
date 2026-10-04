function [candidates, forced] = extraCandidates(context, selectedItems)
%EXTRACANDIDATES 「k個以上」のときの追加のMarkの候補（選んだShotの残りのMark）と、必ず加えるMark（中心の1点）。

candidates = zeros(1, 0);
for item = selectedItems(:)'
    candidates = [candidates, context.items(item).otherMarks]; %#ok<AGROW>
end
forced = zeros(1, 0);
center = context.center;
if center.active && ~center.isDesignated && ismember(center.markIndex, candidates)
    forced = center.markIndex;
end
candidates = candidates(~ismember(candidates, forced));
end
