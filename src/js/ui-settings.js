/**
 * 左側の設定欄。入力欄と設定（state.settings）を結び、入力の誤りをその場で知らせる。
 *
 * data-setting="a.b.c" を付けた入力欄は、値が変わると settings の同じ場所を書き換える。
 * 数値の欄は data-integer / data-min / data-max / data-min-exclusive で範囲を確かめる。
 * 誤りのある欄は settings を書き換えず、state.invalidFields に入れて実行できないようにする。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const ui = ASC.ui;

  // 入力欄の種類ごとに、どの再計算が要るかを決める
  const CHANGE_KIND_BY_PREFIX = {
    map: "map",
    evaluationData: "data",
    model: "model",
    sampling: "sampling",
    constraints: "constraints",
    zones: "constraints",
  };

  let state = null;
  let notifyChange = null;

  function changeKindOf(path) {
    return CHANGE_KIND_BY_PREFIX[path.split(".")[0]] || "other";
  }

  /** ラベルの文字（誤りの説明に使う）。 */
  function labelOf(input) {
    const label = input.id ? document.querySelector(`label[for="${input.id}"]`) : null;
    return label ? label.textContent.replace(/\s*\[.*\]\s*$/, "") : "この欄";
  }

  /** 数値の欄を確かめ、{ value, error } を返す。 */
  function readNumber(input) {
    const text = input.value.trim();
    const label = labelOf(input);
    if (text === "") {
      return { value: null, error: `${label}が空です。数値を入れてください。` };
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return { value: null, error: `${label}に数値以外が入っています。半角の数値にしてください。` };
    }
    if (input.hasAttribute("data-integer") && !Number.isInteger(value)) {
      return { value: null, error: `${label}は整数にしてください。` };
    }
    const min = input.dataset.min;
    const max = input.dataset.max;
    const minExclusive = input.dataset.minExclusive;
    if (min !== undefined && value < Number(min)) {
      return { value: null, error: `${label}は${min}以上にしてください。` };
    }
    if (minExclusive !== undefined && value <= Number(minExclusive)) {
      return { value: null, error: `${label}は${minExclusive}より大きい値にしてください。` };
    }
    if (max !== undefined && value > Number(max)) {
      return { value: null, error: `${label}は${max}以下にしてください。` };
    }
    return { value, error: null };
  }

  function showFieldError(input, message) {
    const errorElement = input.id ? ui.byId(`${input.id}-error`) : null;
    if (message) {
      input.setAttribute("aria-invalid", "true");
      state.invalidFields.add(input.id || input.name);
    } else {
      input.removeAttribute("aria-invalid");
      state.invalidFields.delete(input.id || input.name);
    }
    if (errorElement) {
      errorElement.textContent = message || "";
      if (message) {
        input.setAttribute("aria-describedby", errorElement.id);
      }
    }
  }

  /** data-setting の欄の値を settings に書く。 */
  function handleBoundInput(event) {
    const input = event.target;
    const path = input.dataset.setting;
    let value;
    if (input.type === "checkbox") {
      value = input.checked;
    } else if (input.type === "radio") {
      if (!input.checked) {
        return;
      }
      value = input.value;
    } else if (input.type === "number") {
      const result = readNumber(input);
      showFieldError(input, result.error);
      if (result.error) {
        return;
      }
      value = result.value;
    } else if (input.dataset.type === "hardsoft") {
      value = input.value === "hard";
    } else if (input.dataset.type === "int") {
      value = Number(input.value);
    } else {
      value = input.value;
    }
    ui.setPath(state.settings, path, value);
    notifyChange(changeKindOf(path));
  }

  /** settings の値を、data-setting の欄にすべて書く（JSON読込のあとなど）。 */
  function writeBoundInputs() {
    for (const input of document.querySelectorAll("[data-setting]")) {
      const value = ui.getPath(state.settings, input.dataset.setting);
      if (input.type === "checkbox") {
        input.checked = Boolean(value);
      } else if (input.type === "radio") {
        input.checked = input.value === value;
      } else if (input.dataset.type === "hardsoft") {
        input.value = value ? "hard" : "soft";
      } else {
        input.value = value;
      }
      if (input.type === "number") {
        showFieldError(input, null);
      }
    }
  }

  function fillSelect(select, options) {
    select.replaceChildren(...Object.entries(options).map(([value, text]) => ui.create("option", { value, text })));
  }

  // ---- Shot内のMarkの表 ----------------------------------------------------

  function renderMarkTable() {
    const body = ui.byId("mark-table").querySelector("tbody");
    body.replaceChildren();
    // 行番号で覚えている誤りは、表を作り直すと位置がずれるので消す
    for (const key of Array.from(state.invalidFields)) {
      if (key.startsWith("mark-")) {
        state.invalidFields.delete(key);
      }
    }
    ui.byId("mark-table-error").textContent = "";
    state.settings.map.marks.forEach((mark, index) => {
      const cellInput = (key, label, integer) =>
        ui.create("input", {
          type: "number",
          step: integer ? "1" : "any",
          value: mark[key],
          "aria-label": `${index + 1}行目の${label}`,
          onInput: (event) => {
            const value = Number(event.target.value);
            const valid = event.target.value.trim() !== "" && Number.isFinite(value) && (!integer || (Number.isInteger(value) && value >= 1));
            event.target.setAttribute("aria-invalid", valid ? "false" : "true");
            if (valid) {
              mark[key] = value;
              state.invalidFields.delete(`mark-${index}-${key}`);
            } else {
              state.invalidFields.add(`mark-${index}-${key}`);
            }
            ui.byId("mark-table-error").textContent = valid ? "" : `${index + 1}行目の${label}を${integer ? "1以上の整数" : "数値"}にしてください。`;
            notifyChange("map");
          },
        });
      body.append(
        ui.create("tr", null, [
          ui.create("td", null, cellInput("markNo", "Mark番号", true)),
          ui.create("td", null, cellInput("x", "X", false)),
          ui.create("td", null, cellInput("y", "Y", false)),
          ui.create("td", null,
            ui.create("button", {
              type: "button",
              className: "button-secondary button-small",
              text: "削除",
              "aria-label": `Mark ${mark.markNo} を削除`,
              disabled: state.settings.map.marks.length <= 1 ? "disabled" : null,
              onClick: () => {
                state.settings.map.marks.splice(index, 1);
                renderMarkTable();
                notifyChange("map");
              },
            })
          ),
        ])
      );
    });
  }

  function addMarkRow() {
    const marks = state.settings.map.marks;
    const nextNo = marks.reduce((max, mark) => Math.max(max, mark.markNo), 0) + 1;
    marks.push({ markNo: nextNo, x: 0, y: 0 });
    renderMarkTable();
    notifyChange("map");
  }

  // ---- Zernikeの表 ---------------------------------------------------------

  function renderZernikeTable() {
    const body = ui.byId("zernike-table").querySelector("tbody");
    body.replaceChildren();
    state.settings.evaluationData.terms.forEach((termSetting) => {
      const term = ASC.zernike.termByFringe(termSetting.fringeIndex);
      const valueInput = (key, axis) =>
        ui.create("input", {
          type: "number",
          step: "any",
          min: "0",
          value: termSetting[key],
          "aria-label": `Z${term.fringeIndex} の ${axis} の大きさ`,
          onInput: (event) => {
            const value = Number(event.target.value);
            const valid = event.target.value.trim() !== "" && Number.isFinite(value) && value >= 0;
            event.target.setAttribute("aria-invalid", valid ? "false" : "true");
            const id = `zernike-${term.fringeIndex}-${key}`;
            if (valid) {
              termSetting[key] = value;
              state.invalidFields.delete(id);
            } else {
              state.invalidFields.add(id);
            }
            ui.byId("zernike-table-error").textContent = valid ? "" : `Z${term.fringeIndex} の${axis}は0以上の数値にしてください。`;
            notifyChange("data");
          },
        });
      body.append(
        ui.create("tr", null, [
          ui.create("td", null,
            ui.create("input", {
              type: "checkbox",
              checked: termSetting.enabled ? "checked" : null,
              "aria-label": `Z${term.fringeIndex} を使う`,
              onChange: (event) => {
                termSetting.enabled = event.target.checked;
                notifyChange("data");
              },
            })
          ),
          ui.create("td", { text: `Z${term.fringeIndex}` }),
          ui.create("td", { text: `n=${term.n}, m=${term.m}` }),
          ui.create("td", null, valueInput("xValue", "X")),
          ui.create("td", null, valueInput("yValue", "Y")),
          ui.create("td", { className: "zernike-status", "data-fringe": term.fringeIndex }),
        ])
      );
    });
    updateZernikeStatus();
  }

  /** 選んだ多項式の項で、各Zernike項を正確に補正できるかを表に書く。 */
  function updateZernikeStatus() {
    const termsX = new Set(state.settings.model.termsX);
    const termsY = new Set(state.settings.model.termsY);
    const indexOfMonomial = new Map(ASC.correction.POLYNOMIAL_TERMS.map((term, index) => [`${term.powerX},${term.powerY}`, index]));
    for (const cell of document.querySelectorAll(".zernike-status")) {
      const term = ASC.zernike.termByFringe(Number(cell.dataset.fringe));
      const needed = ASC.zernike.monomialsOf(term).map((monomial) => indexOfMonomial.get(`${monomial.powerX},${monomial.powerY}`));
      const fits = (selected) => needed.every((index) => index !== undefined && selected.has(index));
      const text = (axis, ok) => `${axis}: ${ok ? "○ できる" : "× できない"}`;
      cell.textContent = `${text("X", fits(termsX))} / ${text("Y", fits(termsY))}`;
    }
  }

  function applyBulkAmplitude() {
    const low = Number(ui.byId("bulk-low").value);
    const high = Number(ui.byId("bulk-high").value);
    if (!(low >= 0) || !(high >= 0)) {
      ui.showMessage("error", "まとめて設定できませんでした", ["5次以下・6次以上の値は0以上の数値にしてください。"]);
      return;
    }
    for (const termSetting of state.settings.evaluationData.terms) {
      const term = ASC.zernike.termByFringe(termSetting.fringeIndex);
      const value = term.polynomialExpressible ? low : high;
      termSetting.xValue = value;
      termSetting.yValue = value;
    }
    for (const key of Array.from(state.invalidFields)) {
      if (key.startsWith("zernike-")) {
        state.invalidFields.delete(key);
      }
    }
    ui.byId("zernike-table-error").textContent = "";
    renderZernikeTable();
    notifyChange("data");
  }

  // ---- 多項式の表 ----------------------------------------------------------

  function renderPolynomialTable() {
    const body = ui.byId("polynomial-table").querySelector("tbody");
    body.replaceChildren();
    const model = state.settings.model;
    ASC.correction.POLYNOMIAL_TERMS.forEach((term, index) => {
      const checkbox = (key, axis) =>
        ui.create("input", {
          type: "checkbox",
          checked: model[key].includes(index) ? "checked" : null,
          "aria-label": `${term.label} を${axis}の補正に使う`,
          onChange: (event) => {
            const set = new Set(model[key]);
            if (event.target.checked) {
              set.add(index);
            } else {
              set.delete(index);
            }
            model[key] = Array.from(set).sort((a, b) => a - b);
            notifyChange("model");
          },
        });
      body.append(
        ui.create("tr", null, [
          ui.create("td", { text: term.label }),
          ui.create("td", { text: `${term.order}次` }),
          ui.create("td", null, checkbox("termsX", "X")),
          ui.create("td", null, checkbox("termsY", "Y")),
        ])
      );
    });
  }

  function applyTermPreset(maxOrder) {
    const terms = ASC.correction.POLYNOMIAL_TERMS.map((term, index) => (term.order <= maxOrder ? index : -1)).filter((index) => index >= 0);
    state.settings.model.termsX = terms.slice();
    state.settings.model.termsY = terms.slice();
    renderPolynomialTable();
    notifyChange("model");
  }

  // ---- サンプリング・制約 --------------------------------------------------

  function renderDesignatedMarks() {
    const container = ui.byId("designated-marks");
    container.replaceChildren();
    const markNumbers = state.map ? state.map.markNumbers : [];
    const sampling = state.settings.sampling;
    if (state.map) {
      // マップにない番号は外す。全部なくなったら、最初の番号を選んでおく（マップがないときは選択を残す）
      sampling.designatedMarkNos = sampling.designatedMarkNos.filter((markNo) => markNumbers.includes(markNo));
      if (sampling.designatedMarkNos.length === 0 && markNumbers.length > 0) {
        sampling.designatedMarkNos = [markNumbers[0]];
      }
    }
    for (const markNo of markNumbers) {
      container.append(
        ui.create("label", { className: "choice" }, [
          ui.create("input", {
            type: "checkbox",
            checked: sampling.designatedMarkNos.includes(markNo) ? "checked" : null,
            onChange: (event) => {
              const set = new Set(sampling.designatedMarkNos);
              if (event.target.checked) {
                set.add(markNo);
              } else {
                set.delete(markNo);
              }
              sampling.designatedMarkNos = Array.from(set).sort((a, b) => a - b);
              notifyChange("sampling");
            },
          }),
          ` Mark ${markNo}`,
        ])
      );
    }
  }

  function renderMethodChoices() {
    const container = ui.byId("method-choices");
    container.replaceChildren();
    for (const method of C.METHODS) {
      const input = ui.create("input", { type: "checkbox", "data-setting": `sampling.methods.${method.key}` });
      input.addEventListener("change", handleBoundInput);
      container.append(ui.create("label", { className: "choice" }, [input, ` ${method.label}`]));
    }
  }

  function renderConstraintTable() {
    const body = ui.byId("constraint-table").querySelector("tbody");
    body.replaceChildren();
    for (const key of C.CONSTRAINT_KEYS) {
      const path = `constraints.${key}`;
      const enabled = ui.create("input", { type: "checkbox", "data-setting": `${path}.enabled`, "aria-label": `${C.CONSTRAINT_LABELS[key]}をオンにする` });
      const priority = ui.create("select", { "data-setting": `${path}.priority`, "data-type": "int", "aria-label": `${C.CONSTRAINT_LABELS[key]}の優先度` });
      fillSelect(priority, { 1: "1（最優先）", 2: "2", 3: "3", 4: "4" });
      let kindCell;
      let allocationCell;
      if (key === "center") {
        kindCell = ui.create("td", { text: "常にハード" });
        allocationCell = ui.create("td", { text: "—" });
      } else {
        const kind = ui.create("select", { "data-setting": `${path}.hard`, "data-type": "hardsoft", "aria-label": `${C.CONSTRAINT_LABELS[key]}の種類` });
        fillSelect(kind, { hard: "ハード", soft: "ソフト" });
        const allocation = ui.create("select", { "data-setting": `${path}.allocation`, "aria-label": `${C.CONSTRAINT_LABELS[key]}の配分` });
        fillSelect(allocation, { equal: "同数", proportional: "候補数に比例" });
        kindCell = ui.create("td", null, kind);
        allocationCell = ui.create("td", null, allocation);
      }
      body.append(
        ui.create("tr", null, [
          ui.create("td", { text: C.CONSTRAINT_LABELS[key] }),
          ui.create("td", null, enabled),
          kindCell,
          ui.create("td", null, priority),
          allocationCell,
        ])
      );
    }
    for (const input of body.querySelectorAll("[data-setting]")) {
      input.addEventListener("change", handleBoundInput);
    }
  }

  // ---- 表示の切り替えと補足の文 ------------------------------------------

  /** 設定に応じて、欄の表示・無効化と補足の文を更新する。 */
  function updateDerivedTexts() {
    const settings = state.settings;
    const isCsv = settings.map.source === "csv";
    ui.byId("generate-fields").hidden = isCsv;
    ui.byId("csv-fields").hidden = !isCsv;

    const map = state.map;
    const summary = ui.byId("map-summary");
    if (map) {
      const parts = [`Shot ${map.shots.length}個、有効なMark ${map.marks.length}個`];
      if (map.excludedMarkCount > 0) {
        parts.push(`有効範囲外で外したMark ${map.excludedMarkCount}個`);
      }
      if (map.excludedShotCount > 0) {
        parts.push(`Markがすべて範囲外で外したShot ${map.excludedShotCount}個`);
      }
      summary.textContent = parts.join("、") + "。";
    } else {
      summary.textContent = "マップがまだありません。";
    }

    const sampling = settings.sampling;
    const k = sampling.designatedMarkNos.length;
    const exact = sampling.markMode === "exact";
    const totalInput = ui.byId("total-mark-count");
    totalInput.disabled = exact;
    ui.byId("total-mark-hint").textContent = exact
      ? `ちょうどk個のときは自動で決まります: ${sampling.shotCount} × ${k} = ${sampling.shotCount * k}`
      : `計測Shot数 × 必ず測るMarkの数（${sampling.shotCount} × ${k} = ${sampling.shotCount * k}）以上にしてください。`;

    const eligible = ui.byId("eligible-summary");
    if (map && k > 0) {
      const eligibleCount = map.shots.filter((shot) => {
        const numbers = new Set(shot.markIndices.map((index) => map.marks[index].markNo));
        return sampling.designatedMarkNos.every((markNo) => numbers.has(markNo));
      }).length;
      eligible.textContent = `選べるShot: ${eligibleCount}個（必ず測るMarkのどれかが有効範囲外のShot ${map.shots.length - eligibleCount}個は選べません）。`;
    } else {
      eligible.textContent = "必ず測るMarkを1つ以上選んでください。";
    }

    const model = settings.model;
    ui.byId("polynomial-summary").textContent = `X: ${model.termsX.length}項、Y: ${model.termsY.length}項を使います。`;
    ui.byId("polynomial-table-error").textContent =
      model.termsX.length === 0 || model.termsY.length === 0 ? "X・Yとも1項以上選んでください。" : "";
    const anyFlow = C.FLOWS.some((flow) => model.flows[flow.key]);
    ui.byId("flows-error").textContent = anyFlow ? "" : "補正の流れを1つ以上選んでください。";
    ui.byId("rbf-shape").disabled = model.rbfKernel === "tps";

    const zones = settings.zones;
    const validRadius = map ? map.validRadiusMm : settings.map.validRadiusMm;
    ui.byId("zones-error").textContent =
      zones.innerRadiusMm < zones.outerRadiusMm && zones.outerRadiusMm < validRadius
        ? ""
        : `区切りは「内側 < 外側 < 有効半径（${validRadius} mm）」にしてください。`;
    const priorities = C.CONSTRAINT_KEYS.filter((key) => settings.constraints[key].enabled).map((key) => settings.constraints[key].priority);
    ui.byId("constraint-table-error").textContent =
      new Set(priorities).size === priorities.length ? "" : "オンにした制約の優先度が重複しています。1〜4を1回ずつ使ってください。";
    updateZernikeStatus();
  }

  /** 設定欄を作り、入力と settings を結ぶ。 */
  function initialize(appState, onChange) {
    state = appState;
    notifyChange = onChange;
    fillSelect(ui.byId("scan-pattern"), C.SCAN_PATTERNS);
    fillSelect(ui.byId("rbf-kernel"), C.RBF_KERNELS);
    renderMethodChoices();
    renderConstraintTable();
    for (const input of document.querySelectorAll("[data-setting]")) {
      const eventName = input.type === "number" ? "input" : "change";
      if (!input.closest("#constraint-table") && !input.closest("#method-choices")) {
        input.addEventListener(eventName, handleBoundInput);
      }
    }
    ui.byId("add-mark-button").addEventListener("click", addMarkRow);
    ui.byId("bulk-apply-button").addEventListener("click", applyBulkAmplitude);
    for (const button of document.querySelectorAll("[data-term-preset]")) {
      button.addEventListener("click", () => applyTermPreset(Number(button.dataset.termPreset)));
    }
    ui.byId("copy-x-to-y-button").addEventListener("click", () => {
      state.settings.model.termsY = state.settings.model.termsX.slice();
      renderPolynomialTable();
      notifyChange("model");
    });
    writeAll();
  }

  /** 設定欄全体を settings の内容で書き直す。 */
  function writeAll() {
    state.invalidFields.clear();
    writeBoundInputs();
    renderMarkTable();
    renderZernikeTable();
    renderPolynomialTable();
    renderDesignatedMarks();
    updateDerivedTexts();
  }

  ASC.settingsForm = { initialize, writeAll, renderDesignatedMarks, updateDerivedTexts };
})(typeof window !== "undefined" ? window : globalThis);
