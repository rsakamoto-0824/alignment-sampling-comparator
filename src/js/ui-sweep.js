/**
 * 「計測点数のスイープ」タブ。計測Mark数（計測コスト）と精度のトレードオフカーブを描く。
 * 比べるものは3通り:
 *   methods     補正を1つ選び、選び方を比べる
 *   corrections 選び方を1つ選び、補正（HOWAのみ＋推定手法）を比べる
 *   estimation  選び方を1つ選び、推定精度（未計測Markの推定誤差）を比べる
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const MODES = {
    methods: "選び方を比べる（補正を1つ選ぶ）",
    corrections: "補正を比べる（選び方を1つ選ぶ）",
    estimation: "推定精度を比べる（選び方を1つ選ぶ）",
  };
  const STATS = { mean: "Wafer平均", p95: "95%点" };
  const SCALES = { linear: "線形", log: "対数" };
  // 選び方の線の色と形。ランダムは基準として灰色にする（推定手法の色と重ならないように）
  const METHOD_STYLES = {
    random: { color: "var(--method-random)", shape: "circle" },
    poisson: { color: "var(--method-poisson)", shape: "square" },
    dOptimal: { color: "var(--method-d)", shape: "triangle" },
    iOptimal: { color: "var(--method-i)", shape: "diamond" },
  };
  const ESTIMATOR_SHAPES = { howa: "circle", rbfXY: "square", rbfXYR: "triangle", gpXY: "diamond", gpXYR: "triangleDown" };
  // 手動プランは計測Shot数が決まっているので、線ではなく点（文字色の × や ＋）で重ねる
  const MANUAL_SHAPES = ["cross", "plus"];
  const MANUAL_COLOR = "var(--ink-1)";

  // 折れ線グラフの寸法（SVGの単位）
  const WIDTH = 880;
  const HEIGHT = 420;
  const MARGIN = { left: 64, right: 190, top: 20, bottom: 56 };
  const MARKER_RADIUS = 4.5;
  const LABEL_MIN_GAP = 15;

  /** 1点の値（選んだ統計）。 */
  function statOf(entry, stat) {
    return entry ? entry.all[stat === "p95" ? "p95" : "mean"] : NaN;
  }

  /** スイープの選び方（線になる自動の選び方 → 点になる手動プラン）。 */
  function allMethods(sweep) {
    return sweep.methods.concat(sweep.manual ? sweep.manual.methods : []);
  }

  function methodLabelOf(sweep, key) {
    const method = allMethods(sweep).find((entry) => entry.key === key);
    return method ? method.label : key;
  }

  /** 表示の選択を、結果にある選択肢に合わせて直す。 */
  function normalizeView(sweep, view) {
    const methodKeys = allMethods(sweep).map((method) => method.key);
    const variantKeys = sweep.variants.map((variant) => variant.key);
    const flowTypes = C.FLOW_TYPES.filter((flow) => flow.key !== "howa" && sweep.variants.some((variant) => variant.flowType === flow.key)).map((flow) => flow.key);
    return {
      mode: MODES[view.mode] ? view.mode : "methods",
      variant: variantKeys.includes(view.variant) ? view.variant : variantKeys[0],
      method: methodKeys.includes(view.method) ? view.method : sweep.methods[sweep.methods.length - 1].key,
      flowType: flowTypes.includes(view.flowType) ? view.flowType : flowTypes[0] || "howa",
      metric: view.metric || "rms",
      axis: view.axis || "x",
      stat: STATS[view.stat] ? view.stat : "mean",
      scale: SCALES[view.scale] ? view.scale : "linear",
      target: view.target,
      methodKeys,
      flowTypes,
    };
  }

  /**
   * 選び方1つぶんの点の並び。自動の選び方はスイープの各点、手動プランは1点だけ。
   * pick(summary) で、その点の値（集計）を取り出す。
   */
  function methodPoints(sweep, methodKey, pick) {
    if (sweep.manual && sweep.manual.summary[methodKey]) {
      const summary = sweep.manual.summary[methodKey];
      return [{ x: sweep.manual.markCounts[methodKey], shotCount: sweep.manual.shotCounts[methodKey], y: pick(summary) }];
    }
    return sweep.points
      .filter((point) => point.summary)
      .map((point) => ({
        x: point.markCounts[methodKey],
        shotCount: point.shotCount,
        y: point.summary[methodKey] ? pick(point.summary[methodKey]) : NaN,
      }));
  }

  /** グラフに描く系列（線、手動プランは点）。 */
  function buildSeries(sweep, view) {
    const series = [];
    if (view.mode === "methods") {
      sweep.methods.forEach((method) => {
        const style = METHOD_STYLES[method.key];
        series.push({
          key: method.key,
          label: method.label,
          color: style.color,
          shape: style.shape,
          points: methodPoints(sweep, method.key, (summary) => statOf(summary.variants[view.variant][view.axis][view.metric], view.stat)),
        });
      });
      (sweep.manual ? sweep.manual.methods : []).forEach((method, index) => {
        series.push({
          key: method.key,
          label: `${method.label}（手動）`,
          color: MANUAL_COLOR,
          shape: MANUAL_SHAPES[index % MANUAL_SHAPES.length],
          points: methodPoints(sweep, method.key, (summary) => statOf(summary.variants[view.variant][view.axis][view.metric], view.stat)),
        });
      });
    } else if (view.mode === "corrections") {
      const variants = sweep.variants.filter((variant) => variant.flowType === "howa" || variant.flowType === view.flowType);
      for (const variant of variants) {
        const estimatorKey = variant.estimator ? variant.estimator.key : "howa";
        series.push({
          key: variant.key,
          label: variant.label,
          color: ASC.resultsView.SERIES_COLORS[estimatorKey],
          shape: ESTIMATOR_SHAPES[estimatorKey],
          points: methodPoints(sweep, view.method, (summary) => statOf(summary.variants[variant.key][view.axis][view.metric], view.stat)),
        });
      }
    } else {
      for (const key of sweep.estimationKeys) {
        series.push({
          key,
          label: ASC.evaluator.estimationLabel(key),
          color: ASC.resultsView.SERIES_COLORS[key],
          shape: ESTIMATOR_SHAPES[key],
          points: methodPoints(sweep, view.method, (summary) => (summary.estimation[key] ? statOf(summary.estimation[key][view.axis][view.metric], view.stat) : NaN)),
        });
      }
    }
    return series;
  }

  /** 縦軸の目盛り（線形: 0 から、対数: 10のべき × 1・2・5）。 */
  function yScale(values, scale, height) {
    const finite = values.filter((value) => Number.isFinite(value) && value > 0);
    if (finite.length === 0) {
      return { toY: () => height, ticks: [], min: 0, max: 1 };
    }
    if (scale === "log") {
      // 範囲の両端は 1・2・5 × 10のべき にそろえ、値の範囲に合わせて詰める
      const min = niceLogBound(Math.min(...finite), "down");
      const max = niceLogBound(Math.max(...finite), "up");
      const ticks = [];
      for (let decade = Math.pow(10, Math.floor(Math.log10(min))); decade <= max * 1.0001; decade *= 10) {
        for (const factor of [1, 2, 5]) {
          const value = decade * factor;
          if (value >= min * 0.9999 && value <= max * 1.0001) {
            ticks.push(value);
          }
        }
      }
      const span = Math.log10(max) - Math.log10(min) || 1;
      return { toY: (value) => height - ((Math.log10(Math.max(value, min)) - Math.log10(min)) / span) * height, ticks, min, max };
    }
    const nice = ASC.resultsView.niceTicks(Math.max(...finite) * 1.05);
    return { toY: (value) => height - (Math.min(value, nice.max) / nice.max) * height, ticks: nice.ticks, min: 0, max: nice.max };
  }

  /** 値以下（down）または値以上（up）で、最も近い 1・2・5 × 10のべき。 */
  function niceLogBound(value, direction) {
    const decade = Math.pow(10, Math.floor(Math.log10(value)));
    const candidates = [1, 2, 5, 10].map((factor) => factor * decade);
    if (direction === "down") {
      return candidates.filter((candidate) => candidate <= value * (1 + 1e-9)).pop();
    }
    return candidates.find((candidate) => candidate >= value * (1 - 1e-9));
  }

  function formatValue(value) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(3);
  }

  /** マーカー（形で系列を見分けられるようにする）。 */
  function marker(shape, x, y, color) {
    const r = MARKER_RADIUS;
    const common = { fill: color, stroke: "var(--surface-1)", "stroke-width": 2 };
    const stroked = { fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linecap": "round" };
    switch (shape) {
      case "cross":
        return ui.createSvg("path", Object.assign({ d: `M ${x - r - 1} ${y - r - 1} L ${x + r + 1} ${y + r + 1} M ${x - r - 1} ${y + r + 1} L ${x + r + 1} ${y - r - 1}` }, stroked));
      case "plus":
        return ui.createSvg("path", Object.assign({ d: `M ${x - r - 2} ${y} L ${x + r + 2} ${y} M ${x} ${y - r - 2} L ${x} ${y + r + 2}` }, stroked));
      case "square":
        return ui.createSvg("rect", Object.assign({ x: x - r, y: y - r, width: 2 * r, height: 2 * r }, common));
      case "triangle":
        return ui.createSvg("path", Object.assign({ d: `M ${x} ${y - r - 1} L ${x + r + 1} ${y + r} L ${x - r - 1} ${y + r} Z` }, common));
      case "triangleDown":
        return ui.createSvg("path", Object.assign({ d: `M ${x - r - 1} ${y - r} L ${x + r + 1} ${y - r} L ${x} ${y + r + 1} Z` }, common));
      case "diamond":
        return ui.createSvg("path", Object.assign({ d: `M ${x} ${y - r - 1} L ${x + r + 1} ${y} L ${x} ${y + r + 1} L ${x - r - 1} ${y} Z` }, common));
      default:
        return ui.createSvg("circle", Object.assign({ cx: x, cy: y, r }, common));
    }
  }

  /**
   * 折れ線グラフ。references: [{ label, value }]（全点計測・目標などの横線）
   */
  function renderLineChart(series, view, references, yTitle) {
    const plotWidth = WIDTH - MARGIN.left - MARGIN.right;
    const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
    const xs = series.flatMap((entry) => entry.points.map((point) => point.x)).filter(Number.isFinite);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const xTicks = ASC.resultsView.niceTicks(xMax).ticks.filter((tick) => tick >= xMin - 1e-9);
    const xOf = (value) => MARGIN.left + (xMax === xMin ? plotWidth / 2 : ((value - xMin) / (xMax - xMin)) * plotWidth);
    const yValues = series.flatMap((entry) => entry.points.map((point) => point.y)).concat(references.map((reference) => reference.value));
    const scale = yScale(yValues, view.scale, plotHeight);
    const yOf = (value) => MARGIN.top + scale.toY(value);

    const svg = ui.createSvg("svg", {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: "img",
      "aria-label": `計測Mark数と${yTitle}の関係の折れ線グラフ。数値は下の表にもあります。`,
    });
    for (const tick of scale.ticks) {
      const y = yOf(tick);
      svg.append(ui.createSvg("line", { className: "chart-gridline", x1: MARGIN.left, y1: y, x2: MARGIN.left + plotWidth, y2: y }));
      svg.append(ui.createSvg("text", { className: "chart-tick", x: MARGIN.left - 8, y, "text-anchor": "end", "dominant-baseline": "central", text: String(Number(tick.toPrecision(3))) }));
    }
    for (const tick of [xMin].concat(xTicks.filter((tick) => tick > xMin && tick <= xMax))) {
      svg.append(ui.createSvg("text", { className: "chart-tick", x: xOf(tick), y: MARGIN.top + plotHeight + 18, "text-anchor": "middle", text: String(Math.round(tick)) }));
    }
    svg.append(ui.createSvg("line", { className: "chart-axis", x1: MARGIN.left, y1: MARGIN.top + plotHeight, x2: MARGIN.left + plotWidth, y2: MARGIN.top + plotHeight }));
    svg.append(ui.createSvg("text", { className: "chart-tick", x: MARGIN.left + plotWidth / 2, y: HEIGHT - 10, "text-anchor": "middle", text: "計測Mark数（計測コスト）" }));
    svg.append(ui.createSvg("text", { className: "chart-tick", x: 14, y: MARGIN.top + plotHeight / 2, "text-anchor": "middle", transform: `rotate(-90 14 ${MARGIN.top + plotHeight / 2})`, text: `${yTitle} [nm]` }));

    for (const reference of references) {
      if (!Number.isFinite(reference.value)) {
        continue;
      }
      const y = yOf(reference.value);
      svg.append(ui.createSvg("line", { className: "chart-reference", x1: MARGIN.left, y1: y, x2: MARGIN.left + plotWidth, y2: y }));
      svg.append(ui.createSvg("text", { className: "chart-baseline-label", x: MARGIN.left + 6, y: y - 6, text: `${reference.label} ${formatValue(reference.value)}` }));
    }

    // 線とマーカー
    const endLabels = [];
    for (const entry of series) {
      const valid = entry.points.filter((point) => Number.isFinite(point.y) && point.y > 0 && Number.isFinite(point.x));
      if (valid.length === 0) {
        continue;
      }
      const d = valid.map((point, index) => `${index === 0 ? "M" : "L"} ${xOf(point.x)} ${yOf(point.y)}`).join(" ");
      svg.append(ui.createSvg("path", { d, fill: "none", stroke: entry.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      for (const point of valid) {
        svg.append(marker(entry.shape, xOf(point.x), yOf(point.y), entry.color));
      }
      const last = valid[valid.length - 1];
      if (valid.length === 1) {
        // 1点だけの系列（手動プラン）は、線の端の名前欄ではなく点のすぐ横に名前を書く
        svg.append(ui.createSvg("text", { className: "chart-row-label chart-point-label", x: xOf(last.x) + MARKER_RADIUS + 6, y: yOf(last.y), "dominant-baseline": "central", text: entry.label }));
        continue;
      }
      endLabels.push({ entry, x: xOf(last.x), y: yOf(last.y) });
    }
    // 線の端に名前を書く。重なるときは少しずらし、引き出し線でつなぐ
    endLabels.sort((a, b) => a.y - b.y);
    let previous = -Infinity;
    for (const label of endLabels) {
      label.labelY = Math.max(label.y, previous + LABEL_MIN_GAP);
      previous = label.labelY;
    }
    for (const label of endLabels) {
      const labelX = MARGIN.left + plotWidth + 14;
      svg.append(ui.createSvg("line", { className: "chart-leader", x1: label.x + MARKER_RADIUS + 2, y1: label.y, x2: labelX - 4, y2: label.labelY }));
      svg.append(ui.createSvg("text", { className: "chart-row-label", x: labelX, y: label.labelY, "dominant-baseline": "central", text: label.entry.label }));
    }

    // 縦線で一番近い計測Mark数を指し、全系列の値を出す（キーボードの左右キーでも動かせる）
    const xPositions = Array.from(new Set(series.flatMap((entry) => entry.points.map((point) => point.x)))).filter(Number.isFinite).sort((a, b) => a - b);
    const crosshair = ui.createSvg("line", { className: "chart-crosshair", x1: 0, y1: MARGIN.top, x2: 0, y2: MARGIN.top + plotHeight, visibility: "hidden" });
    svg.append(crosshair);
    const hit = ui.createSvg("rect", {
      x: MARGIN.left,
      y: MARGIN.top,
      width: plotWidth,
      height: plotHeight,
      fill: "transparent",
      tabindex: "0",
      "aria-label": "グラフの値を読む。左右の矢印キーで計測Mark数を移動します",
    });
    svg.append(hit);
    const tooltip = ui.byId("chart-tooltip");
    let activeIndex = -1;
    const show = (index, clientX, clientY) => {
      activeIndex = index;
      const xValue = xPositions[index];
      crosshair.setAttribute("x1", xOf(xValue));
      crosshair.setAttribute("x2", xOf(xValue));
      crosshair.setAttribute("visibility", "visible");
      const rows = series
        .map((entry) => ({ entry, point: entry.points.find((point) => point.x === xValue) }))
        .filter((row) => row.point && Number.isFinite(row.point.y))
        .sort((a, b) => a.point.y - b.point.y);
      const shotCount = rows.length > 0 ? rows[0].point.shotCount : "";
      tooltip.replaceChildren(
        ui.create("strong", { text: `計測Mark数 ${xValue}（Shot ${shotCount}）` }),
        ...rows.map((row) =>
          ui.create("div", { className: "tooltip-row" }, [
            ui.create("span", { className: "tooltip-key", style: `background:${row.entry.color}` }),
            ui.create("strong", { text: formatValue(row.point.y) }),
            ` ${row.entry.label}`,
          ])
        )
      );
      tooltip.hidden = false;
      tooltip.style.left = `${Math.min(clientX + 14, window.innerWidth - 330)}px`;
      tooltip.style.top = `${clientY + 14}px`;
    };
    const hide = () => {
      tooltip.hidden = true;
      crosshair.setAttribute("visibility", "hidden");
    };
    const nearestIndex = (svgX) => {
      let best = 0;
      xPositions.forEach((value, index) => {
        if (Math.abs(xOf(value) - svgX) < Math.abs(xOf(xPositions[best]) - svgX)) {
          best = index;
        }
      });
      return best;
    };
    hit.addEventListener("pointermove", (event) => {
      const box = svg.getBoundingClientRect();
      const svgX = ((event.clientX - box.left) / box.width) * WIDTH;
      show(nearestIndex(svgX), event.clientX, event.clientY);
    });
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("blur", hide);
    hit.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") {
        return;
      }
      event.preventDefault();
      const next = activeIndex < 0 ? 0 : Math.max(0, Math.min(xPositions.length - 1, activeIndex + (event.key === "ArrowRight" ? 1 : -1)));
      const box = svg.getBoundingClientRect();
      show(next, box.left + (xOf(xPositions[next]) / WIDTH) * box.width, box.top + box.height / 3);
    });

    const legend = ui.create(
      "ul",
      { className: "chart-legend", "aria-label": "凡例" },
      series.map((entry) =>
        ui.create("li", null, [
          ui.createSvg("svg", { className: "legend-marker", viewBox: "0 0 16 16", "aria-hidden": "true" }, [
            ui.createSvg("line", { x1: 0, y1: 8, x2: 16, y2: 8, stroke: entry.color, "stroke-width": 2 }),
            marker(entry.shape, 8, 8, entry.color),
          ]),
          entry.label,
        ])
      )
    );
    return ui.create("div", null, [legend, ui.create("div", { className: "chart-frame" }, svg)]);
  }

  /** 数値の表（行: 計測Shot数・Mark数、列: 系列）。 */
  function dataTable(series) {
    const xs = Array.from(new Set(series.flatMap((entry) => entry.points.map((point) => point.shotCount)))).sort((a, b) => a - b);
    const headers = ["計測Shot数", "計測Mark数"].concat(series.map((entry) => entry.label));
    const rows = xs.map((shotCount) => {
      const points = series.map((entry) => entry.points.find((point) => point.shotCount === shotCount));
      const markCount = points.find((point) => point && Number.isFinite(point.x));
      return [String(shotCount), markCount ? String(Math.round(markCount.x)) : "—"].concat(points.map((point) => (point ? formatValue(point.y) : "—")));
    });
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, headers.map((header) => ui.create("th", { className: "number", text: header })))),
        ui.create("tbody", null, rows.map((cells) => ui.create("tr", null, cells.map((cell) => ui.create("td", { className: "number", text: cell }))))),
      ])
    );
  }

  /** 手動プランの表（プランごとに1行）。 */
  function manualTable(series) {
    const headers = ["手動プラン", "計測Shot数", "計測Mark数", "値"];
    const rows = series.map((entry) => {
      const point = entry.points[0];
      return [entry.label, String(Math.round(point.shotCount)), String(Math.round(point.x)), formatValue(point.y)];
    });
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, headers.map((header, index) => ui.create("th", { className: index > 0 ? "number" : null, text: header })))),
        ui.create("tbody", null, rows.map((cells) => ui.create("tr", null, cells.map((cell, index) => ui.create("td", { className: index > 0 ? "number" : null, text: cell }))))),
      ])
    );
  }

  /** 目標の精度に届く最小の計測Mark数。 */
  function targetTable(series, target) {
    const rows = series.map((entry) => {
      const reached = entry.points.filter((point) => Number.isFinite(point.y) && point.y <= target).sort((a, b) => a.x - b.x)[0];
      return [entry.label, reached ? `${Math.round(reached.x)}点（Shot ${reached.shotCount}）` : "範囲内では届かない"];
    });
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, [ui.create("th", { text: "系列" }), ui.create("th", { text: `目標 ${target} nm 以下になる最小の計測Mark数` })])),
        ui.create("tbody", null, rows.map((cells) => ui.create("tr", null, cells.map((cell) => ui.create("td", { text: cell }))))),
      ])
    );
  }

  /**
   * タブの結果部分を描く。
   * handlers: { onViewChange(change, focusId), onExport() }
   */
  function render(container, sweep, rawView, handlers, isStale) {
    const view = normalizeView(sweep, rawView);
    const select = ASC.resultsView.selectField;
    const metricLabel = ASC.resultsView.METRIC_LABELS[view.metric];
    const axisLabel = ASC.resultsView.AXIS_LABELS[view.axis];
    const children = [];
    if (isStale) {
      children.push(notice("スイープのあとで設定が変わりました。今の設定で見るには、もう一度「スイープを実行」を押してください。"));
    }
    const failed = sweep.points.filter((point) => point.errors);
    if (failed.length > 0) {
      children.push(notice("評価できなかった計測Shot数があります。", failed.map((point) => `Shot ${point.shotCount}: ${point.errors.join(" ")}`)));
    }
    const relaxed = sweep.points.filter((point) => point.relaxed && point.relaxed.length > 0);
    if (relaxed.length > 0) {
      children.push(notice("ハード制約を同時に満たせず、ソフトとして扱った計測Shot数があります。", relaxed.map((point) => `Shot ${point.shotCount}: ${point.relaxed.map((entry) => entry.label).join("、")}`)));
    }
    const rankWarnings = sweep.points.filter((point) => point.warnings && point.warnings.some((text) => text.includes("多すぎる")));
    if (rankWarnings.length > 0) {
      children.push(notice("計測点が多項式の項数に対して少ない計測Shot数があります（HOWAが不安定になります）。", [`該当: Shot ${rankWarnings.map((point) => point.shotCount).join("、")}`]));
    }

    const modeField = select("sweep-mode", "比べるもの", Object.entries(MODES), view.mode, (value) => handlers.onViewChange({ mode: value }, "sweep-mode"));
    const selectors = [modeField];
    if (view.mode === "methods") {
      selectors.push(select("sweep-variant", "補正", sweep.variants.map((variant) => [variant.key, variant.label]), view.variant, (value) => handlers.onViewChange({ variant: value }, "sweep-variant")));
    } else {
      selectors.push(
        select(
          "sweep-method",
          "選び方",
          view.methodKeys.map((key) => [key, methodLabelOf(sweep, key) + (sweep.manual && sweep.manual.summary[key] ? "（手動プラン）" : "")]),
          view.method,
          (value) => handlers.onViewChange({ method: value }, "sweep-method")
        )
      );
      if (view.mode === "corrections" && view.flowTypes.length > 0) {
        selectors.push(
          select("sweep-flow", "推定を使う流れ", view.flowTypes.map((key) => [key, C.FLOW_TYPES.find((flow) => flow.key === key).label]), view.flowType, (value) =>
            handlers.onViewChange({ flowType: value }, "sweep-flow")
          )
        );
      }
    }
    children.push(ui.create("div", { className: "toolbar" }, selectors));
    const targetInput = ui.create("input", { type: "number", id: "sweep-target", step: "any", min: "0", value: Number.isFinite(view.target) ? view.target : "", "aria-describedby": "sweep-target-hint" });
    targetInput.addEventListener("change", () => {
      const value = targetInput.value.trim() === "" ? NaN : Number(targetInput.value);
      handlers.onViewChange({ target: value > 0 ? value : NaN }, "sweep-target");
    });
    children.push(
      ui.create("div", { className: "toolbar" }, [
        select("sweep-metric", "指標", Object.entries(ASC.resultsView.METRIC_LABELS), view.metric, (value) => handlers.onViewChange({ metric: value }, "sweep-metric")),
        select("sweep-axis", "軸", Object.entries(ASC.resultsView.AXIS_LABELS), view.axis, (value) => handlers.onViewChange({ axis: value }, "sweep-axis")),
        select("sweep-stat", "統計", Object.entries(STATS), view.stat, (value) => handlers.onViewChange({ stat: value }, "sweep-stat")),
        select("sweep-scale", "縦軸", Object.entries(SCALES), view.scale, (value) => handlers.onViewChange({ scale: value }, "sweep-scale")),
        ui.create("div", { className: "field" }, [ui.create("label", { for: "sweep-target", text: "目標の精度 [nm]（任意）" }), targetInput]),
        ui.create("button", { type: "button", className: "button-secondary", text: "スイープ結果をCSVで保存", onClick: handlers.onExport }),
      ])
    );

    const series = buildSeries(sweep, view);
    const what = view.mode === "estimation" ? "推定誤差" : "残差";
    const yTitle = `${what} ${metricLabel}（${axisLabel}、${STATS[view.stat]}）`;
    const references = [];
    if (view.mode !== "estimation") {
      references.push({ label: "全点計測", value: sweep.baseline[view.axis][view.metric][view.stat === "p95" ? "p95" : "mean"] });
    }
    if (Number.isFinite(view.target)) {
      references.push({ label: "目標", value: view.target });
    }
    children.push(ui.create("h2", { className: "subheading", text: `計測Mark数と${yTitle}（Wafer ${sweep.waferCount}枚、ランダム系は${sweep.draws}回の試行をまとめたもの）` }));
    children.push(renderLineChart(series, view, references, yTitle));
    children.push(
      ui.create("p", {
        className: "hint",
        id: "sweep-target-hint",
        text:
          view.mode === "estimation"
            ? "推定誤差は、未計測Markでの 推定値 − 真のずれ です。計測Mark数が増えると未計測Markが減るので、評価するMarkの数も変わります。"
            : "横線の「全点計測」は全Markを計測してHOWAで補正した残差で、計測点を増やしても下回れない目安です。グラフにポインターを合わせるか、グラフをTabで選んで左右キーを押すと値が出ます。",
      })
    );
    children.push(ui.create("h3", { className: "subheading", text: "数値の表（単位 nm）" }));
    // 選び方を比べるときは、手動プラン（点）を線の表と分けて書く（計測Shot数がスイープの刻みと合わないため）
    const isManual = (entry) => entry.key.startsWith(C.MANUAL_PREFIX);
    const lineSeries = view.mode === "methods" ? series.filter((entry) => !isManual(entry)) : series;
    children.push(dataTable(lineSeries));
    const manualSeries = view.mode === "methods" ? series.filter(isManual) : [];
    if (manualSeries.length > 0) {
      children.push(ui.create("h3", { className: "subheading", text: "手動プラン（単位 nm）" }));
      children.push(manualTable(manualSeries));
    }
    if (Number.isFinite(view.target)) {
      children.push(ui.create("h3", { className: "subheading", text: "目標に届く計測Mark数" }));
      children.push(targetTable(series, view.target));
    }
    container.replaceChildren(...children);
  }

  function notice(title, items) {
    const body = ui.create("div", null, [ui.create("strong", { text: title })]);
    if (items && items.length > 0) {
      body.append(ui.create("ul", null, items.map((item) => ui.create("li", { text: item }))));
    }
    return ui.create("div", { className: "notice notice-warning" }, [ui.create("span", { className: "notice-icon", "aria-hidden": "true", text: "⚠" }), body]);
  }

  /** スイープ結果のCSV（1行 = 計測Shot数 × 選び方 × 補正または推定手法 × 軸 × 指標）。 */
  function sweepCsv(sweep) {
    const lines = [["ShotCount", "MarkCount", "Method", "Kind", "Name", "Axis", "Metric", "Mean", "Median", "P5", "P95", "Max"].join(",")];
    const push = (point, methodKey, kind, name, axis, metric, stats) => {
      lines.push(
        [point.shotCount, point.markCounts[methodKey], methodLabelOf(sweep, methodKey), kind, name, axis.toUpperCase(), ASC.resultsView.METRIC_LABELS[metric], stats.mean, stats.median, stats.p5, stats.p95, stats.max]
          .map(ui.csvCell)
          .join(",")
      );
    };
    const allPoints = sweep.points.filter((entry) => entry.summary);
    if (sweep.manual) {
      // 手動プランは、そのプランの計測Shot数・Mark数の点として書く
      for (const method of sweep.manual.methods) {
        allPoints.push({
          shotCount: sweep.manual.shotCounts[method.key],
          markCounts: { [method.key]: sweep.manual.markCounts[method.key] },
          summary: { [method.key]: sweep.manual.summary[method.key] },
        });
      }
    }
    for (const point of allPoints) {
      for (const [methodKey, summary] of Object.entries(point.summary)) {
        for (const axis of ASC.evaluator.AXES) {
          for (const metric of ASC.evaluator.METRIC_KEYS) {
            for (const variant of sweep.variants) {
              push(point, methodKey, "残差", variant.label, axis, metric, summary.variants[variant.key][axis][metric].all);
            }
            for (const key of sweep.estimationKeys) {
              if (summary.estimation[key]) {
                push(point, methodKey, "推定精度", ASC.evaluator.estimationLabel(key), axis, metric, summary.estimation[key][axis][metric].all);
              }
            }
          }
        }
      }
    }
    return lines.join("\r\n") + "\r\n";
  }

  ASC.sweepView = { render, sweepCsv };
})(typeof window !== "undefined" ? window : globalThis);
