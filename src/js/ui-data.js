/**
 * 「評価データ」タブ。乱数で作ったWafer面内傾向（評価データ）を、Waferごと・成分ごとに確かめる。
 * 表示はベクトル図（矢印）か、X・Yの色マップ。矢印の長さと色の目盛りは成分ごとに全Waferで共通にし、
 * Waferどうしを同じ目盛りで見比べられるようにする。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const ui = ASC.ui;

  const VIEW_HALF_SIZE_MM = 162;
  // 矢印の目盛り: 成分ごとに、全Waferのずれの大きさの95%点をこの長さ [mm] で描く
  const ARROW_REFERENCE_MM = 16;
  const SCALE_PERCENT = 95;
  // 目盛りを決めるのに使うWaferの数の上限（Wafer数が多いときの計算時間を抑える）
  const SCALE_SAMPLE_WAFERS = 200;
  // これより短い矢印は向きが読めないので、点で描く
  const ARROW_MIN_LENGTH_MM = 0.3;
  const COLOR_MARK_RADIUS_MM = 2.6;
  // 目盛りの矢印を描く位置（地図の左下、Waferの外）と文字の大きさ [mm]
  const SCALE_ARROW_ORIGIN_MM = { x: -156, y: -150 };
  const SCALE_TEXT_SIZE_MM = 9;
  // 色マップの段階: 負の側4段・ほぼ0の1段・正の側4段
  const DIVERGING_STEPS = 9;
  const THUMBNAILS_PER_PAGE = 12;
  const NICE_FACTORS = [1, 2, 5];
  const DISPLAYS = [
    { key: "vector", label: "ベクトル図（矢印）" },
    { key: "x", label: "Xの色マップ" },
    { key: "y", label: "Yの色マップ" },
  ];

  let markerCounter = 0;
  const statisticsCache = new WeakMap();

  function components() {
    return ASC.evaluationData.COMPONENTS;
  }

  // ---- 集計と目盛り ----------------------------------------------------------

  /** 成分ごとの、Waferごとの大きさ（RMS・最大）と表示の目盛り。データごとに1回だけ計算する。 */
  function statisticsOf(data) {
    const cached = statisticsCache.get(data);
    if (cached) {
      return cached;
    }
    const waferCount = data.waferCount;
    const markCount = data.markCount;
    const perWafer = {};
    const samples = {};
    for (const component of components()) {
      perWafer[component.key] = { rmsX: new Float64Array(waferCount), rmsY: new Float64Array(waferCount), maxLength: new Float64Array(waferCount) };
      samples[component.key] = { length: [], x: [], y: [] };
    }
    for (let wafer = 0; wafer < waferCount; wafer++) {
      const parts = ASC.evaluationData.waferComponents(data, wafer);
      for (const component of components()) {
        const { x, y } = parts[component.key];
        const sample = samples[component.key];
        let sumX = 0;
        let sumY = 0;
        let maxLength = 0;
        for (let i = 0; i < markCount; i++) {
          const length = Math.hypot(x[i], y[i]);
          sumX += x[i] * x[i];
          sumY += y[i] * y[i];
          maxLength = Math.max(maxLength, length);
          if (wafer < SCALE_SAMPLE_WAFERS) {
            sample.length.push(length);
            sample.x.push(Math.abs(x[i]));
            sample.y.push(Math.abs(y[i]));
          }
        }
        perWafer[component.key].rmsX[wafer] = Math.sqrt(sumX / markCount);
        perWafer[component.key].rmsY[wafer] = Math.sqrt(sumY / markCount);
        perWafer[component.key].maxLength[wafer] = maxLength;
      }
    }
    const scales = {};
    for (const component of components()) {
      const sample = samples[component.key];
      const scaleOf = (values) => ASC.math.percentileOfSorted(values.sort((a, b) => a - b), SCALE_PERCENT);
      scales[component.key] = { vector: scaleOf(sample.length), x: scaleOf(sample.x), y: scaleOf(sample.y) };
    }
    const statistics = { perWafer, scales };
    statisticsCache.set(data, statistics);
    return statistics;
  }

  /** value 以下で最も大きい「きりのよい値」（1・2・5 × 10のべき）。目盛りの矢印に使う。 */
  function niceValueBelow(value) {
    const exponent = Math.floor(Math.log10(value));
    let best = Math.pow(10, exponent);
    for (const factor of NICE_FACTORS) {
      const candidate = factor * Math.pow(10, exponent);
      if (candidate <= value) {
        best = candidate;
      }
    }
    return best;
  }

  /** 色マップの段階（1〜9）。scale を超える値は端の段階にまとめる。 */
  function divergingStep(value, scale) {
    const ratio = Math.max(-1, Math.min(1, value / scale));
    return Math.min(DIVERGING_STEPS, Math.floor(((ratio + 1) / 2) * DIVERGING_STEPS) + 1);
  }

  // ---- 描画 ------------------------------------------------------------------

  function markText(map, markIndex, x, y) {
    const mark = map.marks[markIndex];
    const shot = map.shots[mark.shotIndex];
    return `Shot ${shot.id} Mark ${mark.markNo}（${ui.formatNumber(mark.x, 1)}, ${ui.formatNumber(mark.y, 1)} mm）: X ${ui.formatNumber(x)} nm、Y ${ui.formatNumber(y)} nm`;
  }

  /**
   * 1枚のWaferの図（SVG）。display は "vector"（矢印）・"x"・"y"（色マップ）。
   * scale はその成分の目盛り（矢印なら大きさ、色なら X か Y の絶対値の95%点）。withTitles で各点に値の説明を付ける。
   */
  function waferSvg(map, values, display, scale, options) {
    const size = VIEW_HALF_SIZE_MM * 2;
    const svg = ui.createSvg("svg", {
      viewBox: `${-VIEW_HALF_SIZE_MM} ${-VIEW_HALF_SIZE_MM} ${size} ${size}`,
      role: "img",
      "aria-label": options.ariaLabel,
    });
    const markerId = `data-arrow-head-${++markerCounter}`;
    if (display === "vector") {
      svg.append(
        ui.createSvg("defs", null,
          ui.createSvg("marker", { id: markerId, viewBox: "0 0 6 6", refX: 5, refY: 3, markerWidth: 4, markerHeight: 4, orient: "auto" },
            ui.createSvg("path", { className: "data-arrow-head", d: "M0,0 L6,3 L0,6 z" })
          )
        )
      );
    }
    svg.append(ui.createSvg("circle", { className: "map-wafer", cx: 0, cy: 0, r: ASC.constants.WAFER_RADIUS_MM }));
    const shotLayer = ui.createSvg("g");
    for (const shot of map.shots) {
      shotLayer.append(
        ui.createSvg("rect", {
          className: "map-shot",
          x: shot.x - map.shotWidthMm / 2,
          y: -(shot.y + map.shotHeightMm / 2),
          width: map.shotWidthMm,
          height: map.shotHeightMm,
        })
      );
    }
    svg.append(shotLayer);
    svg.append(ui.createSvg("circle", { className: "data-wafer-edge", cx: 0, cy: 0, r: ASC.constants.WAFER_RADIUS_MM }));

    const layer = ui.createSvg("g");
    if (display === "vector") {
      const mmPerNm = scale > 0 ? ARROW_REFERENCE_MM / scale : 0;
      if (options.withScale && scale > 0) {
        // 目盛りの矢印は地図と同じ縮尺で、地図の中（左下）に描く
        const reference = niceValueBelow(scale);
        const { x, y } = SCALE_ARROW_ORIGIN_MM;
        svg.append(
          ui.createSvg("g", { className: "data-scale-in-map" }, [
            ui.createSvg("line", { className: "data-arrow", x1: x, y1: -y, x2: x + reference * mmPerNm, y2: -y, "marker-end": `url(#${markerId})` }),
            ui.createSvg("text", { className: "data-scale-text", x: x, y: -y - 4, "font-size": SCALE_TEXT_SIZE_MM, text: `${reference} nm` }),
          ])
        );
      }
      map.marks.forEach((mark, markIndex) => {
        const dx = values.x[markIndex] * mmPerNm;
        const dy = values.y[markIndex] * mmPerNm;
        const element =
          Math.hypot(dx, dy) < ARROW_MIN_LENGTH_MM
            ? ui.createSvg("circle", { className: "data-arrow-dot", cx: mark.x, cy: -mark.y, r: 0.6 })
            : ui.createSvg("line", { className: "data-arrow", x1: mark.x, y1: -mark.y, x2: mark.x + dx, y2: -(mark.y + dy), "marker-end": `url(#${markerId})` });
        if (options.withTitles) {
          element.append(ui.createSvg("title", { text: markText(map, markIndex, values.x[markIndex], values.y[markIndex]) }));
        }
        layer.append(element);
      });
    } else {
      const axisValues = display === "x" ? values.x : values.y;
      map.marks.forEach((mark, markIndex) => {
        const step = scale > 0 ? divergingStep(axisValues[markIndex], scale) : (DIVERGING_STEPS + 1) / 2;
        const circle = ui.createSvg("circle", { className: `data-color-mark div-${step}`, cx: mark.x, cy: -mark.y, r: COLOR_MARK_RADIUS_MM });
        if (options.withTitles) {
          circle.append(ui.createSvg("title", { text: markText(map, markIndex, values.x[markIndex], values.y[markIndex]) }));
        }
        layer.append(circle);
      });
    }
    svg.append(layer);
    return svg;
  }

  /** 目盛りの説明（矢印の長さか、色の段階）。 */
  function scaleLegend(display, scale) {
    if (!(scale > 0)) {
      return ui.create("p", { className: "hint", text: "この成分はすべて0です（設定で大きさを0にしているか、オフにしています）。" });
    }
    if (display === "vector") {
      const reference = niceValueBelow(scale);
      return ui.create("div", null, [
        ui.create("p", { className: "data-scale-row", text: `地図の左下の矢印の長さが ${reference} nm です。` }),
        ui.create("p", { className: "hint", text: `矢印はMarkの位置から、ずれ（X, Y）の向きに伸ばしています。長さの目盛りはこの成分で全Wafer共通です（全Waferのずれの大きさの${SCALE_PERCENT}%点を ${ARROW_REFERENCE_MM} mm で描画）。` }),
      ]);
    }
    const width = (2 * scale) / DIVERGING_STEPS;
    const items = [];
    for (let step = 1; step <= DIVERGING_STEPS; step++) {
      const low = -scale + (step - 1) * width;
      const high = low + width;
      let text = `${ui.formatNumber(low, 2)}〜${ui.formatNumber(high, 2)} nm`;
      if (step === 1) {
        text = `${ui.formatNumber(high, 2)} nm 未満（−）`;
      } else if (step === DIVERGING_STEPS) {
        text = `${ui.formatNumber(low, 2)} nm 以上（＋）`;
      } else if (step === (DIVERGING_STEPS + 1) / 2) {
        text = `${text}（ほぼ0）`;
      }
      items.push(ui.create("li", null, [ui.create("span", { className: "step-swatch", style: `background:var(--div-${step})` }), text]));
    }
    return ui.create("div", null, [
      ui.create("p", { className: "hint", text: `青が負（−）、赤が正（＋）、灰色がほぼ0です。目盛りはこの成分で全Wafer共通です（絶対値の${SCALE_PERCENT}%点で端の色）。各Markにポインターを合わせると値が出ます。` }),
      ui.create("ul", { className: "step-legend vertical", "aria-label": "色の目盛り" }, items),
    ]);
  }

  /** 表示中のWaferの、成分ごとの大きさの表。 */
  function waferTable(statistics, wafer, currentKey) {
    const rows = components().map((component) => {
      const entry = statistics.perWafer[component.key];
      const current = component.key === currentKey;
      return ui.create("tr", { className: current ? "current-row" : null, "aria-current": current ? "true" : null }, [
        ui.create("th", { scope: "row", text: current ? `▶ ${component.shortLabel}（表示中）` : component.shortLabel }),
        ui.create("td", { className: "number", text: ui.formatNumber(entry.rmsX[wafer]) }),
        ui.create("td", { className: "number", text: ui.formatNumber(entry.rmsY[wafer]) }),
        ui.create("td", { className: "number", text: ui.formatNumber(entry.maxLength[wafer]) }),
      ]);
    });
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, [
          ui.create("th", { text: "成分" }),
          ui.create("th", { className: "number", text: "RMS X" }),
          ui.create("th", { className: "number", text: "RMS Y" }),
          ui.create("th", { className: "number", text: "最大の大きさ" }),
        ])),
        ui.create("tbody", null, rows),
      ])
    );
  }

  /** 全Waferでの、成分ごとの大きさのばらつきの表。 */
  function spreadTable(statistics) {
    const rows = components().map((component) => {
      const entry = statistics.perWafer[component.key];
      const rmsX = ASC.math.summarize(Array.from(entry.rmsX));
      const rmsY = ASC.math.summarize(Array.from(entry.rmsY));
      const maxLength = ASC.math.summarize(Array.from(entry.maxLength));
      return ui.create("tr", null, [
        ui.create("th", { scope: "row", text: component.label }),
        ui.create("td", { className: "number", text: ui.formatNumber(rmsX.mean) }),
        ui.create("td", { className: "number", text: ui.formatNumber(rmsX.p95) }),
        ui.create("td", { className: "number", text: ui.formatNumber(rmsY.mean) }),
        ui.create("td", { className: "number", text: ui.formatNumber(rmsY.p95) }),
        ui.create("td", { className: "number", text: ui.formatNumber(maxLength.max) }),
      ]);
    });
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, [
          ui.create("th", { text: "成分" }),
          ui.create("th", { className: "number", text: "RMS X 平均" }),
          ui.create("th", { className: "number", text: "RMS X 95%点" }),
          ui.create("th", { className: "number", text: "RMS Y 平均" }),
          ui.create("th", { className: "number", text: "RMS Y 95%点" }),
          ui.create("th", { className: "number", text: "最大の大きさ" }),
        ])),
        ui.create("tbody", null, rows),
      ])
    );
  }

  /** 表示中のWaferのZernike項の係数（使っている項だけ）。 */
  function coefficientTable(data, wafer) {
    const termCount = data.fringeIndices.length;
    if (termCount === 0) {
      return ui.create("p", { className: "hint", text: "使っているZernike項がありません（すべて大きさ0かオフです）。" });
    }
    const rows = data.fringeIndices.map((fringe, k) => {
      const term = ASC.zernike.termByFringe(fringe);
      return ui.create("tr", null, [
        ui.create("th", { scope: "row", text: `Z${fringe}` }),
        ui.create("td", { className: "number", text: String(term.n) }),
        ui.create("td", { className: "number", text: String(term.m) }),
        ui.create("td", { text: term.polynomialExpressible ? "5次以下" : "6次以上" }),
        ui.create("td", { className: "number", text: ui.formatNumber(data.coefficientsX[wafer * termCount + k]) }),
        ui.create("td", { className: "number", text: ui.formatNumber(data.coefficientsY[wafer * termCount + k]) }),
      ]);
    });
    return ui.create("div", { className: "table-scroll tall" },
      ui.create("table", null, [
        ui.create("thead", null, ui.create("tr", null, [
          ui.create("th", { text: "項" }),
          ui.create("th", { className: "number", text: "n" }),
          ui.create("th", { className: "number", text: "m" }),
          ui.create("th", { text: "区分" }),
          ui.create("th", { className: "number", text: "X の係数 [nm]" }),
          ui.create("th", { className: "number", text: "Y の係数 [nm]" }),
        ])),
        ui.create("tbody", null, rows),
      ])
    );
  }

  function field(id, labelText, control, errorId) {
    return ui.create("div", { className: "field" }, [ui.create("label", { for: id, text: labelText }), control, errorId ? ui.create("p", { className: "field-error", id: errorId }) : null]);
  }

  function select(id, options, value, onChange) {
    const element = ui.create("select", { id }, options.map((option) => ui.create("option", { value: option.key, text: option.label })));
    element.value = value;
    element.addEventListener("change", () => onChange(element.value));
    return element;
  }

  // ---- タブ全体 --------------------------------------------------------------

  /**
   * タブを描く。
   * input: { map, data, errors, view: { wafer（0始まり）, component, display, page }, onChange(部分的な view), onDownload(wafer) }
   */
  function render(container, input) {
    const { map, data, view } = input;
    if (!map || !data) {
      const items = (input.errors || []).map((text) => ui.create("li", { text }));
      container.replaceChildren(
        ui.create("p", { className: "empty-state", text: "評価データを作れません。左の「1. Waferマップ」と「2. 評価データ」の設定を直してください。" }),
        items.length > 0 ? ui.create("ul", null, items) : null
      );
      return;
    }
    const waferCount = data.waferCount;
    const wafer = Math.max(0, Math.min(waferCount - 1, view.wafer));
    const component = components().find((entry) => entry.key === view.component) || components()[0];
    const display = DISPLAYS.find((entry) => entry.key === view.display) || DISPLAYS[0];
    const statistics = statisticsOf(data);
    const parts = ASC.evaluationData.waferComponents(data, wafer);
    const scale = statistics.scales[component.key][display.key];

    const waferInput = ui.create("input", { type: "number", id: "data-wafer", min: 1, max: waferCount, step: 1, value: wafer + 1, className: "compact-input" });
    waferInput.addEventListener("change", () => {
      const number = Number(waferInput.value);
      const error = ui.byId("data-wafer-error");
      if (!Number.isInteger(number) || number < 1 || number > waferCount) {
        error.textContent = `1〜${waferCount}の整数を入れてください。`;
        return;
      }
      error.textContent = "";
      input.onChange({ wafer: number - 1, page: Math.floor((number - 1) / THUMBNAILS_PER_PAGE) });
    });
    const goTo = (target) => input.onChange({ wafer: target, page: Math.floor(target / THUMBNAILS_PER_PAGE) });
    const toolbar = ui.create("div", { className: "toolbar" }, [
      field("data-wafer", `Wafer番号（1〜${waferCount}）`, waferInput, "data-wafer-error"),
      ui.create("button", { type: "button", className: "button-secondary", id: "data-previous", text: "← 前のWafer", disabled: wafer === 0, onClick: () => goTo(wafer - 1) }),
      ui.create("button", { type: "button", className: "button-secondary", id: "data-next", text: "次のWafer →", disabled: wafer === waferCount - 1, onClick: () => goTo(wafer + 1) }),
      field("data-component", "表示する成分", select("data-component", components(), component.key, (value) => input.onChange({ component: value }))),
      field("data-display", "表示の形", select("data-display", DISPLAYS, display.key, (value) => input.onChange({ display: value }))),
      ui.create("button", { type: "button", className: "button-secondary", id: "data-download", text: "このWaferのずれをCSVで保存", onClick: () => input.onDownload(wafer) }),
    ]);

    const mainFrame = ui.create("div", { className: "map-frame" },
      waferSvg(map, parts[component.key], display.key, scale, {
        withTitles: true,
        withScale: true,
        ariaLabel: `Wafer ${wafer + 1} の${component.label}の${display.label}`,
      })
    );
    const side = ui.create("div", null, [
      ui.create("h2", { className: "subheading", text: "目盛り" }),
      scaleLegend(display.key, scale),
      ui.create("h2", { className: "subheading", text: `Wafer ${wafer + 1} の大きさ [nm]` }),
      waferTable(statistics, wafer, component.key),
      ui.create("p", { className: "hint", text: "RMS は全Markでの二乗平均平方根、最大の大きさは √(X²＋Y²) の最大です。" }),
    ]);

    // 全Waferの一覧（ページごとに小さく並べる。押すとそのWaferを上に表示）
    const pageCount = Math.ceil(waferCount / THUMBNAILS_PER_PAGE);
    const page = Math.max(0, Math.min(pageCount - 1, Number.isInteger(view.page) ? view.page : Math.floor(wafer / THUMBNAILS_PER_PAGE)));
    const first = page * THUMBNAILS_PER_PAGE;
    const last = Math.min(waferCount, first + THUMBNAILS_PER_PAGE);
    const thumbnails = [];
    for (let index = first; index < last; index++) {
      const thumbParts = ASC.evaluationData.waferComponents(data, index);
      const entry = statistics.perWafer[component.key];
      const current = index === wafer;
      const caption = `Wafer ${index + 1}${current ? "（表示中）" : ""}`;
      const detail = `RMS X ${ui.formatNumber(entry.rmsX[index], 2)}・Y ${ui.formatNumber(entry.rmsY[index], 2)} nm`;
      thumbnails.push(
        ui.create("button", {
          type: "button",
          className: current ? "data-thumb current" : "data-thumb",
          "aria-current": current ? "true" : null,
          "aria-label": `${caption}を上に表示（${detail}）`,
          onClick: () => input.onChange({ wafer: index }),
        }, [
          waferSvg(map, thumbParts[component.key], display.key, scale, { withTitles: false, ariaLabel: "" }),
          ui.create("span", { className: "data-thumb-caption", text: caption }),
          ui.create("span", { className: "data-thumb-detail", text: detail }),
        ])
      );
    }
    const pager = ui.create("div", { className: "toolbar" }, [
      ui.create("button", { type: "button", className: "button-secondary", id: "data-page-previous", text: `← 前の${THUMBNAILS_PER_PAGE}枚`, disabled: page === 0, onClick: () => input.onChange({ page: page - 1 }) }),
      ui.create("span", { className: "data-page-text", text: `Wafer ${first + 1}〜${last}（全${waferCount}枚）` }),
      ui.create("button", { type: "button", className: "button-secondary", id: "data-page-next", text: `次の${THUMBNAILS_PER_PAGE}枚 →`, disabled: page >= pageCount - 1, onClick: () => input.onChange({ page: page + 1 }) }),
    ]);

    container.replaceChildren(
      ui.create("p", {
        className: "hint",
        text: "「評価を実行」で使うものと同じ評価データです（左の「2. 評価データ」の設定とシードで決まり、同じ設定なら毎回同じ値になります）。「5次以下」は5次までの多項式（21項）ですべて表せる成分で、補正モデルで項を減らすと一部は補正しきれません。「6次以上」とScan方向のずれは、多項式では補正できない成分です。",
      }),
      toolbar,
      ui.create("div", { className: "map-layout" }, [mainFrame, side]),
      ui.create("h2", { className: "subheading", text: `Wafer ${wafer + 1} のZernike項の係数` }),
      ui.create("p", { className: "hint", text: "各項の値（正規化なしなら単位円の端で最大1）に掛けた乱数の係数です。大きさ0かオフにした項は使っていないので出しません。" }),
      coefficientTable(data, wafer),
      ui.create("h2", { className: "subheading", text: `全Waferの一覧（${component.shortLabel}・${display.label}）` }),
      pager,
      ui.create("div", { className: "data-thumbs" }, thumbnails),
      ui.create("h2", { className: "subheading", text: `全${waferCount}枚のばらつき（Waferごとの大きさ [nm]）` }),
      spreadTable(statistics)
    );
  }

  /** 1枚のWaferのずれ（成分ごと）をCSVにする。 */
  function waferCsv(map, data, wafer) {
    const parts = ASC.evaluationData.waferComponents(data, wafer);
    const keys = components().map((component) => component.key);
    const header = ["Wafer", "ShotId", "MarkNo", "X_mm", "Y_mm"].concat(keys.flatMap((key) => [`${key}X_nm`, `${key}Y_nm`]));
    const lines = [header.join(",")];
    map.marks.forEach((mark, markIndex) => {
      const cells = [wafer + 1, map.shots[mark.shotIndex].id, mark.markNo, mark.x, mark.y].concat(keys.flatMap((key) => [parts[key].x[markIndex], parts[key].y[markIndex]]));
      lines.push(cells.map(ui.csvCell).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  ASC.dataView = { render, waferCsv };
})(typeof window !== "undefined" ? window : globalThis);
