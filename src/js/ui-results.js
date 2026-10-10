/**
 * 評価結果の表示（一覧表・箱ひげ図・表）とCSVの書き出し。
 * 比べる補正は「HOWAのみ」と「推定→HOWA × 推定手法」。色は推定手法ごとに固定する
 * （推定手法を減らしても、残った手法の色は変えない）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const METRIC_LABELS = { rms: "RMS", mean3sigma: "|平均|+3σ", max: "最大" };
  const AXIS_LABELS = { x: "X", y: "Y" };
  // 推定手法ごとの色。"howa" は HOWAのみ（推定精度では多項式の予測）
  const SERIES_COLORS = {
    howa: "var(--series-1)",
    rbfXY: "var(--series-2)",
    rbfXYR: "var(--series-3)",
    gpXY: "var(--series-4)",
    gpXYR: "var(--series-5)",
  };
  const BASELINE_KEY = "allMarks";
  const BASELINE_LABEL = "全点計測（基準）";
  // 一覧表の色の段階（値が大きいほど濃い）
  const HEAT_STEPS = 5;

  // 箱ひげ図の寸法（SVGの単位）
  const CHART_WIDTH = 880;
  const GROUP_LABEL_WIDTH = 150;
  const ROW_LABEL_WIDTH = 150;
  const RIGHT_PADDING = 24;
  const TOP_PADDING = 28;
  const AXIS_HEIGHT = 44;
  const ROW_HEIGHT = 22;
  const GROUP_GAP = 16;
  const BOX_HEIGHT = 12;

  // 描いている結果の選び方の一覧（自動の選び方と手動プラン）。render で入れる
  let methodsInView = [];

  /** 表やグラフに出す選び方の名前。手動プランは自動の選び方と見分けられるように「（手動）」を添える。 */
  function displayName(method) {
    return method.manual ? `${method.label}（手動）` : method.label;
  }

  function methodLabel(key) {
    if (key === BASELINE_KEY) {
      return BASELINE_LABEL;
    }
    const method = methodsInView.find((entry) => entry.key === key);
    return method ? displayName(method) : key;
  }

  function seriesColor(variant) {
    return SERIES_COLORS[variant.estimator ? variant.estimator.key : "howa"];
  }

  /** 箱ひげ図の行に添える短い名前（推定手法を見分ける）。 */
  function rowLabel(variant) {
    return variant.estimator ? variant.estimator.label : "HOWAのみ";
  }

  /** 1・2・5 の倍数のきれいな目盛り。 */
  function niceTicks(maximum) {
    if (!(maximum > 0)) {
      return { max: 1, ticks: [0, 0.5, 1] };
    }
    const rough = maximum / 5;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough);
    const max = Math.ceil(maximum / step) * step;
    const ticks = [];
    for (let value = 0; value <= max + step * 1e-9; value += step) {
      ticks.push(Math.round(value / step) * step);
    }
    return { max, ticks };
  }

  function baselineStats(output, axis, metric) {
    return ASC.evaluator.summarizeStore(output.baselines.allMarks.howa)[axis][metric];
  }

  /** 箱ひげ図の1行。group は選び方、row は補正や推定手法。 */
  function chartRow(methodKey, rowText, fullLabel, color, stats) {
    return { method: methodKey, rowLabel: rowText, fullLabel, color, stats };
  }

  /** 残差の箱ひげ図に並べる行（選び方 × 補正）。最後に全点計測の基準を置く。 */
  function chartGroups(output, variants, metric, axis) {
    const groups = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      groups.push({
        method: method.key,
        rows: variants.map((variant) => chartRow(method.key, rowLabel(variant), variant.label, seriesColor(variant), summary.variants[variant.key][axis][metric].all)),
      });
    }
    groups.push({
      method: BASELINE_KEY,
      rows: [chartRow(BASELINE_KEY, "HOWAのみ", "HOWAのみ", SERIES_COLORS.howa, baselineStats(output, axis, metric))],
    });
    return groups;
  }

  /** 推定精度の箱ひげ図に並べる行（選び方 × 推定手法）。 */
  function estimationGroups(output, metric, axis) {
    const groups = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      const keys = output.estimationKeys.filter((key) => summary.estimation[key]);
      groups.push({
        method: method.key,
        rows: keys.map((key) => chartRow(method.key, estimationRowLabel(key), ASC.evaluator.estimationLabel(key), SERIES_COLORS[key], summary.estimation[key][axis][metric].all)),
      });
    }
    return groups;
  }

  function estimationRowLabel(key) {
    return key === "howa" ? "HOWA（多項式）" : ASC.evaluator.estimationLabel(key);
  }

  /**
   * 横向きの箱ひげ図。groups: [{ method, rows: [{ rowLabel, fullLabel, color, stats }] }]
   * legendItems: [{ label, color }]、axisTitle: 横軸の説明、ariaLabel: 図の説明
   */
  function renderChart(container, groups, legendItems, axisTitle, ariaLabel) {
    const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
    const height = TOP_PADDING + rowCount * ROW_HEIGHT + (groups.length - 1) * GROUP_GAP + AXIS_HEIGHT;
    let maximum = 0;
    for (const group of groups) {
      for (const row of group.rows) {
        if (Number.isFinite(row.stats.p95)) {
          maximum = Math.max(maximum, row.stats.p95);
        }
      }
    }
    const scale = niceTicks(maximum * 1.05);
    const plotLeft = GROUP_LABEL_WIDTH + ROW_LABEL_WIDTH;
    const plotWidth = CHART_WIDTH - plotLeft - RIGHT_PADDING;
    const xOf = (value) => plotLeft + (Math.min(value, scale.max) / scale.max) * plotWidth;
    const plotBottom = height - AXIS_HEIGHT;

    const svg = ui.createSvg("svg", { viewBox: `0 0 ${CHART_WIDTH} ${height}`, role: "img", "aria-label": ariaLabel });
    for (const tick of scale.ticks) {
      const x = xOf(tick);
      svg.append(ui.createSvg("line", { className: "chart-gridline", x1: x, y1: TOP_PADDING - 8, x2: x, y2: plotBottom }));
      svg.append(ui.createSvg("text", { className: "chart-tick", x, y: plotBottom + 18, "text-anchor": "middle", text: formatTick(tick) }));
    }
    svg.append(
      ui.createSvg("text", {
        className: "chart-tick",
        x: plotLeft + plotWidth / 2,
        y: plotBottom + 38,
        "text-anchor": "middle",
        text: axisTitle,
      })
    );

    let y = TOP_PADDING;
    const tooltip = ui.byId("chart-tooltip");
    groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        y += GROUP_GAP;
        svg.append(ui.createSvg("line", { className: "chart-gridline", x1: 0, y1: y - GROUP_GAP / 2, x2: CHART_WIDTH, y2: y - GROUP_GAP / 2 }));
      }
      const groupTop = y;
      for (const row of group.rows) {
        // 4系列以上は色だけで見分けにくいので、行ごとに名前を添える
        svg.append(
          ui.createSvg("text", {
            className: "chart-row-label",
            x: plotLeft - 10,
            y: y + ROW_HEIGHT / 2,
            "text-anchor": "end",
            "dominant-baseline": "central",
            text: row.rowLabel,
          })
        );
        if (Number.isFinite(row.stats.median)) {
          svg.append(drawBox(row, y, xOf, tooltip));
        } else {
          svg.append(ui.createSvg("text", { className: "chart-tick", x: xOf(0) + 4, y: y + ROW_HEIGHT / 2, "dominant-baseline": "central", text: "計算できませんでした" }));
        }
        y += ROW_HEIGHT;
      }
      svg.append(
        ui.createSvg("text", {
          className: "chart-label",
          x: 4,
          y: (groupTop + y) / 2,
          "dominant-baseline": "central",
          text: methodLabel(group.method),
        })
      );
    });

    const legend = ui.create(
      "ul",
      { className: "chart-legend", "aria-label": "凡例" },
      legendItems.map((item) => ui.create("li", null, [ui.create("span", { className: "chart-swatch", style: `background:${item.color}` }), item.label]))
    );
    container.replaceChildren(legend, ui.create("div", { className: "chart-frame" }, svg));
  }

  function formatTick(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3)));
  }

  /** 1本の箱ひげ。箱は25〜75%点、線は5〜95%点、白い縦線は中央値。 */
  function drawBox(row, top, xOf, tooltip) {
    const stats = row.stats;
    const center = top + ROW_HEIGHT / 2;
    const color = row.color;
    const label = `${methodLabel(row.method)}・${row.fullLabel}`;
    const group = ui.createSvg("g", {
      className: "chart-box",
      tabindex: "0",
      "aria-label": `${label}: 中央値 ${ui.formatNumber(stats.median)} nm、平均 ${ui.formatNumber(stats.mean)} nm、95%点 ${ui.formatNumber(stats.p95)} nm`,
    });
    // 当たり判定は箱より大きくする
    group.append(ui.createSvg("rect", { x: xOf(0), y: top, width: xOf(Infinity) - xOf(0), height: ROW_HEIGHT, fill: "transparent" }));
    group.append(ui.createSvg("line", { x1: xOf(stats.p5), y1: center, x2: xOf(stats.p95), y2: center, stroke: color, "stroke-width": 2, "stroke-linecap": "round" }));
    for (const value of [stats.p5, stats.p95]) {
      group.append(ui.createSvg("line", { x1: xOf(value), y1: center - 4, x2: xOf(value), y2: center + 4, stroke: color, "stroke-width": 2 }));
    }
    const boxLeft = xOf(stats.p25);
    group.append(
      ui.createSvg("rect", { x: boxLeft, y: center - BOX_HEIGHT / 2, width: Math.max(2, xOf(stats.p75) - boxLeft), height: BOX_HEIGHT, rx: 2, fill: color })
    );
    group.append(
      ui.createSvg("line", {
        x1: xOf(stats.median),
        y1: center - BOX_HEIGHT / 2,
        x2: xOf(stats.median),
        y2: center + BOX_HEIGHT / 2,
        stroke: "var(--surface-1)",
        "stroke-width": 2,
      })
    );
    const show = (clientX, clientY) => {
      tooltip.replaceChildren(
        ui.create("strong", { text: `中央値 ${ui.formatNumber(stats.median)} nm` }),
        ui.create("div", { text: label }),
        ui.create("div", { text: `平均 ${ui.formatNumber(stats.mean)}、25〜75% ${ui.formatNumber(stats.p25)}〜${ui.formatNumber(stats.p75)}` }),
        ui.create("div", { text: `5〜95% ${ui.formatNumber(stats.p5)}〜${ui.formatNumber(stats.p95)}、最大 ${ui.formatNumber(stats.max)}` })
      );
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(clientX + 14, window.innerWidth - 330)}px`;
      tooltip.style.top = `${clientY + 14}px`;
    };
    const hide = () => {
      tooltip.hidden = true;
    };
    group.addEventListener("pointermove", (event) => show(event.clientX, event.clientY));
    group.addEventListener("pointerleave", hide);
    group.addEventListener("focus", () => {
      const rect = group.getBoundingClientRect();
      show(rect.left + rect.width / 2, rect.bottom);
    });
    group.addEventListener("blur", hide);
    return group;
  }

  // ---- 表 ------------------------------------------------------------------

  function table(headers, rows) {
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, headers.map((header) => ui.create("th", { className: header.number ? "number" : null, text: header.text })))),
        ui.create("tbody", null,
          rows.map((cells) =>
            ui.create("tr", null, cells.map((cell, index) => ui.create("td", { className: headers[index].number ? "number" : null, text: cell })))
          )
        ),
      ])
    );
  }

  /**
   * 段階色の表: 行 × 列の値。値が大きいほど濃い色にし、行ごとに最も小さい値に ★ を付ける。
   * rows: [{ label, values }]
   */
  function heatTable(columnLabels, rows, firstHeader) {
    let maximum = 0;
    for (const row of rows) {
      for (const value of row.values) {
        if (Number.isFinite(value)) {
          maximum = Math.max(maximum, value);
        }
      }
    }
    const headRow = ui.create("tr", null, [ui.create("th", { text: firstHeader })].concat(columnLabels.map((label) => ui.create("th", { className: "number", text: label }))));
    const body = ui.create("tbody");
    for (const row of rows) {
      const finite = row.values.filter(Number.isFinite);
      const best = finite.length > 0 ? Math.min(...finite) : NaN;
      const cells = [ui.create("th", { scope: "row", text: row.label })];
      row.values.forEach((value) => {
        const step = Number.isFinite(value) && maximum > 0 ? Math.min(HEAT_STEPS, Math.max(1, Math.ceil((value / maximum) * HEAT_STEPS))) : 0;
        const isBest = Number.isFinite(value) && value === best;
        cells.push(
          ui.create("td", {
            className: `number heat-cell${step ? ` heat-${step}` : ""}${isBest ? " heat-best" : ""}`,
            text: `${isBest ? "★ " : ""}${ui.formatNumber(value)}`,
          })
        );
      });
      body.append(ui.create("tr", null, cells));
    }
    return ui.create("div", { className: "table-scroll" }, ui.create("table", { className: "heat-table" }, [ui.create("thead", null, headRow), body]));
  }

  /** 一覧表: 選び方 × 補正の平均。 */
  function renderOverviewTable(output, view) {
    const rows = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (summary) {
        rows.push({ label: displayName(method), values: output.variants.map((variant) => summary.variants[variant.key][view.axis][view.metric].all.mean) });
      }
    }
    const baseline = baselineStats(output, view.axis, view.metric).mean;
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected)[view.axis][view.metric].mean;
    return [
      heatTable(output.variants.map((variant) => variant.label), rows, "選び方"),
      ui.create("p", {
        className: "hint",
        text: `★ はその選び方で最も小さい値です。色が濃いほど残差が大きいことを表します。参考: 全点計測（HOWAのみ）${ui.formatNumber(baseline)} nm、補正なし ${ui.formatNumber(uncorrected)} nm。`,
      }),
    ];
  }

  /** 推定精度の一覧表: 選び方 × 推定手法（と多項式の予測）の平均。 */
  function renderEstimationTable(output, view) {
    const keys = output.estimationKeys;
    const rows = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (summary) {
        rows.push({ label: displayName(method), values: keys.map((key) => (summary.estimation[key] ? summary.estimation[key][view.axis][view.metric].all.mean : NaN)) });
      }
    }
    return heatTable(keys.map((key) => ASC.evaluator.estimationLabel(key)), rows, "選び方");
  }

  function renderSummaryTable(output, variants, view) {
    const headers = [
      { text: "選び方" },
      { text: "補正" },
      { text: "平均", number: true },
      { text: "中央値", number: true },
      { text: "95%点", number: true },
      { text: "最大", number: true },
    ];
    const rows = [];
    for (const group of chartGroups(output, variants, view.metric, view.axis)) {
      for (const row of group.rows) {
        rows.push([
          methodLabel(row.method),
          row.fullLabel,
          ui.formatNumber(row.stats.mean),
          ui.formatNumber(row.stats.median),
          ui.formatNumber(row.stats.p95),
          ui.formatNumber(row.stats.max),
        ]);
      }
    }
    return table(headers, rows);
  }

  /** ガウス過程回帰がWaferごとに学習した値（相関の長さ・ノイズ比）の中央値。 */
  function renderGpTable(output) {
    const gpVariants = output.variants.filter((variant) => variant.estimator && variant.estimator.type === "gp");
    if (gpVariants.length === 0) {
      return null;
    }
    const headers = [
      { text: "選び方" },
      { text: "補正" },
      { text: "相関の長さ 中央値 [mm]", number: true },
      { text: "相関の長さ 5〜95%点 [mm]", number: true },
      { text: "ノイズ比 中央値", number: true },
    ];
    const rows = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const variant of gpVariants) {
        const choice = summary.gpChoices[variant.key];
        if (!choice || choice.lengthMm.count === 0) {
          continue;
        }
        rows.push([
          displayName(method),
          variant.label,
          ui.formatNumber(choice.lengthMm.median, 1),
          `${ui.formatNumber(choice.lengthMm.p5, 1)}〜${ui.formatNumber(choice.lengthMm.p95, 1)}`,
          Number.isFinite(choice.noiseRatio.median) ? choice.noiseRatio.median.toExponential(1) : "—",
        ]);
      }
    }
    return table(headers, rows);
  }

  /**
   * 選んだ点の性質: 数・間隔と、D基準・I基準（試行の平均）と効率。
   * 効率は、この評価の中で最も良い選び方・試行を100%にした値（D効率 = (det/det最良)^(1/p)、I効率 = 最良の予測分散 ÷ 予測分散）。
   */
  function renderMethodTable(output) {
    const axes = output.criteriaSameTerms ? [["", "x"]] : [["X ", "x"], ["Y ", "y"]];
    const headers = [{ text: "選び方" }, { text: "選んだ回数" }, { text: "Shot数", number: true }, { text: "Mark数", number: true }, { text: "最小間隔 [mm]", number: true }];
    for (const [prefix] of axes) {
      headers.push(
        { text: `${prefix}D基準 log₁₀det`, number: true },
        { text: `${prefix}D効率`, number: true },
        { text: `${prefix}I基準（κ²）`, number: true },
        { text: `${prefix}I効率`, number: true }
      );
    }
    const rows = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      const cells = [
        displayName(method),
        `${summary.drawCount}回`,
        ui.formatNumber(summary.shotCount.mean, 0),
        ui.formatNumber(summary.markCount.mean, 0),
        ui.formatNumber(summary.minSpacingMm.mean, 1),
      ];
      for (const [, axis] of axes) {
        const criteria = summary[`criteria${axis.toUpperCase()}`];
        const reference = output.criteriaReference[axis];
        if (criteria.singularCount > 0) {
          cells.push(`計算できない（${criteria.singularCount}回。点が足りないか偏っている）`, "—", "—", "—");
          continue;
        }
        // 試行の平均（log det は平均、予測分散も平均）から効率を出す
        const mean = { logDet: criteria.logDet.mean, trace: criteria.trace.mean, p: criteriaTermCount(output, axis), singular: false };
        const efficiency = reference ? ASC.sampling.efficiencies(mean, reference) : { d: NaN, i: NaN };
        cells.push(
          ui.formatNumber(ASC.mapView.log10Det(criteria.logDet.mean), 2),
          Number.isFinite(efficiency.d) ? `${ui.formatNumber(efficiency.d, 0)}%` : "—",
          ui.formatNumber(criteria.trace.mean, 3),
          Number.isFinite(efficiency.i) ? `${ui.formatNumber(efficiency.i, 0)}%` : "—"
        );
      }
      rows.push(cells);
    }
    return table(headers, rows);
  }

  /** 軸ごとの多項式の項数（D効率の計算に使う）。 */
  function criteriaTermCount(output, axis) {
    const set = output.sets.find((entry) => entry.criteria);
    return set ? set.criteria[axis].p : 1;
  }

  /** 制約の満たし具合: 選び方 × 制約。満たした回数と、ずれ（移せば満たせるShot数）の平均。 */
  function renderConstraintSummaryTable(output) {
    const first = output.methods.map((method) => output.summary[method.key]).find((summary) => summary && summary.constraints.length > 0);
    if (!first) {
      return null;
    }
    const relaxedKeys = new Set(output.relaxed.map((entry) => entry.key));
    const kindText = (entry) => (entry.hard ? "ハード" : relaxedKeys.has(entry.key) ? "ソフトに切替" : "ソフト");
    const headRow = ui.create("tr", null, [ui.create("th", { text: "選び方" })].concat(first.constraints.map((entry) => ui.create("th", { text: `${entry.label}（${kindText(entry)}）` }))));
    const body = ui.create("tbody");
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      const cells = [ui.create("th", { scope: "row", text: displayName(method) })];
      for (const entry of summary.constraints) {
        const ok = entry.satisfied === entry.total;
        const text = ok ? `✓ ${entry.satisfied} / ${entry.total}回` : `✕ ${entry.satisfied} / ${entry.total}回（平均 ${ui.formatNumber(entry.meanShift, 1)}個ずれ）`;
        cells.push(ui.create("td", null, ui.create("span", { className: ok ? "status-ok" : "status-ng", text })));
      }
      body.append(ui.create("tr", null, cells));
    }
    return ui.create("div", { className: "table-scroll" }, ui.create("table", { className: "constraint-table" }, [ui.create("thead", null, headRow), body]));
  }

  function renderDrawTable(output, variants, view) {
    const headers = [
      { text: "選び方" },
      { text: "補正" },
      { text: "最も良い試行", number: true },
      { text: "中央の試行", number: true },
      { text: "最も悪い試行", number: true },
    ];
    const rows = [];
    for (const method of output.methods.filter((entry) => entry.usesDraws)) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const variant of variants) {
        const perDraw = summary.variants[variant.key][view.axis][view.metric].perDraw;
        rows.push([displayName(method), variant.label, ui.formatNumber(perDraw.min), ui.formatNumber(perDraw.median), ui.formatNumber(perDraw.max)]);
      }
    }
    return rows.length > 0 ? table(headers, rows) : null;
  }

  function selectField(id, label, options, value, onChange) {
    const select = ui.create("select", { id }, options.map(([optionValue, text]) => ui.create("option", { value: optionValue, text })));
    select.value = value;
    select.addEventListener("change", () => onChange(select.value));
    return ui.create("div", { className: "field" }, [ui.create("label", { for: id, text: label }), select]);
  }

  /**
   * 結果の画面全体を描く。
   * handlers: { onViewChange(change, focusId), onExportResults(), onExportSelections() }
   */
  function render(container, output, view, handlers, isStale) {
    methodsInView = output.methods;
    const children = [];
    if (isStale) {
      children.push(notice("warning", "⚠", "結果を出したあとで設定が変わりました。今の設定で比べるには、もう一度「評価を実行」を押してください。"));
    }
    if (output.relaxed.length > 0) {
      children.push(
        notice(
          "warning",
          "⚠",
          "次のハード制約は同時に満たせなかったため、ソフト制約として扱いました。",
          output.relaxed.map((entry) => `${entry.label}: ${entry.reason}`)
        )
      );
    }
    if (output.failedMethods && output.failedMethods.length > 0) {
      children.push(
        notice("warning", "⚠", "次の選び方は、制約（強制計測Shotを含む）を満たす点を選べなかったため、結果にありません。計測Shot数や制約を見直してください。", output.failedMethods)
      );
    }
    const warnings = Array.from(new Set(output.sets.flatMap((set) => set.warnings)));
    if (warnings.length > 0) {
      children.push(notice("warning", "⚠", "計算の注意", warnings));
    }

    children.push(
      ui.create("div", { className: "toolbar" }, [
        selectField("result-metric", "指標", Object.entries(METRIC_LABELS), view.metric, (value) => handlers.onViewChange({ metric: value }, "result-metric")),
        selectField("result-axis", "軸", Object.entries(AXIS_LABELS), view.axis, (value) => handlers.onViewChange({ axis: value }, "result-axis")),
        ui.create("button", { type: "button", className: "button-secondary", text: "結果をCSVで保存", onClick: handlers.onExportResults }),
        ui.create("button", { type: "button", className: "button-secondary", text: "選択点をCSVで保存", onClick: handlers.onExportSelections }),
      ])
    );

    children.push(ui.create("h2", { className: "subheading", text: `一覧（${METRIC_LABELS[view.metric]}・${AXIS_LABELS[view.axis]} のWafer平均、単位 nm）` }));
    children.push(...renderOverviewTable(output, view));

    const variants = output.variants;
    children.push(ui.create("h2", { className: "subheading", text: `残差の分布（Wafer ${output.waferCount}枚、ランダム系は全試行をまとめたもの）` }));
    const chartContainer = ui.create("div");
    renderChart(
      chartContainer,
      chartGroups(output, variants, view.metric, view.axis),
      variants.map((variant) => ({ label: variant.label, color: seriesColor(variant) })),
      `Waferごとの残差 ${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）[nm]`,
      `選び方と補正ごとの残差${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）の箱ひげ図。数値は下の表にもあります。`
    );
    children.push(chartContainer);
    children.push(ui.create("p", { className: "hint", text: "箱は25〜75%点、線は5〜95%点、箱の中の縦線は中央値です。箱にポインターを合わせるか、Tabキーで選ぶと数値が出ます。" }));

    children.push(ui.create("h2", { className: "subheading", text: `数値の表（${METRIC_LABELS[view.metric]}・${AXIS_LABELS[view.axis]}、単位 nm）` }));
    children.push(renderSummaryTable(output, variants, view));
    if (output.estimationKeys.length > 1) {
      children.push(...renderEstimationSection(output, view, handlers));
    }
    const gpTable = renderGpTable(output);
    if (gpTable) {
      children.push(ui.create("h2", { className: "subheading", text: "GPが学習した値（Waferごと・X/Yごとに学習した値の分布）" }));
      children.push(gpTable);
      const shortestMm = C.GP_LENGTH_SCALE_MIN * C.NORMALIZATION_RADIUS_MM;
      children.push(
        ui.create("p", {
          className: "hint",
          text: `ノイズ比は「ノイズの分散 ÷ 信号の分散」です。探索範囲の端（相関の長さ ${shortestMm} mm・ノイズ比 ${C.GP_NOISE_RATIO_MAX}）に張り付くときは、計測点から空間的なつながりが読み取れず、推定がほぼ1次式だけになっています。`,
        })
      );
    }
    children.push(ui.create("h2", { className: "subheading", text: "選んだ点の性質（D基準・I基準）" }));
    children.push(renderMethodTable(output));
    children.push(
      ui.create("p", {
        className: "hint",
        text: "D基準 log₁₀det(XᵀX) は大きいほど多項式の係数の推定精度が良く、I基準（予測分散の平均÷σ²＝κ²）は小さいほど全Markの補正量にノイズが乗りにくい選び方です（HOWAの多項式に対して）。効率はこの評価の中で最も良い選び方・試行を100%にした値です。D基準の値そのものは座標の尺度で決まる負の数になることがあるので、選び方どうしの差や効率で比べてください。値は試行の平均です。",
      })
    );
    const constraintTable = renderConstraintSummaryTable(output);
    if (constraintTable) {
      children.push(ui.create("h2", { className: "subheading", text: "制約の満たし具合" }));
      children.push(constraintTable);
      children.push(ui.create("p", { className: "hint", text: "満たした回数は試行の数のうちいくつで満たしたか、ずれは何個のShotを別の区画へ移せば満たせるかの目安です（強制計測Shotは選ばれていない数）。制約なしのD最適・I最適と手動プランは制約を守らないので、外れることがあります。" }));
    }
    const drawTable = renderDrawTable(output, variants, view);
    if (drawTable) {
      children.push(ui.create("h2", { className: "subheading", text: "試行ごとのばらつき（試行ごとのWafer平均）" }));
      children.push(drawTable);
    }
    container.replaceChildren(...children);
  }

  /**
   * 推定精度の節: 未計測Markでの「推定値 − 真のずれ」。一覧表、箱ひげ図、誤差のマップ。
   */
  function renderEstimationSection(output, view, handlers) {
    const children = [];
    children.push(ui.create("h2", { className: "subheading", text: `推定精度（未計測Markでの 推定値 − 真のずれ、${METRIC_LABELS[view.metric]}・${AXIS_LABELS[view.axis]}、Wafer平均、単位 nm）` }));
    children.push(
      ui.create("p", {
        className: "hint",
        text: "計測値（ノイズを含む）から推定した未計測Markの値を、ノイズのない真のずれと比べます。「HOWA（多項式の予測）」は、計測Markに当てはめた多項式で未計測Markを予測した場合で、推定手法を使う意味があるかの基準です。",
      })
    );
    children.push(renderEstimationTable(output, view));
    const keys = output.estimationKeys;
    const chartContainer = ui.create("div");
    renderChart(
      chartContainer,
      estimationGroups(output, view.metric, view.axis),
      keys.map((key) => ({ label: ASC.evaluator.estimationLabel(key), color: SERIES_COLORS[key] })),
      `Waferごとの推定誤差 ${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}、未計測Mark）[nm]`,
      `選び方と推定手法ごとの推定誤差${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）の箱ひげ図。数値は上の表にもあります。`
    );
    children.push(chartContainer);

    // 誤差のマップ: 選び方を1つ選び、推定手法ごとにMarkの誤差（Waferで2乗平均）を並べる
    const methods = output.methods.filter((method) => output.summary[method.key]);
    const methodKey = methods.some((method) => method.key === view.estimationMapMethod) ? view.estimationMapMethod : methods[0].key;
    children.push(ui.create("h3", { className: "subheading", text: "推定誤差のマップ（Markごとに、全WaferのRMS）" }));
    children.push(
      ui.create("div", { className: "toolbar" }, [
        selectField("estimation-map-method", "選び方", methods.map((method) => [method.key, displayName(method)]), methodKey, (value) =>
          handlers.onViewChange({ estimationMapMethod: value }, "estimation-map-method")
        ),
      ])
    );
    children.push(ASC.samplingMapsView.renderEstimationMaps(output, methodKey, view.axis));
    return children;
  }

  function notice(type, icon, title, items) {
    const body = ui.create("div", null, [ui.create("strong", { text: title })]);
    if (items && items.length > 0) {
      body.append(ui.create("ul", null, items.map((item) => ui.create("li", { text: item }))));
    }
    return ui.create("div", { className: `notice notice-${type}` }, [ui.create("span", { className: "notice-icon", "aria-hidden": "true", text: icon }), body]);
  }

  // ---- CSV -----------------------------------------------------------------

  function resultsCsv(output) {
    methodsInView = output.methods;
    const header = ["Method", "Correction", "Axis", "Metric", "Mean", "Median", "P5", "P25", "P75", "P95", "Max", "Count"];
    const lines = [header.join(",")];
    const push = (methodName, variantName, axis, metric, stats) => {
      lines.push(
        [methodName, variantName, AXIS_LABELS[axis], METRIC_LABELS[metric], stats.mean, stats.median, stats.p5, stats.p25, stats.p75, stats.p95, stats.max, stats.count]
          .map(ui.csvCell)
          .join(",")
      );
    };
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const variant of output.variants) {
        for (const axis of ASC.evaluator.AXES) {
          for (const metric of ASC.evaluator.METRIC_KEYS) {
            push(displayName(method), variant.label, axis, metric, summary.variants[variant.key][axis][metric].all);
          }
        }
      }
    }
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const key of output.estimationKeys) {
        if (!summary.estimation[key]) {
          continue;
        }
        for (const axis of ASC.evaluator.AXES) {
          for (const metric of ASC.evaluator.METRIC_KEYS) {
            push(displayName(method), `推定精度: ${ASC.evaluator.estimationLabel(key)}`, axis, metric, summary.estimation[key][axis][metric].all);
          }
        }
      }
    }
    const baseline = ASC.evaluator.summarizeStore(output.baselines.allMarks.howa);
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected);
    for (const axis of ASC.evaluator.AXES) {
      for (const metric of ASC.evaluator.METRIC_KEYS) {
        push(BASELINE_LABEL, "HOWAのみ", axis, metric, baseline[axis][metric]);
        push("補正なし", "—", axis, metric, uncorrected[axis][metric]);
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  function selectionsCsv(output, map) {
    methodsInView = output.methods;
    const lines = [["Method", "Draw", "ShotId", "MarkNo", "X_mm", "Y_mm", "ScanDir"].join(",")];
    for (const set of output.sets) {
      for (const markIndex of set.markIndices) {
        const mark = map.marks[markIndex];
        const shot = map.shots[mark.shotIndex];
        lines.push([methodLabel(set.method), set.draw + 1, shot.id, mark.markNo, mark.x, mark.y, shot.scan].map(ui.csvCell).join(","));
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  ASC.resultsView = { render, resultsCsv, selectionsCsv, METRIC_LABELS, AXIS_LABELS, SERIES_COLORS, niceTicks, selectField, heatTable };
})(typeof window !== "undefined" ? window : globalThis);
