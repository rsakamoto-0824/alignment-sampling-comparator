/**
 * 評価結果の表示（一覧表・箱ひげ図・表）とCSVの書き出し。
 * 比べる補正は「HOWAのみ」と「補正の流れ × 推定手法」。色は推定手法ごとに固定する
 * （推定手法を減らしても、残った手法の色は変えない）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const METRIC_LABELS = { rms: "RMS", mean3sigma: "|平均|+3σ", max: "最大" };
  const AXIS_LABELS = { x: "X", y: "Y" };
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

  function methodLabel(key) {
    if (key === BASELINE_KEY) {
      return BASELINE_LABEL;
    }
    const method = C.METHODS.find((entry) => entry.key === key);
    return method ? method.label : key;
  }

  function seriesColor(variant) {
    return SERIES_COLORS[variant.estimator ? variant.estimator.key : "howa"];
  }

  /** 箱ひげ図の行に添える短い名前（同じ流れの中で推定手法を見分ける）。 */
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

  /** 箱ひげ図で比べる補正（HOWAのみ ＋ 選んだ流れの推定手法）。 */
  function chartVariants(output, flowType) {
    return output.variants.filter((variant) => variant.flowType === "howa" || variant.flowType === flowType);
  }

  function baselineStats(output, axis, metric) {
    return ASC.evaluator.summarizeStore(output.baselines.allMarks.howa)[axis][metric];
  }

  /** 箱ひげ図に並べる行（選び方 × 補正）。 */
  function chartGroups(output, variants, metric, axis) {
    const groups = [];
    for (const method of C.METHODS) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      groups.push({
        method: method.key,
        rows: variants.map((variant) => ({ method: method.key, variant, stats: summary.variants[variant.key][axis][metric].all })),
      });
    }
    const howa = output.variants.find((variant) => variant.key === "howa") || { key: "howa", flowType: "howa", estimator: null, label: "HOWAのみ" };
    groups.push({ method: BASELINE_KEY, rows: [{ method: BASELINE_KEY, variant: howa, stats: baselineStats(output, axis, metric) }] });
    return groups;
  }

  function renderChart(container, output, variants, view) {
    const groups = chartGroups(output, variants, view.metric, view.axis);
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

    const svg = ui.createSvg("svg", {
      viewBox: `0 0 ${CHART_WIDTH} ${height}`,
      role: "img",
      "aria-label": `選び方と補正ごとの残差${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）の箱ひげ図。数値は下の表にもあります。`,
    });
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
        text: `Waferごとの残差 ${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）[nm]`,
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
            text: rowLabel(row.variant),
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
      { className: "chart-legend", "aria-label": "補正" },
      variants.map((variant) =>
        ui.create("li", null, [ui.create("span", { className: "chart-swatch", style: `background:${seriesColor(variant)}` }), variant.label])
      )
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
    const color = seriesColor(row.variant);
    const label = `${methodLabel(row.method)}・${row.variant.label}`;
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
   * 一覧表: 選び方 × 補正の平均。値が大きいほど濃い色にし、行ごとに最も小さい値に ★ を付ける。
   */
  function renderOverviewTable(output, view) {
    const variants = output.variants;
    const rows = [];
    for (const method of C.METHODS) {
      const summary = output.summary[method.key];
      if (summary) {
        rows.push({ label: method.label, values: variants.map((variant) => summary.variants[variant.key][view.axis][view.metric].all.mean) });
      }
    }
    let maximum = 0;
    for (const row of rows) {
      for (const value of row.values) {
        if (Number.isFinite(value)) {
          maximum = Math.max(maximum, value);
        }
      }
    }
    const headRow = ui.create("tr", null, [ui.create("th", { text: "選び方" })].concat(variants.map((variant) => ui.create("th", { className: "number", text: variant.label }))));
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
    const baseline = baselineStats(output, view.axis, view.metric).mean;
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected)[view.axis][view.metric].mean;
    return [
      ui.create("div", { className: "table-scroll" }, ui.create("table", { className: "heat-table" }, [ui.create("thead", null, headRow), body])),
      ui.create("p", {
        className: "hint",
        text: `★ はその選び方で最も小さい値です。色が濃いほど残差が大きいことを表します。参考: 全点計測（HOWAのみ）${ui.formatNumber(baseline)} nm、補正なし ${ui.formatNumber(uncorrected)} nm。`,
      }),
    ];
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
          row.variant.label,
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
    for (const method of C.METHODS) {
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
          method.label,
          variant.label,
          ui.formatNumber(choice.lengthMm.median, 1),
          `${ui.formatNumber(choice.lengthMm.p5, 1)}〜${ui.formatNumber(choice.lengthMm.p95, 1)}`,
          Number.isFinite(choice.noiseRatio.median) ? choice.noiseRatio.median.toExponential(1) : "—",
        ]);
      }
    }
    return table(headers, rows);
  }

  function renderMethodTable(output) {
    const headers = [
      { text: "選び方" },
      { text: "選んだ回数" },
      { text: "Shot数", number: true },
      { text: "Mark数", number: true },
      { text: "κ（X）", number: true },
      { text: "κ（Y）", number: true },
      { text: "最小間隔 [mm]", number: true },
      { text: "制約をすべて満たした回数" },
    ];
    const rows = [];
    for (const method of C.METHODS) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      const all = summary.constraintsMet === summary.drawCount;
      rows.push([
        method.label,
        `${summary.drawCount}回`,
        ui.formatNumber(summary.shotCount.mean, 0),
        ui.formatNumber(summary.markCount.mean, 0),
        ui.formatNumber(summary.kappaX.mean),
        ui.formatNumber(summary.kappaY.mean),
        ui.formatNumber(summary.minSpacingMm.mean, 1),
        `${all ? "✓" : "✕"} ${summary.constraintsMet} / ${summary.drawCount}回`,
      ]);
    }
    return table(headers, rows);
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
    for (const method of C.METHODS.filter((entry) => entry.usesDraws)) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const variant of variants) {
        const perDraw = summary.variants[variant.key][view.axis][view.metric].perDraw;
        rows.push([method.label, variant.label, ui.formatNumber(perDraw.min), ui.formatNumber(perDraw.median), ui.formatNumber(perDraw.max)]);
      }
    }
    return rows.length > 0 ? table(headers, rows) : null;
  }

  /** 推定を使う流れのうち、結果にあるもの。 */
  function availableFlowTypes(output) {
    return C.FLOW_TYPES.filter((flow) => flow.key !== "howa" && output.variants.some((variant) => variant.flowType === flow.key));
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

    const flowTypes = availableFlowTypes(output);
    const flowType = flowTypes.some((flow) => flow.key === view.flowType) ? view.flowType : flowTypes.length > 0 ? flowTypes[0].key : "howa";
    const variants = chartVariants(output, flowType);
    children.push(ui.create("h2", { className: "subheading", text: `残差の分布（Wafer ${output.waferCount}枚、ランダム系は全試行をまとめたもの）` }));
    if (flowTypes.length > 1) {
      children.push(
        ui.create("div", { className: "toolbar" }, [
          selectField("result-flow", "推定手法を比べる流れ", flowTypes.map((flow) => [flow.key, flow.label]), flowType, (value) =>
            handlers.onViewChange({ flowType: value }, "result-flow")
          ),
        ])
      );
    }
    const chartContainer = ui.create("div");
    renderChart(chartContainer, output, variants, view);
    children.push(chartContainer);
    children.push(ui.create("p", { className: "hint", text: "箱は25〜75%点、線は5〜95%点、箱の中の縦線は中央値です。箱にポインターを合わせるか、Tabキーで選ぶと数値が出ます。" }));

    children.push(ui.create("h2", { className: "subheading", text: `数値の表（${METRIC_LABELS[view.metric]}・${AXIS_LABELS[view.axis]}、単位 nm）` }));
    children.push(renderSummaryTable(output, variants, view));
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
    children.push(ui.create("h2", { className: "subheading", text: "選んだ点の性質" }));
    children.push(renderMethodTable(output));
    children.push(ui.create("p", { className: "hint", text: "κ は計測ノイズが補正量に乗る倍率（HOWAのみの場合）、最小間隔はShot中心どうしの最小距離です。値は試行の平均です。" }));
    const drawTable = renderDrawTable(output, variants, view);
    if (drawTable) {
      children.push(ui.create("h2", { className: "subheading", text: "試行ごとのばらつき（試行ごとのWafer平均）" }));
      children.push(drawTable);
    }
    container.replaceChildren(...children);
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
    const header = ["Method", "Correction", "Axis", "Metric", "Mean", "Median", "P5", "P25", "P75", "P95", "Max", "Count"];
    const lines = [header.join(",")];
    const push = (methodName, variantName, axis, metric, stats) => {
      lines.push(
        [methodName, variantName, AXIS_LABELS[axis], METRIC_LABELS[metric], stats.mean, stats.median, stats.p5, stats.p25, stats.p75, stats.p95, stats.max, stats.count]
          .map(ui.csvCell)
          .join(",")
      );
    };
    for (const method of C.METHODS) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      for (const variant of output.variants) {
        for (const axis of ASC.evaluator.AXES) {
          for (const metric of ASC.evaluator.METRIC_KEYS) {
            push(method.label, variant.label, axis, metric, summary.variants[variant.key][axis][metric].all);
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

  ASC.resultsView = { render, resultsCsv, selectionsCsv, METRIC_LABELS };
})(typeof window !== "undefined" ? window : globalThis);
