/**
 * サンプリングの前提（選べるShot・区画分け）と条件制約の判定。
 *
 * 用語:
 *   候補（item）: 選べるShot。除外Shotと、（設定によっては）Markが揃わない端のShotを除いたもの。
 *                 選んだShotでは、そのShotの有効なMarkをすべて測る
 *   区画（class）: 制約ごとの分け方（Scan方向は2つ、4象限は4つ、同心円は3つ）
 *   目標の幅: 各区画の選択数が入るべき範囲 [floor, ceil]。同数配分なら差1以内と同じ意味
 *   強制計測Shot: 必ず選ぶShot（常にハード）。中心の1点のShotとあわせて、入れ替えの対象にしない
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

  /** Shot番号の並び（数でも文字でもよい）を、重複のない文字の並びにする。 */
  function shotIdList(values) {
    return Array.isArray(values) ? Array.from(new Set(values.map((value) => String(value).trim()).filter((value) => value !== ""))) : [];
  }

  /** Markが揃わない端のShot（定義したMarkの一部が有効範囲の外にあるShot）か。 */
  function isIncompleteShot(shot) {
    return shot.markIndices.length < shot.definedMarkCount;
  }

  /**
   * 候補・区画・中心の1点・強制計測Shotをまとめた「サンプリングの前提」を作る。
   */
  function buildContext(map, settings) {
    const errors = validateSettings(map, settings);
    if (errors.length > 0) {
      return { context: null, errors };
    }
    const sampling = settings.sampling;
    const constraintSettings = settings.constraints;
    const shotIndexById = new Map(map.shots.map((shot, index) => [shot.id, index]));
    const mandatoryIds = shotIdList(constraintSettings.mandatoryShotIds);
    const excludedIds = shotIdList(constraintSettings.excludedShotIds);
    for (const [ids, label] of [[mandatoryIds, "強制計測Shot"], [excludedIds, "除外Shot"]]) {
      const unknown = ids.filter((id) => !shotIndexById.has(id));
      if (unknown.length > 0) {
        errors.push(`${label}の番号 ${unknown.slice(0, 8).join(", ")}${unknown.length > 8 ? " ほか" : ""} がマップにありません。マップのShot番号を確かめてください。`);
      }
    }
    const excludedShots = new Set(excludedIds.filter((id) => shotIndexById.has(id)).map((id) => shotIndexById.get(id)));

    const items = [];
    const itemByShot = new Map();
    map.shots.forEach((shot, shotIndex) => {
      if (excludedShots.has(shotIndex) || (sampling.excludeIncompleteShots && isIncompleteShot(shot))) {
        return;
      }
      itemByShot.set(shotIndex, items.length);
      items.push({ shotIndex, x: shot.x, y: shot.y, scan: shot.scan, marks: shot.markIndices.slice() });
    });

    const mandatoryItems = [];
    for (const id of mandatoryIds) {
      if (!shotIndexById.has(id)) {
        continue;
      }
      const shotIndex = shotIndexById.get(id);
      if (excludedShots.has(shotIndex)) {
        errors.push(`Shot ${id} が強制計測Shotと除外Shotの両方に入っています。どちらかから外してください。`);
      } else if (!itemByShot.has(shotIndex)) {
        errors.push(`強制計測Shot ${id} はMarkが揃わない端のShotなので選べません。番号を外すか、「Markが揃わない端のShotは選ばない」をオフにしてください。`);
      } else {
        mandatoryItems.push(itemByShot.get(shotIndex));
      }
    }
    mandatoryItems.sort((a, b) => a - b);

    const shotCount = sampling.shotCount;
    if (items.length === 0) {
      errors.push("選べるShotがありません。除外Shotや有効半径を見直してください。");
    } else if (shotCount > items.length) {
      errors.push(`計測Shot数（${shotCount}）が選べるShot数（${items.length}）を超えています。数を減らしてください。`);
    }
    if (errors.length > 0) {
      return { context: null, errors };
    }

    const center = buildCenter(map, items, constraintSettings.center);
    const forcedCount = new Set(mandatoryItems.concat(center.active ? [center.itemIndex] : [])).size;
    if (forcedCount > shotCount) {
      errors.push(`強制計測Shot（中心の1点のShotを含む）が${forcedCount}個あり、計測Shot数（${shotCount}）を超えています。計測Shot数を増やすか、強制計測Shotを減らしてください。`);
      return { context: null, errors };
    }

    return {
      context: {
        map,
        items,
        shotCount,
        constraints: buildBalanceConstraints(items, settings),
        center,
        mandatoryItems,
        softStrength: constraintSettings.softStrength,
      },
      errors: [],
    };
  }

  /** 必ず選ぶ候補（中心の1点のShot → 強制計測Shot の順。入れ替えの対象にしない）。 */
  function forcedItemsOf(context) {
    const forced = context.center.active ? [context.center.itemIndex] : [];
    for (const item of context.mandatoryItems) {
      if (!forced.includes(item)) {
        forced.push(item);
      }
    }
    return forced;
  }

  /** 条件制約を使わない選び方（D最適・I最適の制約なし）の前提。候補は同じで、制約・中心の1点・強制計測Shotを外す。 */
  function unconstrainedContext(context) {
    return Object.assign({}, context, {
      constraints: [],
      center: { enabled: false, active: false },
      mandatoryItems: [],
    });
  }

  function buildBalanceConstraints(items, settings) {
    const zones = settings.zones;
    const definitions = {
      scan: {
        classCount: 2,
        labels: ["Up", "Down"],
        shortLabels: ["Up", "Down"],
        classOf: (item) => (item.scan === C.SCAN_UP ? 0 : 1),
      },
      quadrant: {
        classCount: 4,
        labels: QUADRANT_LABELS,
        shortLabels: ["第1", "第2", "第3", "第4"],
        classOf: (item) => quadrantOf(item.x, item.y),
      },
      zone: {
        classCount: 3,
        labels: [
          `内側（r < ${zones.innerRadiusMm} mm）`,
          `中間（${zones.innerRadiusMm}〜${zones.outerRadiusMm} mm）`,
          `外側（r ≧ ${zones.outerRadiusMm} mm）`,
        ],
        shortLabels: ["内側", "中間", "外側"],
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
        classShortLabels: definition.shortLabels,
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

  /** 中心に最も近いMark（選べるShotの全Markから探す）。そのMarkのShotを必ず選ぶ。 */
  function buildCenter(map, items, setting) {
    if (!setting.enabled) {
      return { active: false, enabled: false };
    }
    let best = null;
    items.forEach((item, itemIndex) => {
      for (const markIndex of item.marks) {
        const mark = map.marks[markIndex];
        const distance = Math.hypot(mark.x, mark.y);
        if (!best || distance < best.distance) {
          best = { itemIndex, markIndex, distance };
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
        shortLabel: constraint.classShortLabels[c],
        count: counts[c],
        floor: targets.floor[c],
        ceil: targets.ceil[c],
        ok: counts[c] >= targets.floor[c] && counts[c] <= targets.ceil[c],
      }));
      // ずれ: 目標の幅から外れた数の合計の半分（切り上げ）。何個のShotを別の区画へ移せば満たせるかの目安
      const shift = Math.ceil(violationOf(counts, targets) / 2);
      return {
        key: constraint.key,
        label: constraint.label,
        hard: constraint.hard,
        priority: constraint.priority,
        ok: classes.every((entry) => entry.ok),
        shift,
        classes,
      };
    });
    const center = context.center;
    let centerRow = null;
    if (center.enabled) {
      const included = measuredMarks.includes(center.markIndex);
      centerRow = { key: "center", label: C.CONSTRAINT_LABELS.center, hard: center.active, priority: center.priority, ok: included, shift: included ? 0 : 1 };
    }
    // 強制計測Shot: ずれは選ばれていない強制計測Shotの数
    let mandatoryRow = null;
    if (context.mandatoryItems.length > 0) {
      const selected = new Set(selectedItems);
      const included = context.mandatoryItems.filter((item) => selected.has(item)).length;
      const total = context.mandatoryItems.length;
      mandatoryRow = { key: "mandatory", label: C.CONSTRAINT_LABELS.mandatory, hard: true, priority: 0, ok: included === total, shift: total - included, included, total };
    }
    return { rows, center: centerRow, mandatory: mandatoryRow };
  }

  /** 満たし具合の行を、表に出す順（区画の制約 → 中心の1点 → 強制計測Shot）に並べる。 */
  function statusRows(status) {
    return status.rows.concat(status.center ? [status.center] : [], status.mandatory ? [status.mandatory] : []);
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
    shotIdList,
    isIncompleteShot,
    buildContext,
    forcedItemsOf,
    unconstrainedContext,
    statusRows,
    targetsFor,
    violationOf,
    hasCapacity,
    createState,
    describeStatus,
    resolveHardConstraints,
  };
})(typeof window !== "undefined" ? window : globalThis);
