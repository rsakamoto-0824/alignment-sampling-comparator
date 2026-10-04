/**
 * Waferマップの描画（SVG）と、手動選択のクリック操作。
 * 座標は mm のまま描き、SVGでは y を反転する（画面の上が +y）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  const VIEW_HALF_SIZE_MM = 162;
  const MARK_RADIUS_MM = 1.6;
  const MARK_HIT_RADIUS_MM = 3.5;
  // 推定誤差などを色で示すMarkは、色が見えるように大きめに描く
  const STEP_MARK_RADIUS_MM = 2.6;
  const CENTER_RING_RADIUS_MM = 4.5;
  const SCAN_GLYPH_MIN_SHOT_MM = 10;
  const QUADRANT_LABEL_OFFSET_MM = 138;
  // 選べないShotは色だけでなく斜線でも示す（濃色表示や白黒印刷でも区別できるように）
  const HATCH_ID_MAP = "map-hatch";
  const HATCH_ID_LEGEND = "legend-hatch";

  function hatchPattern(id, spacing) {
    return ui.createSvg("defs", null,
      ui.createSvg("pattern", { id, width: spacing, height: spacing, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, [
        ui.createSvg("rect", { className: "map-hatch-background", width: spacing, height: spacing }),
        ui.createSvg("line", { className: "map-hatch-line", x1: 0, y1: 0, x2: 0, y2: spacing }),
      ])
    );
  }

  /**
   * マップを描く。options:
   *   map, zones, eligibleShots(Set), selectedShots(Set), measuredMarks(Set), centerMarkIndex,
   *   editable, extraCandidates(Set: クリックで追加・解除できるMark), onToggleShot, onToggleMark
   *   compact（小さく並べる用。Scan方向・区画の文字を省く）、
   *   shotSteps（Map: Shot番号 → { step: 1〜5, text }。選ばれた割合などを段階色で塗る）、
   *   markSteps（Map: Mark番号 → { step: 1〜5, text }。推定誤差などをMarkの段階色で示す）、ariaLabel
   */
  function render(container, options) {
    const { map, zones } = options;
    const size = VIEW_HALF_SIZE_MM * 2;
    const svg = ui.createSvg("svg", {
      viewBox: `${-VIEW_HALF_SIZE_MM} ${-VIEW_HALF_SIZE_MM} ${size} ${size}`,
      role: "img",
      "aria-label": options.ariaLabel || "Waferマップ。Shot、Mark、Scan方向、4象限と同心円の区切り、選んだ点を表示",
    });
    svg.append(hatchPattern(HATCH_ID_MAP, 4));
    svg.append(ui.createSvg("circle", { className: "map-wafer", cx: 0, cy: 0, r: C.WAFER_RADIUS_MM }));

    const shotLayer = ui.createSvg("g");
    const markLayer = ui.createSvg("g");
    const width = map.shotWidthMm;
    const height = map.shotHeightMm;
    map.shots.forEach((shot, shotIndex) => {
      shotLayer.append(drawShot(shot, shotIndex, width, height, options));
      if (!options.compact && Math.min(width, height) >= SCAN_GLYPH_MIN_SHOT_MM) {
        shotLayer.append(
          ui.createSvg("text", { className: "map-scan", x: shot.x, y: -shot.y, text: shot.scan === C.SCAN_UP ? "▲" : "▼" })
        );
      }
      for (const markIndex of shot.markIndices) {
        drawMark(markLayer, map, markIndex, options);
      }
    });
    svg.append(shotLayer);
    svg.append(drawGuides(map, zones, Boolean(options.compact)));
    svg.append(markLayer);

    if (options.centerMarkIndex !== null && options.centerMarkIndex !== undefined) {
      const mark = map.marks[options.centerMarkIndex];
      svg.append(ui.createSvg("circle", { className: "map-center", cx: mark.x, cy: -mark.y, r: CENTER_RING_RADIUS_MM }));
    }
    container.replaceChildren(svg);
  }

  function drawShot(shot, shotIndex, width, height, options) {
    const eligible = options.eligibleShots.has(shotIndex);
    const selected = options.selectedShots.has(shotIndex);
    const classes = ["map-shot"];
    if (!eligible) {
      classes.push("not-eligible");
    }
    if (selected) {
      classes.push("selected");
    }
    const editable = options.editable && eligible;
    if (editable) {
      classes.push("editable");
    }
    const stepInfo = options.shotSteps ? options.shotSteps.get(shotIndex) : null;
    if (stepInfo && stepInfo.step > 0) {
      classes.push(`step-${stepInfo.step}`);
    }
    let stateText = selected ? "選択中" : eligible ? "未選択" : "選べない（必ず測るMarkが範囲外）";
    if (stepInfo) {
      stateText = stepInfo.text;
    }
    const label = `Shot ${shot.id}（中心 ${shot.x}, ${shot.y} mm、Scan ${shot.scan}）${stateText}`;
    const rect = ui.createSvg("rect", {
      className: classes.join(" "),
      // CSSのクラスより優先させるため style で指定する
      style: eligible ? null : `fill:url(#${HATCH_ID_MAP})`,
      x: shot.x - width / 2,
      y: -(shot.y + height / 2),
      width,
      height,
    });
    rect.append(ui.createSvg("title", { text: label }));
    if (editable) {
      rect.setAttribute("tabindex", "0");
      rect.setAttribute("role", "button");
      rect.setAttribute("aria-pressed", selected ? "true" : "false");
      rect.setAttribute("aria-label", label);
      rect.addEventListener("click", () => options.onToggleShot(shotIndex));
      rect.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          options.onToggleShot(shotIndex);
        }
      });
    }
    return rect;
  }

  function drawMark(layer, map, markIndex, options) {
    const mark = map.marks[markIndex];
    const measured = options.measuredMarks.has(markIndex);
    const stepInfo = options.markSteps ? options.markSteps.get(markIndex) : null;
    if (stepInfo) {
      const circle = ui.createSvg("circle", {
        className: `map-mark-step step-${stepInfo.step}`,
        cx: mark.x,
        cy: -mark.y,
        r: STEP_MARK_RADIUS_MM,
      });
      circle.append(ui.createSvg("title", { text: `Shot ${map.shots[mark.shotIndex].id} の Mark ${mark.markNo}: ${stepInfo.text}` }));
      layer.append(circle);
      return;
    }
    layer.append(
      ui.createSvg("circle", {
        className: measured ? "map-mark measured" : "map-mark",
        cx: mark.x,
        cy: -mark.y,
        r: MARK_RADIUS_MM,
        "pointer-events": "none",
      })
    );
    if (options.editable && options.extraCandidates.has(markIndex)) {
      const label = `Shot ${map.shots[mark.shotIndex].id} の Mark ${mark.markNo}（追加Mark、${measured ? "測る" : "測らない"}）`;
      const hit = ui.createSvg("circle", {
        className: "map-mark-hit editable",
        cx: mark.x,
        cy: -mark.y,
        r: MARK_HIT_RADIUS_MM,
        fill: "transparent",
        tabindex: "0",
        role: "button",
        "aria-pressed": measured ? "true" : "false",
        "aria-label": label,
      });
      hit.append(ui.createSvg("title", { text: label }));
      const toggle = (event) => {
        event.stopPropagation();
        options.onToggleMark(markIndex);
      };
      hit.addEventListener("click", toggle);
      hit.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle(event);
        }
      });
      layer.append(hit);
    }
  }

  /** 4象限の境界、同心円の区切り、有効半径、ノッチ。compact なら文字を省く。 */
  function drawGuides(map, zones, compact) {
    const group = ui.createSvg("g", { "pointer-events": "none" });
    const radius = C.WAFER_RADIUS_MM;
    // Wafer端のShotに隠れないよう、外周線はShotの上に描く
    group.append(ui.createSvg("circle", { className: "map-wafer-outline", cx: 0, cy: 0, r: radius }));
    group.append(ui.createSvg("line", { className: "map-guide", x1: -radius, y1: 0, x2: radius, y2: 0 }));
    group.append(ui.createSvg("line", { className: "map-guide", x1: 0, y1: -radius, x2: 0, y2: radius }));
    const labelAngle = (-35 * Math.PI) / 180;
    for (const zoneRadius of [zones.innerRadiusMm, zones.outerRadiusMm]) {
      if (zoneRadius > 0 && zoneRadius < radius) {
        group.append(ui.createSvg("circle", { className: "map-guide", cx: 0, cy: 0, r: zoneRadius, "stroke-dasharray": "3 2" }));
        if (compact) {
          continue;
        }
        group.append(
          ui.createSvg("text", {
            className: "map-guide-label",
            x: zoneRadius * Math.cos(labelAngle) + 1,
            y: zoneRadius * Math.sin(labelAngle) - 1,
            text: `r=${zoneRadius}`,
          })
        );
      }
    }
    if (map.validRadiusMm < radius) {
      group.append(ui.createSvg("circle", { className: "map-guide", cx: 0, cy: 0, r: map.validRadiusMm }));
    }
    const notch = C.NOTCH_SIZE_MM;
    group.append(
      ui.createSvg("path", {
        className: "map-guide",
        d: `M ${-notch} ${radius} L 0 ${radius - notch} L ${notch} ${radius}`,
      })
    );
    if (compact) {
      return group;
    }
    const labels = [
      ["第1象限", 1, 1],
      ["第2象限", -1, 1],
      ["第3象限", -1, -1],
      ["第4象限", 1, -1],
    ];
    for (const [text, signX, signY] of labels) {
      group.append(
        ui.createSvg("text", {
          className: "map-guide-label",
          x: signX * QUADRANT_LABEL_OFFSET_MM,
          y: -signY * QUADRANT_LABEL_OFFSET_MM,
          "text-anchor": "middle",
          text,
        })
      );
    }
    return group;
  }

  /** 記号の説明（色だけに頼らず、形と文字で示す）。 */
  function renderLegend(list) {
    const symbol = (children) =>
      ui.createSvg("svg", { className: "legend-symbol", viewBox: "0 0 28 20", "aria-hidden": "true" }, children);
    const items = [
      [symbol([ui.createSvg("rect", { className: "map-shot selected", x: 2, y: 2, width: 24, height: 16 })]), "選んだShot"],
      [symbol([ui.createSvg("rect", { className: "map-shot", x: 2, y: 2, width: 24, height: 16 })]), "選べるが選んでいないShot"],
      [
        symbol([
          hatchPattern(HATCH_ID_LEGEND, 4),
          ui.createSvg("rect", { className: "map-shot not-eligible", style: `fill:url(#${HATCH_ID_LEGEND})`, x: 2, y: 2, width: 24, height: 16 }),
        ]),
        "選べないShot（必ず測るMarkが範囲外、斜線）",
      ],
      [symbol([ui.createSvg("circle", { className: "map-mark measured", cx: 14, cy: 10, r: 4 })]), "測るMark"],
      [symbol([ui.createSvg("circle", { className: "map-mark", cx: 14, cy: 10, r: 4 })]), "測らないMark"],
      [symbol([ui.createSvg("circle", { className: "map-center", cx: 14, cy: 10, r: 7 })]), "中心に最も近いMark（中心の1点）"],
      [symbol([ui.createSvg("text", { className: "map-scan", x: 14, y: 10, style: "font-size:14px", text: "▲" })]), "Scan Up（▼はDown）"],
      [symbol([ui.createSvg("line", { className: "map-guide", x1: 2, y1: 10, x2: 26, y2: 10, "stroke-dasharray": "3 2" })]), "同心円の区切り（実線は4象限の境界）"],
    ];
    list.replaceChildren(...items.map(([icon, text]) => ui.create("li", null, [icon, ui.create("span", { text })])));
  }

  /** log det を常用対数にした値（D基準の表示用）。 */
  function log10Det(logDet) {
    return logDet / Math.LN10;
  }

  /**
   * D基準・I基準の行。criteria は { x, y, sameTerms }、reference は効率の基準（{ x, y }、なければ null）。
   * XとYで多項式の項が同じなら1つにまとめて書く。
   */
  function criteriaRows(criteria, reference) {
    if (!criteria) {
      return [];
    }
    const axes = criteria.sameTerms ? [["", "x"]] : [["X ", "x"], ["Y ", "y"]];
    const dText = axes
      .map(([prefix, axis]) => {
        const entry = criteria[axis];
        if (entry.singular) {
          return `${prefix}計算できない（${entry.reason === "tooFew" ? `点が${entry.n}個で、多項式の${entry.p}項より少ない` : "点が一部の行・列に集まっていて、多項式が決まらない"}）`;
        }
        const efficiency = reference && reference[axis] ? ASC.sampling.efficiencies(entry, reference[axis]).d : NaN;
        return `${prefix}${ui.formatNumber(log10Det(entry.logDet), 2)}${Number.isFinite(efficiency) ? `（効率 ${ui.formatNumber(efficiency, 0)}%）` : ""}`;
      })
      .join("・");
    const iText = axes
      .map(([prefix, axis]) => {
        const entry = criteria[axis];
        if (entry.singular) {
          return `${prefix}計算できない`;
        }
        const efficiency = reference && reference[axis] ? ASC.sampling.efficiencies(entry, reference[axis]).i : NaN;
        return `${prefix}${ui.formatNumber(entry.trace, 3)}（κ ${ui.formatNumber(entry.kappa, 2)}${Number.isFinite(efficiency) ? `、効率 ${ui.formatNumber(efficiency, 0)}%` : ""}）`;
      })
      .join("・");
    return [
      ["D基準 log₁₀det(XᵀX)", dText],
      ["I基準 予測分散の平均÷σ²", iText],
    ];
  }

  /** 選んだ点の数・間隔・D基準・I基準。 */
  function renderStats(element, stats) {
    const rows = [
      ["Shot数", `${stats.shotCount}個`],
      ["Mark数", `${stats.markCount}個`],
      ["Shot中心の最小間隔", Number.isFinite(stats.minSpacingMm) ? `${ui.formatNumber(stats.minSpacingMm, 1)} mm` : "—"],
    ].concat(criteriaRows(stats.criteria, stats.reference));
    element.replaceChildren(...rows.flatMap(([term, value]) => [ui.create("dt", { text: term }), ui.create("dd", { text: value })]));
  }

  /** 区画ごとの数と目標を「Up 12 / Down 8（目標 10 / 10）」の形にする。 */
  function classCountText(row) {
    const counts = row.classes.map((entry) => `${entry.shortLabel} ${entry.count}`).join(" / ");
    const targets = row.classes.map((entry) => (entry.floor === entry.ceil ? `${entry.floor}` : `${entry.floor}〜${entry.ceil}`)).join(" / ");
    return `${counts}（目標 ${targets}）`;
  }

  /**
   * 制約の満たし具合の表（制約ごとに1行）。判定は記号と文字で示し、外れたときは何個のShotを移せば満たせるか（ずれ）を書く。
   */
  function renderConstraintStatus(container, status, relaxedKeys) {
    if (!status) {
      container.replaceChildren(ui.create("p", { className: "hint", text: "設定に誤りがあるため判定できません。" }));
      return;
    }
    container.replaceChildren(constraintTable(status, relaxedKeys || new Set()));
  }

  function constraintTable(status, relaxedKeys) {
    const verdict = (ok, text) => ui.create("span", { className: ok ? "status-ok" : "status-ng", text: `${ok ? "✓" : "✕"} ${text}` });
    const kindText = (row) => {
      if (row.key === "center") {
        return row.hard ? "ハード" : "ソフトに切替";
      }
      return row.hard ? "ハード" : relaxedKeys.has(row.key) ? "ソフトに切替" : "ソフト";
    };
    const body = ui.create("tbody");
    if (status.center) {
      body.append(
        ui.create("tr", null, [
          ui.create("th", { scope: "row", text: `${status.center.label}（${kindText(status.center)}）` }),
          ui.create("td", { text: "中心に最も近いMark" }),
          ui.create("td", null, verdict(status.center.ok, status.center.ok ? "測る" : "測らない")),
        ])
      );
    }
    for (const row of status.rows) {
      body.append(
        ui.create("tr", null, [
          ui.create("th", { scope: "row", text: `${row.label}（${kindText(row)}）` }),
          ui.create("td", { text: classCountText(row) }),
          ui.create("td", null, verdict(row.ok, row.ok ? "満たす" : `${row.shift}個ずれ`)),
        ])
      );
    }
    if (body.children.length === 0) {
      return ui.create("p", { className: "hint", text: "オンにした制約はありません。" });
    }
    return ui.create("div", { className: "table-scroll" },
      ui.create("table", { className: "constraint-table" }, [
        ui.create("thead", null, ui.create("tr", null, [ui.create("th", { text: "制約" }), ui.create("th", { text: "区画ごとの数（目標）" }), ui.create("th", { text: "判定" })])),
        body,
      ])
    );
  }

  ASC.mapView = { render, renderLegend, renderStats, renderConstraintStatus, constraintTable, criteriaRows, log10Det };
})(typeof window !== "undefined" ? window : globalThis);
