/**
 * サンプリングの前提（選べるShot・区画分け）と条件制約の判定。
 *
 * 用語:
 *   候補（item）: 選べるShot。必ず測るMarkがすべて有効範囲にあるShot
 *   区画（class）: 制約ごとの分け方（Scan方向は2つ、4象限は4つ、同心円は3つ）
 *   目標の幅: 各区画の選択数が入るべき範囲 [floor, ceil]。同数配分なら差1以内と同じ意味
 * 制約は「選んだShotの数」で数え、区画はShot中心の座標で判定する。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const M = ASC.math;

  const QUADRANT_LABELS = ["第1象限（x≧0, y≧0）", "第2象限（x<0, y≧0）", "第3象限（x<0, y<0）", "第4象限（x≧0, y<0）"];

  function quadrantOf(x, y) {
    if (y >= 0) {
      return x >= 0 ? 0 : 1;
    }
    return x < 0 ? 2 : 3;
  }

  function zoneOf(radius, innerRadius, outerRadius) {
    if (radius < innerRadius) {
      return 0;
    }
    return radius < outerRadius ? 1 : 2;
  }

  /** サンプリングと制約の設定を確認する。誤りの説明の一覧を返す。 */
  function validateSettings(map, settings) {
    const errors = [];
    const sampling = settings.sampling;
    const zones = settings.zones;
    if (!(zones.innerRadiusMm > 0) || !(zones.outerRadiusMm > zones.innerRadiusMm) || !(zones.outerRadiusMm < map.validRadiusMm)) {
      errors.push(`同心円の区切りは 0 < 内側 < 外側 < 有効半径（${map.validRadiusMm} mm）にしてください。`);
    }
    if (sampling.designatedMarkNos.length === 0) {
      errors.push("必ず測るMarkを1つ以上選んでください。");
    }
    if (!Number.isInteger(sampling.shotCount) || sampling.shotCount < 1) {
      errors.push("計測Shot数は1以上の整数にしてください。");
    }
    const priorities = C.CONSTRAINT_KEYS.filter((key) => settings.constraints[key].enabled).map(
      (key) => settings.constraints[key].priority
    );
    if (new Set(priorities).size !== priorities.length) {
      errors.push("オンにした制約の優先度が重複しています。1〜4を1回ずつ使ってください。");
    }
    return errors;
  }

  /**
   * 候補・区画・中心の1点をまとめた「サンプリングの前提」を作る。
   */
  function buildContext(map, settings) {
    const errors = validateSettings(map, settings);
    if (errors.length > 0) {
      return { context: null, errors };
    }
    const sampling = settings.sampling;
    const designatedNos = Array.from(new Set(sampling.designatedMarkNos)).sort((a, b) => a - b);
    const markCountPerShot = designatedNos.length;

    const items = [];
    map.shots.forEach((shot, shotIndex) => {
      const markByNo = new Map(shot.markIndices.map((markIndex) => [map.marks[markIndex].markNo, markIndex]));
      if (!designatedNos.every((markNo) => markByNo.has(markNo))) {
        return;
      }
      const designatedMarks = designatedNos.map((markNo) => markByNo.get(markNo));
      const otherMarks = shot.markIndices.filter((markIndex) => !designatedMarks.includes(markIndex));
      items.push({ shotIndex, x: shot.x, y: shot.y, scan: shot.scan, designatedMarks, otherMarks });
    });

    const shotCount = sampling.shotCount;
    const exactMode = sampling.markMode === "exact";
    const totalMarkCount = exactMode ? shotCount * markCountPerShot : sampling.totalMarkCount;
    const extraMarkCount = totalMarkCount - shotCount * markCountPerShot;

    if (items.length === 0) {
      errors.push("必ず測るMarkがすべて有効範囲にあるShotがありません。Markの指定か有効半径を見直してください。");
    } else if (shotCount > items.length) {
      errors.push(`計測Shot数（${shotCount}）が選べるShot数（${items.length}）を超えています。数を減らしてください。`);
    }
    if (!exactMode) {
      const maxExtra = items.reduce((sum, item) => sum + item.otherMarks.length, 0);
      if (!Number.isInteger(totalMarkCount) || extraMarkCount < 0) {
        errors.push(`総Mark数は「計測Shot数 × 必ず測るMarkの数」（${shotCount * markCountPerShot}）以上の整数にしてください。`);
      } else if (maxExtra === 0 && extraMarkCount > 0) {
        errors.push("選べるShotに追加で測れるMarkがありません。「ちょうどk個」にするか、Markを増やしてください。");
      }
    }
    if (errors.length > 0) {
      return { context: null, errors };
    }

    const constraints = buildBalanceConstraints(items, settings);
    const center = buildCenter(map, items, settings.constraints.center, extraMarkCount > 0);

    return {
      context: {
        map,
        items,
        designatedNos,
        markCountPerShot,
        shotCount,
        totalMarkCount,
        extraMarkCount,
        exactMode,
        constraints,
        center,
        softStrength: settings.constraints.softStrength,
      },
      errors: [],
    };
  }

  function buildBalanceConstraints(items, settings) {
    const zones = settings.zones;
    const definitions = {
      scan: {
        classCount: 2,
        labels: ["Up", "Down"],
        classOf: (item) => (item.scan === C.SCAN_UP ? 0 : 1),
      },
      quadrant: {
        classCount: 4,
        labels: QUADRANT_LABELS,
        classOf: (item) => quadrantOf(item.x, item.y),
      },
      zone: {
        classCount: 3,
        labels: [
          `内側（r < ${zones.innerRadiusMm} mm）`,
          `中間（${zones.innerRadiusMm}〜${zones.outerRadiusMm} mm）`,
          `外側（r ≧ ${zones.outerRadiusMm} mm）`,
        ],
        classOf: (item) => zoneOf(Math.hypot(item.x, item.y), zones.innerRadiusMm, zones.outerRadiusMm),
      },
    };

    const constraints = [];
    for (const key of ["scan", "quadrant", "zone"]) {
      const setting = settings.constraints[key];
      if (!setting.enabled) {
        continue;
      }
      const definition = definitions[key];
      const classOf = new Int32Array(items.length);
      const available = new Int32Array(definition.classCount);
      items.forEach((item, index) => {
        classOf[index] = definition.classOf(item);
        available[classOf[index]]++;
      });
      constraints.push({
        key,
        label: C.CONSTRAINT_LABELS[key],
        classCount: definition.classCount,
        classLabels: definition.labels,
        classOf,
        available,
        allocation: setting.allocation,
        hard: setting.hard,
        priority: setting.priority,
        weight: C.PRIORITY_WEIGHTS[setting.priority] || 1,
      });
    }
    return constraints;
  }

  /**
   * 中心に最も近いMark。追加のMarkを測らないときは必ず測るMarkの中から、
   * 追加のMarkを測るときは選べるShotの全Markから探す。
   */
  function buildCenter(map, items, setting, allowExtraMarks) {
    if (!setting.enabled) {
      return { active: false, enabled: false };
    }
    let best = null;
    items.forEach((item, itemIndex) => {
      const candidates = allowExtraMarks ? item.designatedMarks.concat(item.otherMarks) : item.designatedMarks;
      for (const markIndex of candidates) {
        const mark = map.marks[markIndex];
        const distance = Math.hypot(mark.x, mark.y);
        if (!best || distance < best.distance) {
          best = { itemIndex, markIndex, distance, isDesignated: item.designatedMarks.includes(markIndex) };
        }
      }
    });
    return {
      enabled: true,
      active: true,
      hard: true,
      priority: setting.priority,
      itemIndex: best.itemIndex,
      markIndex: best.markIndex,
      isDesignated: best.isDesignated,
      distanceMm: best.distance,
    };
  }

  /** 選択数 total のときの、区画ごとの目標の幅 [floor, ceil]。 */
  function targetsFor(constraint, total) {
    const floor = new Int32Array(constraint.classCount);
    const ceil = new Int32Array(constraint.classCount);
    let availableSum = 0;
    for (let c = 0; c < constraint.classCount; c++) {
      availableSum += constraint.available[c];
    }
    for (let c = 0; c < constraint.classCount; c++) {
      const share =
        constraint.allocation === C.ALLOCATION_PROPORTIONAL && availableSum > 0
          ? constraint.available[c] / availableSum
          : 1 / constraint.classCount;
      const target = total * share;
      floor[c] = Math.floor(target + 1e-9);
      ceil[c] = Math.ceil(target - 1e-9);
    }
    return { floor, ceil };
  }

  /** 区画ごとの数が目標の幅から外れた量の合計。 */
  function violationOf(counts, targets) {
    let violation = 0;
    for (let c = 0; c < counts.length; c++) {
      if (counts[c] > targets.ceil[c]) {
        violation += counts[c] - targets.ceil[c];
      } else if (counts[c] < targets.floor[c]) {
        violation += targets.floor[c] - counts[c];
      }
    }
    return violation;
  }

  /** 区画の候補数が目標の下限に足りているか（足りなければ、その制約は満たせない）。 */
  function hasCapacity(constraint, total) {
    const targets = targetsFor(constraint, total);
    let reachable = 0;
    for (let c = 0; c < constraint.classCount; c++) {
      if (constraint.available[c] < targets.floor[c]) {
        return false;
      }
      reachable += Math.min(constraint.available[c], targets.ceil[c]);
    }
    return reachable >= total;
  }

  /**
   * 選択の状態。区画ごとの数を持ち、追加・削除・入れ替えでの制約の変化を素早く求める。
   */
  function createState(context, total) {
    const itemCount = context.items.length;
    const selected = new Uint8Array(itemCount);
    const list = [];
    const counts = context.constraints.map((constraint) => new Int32Array(constraint.classCount));
    const targets = context.constraints.map((constraint) => targetsFor(constraint, total));

    function add(item) {
      selected[item] = 1;
      list.push(item);
      context.constraints.forEach((constraint, index) => {
        counts[index][constraint.classOf[item]]++;
      });
    }

    function remove(item) {
      selected[item] = 0;
      list.splice(list.indexOf(item), 1);
      context.constraints.forEach((constraint, index) => {
        counts[index][constraint.classOf[item]]--;
      });
    }

    function violation(hard) {
      let sum = 0;
      context.constraints.forEach((constraint, index) => {
        if (constraint.hard === hard) {
          const value = violationOf(counts[index], targets[index]);
          sum += hard ? value : value * constraint.weight;
        }
      });
      return sum;
    }

    /** item を加えても、残りの枠でハード制約を満たせる見込みがあるか。 */
    function canAddHard(item) {
      const remainingAfter = total - list.length - 1;
      for (let index = 0; index < context.constraints.length; index++) {
        const constraint = context.constraints[index];
        if (!constraint.hard) {
          continue;
        }
        const itemClass = constraint.classOf[item];
        const classCounts = counts[index];
        const target = targets[index];
        if (classCounts[itemClass] + 1 > target.ceil[itemClass]) {
          return false;
        }
        let deficit = 0;
        for (let c = 0; c < constraint.classCount; c++) {
          const count = classCounts[c] + (c === itemClass ? 1 : 0);
          deficit += Math.max(0, target.floor[c] - count);
        }
        if (deficit > remainingAfter) {
          return false;
        }
      }
      return true;
    }

    /** item を加えたとき、ソフト制約の区画が目標の上限を超える量（重み付き）。 */
    function softOverfill(item) {
      let sum = 0;
      context.constraints.forEach((constraint, index) => {
        if (!constraint.hard) {
          const itemClass = constraint.classOf[item];
          if (counts[index][itemClass] + 1 > targets[index].ceil[itemClass]) {
            sum += constraint.weight;
          }
        }
      });
      return sum;
    }

    /** removed を外して added を入れたときの、ハード（hard=true）またはソフトの外れ量の変化。 */
    function swapDelta(removed, added, hard) {
      let delta = 0;
      context.constraints.forEach((constraint, index) => {
        if (constraint.hard !== hard) {
          return;
        }
        const from = constraint.classOf[removed];
        const to = constraint.classOf[added];
        if (from === to) {
          return;
        }
        const classCounts = counts[index];
        const target = targets[index];
        const before = classViolation(classCounts[from], target, from) + classViolation(classCounts[to], target, to);
        const after = classViolation(classCounts[from] - 1, target, from) + classViolation(classCounts[to] + 1, target, to);
        delta += hard ? after - before : (after - before) * constraint.weight;
      });
      return delta;
    }

    return { selected, list, counts, targets, total, add, remove, violation, canAddHard, softOverfill, swapDelta };
  }

  function classViolation(count, target, classIndex) {
    if (count > target.ceil[classIndex]) {
      return count - target.ceil[classIndex];
    }
    if (count < target.floor[classIndex]) {
      return target.floor[classIndex] - count;
    }
    return 0;
  }

  /**
   * 任意の選択（手動選択を含む）の制約の満たし具合を表にする。
   * selectedItems: 選んだ候補の番号、measuredMarks: 実際に測るMark
   */
  function describeStatus(context, selectedItems, measuredMarks) {
    const total = selectedItems.length;
    const rows = context.constraints.map((constraint) => {
      const counts = new Int32Array(constraint.classCount);
      for (const item of selectedItems) {
        counts[constraint.classOf[item]]++;
      }
      const targets = targetsFor(constraint, total);
      const classes = constraint.classLabels.map((label, c) => ({
        label,
        count: counts[c],
        floor: targets.floor[c],
        ceil: targets.ceil[c],
        ok: counts[c] >= targets.floor[c] && counts[c] <= targets.ceil[c],
      }));
      return {
        key: constraint.key,
        label: constraint.label,
        hard: constraint.hard,
        priority: constraint.priority,
        ok: classes.every((entry) => entry.ok),
        classes,
      };
    });
    const center = context.center;
    let centerRow = null;
    if (center.enabled) {
      const included = measuredMarks.includes(center.markIndex);
      centerRow = { key: "center", label: C.CONSTRAINT_LABELS.center, hard: center.active, priority: center.priority, ok: included };
    }
    return { rows, center: centerRow };
  }

  /**
   * ハード制約を同時に満たせるか確かめ、満たせなければ優先度の低い順にソフトへ切り替える。
   * 全部の選び方で同じ制約の組み合わせを使い、公平に比べられるようにする。
   * 戻り値: 切り替えた制約と理由の一覧（context の hard / active を書き換える）
   */
  function resolveHardConstraints(context, seed, findFeasible) {
    const relaxed = [];
    for (const constraint of context.constraints) {
      if (constraint.hard && !hasCapacity(constraint, context.shotCount)) {
        constraint.hard = false;
        relaxed.push({
          key: constraint.key,
          label: constraint.label,
          reason: "区画によっては選べるShotが目標の数に足りないため",
        });
      }
    }
    for (let attempt = 0; attempt <= context.constraints.length + 1; attempt++) {
      const random = M.createRandom(M.deriveSeed(seed, 7919 + attempt));
      if (findFeasible(context, random)) {
        return relaxed;
      }
      const lowest = lowestPriorityHard(context);
      if (!lowest) {
        return relaxed;
      }
      if (lowest === context.center) {
        context.center.active = false;
      } else {
        lowest.hard = false;
      }
      relaxed.push({
        key: lowest === context.center ? "center" : lowest.key,
        label: lowest === context.center ? C.CONSTRAINT_LABELS.center : lowest.label,
        reason: "ほかのハード制約と同時に満たす選び方が見つからないため",
      });
    }
    return relaxed;
  }

  function lowestPriorityHard(context) {
    const candidates = context.constraints.filter((constraint) => constraint.hard);
    if (context.center.active) {
      candidates.push(context.center);
    }
    if (candidates.length === 0) {
      return null;
    }
    return candidates.reduce((lowest, entry) => (entry.priority > lowest.priority ? entry : lowest));
  }

  ASC.constraints = {
    QUADRANT_LABELS,
    quadrantOf,
    zoneOf,
    buildContext,
    targetsFor,
    violationOf,
    hasCapacity,
    createState,
    describeStatus,
    resolveHardConstraints,
  };
})(typeof window !== "undefined" ? window : globalThis);
