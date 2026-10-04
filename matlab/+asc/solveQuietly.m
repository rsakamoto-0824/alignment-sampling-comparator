function solution = solveQuietly(matrix, rightSide)
%SOLVEQUIETLY matrix \ rightSide を、特異に近いときの警告を出さずに解く（判定は呼び出し側で行う）。

previous = warning('off', 'MATLAB:nearlySingularMatrix');
previousSingular = warning('off', 'MATLAB:singularMatrix');
solution = matrix \ rightSide;
warning(previous);
warning(previousSingular);
end
