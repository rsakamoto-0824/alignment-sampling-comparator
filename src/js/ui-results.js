/**
 * 評価結果の表示（一覧表・分布の図（箱ひげ図）・表）とCSVの書き出し。
 * 比べる補正は HOWA・RBF・GPR（式内・予測）・計測値＋HOWA。色は補正の系統（family）ごとに固定し
 * （補正を減らしても、残った補正の色は変えない）、RBF・GPRの式内と予測は同じ色で、式内を薄い塗りにして見分ける。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const METRIC_LABELS = { rms: "RMS", mean3sigma: "|平均|+3σ", max: "最大" };
  // 分布の図の横軸の目盛り。対数にすると、値の小さい選び方どうしの差が見やすい
  const CHART_SCALES = { linear: "等間隔", log: "対数" };
  const AXIS_LABELS = { x: "X", y: "Y" };
  // 補正の系統（family）ごとの色
  const SERIES_COLORS = {
    howa: "var(--series-1)",
    rbfXY: "var(--series-2)",
    rbfXYR: "var(--series-3)",
    gpXY: "var(--series-4)",
    gpXYR: "var(--series-5)",
    measured: "var(--series-6)",
  };
  const BASELINE_KEY = "allMarks";
  const BASELINE_LABEL = "全点計測（基準）";
  // 一覧表の色の段階（値が大きいほど濃い）
  const HEAT_STEPS = 5;

  // 分布の図（箱ひげ図に分布の形を重ねたもの）の寸法（SVGの単位）
  const CHART_WIDTH = 880;
  const GROUP_LABEL_WIDTH = 140;
  const ROW_LABEL_WIDTH = 170;
  const RIGHT_PADDING = 28;
  const TOP_PADDING = 34;
  const AXIS_HEIGHT = 48;
  const ROW_HEIGHT = 30;
  const GROUP_GAP = 8;
  // 分布の形（山）の高さの半分、25〜75%点の棒の太さと角の丸み、5〜95%点の線の太さ、中央値の丸の半径
  const VIOLIN_HALF_HEIGHT = 12;
  const BOX_HEIGHT = 8;
  const BOX_RADIUS = 4;
  const WHISKER_WIDTH = 2;
  const MEDIAN_RADIUS = 3.5;
  // 値が少ない行は、分布の形の代わりに値を点で描く（点の半径と、重ならないように上下へずらす幅）
  const MIN_VIOLIN_COUNT = 20;
  const DOT_RADIUS = 3;
  const DOT_SPREAD = 9;
  // 分布の形を計算する点の数と、横軸の両端に足す余白（値の幅に対する割合）
  const DENSITY_STEPS = 64;
  const AXIS_PADDING_RATIO = 0.05;
  const TICK_TARGET_COUNT = 6;
  // 点をずらす量を決める数（黄金比の小数部。点が上下に均等に散らばる）
  const GOLDEN_FRACTION = 0.6180339887;

  // 描いている結果の選び方の一覧（自動の選び方と手動プラン）。render で入れる
  let methodsInView = [];
  // 図ごとに違う切り抜きの名前を付けるための番号
  let chartCounter = 0;

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
    return SERIES_COLORS[variant.family];
  }

  /** RBF・GPRの式内は、予測と同じ色で薄い塗りにする（色だけでなく塗り方でも見分ける）。 */
  function isOutlined(variant) {
    return variant.mode === "embedded";
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

  /** 1・2・5 の倍数のきりのよい刻みで、low〜high を含む等間隔の範囲と目盛り（0から始めない）。 */
  function niceRange(low, high) {
    const rough = (high - low) / TICK_TARGET_COUNT;
    const power = Math.pow(10, Math.floor(Math.log10(rough)));
    const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough);
    const min = Math.floor(low / step + 1e-9) * step;
    const max = Math.ceil(high / step - 1e-9) * step;
    const ticks = [];
    for (let value = min; value <= max + step * 1e-9; value += step) {
      ticks.push(Math.round(value / step) * step);
    }
    return { min, max, ticks, log: false, transform: (value) => value };
  }

  /** 対数の範囲と目盛り（1・2・5 × 10のべき）。low は正の値。 */
  function niceLogRange(low, high) {
    const candidates = [];
    for (let exponent = Math.floor(Math.log10(low)) - 1; exponent <= Math.ceil(Math.log10(high)) + 1; exponent++) {
      for (const factor of [1, 2, 5]) {
        candidates.push(Number((factor * Math.pow(10, exponent)).toPrecision(12)));
      }
    }
    const min = candidates.filter((value) => value <= low * (1 + 1e-9)).pop();
    const max = candidates.find((value) => value >= high * (1 - 1e-9));
    return { min, max, ticks: candidates.filter((value) => value >= min && value <= max), log: true, transform: Math.log10 };
  }

  function baselineStats(output, axis, metric) {
    return ASC.evaluator.summarizeStore(output.baselines.allMarks.howa)[axis][metric];
  }

  /** 値の一覧から、計算できた値だけを小さい順に並べる。 */
  function sortedFinite(arrays) {
    const values = [];
    for (const array of arrays) {
      for (const value of array) {
        if (Number.isFinite(value)) {
          values.push(value);
        }
      }
    }
    return Float64Array.from(values).sort();
  }

  /** 図の1行。group は選び方、row は補正。values はWaferごと（全試行）の値（小さい順）。outlined は薄い塗りで描くか。 */
  function chartRow(methodKey, rowText, fullLabel, color, stats, values, outlined) {
    return { method: methodKey, rowLabel: rowText, fullLabel, color, stats, values, outlined: Boolean(outlined) };
  }

  function setsOfMethod(output, methodKey) {
    return output.sets.filter((set) => set.method === methodKey && set.results);
  }

  /** 残差の箱ひげ図に並べる行（選び方 × 補正）。最後に全点計測の基準を置く。 */
  function chartGroups(output, variants, metric, axis) {
    const groups = [];
    for (const method of output.methods) {
      const summary = output.summary[method.key];
      if (!summary) {
        continue;
      }
      const sets = setsOfMethod(output, method.key);
      groups.push({
        method: method.key,
        rows: variants.map((variant) =>
          chartRow(
            method.key,
            variant.label,
            variant.longLabel,
            seriesColor(variant),
            summary.variants[variant.key][axis][metric].all,
            sortedFinite(sets.map((set) => set.results[variant.key][axis][metric])),
            isOutlined(variant)
          )
        ),
      });
    }
    groups.push({
      method: BASELINE_KEY,
      rows: [
        chartRow(BASELINE_KEY, "HOWA", "HOWA（全Markを計測）", SERIES_COLORS.howa, baselineStats(output, axis, metric), sortedFinite([output.baselines.allMarks.howa[axis][metric]])),
      ],
    });
    return groups;
  }

  /** 横軸の範囲。5〜95%点（点で描く行は全部の値）が入るように、少し余白を足す。scaleKind は "linear" か "log"。 */
  function valueDomain(groups, scaleKind) {
    let low = Infinity;
    let high = -Infinity;
    for (const group of groups) {
      for (const row of group.rows) {
        const dotted = row.values.length < MIN_VIOLIN_COUNT;
        const rowLow = dotted && row.values.length > 0 ? row.values[0] : row.stats.p5;
        const rowHigh = dotted && row.values.length > 0 ? row.values[row.values.length - 1] : row.stats.p95;
        if (Number.isFinite(rowLow) && Number.isFinite(rowHigh)) {
          low = Math.min(low, rowLow);
          high = Math.max(high, rowHigh);
        }
      }
    }
    if (!Number.isFinite(low)) {
      return niceRange(0, 1);
    }
    if (scaleKind === "log" && low > 0) {
      return niceLogRange(low, high);
    }
    const padding = (high - low) * AXIS_PADDING_RATIO || Math.abs(high) * AXIS_PADDING_RATIO || 1;
    // 残差などの指標は0以上なので、余白で負の側へはみ出さない
    return niceRange(low >= 0 ? Math.max(0, low - padding) : low - padding, high + padding);
  }

  /**
   * 分布の形（ガウス核の密度推定）を、行の中心線から上下に広げた形のパスにする。値の最小〜最大の範囲で描き、
   * 高さは行ごとに最も高いところを VIOLIN_HALF_HEIGHT にそろえる。描けないとき（値が1種類など）は null。
   */
  function densityPath(sortedValues, scale, xOfTransformed, center) {
    // 横軸の目盛り（等間隔・対数）の上で分布の形を求める（対数なら対数にした値の分布）
    const values = Array.from(sortedValues, scale.transform).filter(Number.isFinite);
    const count = values.length;
    if (count < 2) {
      return null;
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / count;
    const variance = values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / Math.max(1, count - 1);
    const spread = values[Math.floor(0.75 * (count - 1))] - values[Math.floor(0.25 * (count - 1))];
    // 帯域幅はシルバーマンの目安（外れ値に引きずられないよう、標準偏差と四分位範囲の小さいほうを使う）
    const robust = Math.min(Math.sqrt(variance), spread / 1.34) || Math.sqrt(variance);
    const bandwidth = 0.9 * robust * Math.pow(count, -0.2);
    const from = values[0];
    const to = values[count - 1];
    if (!(bandwidth > 0) || !(to > from)) {
      return null;
    }
    const points = [];
    let peak = 0;
    for (let step = 0; step <= DENSITY_STEPS; step++) {
      const value = from + ((to - from) * step) / DENSITY_STEPS;
      let density = 0;
      for (let i = 0; i < count; i++) {
        const distance = (value - values[i]) / bandwidth;
        density += Math.exp(-0.5 * distance * distance);
      }
      points.push([xOfTransformed(value), density]);
      peak = Math.max(peak, density);
    }
    const upper = points.map(([x, density]) => `${x.toFixed(1)},${(center - (density / peak) * VIOLIN_HALF_HEIGHT).toFixed(1)}`);
    const lower = points
      .slice()
      .reverse()
      .map(([x, density]) => `${x.toFixed(1)},${(center + (density / peak) * VIOLIN_HALF_HEIGHT).toFixed(1)}`);
    return `M ${upper.join(" L ")} L ${lower.join(" L ")} Z`;
  }

  /**
   * 横向きの分布の図。各行に、分布の形（薄い山）、25〜75%点の棒、5〜95%点の線、中央値の丸を重ねる。
   * 値が少ない行は、分布の形の代わりに値を点で描く。
   * groups: [{ method, rows: [{ rowLabel, fullLabel, color, stats, values }] }]
   * legendItems: [{ label, color }]、axisTitle: 横軸の説明、ariaLabel: 図の説明、
   * reference: 縦の破線で示す基準の値（{ value, label }。なければ null）
   */
  function renderChart(container, groups, legendItems, axisTitle, ariaLabel, reference, scaleKind) {
    const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);
    const height = TOP_PADDING + rowCount * ROW_HEIGHT + (groups.length - 1) * GROUP_GAP + AXIS_HEIGHT;
    const domain = valueDomain(groups, scaleKind);
    const plotLeft = GROUP_LABEL_WIDTH + ROW_LABEL_WIDTH;
    const plotWidth = CHART_WIDTH - plotLeft - RIGHT_PADDING;
    const transformedMin = domain.transform(domain.min);
    const transformedMax = domain.transform(domain.max);
    const xOfTransformed = (value) => plotLeft + ((Math.min(Math.max(value, transformedMin), transformedMax) - transformedMin) / (transformedMax - transformedMin)) * plotWidth;
    // 対数で0以下の値は描けないので、範囲の左端に寄せる
    const xOf = (value) => xOfTransformed(domain.log && !(value > 0) ? transformedMin : domain.transform(value));
    const plotTop = TOP_PADDING - 6;
    const plotBottom = height - AXIS_HEIGHT;

    const svg = ui.createSvg("svg", { viewBox: `0 0 ${CHART_WIDTH} ${height}`, role: "img", "aria-label": ariaLabel });
    // 分布の形の裾が軸の外へはみ出さないように、描く範囲を切り取る
    const clipId = `chart-clip-${++chartCounter}`;
    svg.append(
      ui.createSvg("defs", null,
        ui.createSvg("clipPath", { id: clipId }, ui.createSvg("rect", { x: plotLeft, y: 0, width: plotWidth, height }))
      )
    );

    // 選び方ごとの帯（1つおきに薄い色を敷き、区切り線を使わずに群を分ける）
    let y = TOP_PADDING;
    const groupTops = [];
    groups.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        y += GROUP_GAP;
      }
      groupTops.push(y);
      const groupHeight = group.rows.length * ROW_HEIGHT;
      if (groupIndex % 2 === 1) {
        svg.append(ui.createSvg("rect", { className: "chart-band", x: 0, y: y - GROUP_GAP / 2, width: CHART_WIDTH, height: groupHeight + GROUP_GAP, rx: 6 }));
      }
      y += groupHeight;
    });

    for (const tick of domain.ticks) {
      const x = xOf(tick);
      svg.append(ui.createSvg("line", { className: "chart-gridline", x1: x, y1: plotTop, x2: x, y2: plotBottom }));
      svg.append(ui.createSvg("text", { className: "chart-tick", x, y: plotBottom + 20, "text-anchor": "middle", text: formatTick(tick) }));
    }
    svg.append(ui.createSvg("line", { className: "chart-axis", x1: plotLeft, y1: plotBottom, x2: plotLeft + plotWidth, y2: plotBottom }));
    svg.append(
      ui.createSvg("text", {
        className: "chart-axis-title",
        x: plotLeft + plotWidth / 2,
        y: plotBottom + 42,
        "text-anchor": "middle",
        text: axisTitle,
      })
    );
    if (reference && Number.isFinite(reference.value)) {
      const x = xOf(reference.value);
      const nearRight = x > plotLeft + plotWidth * 0.75;
      svg.append(ui.createSvg("line", { className: "chart-reference-line", x1: x, y1: plotTop, x2: x, y2: plotBottom }));
      svg.append(
        ui.createSvg("text", {
          className: "chart-reference-label",
          x: nearRight ? x - 6 : x + 6,
          y: plotTop - 6,
          "text-anchor": nearRight ? "end" : "start",
          text: `${reference.label} ${ui.formatNumber(reference.value)} nm`,
        })
      );
    }

    const tooltip = ui.byId("chart-tooltip");
    groups.forEach((group, groupIndex) => {
      let rowTop = groupTops[groupIndex];
      for (const row of group.rows) {
        // 4系列以上は色だけで見分けにくいので、行ごとに名前を添える
        svg.append(
          ui.createSvg("text", {
            className: "chart-row-label",
            x: plotLeft - 12,
            y: rowTop + ROW_HEIGHT / 2,
            "text-anchor": "end",
            "dominant-baseline": "central",
            text: row.rowLabel,
          })
        );
        if (Number.isFinite(row.stats.median)) {
          svg.append(drawDistribution(row, rowTop, xOf, { plotLeft, plotWidth, clipId, scale: domain, xOfTransformed }, tooltip));
        } else {
          svg.append(ui.createSvg("text", { className: "chart-tick", x: plotLeft + 4, y: rowTop + ROW_HEIGHT / 2, "dominant-baseline": "central", text: "計算できませんでした" }));
        }
        rowTop += ROW_HEIGHT;
      }
      svg.append(
        ui.createSvg("text", {
          className: "chart-group-label",
          x: 8,
          y: groupTops[groupIndex] + (group.rows.length * ROW_HEIGHT) / 2,
          "dominant-baseline": "central",
          text: methodLabel(group.method),
        })
      );
    });

    const legend = ui.create(
      "ul",
      { className: "chart-legend", "aria-label": "凡例" },
      legendItems.map((item) =>
        ui.create("li", null, [
          ui.create("span", { className: item.outlined ? "chart-swatch outlined" : "chart-swatch", style: `--swatch-color:${item.color}` }),
          item.label,
        ])
      )
    );
    container.replaceChildren(legend, ui.create("div", { className: "chart-frame" }, svg), readingKey());
  }

  /** 図の読み方（形の意味）を小さな見本で示す。 */
  function readingKey() {
    const sample = (children) => ui.createSvg("svg", { className: "chart-key-symbol", viewBox: "0 0 44 20", "aria-hidden": "true" }, children);
    const color = "var(--ink-muted)";
    const items = [
      [sample([ui.createSvg("path", { d: "M 2 10 C 12 2, 20 2, 26 6 C 32 9, 38 9, 42 10 C 38 11, 32 11, 26 14 C 20 18, 12 18, 2 10 Z", fill: color, "fill-opacity": 0.18, stroke: color, "stroke-opacity": 0.6 })]), "分布の形（Waferごとの値の多さ）"],
      [sample([ui.createSvg("rect", { x: 8, y: 6, width: 28, height: BOX_HEIGHT, rx: BOX_RADIUS, fill: color })]), "25〜75%点"],
      [sample([ui.createSvg("rect", { className: "chart-box-outlined", x: 8, y: 6, width: 28, height: BOX_HEIGHT, rx: BOX_RADIUS, stroke: color, fill: color })]), "25〜75%点（RBF・GPRの式内。薄い塗り）"],
      [sample([ui.createSvg("line", { x1: 3, y1: 10, x2: 41, y2: 10, stroke: color, "stroke-width": WHISKER_WIDTH, "stroke-linecap": "round" })]), "5〜95%点"],
      [sample([ui.createSvg("circle", { className: "chart-median", cx: 22, cy: 10, r: MEDIAN_RADIUS + 1, stroke: color })]), "中央値"],
      [sample([0, 1, 2, 3, 4].map((index) => ui.createSvg("circle", { cx: 6 + index * 8, cy: 10 + (index % 2 === 0 ? -3 : 3), r: DOT_RADIUS, fill: color, "fill-opacity": 0.6 }))), `値が${MIN_VIOLIN_COUNT}個より少ない行は、1つずつの値を点で描きます`],
    ];
    return ui.create("ul", { className: "chart-key", "aria-label": "図の読み方" }, items.map(([icon, text]) => ui.create("li", null, [icon, ui.create("span", { text })])));
  }

  function formatTick(value) {
    return Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(3)));
  }

  /** 1行の分布（形・25〜75%点の棒・5〜95%点の線・中央値の丸）。ポインターを合わせると数値を出す。 */
  function drawDistribution(row, top, xOf, plot, tooltip) {
    const stats = row.stats;
    const center = top + ROW_HEIGHT / 2;
    const color = row.color;
    const label = `${methodLabel(row.method)}・${row.fullLabel}`;
    const group = ui.createSvg("g", {
      className: "chart-row",
      tabindex: "0",
      "aria-label": `${label}: 中央値 ${ui.formatNumber(stats.median)} nm、平均 ${ui.formatNumber(stats.mean)} nm、95%点 ${ui.formatNumber(stats.p95)} nm`,
    });
    // 当たり判定は行全体にする（ポインターを合わせると行に薄い色が付く）
    group.append(ui.createSvg("rect", { className: "chart-row-hit", x: plot.plotLeft - ROW_LABEL_WIDTH, y: top + 1, width: plot.plotWidth + ROW_LABEL_WIDTH, height: ROW_HEIGHT - 2, rx: 4 }));
    const marks = ui.createSvg("g", { "clip-path": `url(#${plot.clipId})`, "pointer-events": "none" });
    if (row.values.length >= MIN_VIOLIN_COUNT) {
      const path = densityPath(row.values, plot.scale, plot.xOfTransformed, center);
      if (path) {
        marks.append(ui.createSvg("path", { className: "chart-violin", d: path, fill: color, stroke: color }));
      }
    } else {
      row.values.forEach((value, index) => {
        const offset = (((index * GOLDEN_FRACTION) % 1) - 0.5) * 2 * DOT_SPREAD;
        marks.append(ui.createSvg("circle", { className: "chart-dot", cx: xOf(value), cy: center + offset, r: DOT_RADIUS, fill: color }));
      });
    }
    marks.append(ui.createSvg("line", { x1: xOf(stats.p5), y1: center, x2: xOf(stats.p95), y2: center, stroke: color, "stroke-width": WHISKER_WIDTH, "stroke-linecap": "round" }));
    const boxLeft = xOf(stats.p25);
    marks.append(
      ui.createSvg("rect", {
        className: row.outlined ? "chart-box-outlined" : null,
        x: boxLeft,
        y: center - BOX_HEIGHT / 2,
        width: Math.max(BOX_HEIGHT, xOf(stats.p75) - boxLeft),
        height: BOX_HEIGHT,
        rx: BOX_RADIUS,
        fill: color,
        stroke: row.outlined ? color : null,
      })
    );
    marks.append(ui.createSvg("circle", { className: "chart-median", cx: xOf(stats.median), cy: center, r: MEDIAN_RADIUS, stroke: color }));
    group.append(marks);
    const show = (clientX, clientY) => {
      tooltip.replaceChildren(
        ui.create("strong", { text: `中央値 ${ui.formatNumber(stats.median)} nm` }),
        ui.create("div", { text: label }),
        ui.create("div", { text: `平均 ${ui.formatNumber(stats.mean)}、25〜75% ${ui.formatNumber(stats.p25)}〜${ui.formatNumber(stats.p75)}` }),
        ui.create("div", { text: `5〜95% ${ui.formatNumber(stats.p5)}〜${ui.formatNumber(stats.p95)}、最大 ${ui.formatNumber(stats.max)}` }),
        ui.create("div", { text: `値の数 ${stats.count}（Wafer × 試行）` })
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
        text: `★ はその選び方で最も小さい値です。色が濃いほど残差が大きいことを表します。参考: 全点計測（HOWA）${ui.formatNumber(baseline)} nm、補正なし ${ui.formatNumber(uncorrected)} nm。`,
      }),
    ];
  }

  /** 数値の表: 選び方 × 補正ごとの平均・中央値・95%点など。 */
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

  /** GPRがWaferごとに選んだ値（相関の長さ・ノイズ比）の中央値。 */
  function renderGpTable(output) {
    const gpVariants = output.variants.filter((variant) => variant.type === "gp");
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
    const headers = [{ text: "選び方" }, { text: "選んだ回数" }, { text: "測るShot数", number: true }, { text: "Mark数", number: true }, { text: "最小間隔 [mm]", number: true }];
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
    // 見出しの種類はShot単位の選び方のもの（Mark単位で切り替えた制約は、表の上の注意に書く）
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
    if (output.markRelaxed && output.markRelaxed.length > 0) {
      children.push(
        notice(
          "warning",
          "⚠",
          "Mark単位の選び方では、次のハード制約を同時に満たせなかったため、ソフト制約として扱いました（制約はMarkの数で数えます）。",
          output.markRelaxed.map((entry) => `${entry.label}: ${entry.reason.replace("Shot", "Mark")}`)
        )
      );
    }
    if (output.markErrors && output.markErrors.length > 0) {
      children.push(notice("warning", "⚠", "Mark単位の選び方は、次の理由で評価していません。「4. サンプリング」の「Mark単位で選ぶMark数」などを見直してください。", output.markErrors));
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
        selectField("result-chart-scale", "図の横軸", Object.entries(CHART_SCALES), view.chartScale, (value) => handlers.onViewChange({ chartScale: value }, "result-chart-scale")),
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
      variants.map((variant) => ({ label: variant.label, color: seriesColor(variant), outlined: isOutlined(variant) })),
      `Waferごとの残差 ${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）[nm]`,
      `選び方と補正ごとの残差${METRIC_LABELS[view.metric]}（${AXIS_LABELS[view.axis]}）の分布の図（箱ひげ図）。数値は下の表にもあります。`,
      { value: baselineStats(output, view.axis, view.metric).median, label: "全点計測の中央値" },
      view.chartScale
    );
    children.push(chartContainer);
    children.push(
      ui.create("p", {
        className: "hint",
        text: "横軸は値のある範囲に合わせて広げています（0から始まりません）。「図の横軸」を対数にすると、値の小さい選び方どうしの差が見やすくなります。縦の破線は全点計測（基準）の中央値で、ここに近いほど全Markを測ったときに近い補正ができています。RBF・GPRの式内（式の中の多項式を補正値にする）は薄い塗り、予測（全Markの予測に多項式を当てはめる）は塗りつぶしです。行にポインターを合わせるか、Tabキーで選ぶと数値が出ます。",
      })
    );

    children.push(ui.create("h2", { className: "subheading", text: `数値の表（${METRIC_LABELS[view.metric]}・${AXIS_LABELS[view.axis]}、単位 nm）` }));
    children.push(renderSummaryTable(output, variants, view));
    const gpTable = renderGpTable(output);
    if (gpTable) {
      children.push(ui.create("h2", { className: "subheading", text: "GPRが選んだ値（Waferごと・X/Yごとに選んだ値の分布）" }));
      children.push(gpTable);
      const shortestMm = C.GP_LENGTH_SCALE_MIN * C.NORMALIZATION_RADIUS_MM;
      children.push(
        ui.create("p", {
          className: "hint",
          text: `ノイズ比は「ノイズの分散 ÷ 信号の分散」です。式内はHOWAの残差から、予測は1次式を引いた残差から、Waferごとに周辺尤度が最大の値を選びます。探索範囲の端（相関の長さ ${shortestMm} mm・ノイズ比 ${C.GP_NOISE_RATIO_MAX}）に張り付くときは、計測点から空間的なつながりが読み取れず、式内はHOWA、予測は1次式に近い結果になっています。`,
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
    if (output.methods.some((method) => method.unit === "mark")) {
      children.push(
        ui.create("p", {
          className: "hint",
          text: "Mark単位（Shotの括りなし）の選び方の「測るShot数」は、選んだMarkがあるShotの数（計測で訪れるShotの数）、最小間隔はMarkどうしの最小間隔です（Shot単位はShot中心どうし）。同じMark数で、点の配置の良さ（D基準・I基準）と測るShot数を比べると、Shotで括ることの損得が分かります。",
        })
      );
    }
    const constraintTable = renderConstraintSummaryTable(output);
    if (constraintTable) {
      children.push(ui.create("h2", { className: "subheading", text: "制約の満たし具合" }));
      children.push(constraintTable);
      children.push(ui.create("p", { className: "hint", text: "満たした回数は試行の数のうちいくつで満たしたか、ずれは何個のShotを別の区画へ移せば満たせるかの目安です（強制計測Shotは選ばれていない数）。制約なしのD最適・I最適と手動プランは制約を守らないので、外れることがあります。Mark単位の選び方は、制約を選んだMarkの数で数え（4象限・同心円はMarkの座標）、ずれは何個のMarkを移せば満たせるかです（強制計測Shotは選ばれていないMarkの数）。" }));
    }
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
    const baseline = ASC.evaluator.summarizeStore(output.baselines.allMarks.howa);
    const uncorrected = ASC.evaluator.summarizeStore(output.baselines.uncorrected);
    for (const axis of ASC.evaluator.AXES) {
      for (const metric of ASC.evaluator.METRIC_KEYS) {
        push(BASELINE_LABEL, "HOWA", axis, metric, baseline[axis][metric]);
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
