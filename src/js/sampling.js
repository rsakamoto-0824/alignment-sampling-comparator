/**
 * 計測Markの選び方（ランダム・ポアソンディスク・D最適・I最適・手動）。
 *
 * どの選び方も2段階で選ぶ。
 *   1. Shotを選ぶ（条件制約はここで反映する）。選んだShotでは必ず測るMarkを測る
 *   2. 「k個以上」のときは、選んだShotの残りのMarkから追加のMarkを選び、総Mark数にそろえる
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const M = ASC.math;
  const K = ASC.constraints;

  // コレスキー因子の対角の比がこれより小さければ、多項式が決まらない（ほぼ特異）とみなす
  const SINGULAR_DIAGONAL_RATIO = 1e-7;

  // ---- 共通: 制約を満たす無作為な選択 ------------------------------------

  /** ソフト制約の強さを、ランダム系の「選ばれにくさ」に直した係数。 */
  function selectionPenaltyScale(context) {
    return context.softStrength * C.SOFT_PENALTY_SELECTION;
  }

  /**
   * 1つずつ無作為に加えて選ぶ。ハード制約を守れない候補は選ばず、ソフト制約を外す候補は選ばれにくくする。
   * minDistanceMm > 0 なら、選んだShotとの中心間距離がそれ未満の候補も選ばない（ポアソンディスク）。
   * 候補の少ない区画（外周など）が後回しになると行き詰まるため、
   * 「あと何個必要か ÷ 選べる候補の数」が大きい区画の候補ほど選ばれやすくする。
   * 途中で選べる候補がなくなったら null。
   */
  function constructSequential(context, random, minDistanceMm) {
    const state = K.createState(context, context.shotCount);
    const items = context.items;
    const nearest = new Float64Array(items.length).fill(Infinity);

    function addItem(item) {
      state.add(item);
      for (let i = 0; i < items.length; i++) {
        const distance = Math.hypot(items[i].x - items[item].x, items[i].y - items[item].y);
        if (distance < nearest[i]) {
          nearest[i] = distance;
        }
      }
    }

    if (context.center.active) {
      addItem(context.center.itemIndex);
    }
    const penaltyScale = selectionPenaltyScale(context);
    const weights = new Float64Array(items.length);
    const feasible = new Uint8Array(items.length);
    while (state.list.length < context.shotCount) {
      for (let i = 0; i < items.length; i++) {
        feasible[i] = !state.selected[i] && nearest[i] >= minDistanceMm && state.canAddHard(i) ? 1 : 0;
      }
      const urgency = hardUrgency(context, state, feasible);
      if (!urgency) {
        return null;
      }
      for (let i = 0; i < items.length; i++) {
        if (!feasible[i]) {
          weights[i] = 0;
          continue;
        }
        let weight = Math.exp(-penaltyScale * state.softOverfill(i));
        context.constraints.forEach((constraint, index) => {
          if (urgency[index]) {
            weight *= 1 + C.SEQUENTIAL_URGENCY_BOOST * urgency[index][constraint.classOf[i]];
          }
        });
        weights[i] = weight;
      }
      const picked = random.pickWeighted(weights);
      if (picked < 0) {
        return null;
      }
      addItem(picked);
    }
    return state;
  }

  /**
   * ハード制約の区画ごとの「あと何個必要か ÷ 選べる候補の数」。
   * 必要な数より候補が少ない区画があれば、もう満たせないので null。
   */
  function hardUrgency(context, state, feasible) {
    const urgency = [];
    for (let index = 0; index < context.constraints.length; index++) {
      const constraint = context.constraints[index];
      if (!constraint.hard) {
        urgency.push(null);
        continue;
      }
      const supply = new Int32Array(constraint.classCount);
      for (let i = 0; i < feasible.length; i++) {
        if (feasible[i]) {
          supply[constraint.classOf[i]]++;
        }
      }
      const values = new Float64Array(constraint.classCount);
      for (let c = 0; c < constraint.classCount; c++) {
        const need = Math.max(0, state.targets[index].floor[c] - state.counts[index][c]);
        if (need > supply[c]) {
          return null;
        }
        values[c] = need > 0 ? need / supply[c] : 0;
      }
      urgency.push(values);
    }
    return urgency;
  }

  /** 無作為に埋めてから、入れ替えでハード制約の外れをなくす（1つずつ加える方法で行き詰まったとき用）。 */
  function randomFillAndRepair(context, random) {
    const state = K.createState(context, context.shotCount);
    const forced = context.center.active ? context.center.itemIndex : -1;
    if (forced >= 0) {
      state.add(forced);
    }
    const order = random.shuffle(Array.from({ length: context.items.length }, (_, i) => i));
    for (const item of order) {
      if (state.list.length >= context.shotCount) {
        break;
      }
      if (!state.selected[item]) {
        state.add(item);
      }
    }
    for (let iteration = 0; iteration < C.REPAIR_MAX_ITERATIONS; iteration++) {
      if (state.violation(true) === 0) {
        return state;
      }
      let bestDelta = 0;
      let bestSwaps = [];
      for (const removed of state.list) {
        if (removed === forced) {
          continue;
        }
        for (let added = 0; added < context.items.length; added++) {
          if (state.selected[added]) {
            continue;
          }
          const delta = state.swapDelta(removed, added, true);
          if (delta < bestDelta) {
            bestDelta = delta;
            bestSwaps = [[removed, added]];
          } else if (delta === bestDelta && delta < 0) {
            bestSwaps.push([removed, added]);
          }
        }
      }
      if (bestSwaps.length === 0) {
        return null;
      }
      const [removed, added] = bestSwaps[random.integer(bestSwaps.length)];
      state.remove(removed);
      state.add(added);
    }
    return state.violation(true) === 0 ? state : null;
  }

  /** ハード制約を満たす無作為な選択を探す。見つからなければ null。 */
  function findFeasibleState(context, random) {
    for (let attempt = 0; attempt < C.FEASIBLE_ATTEMPTS; attempt++) {
      const state = constructSequential(context, random, 0);
      if (state) {
        return state;
      }
    }
    for (let attempt = 0; attempt < C.FEASIBLE_ATTEMPTS; attempt++) {
      const state = randomFillAndRepair(context, random);
      if (state) {
        return state;
      }
    }
    return null;
  }

  // ---- ランダム ----------------------------------------------------------

  function selectRandom(context, random) {
    const state = findFeasibleState(context, random);
    if (!state) {
      return null;
    }
    const measured = measuredMarksOf(context, state.list);
    const extras = pickExtrasRandom(context, state.list, measured, random);
    return { items: state.list.slice(), markIndices: measured.concat(extras) };
  }

  // ---- ポアソンディスク --------------------------------------------------

  /**
   * Shot中心の最小間隔をできるだけ広げて、無作為に選ぶ。
   * 間隔を二分法で探し、制約を満たしたまま指定数を選べた最大の間隔を使う。
   */
  function selectPoisson(context, random) {
    const waferArea = Math.PI * C.WAFER_RADIUS_MM * C.WAFER_RADIUS_MM;
    let low = 0;
    let high = 2 * Math.sqrt(waferArea / context.shotCount);
    let best = null;
    const drawSeed = Math.floor(random.next() * 4294967296);
    for (let step = 0; step < C.POISSON_BISECTION_STEPS; step++) {
      const distance = (low + high) / 2;
      const stepRandom = M.createRandom(M.deriveSeed(drawSeed, step));
      let state = null;
      for (let attempt = 0; attempt < 3 && !state; attempt++) {
        state = constructSequential(context, stepRandom, distance);
      }
      if (state) {
        best = state;
        low = distance;
      } else {
        high = distance;
      }
    }
    if (!best) {
      best = findFeasibleState(context, random);
      if (!best) {
        return null;
      }
    }
    const measured = measuredMarksOf(context, best.list);
    const extras = pickExtrasFarthest(context, best.list, measured, random);
    return { items: best.list.slice(), markIndices: measured.concat(extras) };
  }

  // ---- D最適・I最適 ------------------------------------------------------

  /**
   * 補正多項式ごとの計算材料。XとYで項が同じなら1つにまとめる。
   * 各候補の「必ず測るMark」での多項式の値（k×p）と、全Markで平均した W = XᵀX / Mark数 を持つ。
   */
  function buildModels(context, termSets) {
    const unique = [];
    for (const terms of termSets) {
      if (!unique.some((entry) => sameTerms(entry, terms))) {
        unique.push(terms);
      }
    }
    const marks = context.map.marks;
    const allIndices = Array.from({ length: marks.length }, (_, i) => i);
    return unique.map((terms) => {
      const p = terms.length;
      const allDesign = ASC.correction.polynomialDesign(marks, allIndices, terms);
      const weight = M.gram(allDesign, marks.length, p);
      for (let i = 0; i < weight.length; i++) {
        weight[i] /= marks.length;
      }
      const blocks = context.items.map((item) => ASC.correction.polynomialDesign(marks, item.designatedMarks, terms));
      return { terms, p, weight, blocks };
    });
  }

  function sameTerms(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }

  /** 情報行列 Σ FᵢᵀFᵢ（＋計算を止めないための小さな値）。 */
  function informationMatrix(model, rowsList) {
    const p = model.p;
    const information = new Float64Array(p * p);
    for (const rows of rowsList) {
      const count = rows.length / p;
      const part = M.gram(rows, count, p);
      for (let i = 0; i < part.length; i++) {
        information[i] += part[i];
      }
    }
    for (let i = 0; i < p; i++) {
      information[i * p + i] += C.INFORMATION_RIDGE;
    }
    return information;
  }

  /** A·Fᵀ（p×k）。A は p×p、F は k×p。 */
  function applyInverse(inverse, block, p) {
    const k = block.length / p;
    const result = new Float64Array(p * k);
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < k; j++) {
        let sum = 0;
        for (let l = 0; l < p; l++) {
          sum += inverse[i * p + l] * block[j * p + l];
        }
        result[i * k + j] = sum;
      }
    }
    return result;
  }

  /** Lᵀ R（L は p×a、R は p×b）→ a×b。 */
  function crossProduct(left, right, p, a, b) {
    const result = new Float64Array(a * b);
    for (let i = 0; i < a; i++) {
      for (let j = 0; j < b; j++) {
        let sum = 0;
        for (let l = 0; l < p; l++) {
          sum += left[l * a + i] * right[l * b + j];
        }
        result[i * b + j] = sum;
      }
    }
    return result;
  }

  /** F（k×p）と Q（p×m）の積 → k×m。 */
  function blockTimes(block, matrix, p, m) {
    const k = block.length / p;
    return M.multiply(block, k, p, matrix, m);
  }

  /**
   * 現在の選択での、候補ごとの前計算（Q = A Fᵀ、G = F A Fᵀ、I最適用に S = W Q、H = Qᵀ W Q）。
   */
  function prepareExchange(model, selectedItems, useWeight) {
    const p = model.p;
    const information = informationMatrix(model, selectedItems.map((item) => model.blocks[item]));
    let lower = M.cholesky(information, p);
    if (!lower) {
      // 丸め誤差で正定値にならないときは、足す値を大きくしてやり直す
      for (let i = 0; i < p; i++) {
        information[i * p + i] += 1e-6;
      }
      lower = M.cholesky(information, p);
    }
    const inverse = M.choleskySolve(lower, p, M.identity(p), p);
    const logDet = M.logDetFromCholesky(lower, p);
    let traceWeighted = 0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        traceWeighted += inverse[i * p + j] * model.weight[j * p + i];
      }
    }
    const perItem = model.blocks.map((block) => {
      const k = block.length / p;
      const q = applyInverse(inverse, block, p);
      const g = blockTimes(block, q, p, k);
      if (!useWeight) {
        return { q, g, k };
      }
      const s = M.multiply(model.weight, p, p, q, k);
      const h = crossProduct(q, s, p, k, k);
      return { q, g, s, h, k };
    });
    return { inverse, logDet, traceWeighted, perItem };
  }

  /**
   * removed を外して added を入れたときの変化を、Woodburyの公式で求める。
   * U = [F_addedᵀ, F_removedᵀ]、C = diag(I, −I) とすると M' = M + U C Uᵀ。
   *   det(M')/det(M) = det(C)·det(C + UᵀAU)
   *   tr(M'⁻¹W) = tr(AW) − tr((C + UᵀAU)⁻¹ UᵀAWAU)
   * 戻り値: { logDetChange, traceChange }（入れ替えると正則でなくなるなら null）
   */
  function swapChange(model, prepared, removed, added, useWeight) {
    const p = model.p;
    const a = prepared.perItem[added];
    const r = prepared.perItem[removed];
    const ka = a.k;
    const kr = r.k;
    const size = ka + kr;
    const kMatrix = new Float64Array(size * size);
    const gCross = blockTimes(model.blocks[added], r.q, p, kr); // F_added A F_removedᵀ
    for (let i = 0; i < ka; i++) {
      for (let j = 0; j < ka; j++) {
        kMatrix[i * size + j] = a.g[i * ka + j] + (i === j ? 1 : 0);
      }
      for (let j = 0; j < kr; j++) {
        kMatrix[i * size + ka + j] = gCross[i * kr + j];
        kMatrix[(ka + j) * size + i] = gCross[i * kr + j];
      }
    }
    for (let i = 0; i < kr; i++) {
      for (let j = 0; j < kr; j++) {
        kMatrix[(ka + i) * size + ka + j] = r.g[i * kr + j] - (i === j ? 1 : 0);
      }
    }
    const signedDet = (kr % 2 === 0 ? 1 : -1) * M.determinant(kMatrix, size);
    if (!(signedDet > 1e-12)) {
      return null;
    }
    const result = { logDetChange: Math.log(signedDet), traceChange: 0 };
    if (!useWeight) {
      return result;
    }
    const hMatrix = new Float64Array(size * size);
    const hCross = crossProduct(a.q, r.s, p, ka, kr); // Q_addedᵀ W Q_removed
    for (let i = 0; i < ka; i++) {
      for (let j = 0; j < ka; j++) {
        hMatrix[i * size + j] = a.h[i * ka + j];
      }
      for (let j = 0; j < kr; j++) {
        hMatrix[i * size + ka + j] = hCross[i * kr + j];
        hMatrix[(ka + j) * size + i] = hCross[i * kr + j];
      }
    }
    for (let i = 0; i < kr; i++) {
      for (let j = 0; j < kr; j++) {
        hMatrix[(ka + i) * size + ka + j] = r.h[i * kr + j];
      }
    }
    const decomposition = M.luDecompose(kMatrix, size);
    if (!decomposition) {
      return null;
    }
    const solved = M.luSolve(decomposition, hMatrix, size);
    let trace = 0;
    for (let i = 0; i < size; i++) {
      trace += solved[i * size + i];
    }
    result.traceChange = -trace;
    return result;
  }

  /**
   * D最適またはI最適の入れ替え法（Fedorov）。
   * 目的: D最適は「項あたりの log det」を大きく、I最適は「log（予測分散の平均）」を小さくする。
   * ソフト制約の外れは、強さに応じて目的から差し引く。ハード制約を外す入れ替えはしない。
   */
  function exchangeOptimize(context, models, criterion, startState) {
    const useWeight = criterion === "I";
    const totalTerms = models.reduce((sum, model) => sum + model.p, 0);
    const penaltyScale = context.softStrength * C.SOFT_PENALTY_LOG_EFFICIENCY;
    const state = startState;
    const forced = context.center.active ? context.center.itemIndex : -1;

    for (let pass = 0; pass < C.OPTIMAL_MAX_PASSES; pass++) {
      const prepared = models.map((model) => prepareExchange(model, state.list, useWeight));
      const traceTotal = prepared.reduce((sum, entry) => sum + entry.traceWeighted, 0);
      let bestGain = 1e-9;
      let bestSwap = null;
      for (const removed of state.list) {
        if (removed === forced) {
          continue;
        }
        for (let added = 0; added < context.items.length; added++) {
          // ハード制約を満たした状態から始めるので、外れが増える入れ替えだけを除けばよい
          if (state.selected[added] || state.swapDelta(removed, added, true) > 0) {
            continue;
          }
          let gain;
          if (useWeight) {
            let traceChange = 0;
            let valid = true;
            models.forEach((model, index) => {
              const change = swapChange(model, prepared[index], removed, added, true);
              if (!change) {
                valid = false;
              } else {
                traceChange += change.traceChange;
              }
            });
            if (!valid || !(traceTotal + traceChange > 0)) {
              continue;
            }
            gain = Math.log(traceTotal) - Math.log(traceTotal + traceChange);
          } else {
            let logDetChange = 0;
            let valid = true;
            models.forEach((model, index) => {
              const change = swapChange(model, prepared[index], removed, added, false);
              if (!change) {
                valid = false;
              } else {
                logDetChange += change.logDetChange;
              }
            });
            if (!valid) {
              continue;
            }
            gain = logDetChange / totalTerms;
          }
          gain -= penaltyScale * state.swapDelta(removed, added, false);
          if (gain > bestGain) {
            bestGain = gain;
            bestSwap = [removed, added];
          }
        }
      }
      if (!bestSwap) {
        break;
      }
      state.remove(bestSwap[0]);
      state.add(bestSwap[1]);
    }
    return state;
  }

  /** 目的の値（大きいほど良い）。複数の開始点の結果を比べるときに使う。 */
  function objectiveOf(context, models, criterion, state) {
    const useWeight = criterion === "I";
    const prepared = models.map((model) => prepareExchange(model, state.list, useWeight));
    const penalty = context.softStrength * C.SOFT_PENALTY_LOG_EFFICIENCY * state.violation(false);
    if (useWeight) {
      const traceTotal = prepared.reduce((sum, entry) => sum + entry.traceWeighted, 0);
      return -Math.log(traceTotal) - penalty;
    }
    const totalTerms = models.reduce((sum, model) => sum + model.p, 0);
    return prepared.reduce((sum, entry) => sum + entry.logDet, 0) / totalTerms - penalty;
  }

  function selectOptimal(context, random, criterion, termSets, startCount) {
    const models = buildModels(context, termSets);
    let best = null;
    let bestObjective = -Infinity;
    for (let start = 0; start < startCount; start++) {
      const startState = findFeasibleState(context, random);
      if (!startState) {
        continue;
      }
      // I最適は制約で入れ替えが限られると局所解で止まりやすいため、D最適で整えてから探す
      const prepared = criterion === "I" ? exchangeOptimize(context, models, "D", startState) : startState;
      const state = exchangeOptimize(context, models, criterion, prepared);
      const objective = objectiveOf(context, models, criterion, state);
      if (objective > bestObjective) {
        bestObjective = objective;
        best = state;
      }
    }
    if (!best) {
      return null;
    }
    const measured = measuredMarksOf(context, best.list);
    const extras = pickExtrasOptimal(context, best.list, measured, models, criterion);
    return { items: best.list.slice(), markIndices: measured.concat(extras) };
  }

  // ---- 追加のMark（k個以上のとき）---------------------------------------

  function measuredMarksOf(context, selectedItems) {
    const marks = [];
    for (const item of selectedItems) {
      marks.push(...context.items[item].designatedMarks);
    }
    return marks;
  }

  /** 追加の候補と、中心の1点のために必ず入れる追加Mark。 */
  function extraCandidates(context, selectedItems) {
    const candidates = [];
    for (const item of selectedItems) {
      candidates.push(...context.items[item].otherMarks);
    }
    const forced = [];
    const center = context.center;
    if (center.active && !center.isDesignated && candidates.includes(center.markIndex)) {
      forced.push(center.markIndex);
    }
    return { candidates: candidates.filter((markIndex) => !forced.includes(markIndex)), forced };
  }

  function pickExtrasRandom(context, selectedItems, measured, random) {
    if (context.extraMarkCount <= 0) {
      return [];
    }
    const { candidates, forced } = extraCandidates(context, selectedItems);
    random.shuffle(candidates);
    return forced.concat(candidates).slice(0, context.extraMarkCount);
  }

  /** すでに測るMarkから最も遠いMarkを順に選ぶ（ポアソンディスクの考え方をMarkに広げたもの）。 */
  function pickExtrasFarthest(context, selectedItems, measured, random) {
    if (context.extraMarkCount <= 0) {
      return [];
    }
    const marks = context.map.marks;
    const { candidates, forced } = extraCandidates(context, selectedItems);
    const chosen = forced.slice();
    const current = measured.concat(forced);
    const remaining = candidates.slice();
    while (chosen.length < context.extraMarkCount && remaining.length > 0) {
      let bestIndex = 0;
      let bestDistance = -1;
      remaining.forEach((markIndex, index) => {
        let nearest = Infinity;
        for (const other of current) {
          nearest = Math.min(nearest, Math.hypot(marks[markIndex].x - marks[other].x, marks[markIndex].y - marks[other].y));
        }
        // 同じ距離が並んだときに偏らないよう、ごく小さな乱数を足す
        nearest += random.next() * 1e-6;
        if (nearest > bestDistance) {
          bestDistance = nearest;
          bestIndex = index;
        }
      });
      const picked = remaining.splice(bestIndex, 1)[0];
      chosen.push(picked);
      current.push(picked);
    }
    return chosen.slice(0, context.extraMarkCount);
  }

  /** D・I最適の基準が最も良くなるMarkを1つずつ加える（Sherman-Morrisonで更新）。 */
  function pickExtrasOptimal(context, selectedItems, measured, models, criterion) {
    if (context.extraMarkCount <= 0) {
      return [];
    }
    const marks = context.map.marks;
    const { candidates, forced } = extraCandidates(context, selectedItems);
    const chosen = forced.slice();
    const current = measured.concat(forced);
    const inverses = models.map((model) => {
      const rows = ASC.correction.polynomialDesign(marks, current, model.terms);
      return M.inverseSymmetric(informationMatrix(model, [rows]), model.p);
    });
    const vectors = models.map((model) => ASC.correction.polynomialDesign(marks, candidates, model.terms));
    const remaining = candidates.map((_, index) => index);

    while (chosen.length < context.extraMarkCount && remaining.length > 0) {
      let bestPosition = 0;
      let bestGain = -Infinity;
      remaining.forEach((candidateIndex, position) => {
        let gain = 0;
        models.forEach((model, modelIndex) => {
          const f = vectors[modelIndex].subarray(candidateIndex * model.p, (candidateIndex + 1) * model.p);
          const af = matrixVector(inverses[modelIndex], f, model.p);
          const leverage = dot(f, af, model.p);
          if (criterion === "I") {
            const waf = matrixVector(model.weight, af, model.p);
            gain += dot(af, waf, model.p) / (1 + leverage);
          } else {
            gain += Math.log(1 + leverage);
          }
        });
        if (gain > bestGain) {
          bestGain = gain;
          bestPosition = position;
        }
      });
      const candidateIndex = remaining.splice(bestPosition, 1)[0];
      models.forEach((model, modelIndex) => {
        const f = vectors[modelIndex].subarray(candidateIndex * model.p, (candidateIndex + 1) * model.p);
        shermanMorrisonUpdate(inverses[modelIndex], f, model.p);
      });
      chosen.push(candidates[candidateIndex]);
    }
    return chosen.slice(0, context.extraMarkCount);
  }

  function matrixVector(matrix, vector, size) {
    const result = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let j = 0; j < size; j++) {
        sum += matrix[i * size + j] * vector[j];
      }
      result[i] = sum;
    }
    return result;
  }

  function dot(left, right, size) {
    let sum = 0;
    for (let i = 0; i < size; i++) {
      sum += left[i] * right[i];
    }
    return sum;
  }

  /** (A⁻¹ + f fᵀ)⁻¹ ではなく、M に f fᵀ を足したときの逆行列 A を更新する。 */
  function shermanMorrisonUpdate(inverse, f, size) {
    const af = matrixVector(inverse, f, size);
    const denominator = 1 + dot(f, af, size);
    for (let i = 0; i < size; i++) {
      for (let j = 0; j < size; j++) {
        inverse[i * size + j] -= (af[i] * af[j]) / denominator;
      }
    }
  }

  // ---- 手動 --------------------------------------------------------------

  /**
   * 手動選択（Shot番号と追加Markの集合）から、測るMarkの一覧を作る。
   * 選べないShot（必ず測るMarkが有効範囲外）は items に入れず、notEligible で知らせる。
   */
  function manualSelection(context, selectedShotIndices, extraMarkIndices) {
    const itemByShot = new Map(context.items.map((item, index) => [item.shotIndex, index]));
    const items = [];
    const notEligible = [];
    for (const shotIndex of selectedShotIndices) {
      if (itemByShot.has(shotIndex)) {
        items.push(itemByShot.get(shotIndex));
      } else {
        notEligible.push(shotIndex);
      }
    }
    const markIndices = measuredMarksOf(context, items);
    if (!context.exactMode) {
      const allowed = new Set();
      for (const item of items) {
        context.items[item].otherMarks.forEach((markIndex) => allowed.add(markIndex));
      }
      for (const markIndex of extraMarkIndices) {
        if (allowed.has(markIndex)) {
          markIndices.push(markIndex);
        }
      }
    }
    return { items, markIndices, notEligible };
  }

  // ---- 選んだ点の性質 ----------------------------------------------------

  /** Shot中心の最小間隔 [mm]。 */
  function minimumShotSpacing(context, selectedItems) {
    let minimum = Infinity;
    for (let i = 0; i < selectedItems.length; i++) {
      for (let j = i + 1; j < selectedItems.length; j++) {
        const a = context.items[selectedItems[i]];
        const b = context.items[selectedItems[j]];
        minimum = Math.min(minimum, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    return minimum;
  }

  /**
   * 選んだ点のD基準とI基準（HOWAの多項式に対して）。
   *   logDet: log det(XᵀX)。D最適が最大にする値（大きいほど係数の推定精度が良い）
   *   trace:  全Markで平均した予測分散 ÷ σ² = tr((XᵀX)⁻¹ W)、W = 全Markで平均した xxᵀ。I最適が最小にする値
   *   kappa:  √trace（予測誤差の倍率）
   * XᵀX が正則でないときは singular を true にし、logDet = −∞、trace = ∞ とする。
   * reason は "tooFew"（点が項数より少ない）か "degenerate"（点の並びが偏っていて多項式が決まらない）。
   */
  function designCriteria(map, markIndices, terms) {
    const marks = map.marks;
    const p = terms.length;
    const result = { p, n: markIndices.length, logDet: -Infinity, trace: Infinity, kappa: Infinity, singular: true, reason: "tooFew" };
    if (markIndices.length < p) {
      return result;
    }
    result.reason = "degenerate";
    const sampleDesign = ASC.correction.polynomialDesign(marks, markIndices, terms);
    const information = M.gram(sampleDesign, markIndices.length, p);
    const lower = M.cholesky(information, p);
    if (!lower || nearlySingular(lower, p)) {
      return result;
    }
    const inverse = M.choleskySolve(lower, p, M.identity(p), p);
    const allIndices = Array.from({ length: marks.length }, (_, i) => i);
    const allDesign = ASC.correction.polynomialDesign(marks, allIndices, terms);
    const weight = M.gram(allDesign, marks.length, p);
    let trace = 0;
    for (let i = 0; i < p; i++) {
      for (let j = 0; j < p; j++) {
        trace += inverse[i * p + j] * weight[j * p + i];
      }
    }
    trace /= marks.length;
    result.logDet = M.logDetFromCholesky(lower, p);
    result.trace = trace;
    result.kappa = Math.sqrt(trace);
    result.singular = false;
    result.reason = null;
    return result;
  }

  /** コレスキー因子の対角の比が極端（ほぼ特異）か。HOWAの最小二乗で警告を出す基準と同じ。 */
  function nearlySingular(lower, size) {
    let minimum = Infinity;
    let maximum = 0;
    for (let i = 0; i < size; i++) {
      minimum = Math.min(minimum, lower[i * size + i]);
      maximum = Math.max(maximum, lower[i * size + i]);
    }
    return minimum / maximum < SINGULAR_DIAGONAL_RATIO;
  }

  /**
   * κ（予測誤差の倍率）= √(全Markで平均した予測分散 / σ²) = √tr(M⁻¹W)。
   * HOWAのみで補正したとき、計測ノイズ σ が全Markの補正量にどれだけ乗るかの目安。
   */
  function kappaOf(map, markIndices, terms) {
    return designCriteria(map, markIndices, terms).kappa;
  }

  /**
   * D効率とI効率（%）。基準（reference）の選び方を100%として比べる。
   *   D効率 = 100 × (det / det_基準)^(1/p)、I効率 = 100 × trace_基準 / trace
   */
  function efficiencies(criteria, reference) {
    if (!reference || criteria.singular) {
      return { d: criteria.singular ? 0 : NaN, i: criteria.singular ? 0 : NaN };
    }
    return {
      d: 100 * Math.exp((criteria.logDet - reference.logDet) / criteria.p),
      i: (100 * reference.trace) / criteria.trace,
    };
  }

  ASC.sampling = {
    constructSequential,
    findFeasibleState,
    selectRandom,
    selectPoisson,
    selectOptimal,
    manualSelection,
    minimumShotSpacing,
    kappaOf,
    designCriteria,
    efficiencies,
    buildModels,
    prepareExchange,
    swapChange,
    informationMatrix,
  };
})(typeof window !== "undefined" ? window : globalThis);
