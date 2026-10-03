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

    for (const method of C.METHODS) {
      const sets = output.sets.filter((set) => set.method === method.key && set.results);
      if (sets.length === 0) {
        continue;
      }
      const card = ui.create("section", { className: "map-card", "aria-label": `${method.label}で選んだ点` });
      card.append(ui.create("h3", { text: method.label }));
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
          statList([
            ["試行", sets.length > 1 ? `${entry.index + 1}回目` : "—"],
            ["Shot数・Mark数", `${set.shotIndices.length}個・${set.markIndices.length}個`],
            ["κ（X・Y）", `${ui.formatNumber(set.kappaX)}・${ui.formatNumber(set.kappaY)}`],
            ["Shot中心の最小間隔", `${ui.formatNumber(set.minSpacingMm, 1)} mm`],
            [`残差RMS（${rankingVariant.label}）`, `X ${ui.formatNumber(ASC.math.summarize(result.x.rms).mean)}・Y ${ui.formatNumber(ASC.math.summarize(result.y.rms).mean)} nm`],
          ])
        );
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
        text: `ランダム・ポアソンの「良い・悪い」は、${rankingVariant.label}の残差RMS（XとYの平均）で決めています。記号は「マップと選択点」のタブと同じです（塗りつぶしたShotが選んだShot、黒い点が測るMark、赤い輪が中心の1点）。`,
      }),
    ];
    if (usesFrequency) {
      children.push(ui.create("h3", { className: "subheading", text: "選ばれた割合の色" }), frequencyLegend());
    }
    children.push(ui.create("div", { className: "maps-grid" }, cards));
    container.replaceChildren(...children);
  }

  ASC.samplingMapsView = { render };
})(typeof window !== "undefined" ? window : globalThis);
