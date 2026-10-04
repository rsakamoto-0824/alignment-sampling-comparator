/**
 * 「選び方ごとのマップ」タブ。選び方ごとに選ばれた点のマップを並べて見比べる。
 * ランダム・ポアソンは試行ごとに点が変わるので、代表の試行（中央・最良・最悪）か、
 * 全試行で各Shotが選ばれた割合を表示する。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const DRAW_CHOICES = {
    median: "中央の試行（代表）",
    best: "最も良い試行",
    worst: "最も悪い試行",
    frequency: "選ばれた割合（全試行）",
  };
  const FREQUENCY_STEPS = 5;
  // 推定誤差のマップの色の上限に使うパーセント点
  const ESTIMATION_SCALE_PERCENT = 95;

  /** 試行の良し悪しを決める値: 基準の補正での残差RMSのWafer平均（XとYの平均）。 */
  function rankingValue(set, variantKey) {
    const result = set.results[variantKey];
    return (ASC.math.summarize(result.x.rms).mean + ASC.math.summarize(result.y.rms).mean) / 2;
  }

  /** 選び方の試行を良い順に並べ、中央・最良・最悪の試行を求める。 */
  function rankedDraws(sets, variantKey) {
    const ranked = sets.map((set, index) => ({ set, index, value: rankingValue(set, variantKey) })).sort((a, b) => a.value - b.value);
    return {
      best: ranked[0],
      median: ranked[Math.floor((ranked.length - 1) / 2)],
      worst: ranked[ranked.length - 1],
    };
  }

  /** 全試行で各Shotが選ばれた割合を、段階（1〜5）と説明文にする。 */
  function selectionFrequency(sets) {
    const counts = new Map();
    for (const set of sets) {
      for (const shotIndex of set.shotIndices) {
        counts.set(shotIndex, (counts.get(shotIndex) || 0) + 1);
      }
    }
    const steps = new Map();
    for (const [shotIndex, count] of counts) {
      const fraction = count / sets.length;
      steps.set(shotIndex, {
        step: Math.min(FREQUENCY_STEPS, Math.max(1, Math.ceil(fraction * FREQUENCY_STEPS))),
        text: `選ばれた割合 ${Math.round(fraction * 100)}%（${count} / ${sets.length}回）`,
      });
    }
    return steps;
  }

  /** 全試行での制約の満たし具合（満たした試行の数と、ずれの平均）。 */
  function constraintSummaryTable(constraints) {
    const rows = constraints.map((entry) =>
      ui.create("tr", null, [
        ui.create("th", { scope: "row", text: entry.label }),
        ui.create("td", null,
          ui.create("span", {
            className: entry.satisfied === entry.total ? "status-ok" : "status-ng",
            text: `${entry.satisfied === entry.total ? "✓" : "✕"} ${entry.satisfied} / ${entry.total}回で満たす`,
          })
        ),
        ui.create("td", { className: "number", text: `${ui.formatNumber(entry.meanShift, 1)}個` }),
      ])
    );
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", { className: "constraint-table" }, [
        ui.create("thead", null, ui.create("tr", null, [ui.create("th", { text: "制約" }), ui.create("th", { text: "全試行での判定" }), ui.create("th", { className: "number", text: "平均のずれ" })])),
        ui.create("tbody", null, rows),
      ])
    );
  }

  function statList(rows) {
    return ui.create("dl", { className: "stat-list" }, rows.flatMap(([term, value]) => [ui.create("dt", { text: term }), ui.create("dd", { text: value })]));
  }

  function frequencyLegend() {
    const items = [ui.create("li", null, [ui.create("span", { className: "step-swatch", style: "background:var(--map-shot)" }), "0%（選ばれなかった）"])];
    for (let step = 1; step <= FREQUENCY_STEPS; step++) {
      const low = ((step - 1) * 100) / FREQUENCY_STEPS;
      const high = (step * 100) / FREQUENCY_STEPS;
      items.push(ui.create("li", null, [ui.create("span", { className: "step-swatch", style: `background:var(--step-${step})` }), `${low}%より多く${high}%以下`]));
    }
    return ui.create("ul", { className: "step-legend", "aria-label": "選ばれた割合の色" }, items);
  }

  /**
   * タブ全体を描く。
   * choices: { 選び方: "median" | "best" | "worst" | "frequency" }（ランダム系の表示の選択）
   * handlers: { onChoiceChange(methodKey, choice), onOpenInMapTab(methodKey, drawIndex) }
   */
  function render(container, output, map, zones, choices, handlers) {
    const rankingVariant = output.variants[0];
    const context = output.context;
    const eligibleShots = new Set(context.items.map((item) => item.shotIndex));
    const centerMarkIndex = context.center.enabled ? context.center.markIndex : null;
    const cards = [];
    let usesFrequency = false;

    for (const method of output.methods) {
      const sets = output.sets.filter((set) => set.method === method.key && set.results);
      if (sets.length === 0) {
        continue;
      }
      const card = ui.create("section", { className: "map-card", "aria-label": `${method.label}で選んだ点` });
      card.append(ui.create("h3", { text: method.manual ? `${method.label}（手動プラン）` : method.label }));
      const choice = sets.length > 1 ? choices[method.key] || "median" : "single";
      if (sets.length > 1) {
        const id = `map-choice-${method.key}`;
        const select = ui.create("select", { id }, Object.entries(DRAW_CHOICES).map(([value, text]) => ui.create("option", { value, text })));
        select.value = choice;
        select.addEventListener("change", () => handlers.onChoiceChange(method.key, select.value, id));
        card.append(ui.create("div", { className: "field" }, [ui.create("label", { for: id, text: `表示する試行（全${sets.length}回）` }), select]));
      }

      const frame = ui.create("div");
      if (choice === "frequency") {
        usesFrequency = true;
        ASC.mapView.render(frame, {
          map,
          zones,
          eligibleShots,
          selectedShots: new Set(),
          measuredMarks: new Set(),
          centerMarkIndex,
          editable: false,
          extraCandidates: new Set(),
          compact: true,
          shotSteps: selectionFrequency(sets),
          ariaLabel: `${method.label}: 全${sets.length}回の試行で各Shotが選ばれた割合`,
        });
        card.append(frame);
        card.append(statList([["試行の数", `${sets.length}回`], ["選ばれたShotの種類", `${new Set(sets.flatMap((set) => set.shotIndices)).size}個`]]));
        card.append(constraintSummaryTable(output.summary[method.key].constraints));
      } else {
        const entry = choice === "single" ? { set: sets[0], index: 0 } : rankedDraws(sets, rankingVariant.key)[choice];
        const set = entry.set;
        ASC.mapView.render(frame, {
          map,
          zones,
          eligibleShots,
          selectedShots: new Set(set.shotIndices),
          measuredMarks: new Set(set.markIndices),
          centerMarkIndex,
          editable: false,
          extraCandidates: new Set(),
          compact: true,
          ariaLabel: `${method.label}${sets.length > 1 ? `（試行 ${entry.index + 1}）` : ""}で選んだ点のマップ`,
        });
        card.append(frame);
        const result = set.results[rankingVariant.key];
        card.append(
          statList(
            [
              ["試行", sets.length > 1 ? `${entry.index + 1}回目` : "—"],
              ["Shot数・Mark数", `${set.shotIndices.length}個・${set.markIndices.length}個`],
              ["Shot中心の最小間隔", `${ui.formatNumber(set.minSpacingMm, 1)} mm`],
            ]
              .concat(ASC.mapView.criteriaRows(set.criteria, output.criteriaReference))
              .concat([[`残差RMS（${rankingVariant.label}）`, `X ${ui.formatNumber(ASC.math.summarize(result.x.rms).mean)}・Y ${ui.formatNumber(ASC.math.summarize(result.y.rms).mean)} nm`]])
          )
        );
        card.append(ASC.mapView.constraintTable(set.status, new Set(output.relaxed.map((relaxedEntry) => relaxedEntry.key))));
        card.append(
          ui.create("button", {
            type: "button",
            className: "button-secondary button-small",
            text: "マップのタブで大きく見る",
            onClick: () => handlers.onOpenInMapTab(method.key, entry.index),
          })
        );
      }
      cards.push(card);
    }

    const children = [
      ui.create("p", {
        className: "hint",
        text: `ランダム・ポアソンの「良い・悪い」は、${rankingVariant.label}の残差RMS（XとYの平均）で決めています。記号は「マップと選択点」のタブと同じです（塗りつぶしたShotが選んだShot、濃い点が測るMark、赤い輪が中心の1点）。D基準 log₁₀det(XᵀX) は大きいほど、I基準（予測分散の平均÷σ²）は小さいほど良く、効率はこの評価の中で最も良い選び方を100%にした値です。制約の「ずれ」は、何個のShotを別の区画へ移せば満たせるかの目安です。`,
      }),
    ];
    if (usesFrequency) {
      children.push(ui.create("h3", { className: "subheading", text: "選ばれた割合の色" }), frequencyLegend());
    }
    children.push(ui.create("div", { className: "maps-grid" }, cards));
    container.replaceChildren(...children);
  }

  /**
   * 推定誤差のマップ（選び方を1つ、推定手法ごとに並べる）。
   * ランダム系は中央の試行を使う。色は全マップ共通の5段階（最大値を5等分）で、計測Markは黒い点。
   */
  function renderEstimationMaps(output, methodKey, axis) {
    const sets = output.sets.filter((set) => set.method === methodKey && set.estimationSquares);
    if (sets.length === 0) {
      return ui.create("p", { className: "hint", text: "推定誤差のマップを出せる結果がありません。" });
    }
    const entry = sets.length > 1 ? rankedDraws(sets, output.variants[0].key).median : { set: sets[0], index: 0 };
    const set = entry.set;
    const map = output.map;
    const waferCount = output.waferCount;
    const keys = output.estimationKeys.filter((key) => set.estimationSquares[key]);
    const perKey = keys.map((key) => {
      const squares = set.estimationSquares[key][axis];
      const rms = Array.from(squares, (value) => (Number.isFinite(value) ? Math.sqrt(value / waferCount) : NaN));
      return { key, rms };
    });
    // 色の目盛りの上限は、全マップの値の95%点にする（一部の大きな誤差に引っぱられて全体が薄くならないように）
    const allValues = perKey.flatMap((entryRms) => entryRms.rms.filter(Number.isFinite)).sort((a, b) => a - b);
    const maximum = allValues.length > 0 ? ASC.math.percentileOfSorted(allValues, ESTIMATION_SCALE_PERCENT) : 0;
    const context = output.context;
    const eligibleShots = new Set(context.items.map((item) => item.shotIndex));
    const cards = perKey.map(({ key, rms }) => {
      const markSteps = new Map();
      const finite = [];
      rms.forEach((value, markIndex) => {
        if (Number.isFinite(value)) {
          finite.push(value);
          const step = maximum > 0 ? Math.min(FREQUENCY_STEPS, Math.max(1, Math.ceil((value / maximum) * FREQUENCY_STEPS))) : 1;
          markSteps.set(markIndex, { step, text: `推定誤差RMS ${ui.formatNumber(value)} nm` });
        }
      });
      const frame = ui.create("div");
      ASC.mapView.render(frame, {
        map,
        zones: output.zones,
        eligibleShots,
        selectedShots: new Set(),
        measuredMarks: new Set(set.markIndices),
        centerMarkIndex: null,
        editable: false,
        extraCandidates: new Set(),
        compact: true,
        markSteps,
        ariaLabel: `${ASC.evaluator.estimationLabel(key)}の推定誤差のマップ`,
      });
      const overall = Math.sqrt(finite.reduce((sum, value) => sum + value * value, 0) / Math.max(finite.length, 1));
      return ui.create("section", { className: "map-card", "aria-label": `${ASC.evaluator.estimationLabel(key)}の推定誤差` }, [
        ui.create("h3", { text: ASC.evaluator.estimationLabel(key) }),
        frame,
        statList([
          ["未計測Mark全体のRMS", `${ui.formatNumber(overall)} nm`],
          ["Markごとの最大", `${ui.formatNumber(Math.max(...finite))} nm`],
        ]),
      ]);
    });
    const legendItems = [ui.create("li", null, [ui.create("span", { className: "step-swatch", style: "background:var(--map-mark-measured)" }), "計測したMark（小さい点。推定の対象外）"])];
    for (let step = 1; step <= FREQUENCY_STEPS; step++) {
      const low = (maximum * (step - 1)) / FREQUENCY_STEPS;
      const high = (maximum * step) / FREQUENCY_STEPS;
      const text = step === FREQUENCY_STEPS ? `${ui.formatNumber(low, 2)} nm 以上` : `${ui.formatNumber(low, 2)}〜${ui.formatNumber(high, 2)} nm`;
      legendItems.push(ui.create("li", null, [ui.create("span", { className: "step-swatch", style: `background:var(--step-${step})` }), text]));
    }
    return ui.create("div", null, [
      ui.create("p", {
        className: "hint",
        text: `${sets.length > 1 ? `試行 ${entry.index + 1}（中央の試行）` : "選んだ点"}で、未計測Markごとに全${waferCount}枚の推定誤差をRMSにしたものです（軸 ${axis.toUpperCase()}）。色が濃いほど推定を外しています。色の上限は全マップの値の${ESTIMATION_SCALE_PERCENT}%点で、それより大きいMarkは一番濃い色です。各Markにポインターを合わせると値が出ます。`,
      }),
      ui.create("ul", { className: "step-legend", "aria-label": "推定誤差の色" }, legendItems),
      ui.create("div", { className: "maps-grid" }, cards),
    ]);
  }

  ASC.samplingMapsView = { render, renderEstimationMaps, rankedDraws };
})(typeof window !== "undefined" ? window : globalThis);
