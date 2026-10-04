/**
 * 手動プラン（人が選んだサンプリングShot）の管理。
 * プランはShot番号（ShotId）と「Shot番号|Mark番号」（追加Mark）で持つ。
 * マップを作り直しても同じShot番号のShotを選んだままにでき、設定JSONにもそのまま保存できる。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;

  const DEFAULT_NAME = "手動";

  function createStore() {
    return { plans: [], nextId: 1 };
  }

  function markKey(shotId, markNo) {
    return `${shotId}|${markNo}`;
  }

  /** 同じ名前があれば「名前 (2)」のように番号を付ける。 */
  function uniqueName(store, base) {
    const names = new Set(store.plans.map((plan) => plan.name));
    if (!names.has(base)) {
      return base;
    }
    for (let suffix = 2; ; suffix++) {
      const candidate = `${base} (${suffix})`;
      if (!names.has(candidate)) {
        return candidate;
      }
    }
  }

  /** プランを足す。上限を超えるときは null。 */
  function addPlan(store, name, shotIds, extraMarkKeys, included) {
    if (store.plans.length >= C.MAX_MANUAL_PLANS) {
      return null;
    }
    const id = store.nextId++;
    const plan = {
      key: `${C.MANUAL_PREFIX}${id}`,
      name: uniqueName(store, (name || `${DEFAULT_NAME}${id}`).slice(0, C.MAX_PLAN_NAME_LENGTH)),
      included: included !== false,
      shotIds: new Set(shotIds || []),
      extraMarks: new Set(extraMarkKeys || []),
    };
    store.plans.push(plan);
    return plan;
  }

  function findPlan(store, key) {
    return store.plans.find((plan) => plan.key === key) || null;
  }

  function removePlan(store, key) {
    store.plans = store.plans.filter((plan) => plan.key !== key);
  }

  function duplicatePlan(store, key) {
    const source = findPlan(store, key);
    if (!source) {
      return null;
    }
    return addPlan(store, `${source.name}の複製`, source.shotIds, source.extraMarks, source.included);
  }

  /**
   * 今のマップでの番号（Shotの並び番号・Markの並び番号）に直す。
   * マップにないShot番号は missingShotIds で返す。
   */
  function planIndices(plan, map) {
    const shotIndexById = new Map(map.shots.map((shot, index) => [shot.id, index]));
    const shotIndices = [];
    const missingShotIds = [];
    for (const shotId of plan.shotIds) {
      if (shotIndexById.has(shotId)) {
        shotIndices.push(shotIndexById.get(shotId));
      } else {
        missingShotIds.push(shotId);
      }
    }
    const extraMarkIndices = [];
    for (const key of plan.extraMarks) {
      const [shotId, markNoText] = key.split("|");
      const shotIndex = shotIndexById.get(shotId);
      if (shotIndex === undefined || !plan.shotIds.has(shotId)) {
        continue;
      }
      const markIndex = map.shots[shotIndex].markIndices.find((index) => map.marks[index].markNo === Number(markNoText));
      if (markIndex !== undefined) {
        extraMarkIndices.push(markIndex);
      }
    }
    return { shotIndices, extraMarkIndices, missingShotIds };
  }

  /** マップ上の番号でShotを足す・外す。外したShotの追加Markも外す。 */
  function toggleShot(plan, map, shotIndex) {
    const shotId = map.shots[shotIndex].id;
    if (plan.shotIds.has(shotId)) {
      plan.shotIds.delete(shotId);
      for (const key of Array.from(plan.extraMarks)) {
        if (key.startsWith(`${shotId}|`)) {
          plan.extraMarks.delete(key);
        }
      }
    } else {
      plan.shotIds.add(shotId);
    }
  }

  function toggleExtraMark(plan, map, markIndex) {
    const mark = map.marks[markIndex];
    const key = markKey(map.shots[mark.shotIndex].id, mark.markNo);
    if (plan.extraMarks.has(key)) {
      plan.extraMarks.delete(key);
    } else {
      plan.extraMarks.add(key);
    }
  }

  /** マップ上の番号の選択から、プランの中身を作り直す（評価結果をプランに写すとき）。 */
  function setFromIndices(plan, map, shotIndices, extraMarkIndices) {
    plan.shotIds = new Set(shotIndices.map((index) => map.shots[index].id));
    plan.extraMarks = new Set(
      extraMarkIndices.map((index) => {
        const mark = map.marks[index];
        return markKey(map.shots[mark.shotIndex].id, mark.markNo);
      })
    );
  }

  /** 「1, 2 3」のような文字からShot番号の一覧を取り出す（カンマ・読点・空白・改行で区切る）。 */
  function parseShotIdText(text) {
    return Array.from(new Set(text.split(/[\s,、，;]+/).map((token) => token.trim()).filter((token) => token !== "")));
  }

  /**
   * Shot番号の一覧でプランのShotを置き換える。
   * 戻り値: { unknown（マップにない番号）, applied（使った番号の数）}
   */
  function applyShotIds(plan, map, shotIds) {
    const known = new Set(map.shots.map((shot) => shot.id));
    const unknown = shotIds.filter((shotId) => !known.has(shotId));
    const applied = shotIds.filter((shotId) => known.has(shotId));
    plan.shotIds = new Set(applied);
    for (const key of Array.from(plan.extraMarks)) {
      if (!plan.shotIds.has(key.split("|")[0])) {
        plan.extraMarks.delete(key);
      }
    }
    return { unknown, applied: applied.length };
  }

  /** Shot番号を、マップのShotの並び（上の行から）にそろえた文字にする。 */
  function shotIdText(plan, map) {
    const order = new Map(map ? map.shots.map((shot, index) => [shot.id, index]) : []);
    return Array.from(plan.shotIds)
      .sort((a, b) => (order.has(a) && order.has(b) ? order.get(a) - order.get(b) : String(a).localeCompare(String(b), "ja", { numeric: true })))
      .join(", ");
  }

  /** 設定JSONに入れる形。 */
  function toJson(store) {
    return {
      plans: store.plans.map((plan) => ({
        name: plan.name,
        included: plan.included,
        shotIds: Array.from(plan.shotIds),
        marks: Array.from(plan.extraMarks).map((key) => {
          const [shotId, markNo] = key.split("|");
          return { shotId, markNo: Number(markNo) };
        }),
      })),
    };
  }

  /** 設定JSONから作り直す。以前の形（手動選択が1つ: { shotIds, marks }）も読む。 */
  function fromJson(json) {
    const store = createStore();
    if (!json) {
      return store;
    }
    const entries = Array.isArray(json.plans) ? json.plans : json.shotIds ? [{ name: `${DEFAULT_NAME}1`, included: true, shotIds: json.shotIds, marks: json.marks }] : [];
    for (const entry of entries.slice(0, C.MAX_MANUAL_PLANS)) {
      const shotIds = Array.isArray(entry.shotIds) ? entry.shotIds.map(String) : [];
      const marks = Array.isArray(entry.marks) ? entry.marks.map((mark) => markKey(String(mark.shotId), Number(mark.markNo))) : [];
      addPlan(store, typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : null, shotIds, marks, entry.included !== false);
    }
    return store;
  }

  ASC.manualPlans = {
    createStore,
    addPlan,
    findPlan,
    removePlan,
    duplicatePlan,
    uniqueName,
    planIndices,
    toggleShot,
    toggleExtraMark,
    setFromIndices,
    parseShotIdText,
    applyShotIds,
    shotIdText,
    toJson,
    fromJson,
  };
})(typeof window !== "undefined" ? window : globalThis);
