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

  /**
   * 全試行で各Shot（Mark単位の選び方なら各Mark）が選ばれた割合を、段階（1〜5）と説明文にする。
   * indicesOf(set) で、試行ごとに数える番号（Shot番号かMark番号）を返す。
   */
  function selectionFrequency(sets, indicesOf) {
    const counts = new Map();
    for (const set of sets) {
      for (const index of indicesOf(set)) {
        counts.set(index, (counts.get(index) || 0) + 1);
      }
    }
    const steps = new Map();
    for (const [index, count] of counts) {
      const fraction = count / sets.length;
      steps.set(index, {
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
   * handlers: { onChoiceChange(methodKey, choice), onOpenInMapTab(methodKey, drawIndex), onExportSelection(name, set) }
   */
  function render(container, output, map, zones, choices, handlers) {
    const rankingVariant = output.variants[0];
    // 選び方の単位（Shot・Mark）ごとの前提から、選べるShot・中心の1点・強制計測Shotを出す
    const viewsByUnit = {};
    for (const [unit, context, relaxed] of [["shot", output.context, output.relaxed], ["mark", output.markContext, output.markRelaxed || []]]) {
      if (!context) {
        continue;
      }
      viewsByUnit[unit] = {
        eligibleShots: new Set(context.items.map((item) => item.shotIndex)),
        centerMarkIndex: context.center.enabled ? context.center.markIndex : null,
        mandatoryShots: new Set(context.mandatoryItems.map((item) => context.items[item].shotIndex)),
        relaxedKeys: new Set(relaxed.map((entry) => entry.key)),
        zones: context.zones || zones,
      };
    }
    const cards = [];
    let usesFrequency = false;
    let usesMarkUnit = false;

    for (const method of output.methods) {
      const sets = output.sets.filter((set) => set.method === method.key && set.results);
      if (sets.length === 0) {
        continue;
      }
      const markUnit = sets[0].unit === "mark";
      usesMarkUnit = usesMarkUnit || markUnit;
      const { eligibleShots, centerMarkIndex, mandatoryShots, relaxedKeys, zones: unitZones } = viewsByUnit[sets[0].unit];
      const labels = ASC.mapView.unitLabels(sets[0].unit);
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
          zones: unitZones,
          eligibleShots,
          selectedShots: new Set(),
          measuredMarks: new Set(),
          centerMarkIndex,
          mandatoryShots,
          editable: false,
          compact: true,
          // Mark単位は各Markが選ばれた割合をMarkの色で、Shot単位は各Shotが選ばれた割合をShotの色で示す
          shotSteps: markUnit ? null : selectionFrequency(sets, (set) => set.shotIndices),
          markSteps: markUnit ? selectionFrequency(sets, (set) => set.markIndices) : null,
          ariaLabel: `${method.label}: 全${sets.length}回の試行で各${markUnit ? "Mark" : "Shot"}が選ばれた割合`,
        });
        card.append(frame);
        card.append(
          statList([
            ["試行の数", `${sets.length}回`],
            markUnit
              ? ["選ばれたMarkの種類", `${new Set(sets.flatMap((set) => set.markIndices)).size}個`]
              : ["選ばれたShotの種類", `${new Set(sets.flatMap((set) => set.shotIndices)).size}個`],
          ])
        );
        card.append(constraintSummaryTable(output.summary[method.key].constraints));
      } else {
        const entry = choice === "single" ? { set: sets[0], index: 0 } : rankedDraws(sets, rankingVariant.key)[choice];
        const set = entry.set;
        ASC.mapView.render(frame, {
          map,
          zones: unitZones,
          eligibleShots,
          // Mark単位はShotを選んだわけではないので、Shotは塗らずに測るMarkだけを示す
          selectedShots: markUnit ? new Set() : new Set(set.shotIndices),
          measuredMarks: new Set(set.markIndices),
          largeMeasuredMarks: markUnit,
          centerMarkIndex,
          mandatoryShots,
          editable: false,
          compact: true,
          ariaLabel: `${method.label}${sets.length > 1 ? `（試行 ${entry.index + 1}）` : ""}で選んだ点のマップ`,
        });
        card.append(frame);
        const result = set.results[rankingVariant.key];
        card.append(
          statList(
            [
              ["試行", sets.length > 1 ? `${entry.index + 1}回目` : "—"],
              [`${labels.shots}・Mark数`, `${set.shotIndices.length}個・${set.markIndices.length}個`],
              [labels.spacing, `${ui.formatNumber(set.minSpacingMm, 1)} mm`],
            ]
              .concat(ASC.mapView.criteriaRows(set.criteria, output.criteriaReference))
              .concat([[`残差RMS（${rankingVariant.label}）`, `X ${ui.formatNumber(ASC.math.summarize(result.x.rms).mean)}・Y ${ui.formatNumber(ASC.math.summarize(result.y.rms).mean)} nm`]])
          )
        );
        card.append(ASC.mapView.constraintTable(set.status, relaxedKeys));
        const exportName = sets.length > 1 ? `${method.label}_試行${entry.index + 1}` : method.label;
        card.append(
          ui.create("div", { className: "button-row" }, [
            ui.create("button", {
              type: "button",
              className: "button-secondary button-small",
              text: "マップのタブで大きく見る",
              onClick: () => handlers.onOpenInMapTab(method.key, entry.index),
            }),
            ui.create("button", {
              type: "button",
              className: "button-secondary button-small",
              text: "この選択点をCSVで保存",
              "aria-label": `${method.label}${sets.length > 1 ? `（試行 ${entry.index + 1}）` : ""}の選択点をCSVで保存`,
              onClick: () => handlers.onExportSelection(exportName, set),
            }),
          ])
        );
      }
      cards.push(card);
    }

    const children = [
      ui.create("p", {
        className: "hint",
        text: `ランダム・ポアソンの「良い・悪い」は、${rankingVariant.label}の残差RMS（XとYの平均）で決めています。記号は「マップと選択点」のタブと同じです（塗りつぶしたShotが選んだShot、濃い点が測るMark、赤い輪が中心の1点、太い枠が強制計測Shot）。「この選択点をCSVで保存」は、表示中の試行の点を1行1Markで保存します。D基準 log₁₀det(XᵀX) は大きいほど、I基準（予測分散の平均÷σ²）は小さいほど良く、効率はこの評価の中で最も良い選び方を100%にした値です。制約の「ずれ」は、何個のShotを別の区画へ移せば満たせるかの目安です。`,
      }),
    ];
    if (usesMarkUnit) {
      children.push(
        ui.create("p", {
          className: "hint",
          text: "Mark単位（Shotの括りなし）の選び方は、Shotを塗らず、測るMarkだけを濃い点で示します（選ばれた割合はMarkの色）。制約は選んだMarkの数で数え、「ずれ」は何個のMarkを移せば満たせるかの目安です。",
        })
      );
    }
    if (usesFrequency) {
      children.push(ui.create("h3", { className: "subheading", text: "選ばれた割合の色" }), frequencyLegend());
    }
    children.push(ui.create("div", { className: "maps-grid" }, cards));
    container.replaceChildren(...children);
  }

  ASC.samplingMapsView = { render, rankedDraws };
})(typeof window !== "undefined" ? window : globalThis);
