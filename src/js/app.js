/**
 * 画面全体のまとめ役。状態（設定・マップ・手動選択・結果）を持ち、各部品をつなぐ。
 */
(function (root) {
  "use strict";
  const ASC = root.ASC;
  const C = ASC.constants;
  const ui = ASC.ui;

  const SETTINGS_FILE_VERSION = 1;
  const MANUAL_KEY = "manual";

  const state = {
    settings: createInitialSettings(),
    map: null,
    mapErrors: [],
    csvText: null,
    csvFileName: null,
    context: null,
    contextErrors: [],
    manual: { shots: new Set(), marks: new Set() },
    output: null,
    outputStale: false,
    invalidFields: new Set(),
    running: false,
    cancelRequested: false,
    view: { selection: MANUAL_KEY, draw: 0, editing: false, metric: "rms", axis: "x", flowType: "estimateThenHowa", mapChoices: {} },
  };

  function createInitialSettings() {
    const settings = ASC.defaultSettings();
    const data = settings.evaluationData;
    data.terms = ASC.evaluationData.defaultTermSettings(data.lowOrderAmplitudeNm, data.highOrderAmplitudeNm);
    return settings;
  }

  // ---- マップと前提の作り直し --------------------------------------------

  function rebuildMap() {
    const settings = state.settings.map;
    const previousIds = state.map ? state.map.shots.map((shot) => shot.id).join("|") : null;
    let result;
    if (settings.source === "csv") {
      result = state.csvText
        ? ASC.waferMap.parseMapCsv(state.csvText, settings)
        : { map: null, errors: ["CSVファイルを選んでください。"] };
    } else {
      result = ASC.waferMap.generateWaferMap(settings);
    }
    state.map = result.map;
    state.mapErrors = result.errors;
    const currentIds = state.map ? state.map.shots.map((shot) => shot.id).join("|") : null;
    if (previousIds !== currentIds && (state.manual.shots.size > 0 || state.manual.marks.size > 0)) {
      state.manual.shots.clear();
      state.manual.marks.clear();
      ui.showMessage("warning", "マップが変わったため、手動選択を消しました。", ["必要なら「マップと選択点」でもう一度選んでください。"]);
    }
  }

  /** 制約の判定に使う前提（手動選択の表示用）。ハード制約の切り替えはしない。 */
  function rebuildContext() {
    if (!state.map) {
      state.context = null;
      state.contextErrors = state.mapErrors;
      return;
    }
    const built = ASC.constraints.buildContext(state.map, state.settings);
    state.context = built.context;
    state.contextErrors = built.errors;
  }

  function onSettingsChange(kind) {
    if (kind === "map") {
      rebuildMap();
      ASC.settingsForm.renderDesignatedMarks();
    }
    if (state.output) {
      state.outputStale = true;
    }
    rebuildContext();
    ASC.settingsForm.updateDerivedTexts();
    renderMapTab();
    if (state.output) {
      renderResultsTab();
    }
  }

  // ---- マップのタブ --------------------------------------------------------

  /** 結果がいまのマップで作られたものか（違うマップの選択は表示しない）。 */
  function outputMatchesMap() {
    return state.output && state.output.map === state.map;
  }

  function methodSets(methodKey) {
    return outputMatchesMap() ? state.output.sets.filter((set) => set.method === methodKey) : [];
  }

  function renderSelectionOptions() {
    const select = ui.byId("view-selection");
    const options = [ui.create("option", { value: MANUAL_KEY, text: "手動選択（編集できます）" })];
    for (const method of C.METHODS) {
      if (method.key !== MANUAL_KEY && methodSets(method.key).length > 0) {
        options.push(ui.create("option", { value: method.key, text: `${method.label}（評価の結果）` }));
      }
    }
    select.replaceChildren(...options);
    if (!Array.from(select.options).some((option) => option.value === state.view.selection)) {
      state.view.selection = MANUAL_KEY;
    }
    select.value = state.view.selection;

    const drawField = ui.byId("view-draw-field");
    const sets = methodSets(state.view.selection);
    drawField.hidden = sets.length <= 1;
    if (sets.length > 1) {
      const drawSelect = ui.byId("view-draw");
      // 試行を見比べる目安として、最初の補正での残差RMS（X）のWafer平均を添える
      const variant = state.output.variants[0];
      drawSelect.replaceChildren(
        ...sets.map((set, index) => {
          const value = ASC.math.summarize(set.results[variant.key].x.rms).mean;
          return ui.create("option", { value: String(index), text: `試行 ${index + 1}（${variant.label}の残差RMS X 平均 ${ui.formatNumber(value)} nm）` });
        })
      );
      state.view.draw = Math.min(state.view.draw, sets.length - 1);
      drawSelect.value = String(state.view.draw);
    }
    ui.byId("copy-to-manual-button").hidden = state.view.selection === MANUAL_KEY;
    ui.byId("manual-toolbar").hidden = state.view.selection !== MANUAL_KEY;
  }

  /** 表示する選択（手動か、評価で選ばれたものか）の中身。 */
  function currentSelection() {
    if (state.view.selection === MANUAL_KEY) {
      if (!state.context) {
        return { shots: new Set(state.manual.shots), marks: new Set(), status: null, stats: null, context: null };
      }
      const selection = ASC.sampling.manualSelection(state.context, Array.from(state.manual.shots), Array.from(state.manual.marks));
      const terms = state.settings.model;
      return {
        shots: new Set(state.manual.shots),
        marks: new Set(selection.markIndices),
        status: ASC.constraints.describeStatus(state.context, selection.items, selection.markIndices),
        stats: {
          shotCount: selection.items.length,
          markCount: selection.markIndices.length,
          minSpacingMm: ASC.sampling.minimumShotSpacing(state.context, selection.items),
          kappaX: selection.markIndices.length > 0 ? ASC.sampling.kappaOf(state.map, selection.markIndices, terms.termsX) : NaN,
          kappaY: selection.markIndices.length > 0 ? ASC.sampling.kappaOf(state.map, selection.markIndices, terms.termsY) : NaN,
        },
        context: state.context,
        relaxedKeys: new Set(),
      };
    }
    const set = methodSets(state.view.selection)[state.view.draw];
    return {
      shots: new Set(set.shotIndices),
      marks: new Set(set.markIndices),
      status: set.status,
      stats: { shotCount: set.shotIndices.length, markCount: set.markIndices.length, minSpacingMm: set.minSpacingMm, kappaX: set.kappaX, kappaY: set.kappaY },
      context: state.output.context,
      relaxedKeys: new Set(state.output.relaxed.map((entry) => entry.key)),
    };
  }

  function renderMapTab() {
    renderSelectionOptions();
    const frame = ui.byId("map-frame");
    if (!state.map) {
      frame.replaceChildren(ui.create("p", { className: "empty-state", text: "マップを表示できません。" + state.mapErrors.join(" ") }));
      ui.byId("selection-stats").replaceChildren();
      ui.byId("constraint-status").replaceChildren();
      return;
    }
    const selection = currentSelection();
    const context = selection.context;
    const editing = state.view.selection === MANUAL_KEY && state.view.editing && Boolean(context);
    const eligibleShots = new Set(context ? context.items.map((item) => item.shotIndex) : []);
    const extraCandidates = new Set();
    if (editing && !context.exactMode) {
      for (const item of context.items) {
        if (state.manual.shots.has(item.shotIndex)) {
          item.otherMarks.forEach((markIndex) => extraCandidates.add(markIndex));
        }
      }
    }
    ASC.mapView.render(frame, {
      map: state.map,
      zones: state.settings.zones,
      eligibleShots,
      selectedShots: selection.shots,
      measuredMarks: selection.marks,
      centerMarkIndex: context && context.center.enabled ? context.center.markIndex : null,
      editable: editing,
      extraCandidates,
      onToggleShot: toggleManualShot,
      onToggleMark: toggleManualMark,
    });
    ui.byId("map-hint").textContent = mapHintText(editing, context);
    if (selection.stats) {
      ASC.mapView.renderStats(ui.byId("selection-stats"), selection.stats);
    } else {
      ui.byId("selection-stats").replaceChildren();
    }
    ASC.mapView.renderConstraintStatus(ui.byId("constraint-status"), selection.status, selection.relaxedKeys || new Set());
  }

  function mapHintText(editing, context) {
    if (!context) {
      return "設定に誤りがあるため、手動選択と制約の判定はできません: " + state.contextErrors.join(" ");
    }
    if (state.view.selection !== MANUAL_KEY) {
      return "評価で選ばれた点です。「この選択を手動選択に写す」で写して直せます。";
    }
    if (!editing) {
      return "「クリックで手動選択を編集する」をオンにすると、Shotをクリック（またはTabで選んでEnter）して選べます。";
    }
    return context.exactMode
      ? "Shotをクリックすると選択・解除します。灰色のShotは必ず測るMarkが範囲外なので選べません。"
      : "Shotをクリックすると選択・解除します。選んだShotの中のMarkの点をクリックすると、追加のMarkを選べます。";
  }

  function toggleManualShot(shotIndex) {
    if (state.manual.shots.has(shotIndex)) {
      state.manual.shots.delete(shotIndex);
      for (const markIndex of state.map.shots[shotIndex].markIndices) {
        state.manual.marks.delete(markIndex);
      }
    } else {
      state.manual.shots.add(shotIndex);
    }
    afterManualChange();
    focusShot(shotIndex);
  }

  function toggleManualMark(markIndex) {
    if (state.manual.marks.has(markIndex)) {
      state.manual.marks.delete(markIndex);
    } else {
      state.manual.marks.add(markIndex);
    }
    afterManualChange();
  }

  /** 作り直したマップで、直前に操作したShotへフォーカスを戻す（キーボード操作を続けられるように）。 */
  function focusShot(shotIndex) {
    const rects = ui.byId("map-frame").querySelectorAll("rect.map-shot");
    const target = rects[shotIndex];
    if (target && target.getAttribute("tabindex") === "0") {
      target.focus();
    }
  }

  function afterManualChange() {
    if (state.output && state.settings.sampling.methods.manual) {
      state.outputStale = true;
      renderResultsTab();
    }
    renderMapTab();
  }

  function copySelectionToManual() {
    const set = methodSets(state.view.selection)[state.view.draw];
    if (!set) {
      return;
    }
    const designated = new Set(set.items.flatMap((item) => state.output.context.items[item].designatedMarks));
    state.manual.shots = new Set(set.shotIndices);
    state.manual.marks = new Set(set.markIndices.filter((markIndex) => !designated.has(markIndex)));
    state.view.selection = MANUAL_KEY;
    state.view.editing = true;
    ui.byId("edit-manual").checked = true;
    afterManualChange();
    ui.showMessage("success", "手動選択に写しました。", ["クリックで追加・解除して直せます。"]);
  }

  // ---- 評価の実行 ----------------------------------------------------------

  function collectRunErrors() {
    const errors = [];
    if (state.invalidFields.size > 0) {
      errors.push(`入力に誤りがある欄が${state.invalidFields.size}か所あります。赤い枠の欄と、その下の説明を確かめてください。`);
    }
    if (!state.map) {
      errors.push(...state.mapErrors);
    }
    const settings = state.settings;
    if (settings.model.termsX.length === 0 || settings.model.termsY.length === 0) {
      errors.push("補正の多項式の項を、X・Yとも1つ以上選んでください。");
    }
    const flowError = ASC.settingsForm.flowSettingError(settings.model);
    if (flowError) {
      errors.push(flowError);
    }
    const methods = C.METHODS.filter((method) => settings.sampling.methods[method.key]);
    if (methods.length === 0) {
      errors.push("比べる選び方を1つ以上選んでください。");
    } else if (methods.every((method) => method.key === MANUAL_KEY) && state.manual.shots.size === 0) {
      errors.push("手動選択だけを比べる設定ですが、手動選択が空です。マップでShotを選んでください。");
    }
    if (state.map) {
      errors.push(...state.contextErrors);
    }
    return Array.from(new Set(errors));
  }

  function setRunning(running) {
    state.running = running;
    ui.byId("run-button").disabled = running;
    ui.byId("run-button").textContent = running ? "計算中…" : "評価を実行";
    ui.byId("progress-area").hidden = !running;
  }

  async function runEvaluation() {
    if (state.running) {
      return;
    }
    const errors = collectRunErrors();
    if (errors.length > 0) {
      ui.showMessage("error", "評価を始められません。次の点を直してください。", errors);
      return;
    }
    ui.clearMessage();
    const generated = ASC.evaluationData.generateEvaluationData(state.map, state.settings.evaluationData);
    if (generated.errors.length > 0) {
      ui.showMessage("error", "評価データを作れません。次の点を直してください。", generated.errors);
      return;
    }
    // 計算中に設定が変わっても結果がずれないよう、設定を写してから使う
    const settings = JSON.parse(JSON.stringify(state.settings));
    const map = state.map;
    state.cancelRequested = false;
    setRunning(true);
    const started = performance.now();
    try {
      const output = await ASC.evaluator.runEvaluation(
        {
          map,
          data: generated.data,
          settings,
          manual: { shotIndices: Array.from(state.manual.shots), extraMarkIndices: Array.from(state.manual.marks) },
        },
        (done, total, label) => {
          ui.byId("progress-bar").value = done / total;
          ui.byId("progress-label").textContent = `${label}（${Math.round((100 * done) / total)}%）`;
        },
        () => state.cancelRequested
      );
      if (output.cancelled) {
        ui.showMessage("warning", "評価を中止しました。", ["前の結果はそのまま残しています。"]);
        return;
      }
      if (output.errors.length > 0) {
        ui.showMessage("error", "評価できませんでした。次の点を直してください。", output.errors);
        return;
      }
      output.map = map;
      output.zones = settings.zones;
      state.output = output;
      state.outputStale = false;
      state.view.selection = MANUAL_KEY;
      state.view.draw = 0;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      const details = [`${output.sets.length}組の選択 × Wafer ${output.waferCount}枚を、${seconds}秒で計算しました。`];
      if (output.relaxed.length > 0) {
        details.push(`同時に満たせなかったハード制約 ${output.relaxed.length}件をソフトとして扱いました（「評価結果」に理由があります）。`);
      }
      ui.showMessage("success", "評価が終わりました。", details);
      renderMapTab();
      renderResultsTab();
      renderMapsTab();
      selectTab("tab-results");
    } catch (error) {
      ui.showMessage("error", "計算の途中で問題が起きました。", [
        `内容: ${error.message}`,
        "設定（特に計測点の数と多項式の項数、RBFの設定）を見直して、もう一度実行してください。",
      ]);
    } finally {
      setRunning(false);
    }
  }

  function renderResultsTab() {
    const container = ui.byId("results-content");
    if (!state.output) {
      container.replaceChildren(ui.create("p", { className: "empty-state", text: "左の設定を確かめて「評価を実行」を押すと、ここに結果が出ます。" }));
      return;
    }
    ASC.resultsView.render(
      container,
      state.output,
      state.view,
      {
        onViewChange: (change, focusId) => {
          Object.assign(state.view, change);
          renderResultsTab();
          // 作り直した画面で、操作した選択欄にフォーカスを戻す
          ui.byId(focusId).focus();
        },
        onExportResults: () => ui.download(`評価結果_${ui.timestampForFile()}.csv`, ASC.resultsView.resultsCsv(state.output), "text/csv"),
        onExportSelections: () => ui.download(`選択点_${ui.timestampForFile()}.csv`, ASC.resultsView.selectionsCsv(state.output, state.output.map), "text/csv"),
      },
      state.outputStale
    );
  }

  /** 「選び方ごとのマップ」タブ。結果を出したときのマップと区切りで描く。 */
  function renderMapsTab() {
    const container = ui.byId("maps-content");
    if (!state.output) {
      container.replaceChildren(ui.create("p", { className: "empty-state", text: "「評価を実行」を押すと、選び方ごとに選んだ点のマップがここに並びます。" }));
      return;
    }
    ASC.samplingMapsView.render(container, state.output, state.output.map, state.output.zones, state.view.mapChoices, {
      onChoiceChange: (methodKey, choice, focusId) => {
        state.view.mapChoices[methodKey] = choice;
        renderMapsTab();
        ui.byId(focusId).focus();
      },
      onOpenInMapTab: (methodKey, drawIndex) => {
        if (!outputMatchesMap()) {
          ui.showMessage("warning", "マップが変わったため、この選択は「マップと選択点」で表示できません。", ["もう一度「評価を実行」を押してください。"]);
          return;
        }
        state.view.selection = methodKey;
        state.view.draw = drawIndex;
        renderMapTab();
        selectTab("tab-map");
        ui.byId("tab-map").focus();
      },
    });
  }

  // ---- ファイルの読み書き --------------------------------------------------

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  async function loadCsvFile(event) {
    const file = event.target.files[0];
    if (!file) {
      return;
    }
    try {
      state.csvText = await readFileAsText(file);
      state.csvFileName = file.name;
      ui.byId("csv-file-name").textContent = `読み込んだファイル: ${file.name}`;
      onSettingsChange("map");
      if (state.mapErrors.length > 0) {
        ui.showMessage("error", "CSVを読み込めませんでした。次の点を直してください。", state.mapErrors.slice(0, 20));
      } else {
        ui.showMessage("success", "CSVを読み込みました。", [`Shot ${state.map.shots.length}個、有効なMark ${state.map.marks.length}個`]);
      }
    } catch (error) {
      ui.showMessage("error", "ファイルを読めませんでした。", [`内容: ${error.message}`, "ファイルが開ける状態か確かめて、もう一度選んでください。"]);
    } finally {
      event.target.value = "";
    }
  }

  function exportMap() {
    if (!state.map) {
      ui.showMessage("error", "保存できるマップがありません。", state.mapErrors);
      return;
    }
    ui.download(`Waferマップ_${ui.timestampForFile()}.csv`, ASC.waferMap.mapToCsv(state.map), "text/csv");
  }

  function saveSettings() {
    const manualShots = Array.from(state.manual.shots).map((shotIndex) => state.map.shots[shotIndex].id);
    const manualMarks = Array.from(state.manual.marks).map((markIndex) => {
      const mark = state.map.marks[markIndex];
      return { shotId: state.map.shots[mark.shotIndex].id, markNo: mark.markNo };
    });
    const content = {
      version: SETTINGS_FILE_VERSION,
      settings: state.settings,
      csvText: state.settings.map.source === "csv" ? state.csvText : null,
      manual: { shotIds: manualShots, marks: manualMarks },
    };
    ui.download(`設定_${ui.timestampForFile()}.json`, JSON.stringify(content, null, 2), "application/json");
  }

  /** 読み込んだ設定を初期設定に重ねる。型が違う値や知らない項目は使わない。 */
  function mergeSettings(base, loaded) {
    if (Array.isArray(base)) {
      return Array.isArray(loaded) ? loaded : base;
    }
    if (base !== null && typeof base === "object") {
      const result = {};
      for (const key of Object.keys(base)) {
        result[key] = loaded && Object.prototype.hasOwnProperty.call(loaded, key) ? mergeSettings(base[key], loaded[key]) : base[key];
      }
      return result;
    }
    if (base === null) {
      return loaded === undefined ? null : loaded;
    }
    return typeof loaded === typeof base ? loaded : base;
  }

  async function loadSettingsFile(event) {
    const file = event.target.files[0];
    if (!file) {
      return;
    }
    try {
      const content = JSON.parse(await readFileAsText(file));
      if (!content || content.version !== SETTINGS_FILE_VERSION || !content.settings) {
        throw new Error("このアプリで保存した設定ファイルではありません。");
      }
      const settings = mergeSettings(createInitialSettings(), content.settings);
      if (!Array.isArray(settings.evaluationData.terms) || settings.evaluationData.terms.length !== ASC.zernike.TERMS.length) {
        settings.evaluationData.terms = createInitialSettings().evaluationData.terms;
      }
      state.settings = settings;
      state.csvText = typeof content.csvText === "string" ? content.csvText : null;
      ui.byId("csv-file-name").textContent = state.csvText ? "設定ファイルに含まれていたCSVを使います。" : "";
      state.manual = { shots: new Set(), marks: new Set() };
      state.output = null;
      state.view.mapChoices = {};
      rebuildMap();
      restoreManual(content.manual);
      ASC.settingsForm.writeAll();
      rebuildContext();
      ASC.settingsForm.updateDerivedTexts();
      renderMapTab();
      renderResultsTab();
      renderMapsTab();
      ui.showMessage("success", "設定を読み込みました。", [`ファイル: ${file.name}`]);
    } catch (error) {
      ui.showMessage("error", "設定を読み込めませんでした。", [`内容: ${error.message}`, "このアプリの「設定をJSONで保存」で作ったファイルを選んでください。"]);
    } finally {
      event.target.value = "";
    }
  }

  function restoreManual(manual) {
    if (!manual || !state.map) {
      return;
    }
    const shotIndexById = new Map(state.map.shots.map((shot, index) => [shot.id, index]));
    for (const shotId of manual.shotIds || []) {
      if (shotIndexById.has(shotId)) {
        state.manual.shots.add(shotIndexById.get(shotId));
      }
    }
    for (const entry of manual.marks || []) {
      const shotIndex = shotIndexById.get(entry.shotId);
      if (shotIndex === undefined) {
        continue;
      }
      const markIndex = state.map.shots[shotIndex].markIndices.find((index) => state.map.marks[index].markNo === entry.markNo);
      if (markIndex !== undefined) {
        state.manual.marks.add(markIndex);
      }
    }
  }

  // ---- タブ ----------------------------------------------------------------

  const TAB_IDS = ["tab-map", "tab-results", "tab-maps", "tab-help"];

  function selectTab(tabId) {
    for (const id of TAB_IDS) {
      const tab = ui.byId(id);
      const selected = id === tabId;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
      tab.tabIndex = selected ? 0 : -1;
      ui.byId(tab.getAttribute("aria-controls")).hidden = !selected;
    }
  }

  function setupTabs() {
    TAB_IDS.forEach((id, index) => {
      const tab = ui.byId(id);
      tab.addEventListener("click", () => selectTab(id));
      tab.addEventListener("keydown", (event) => {
        const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (offset !== 0) {
          const next = TAB_IDS[(index + offset + TAB_IDS.length) % TAB_IDS.length];
          selectTab(next);
          ui.byId(next).focus();
        }
      });
    });
  }

  // ---- 起動 ----------------------------------------------------------------

  function start() {
    rebuildMap();
    ASC.settingsForm.initialize(state, onSettingsChange);
    rebuildContext();
    ASC.settingsForm.updateDerivedTexts();
    ASC.mapView.renderLegend(ui.byId("map-legend"));
    setupTabs();

    ui.byId("run-button").addEventListener("click", runEvaluation);
    ui.byId("cancel-button").addEventListener("click", () => {
      state.cancelRequested = true;
      ui.byId("progress-label").textContent = "中止しています…";
    });
    ui.byId("csv-file").addEventListener("change", loadCsvFile);
    ui.byId("export-map-button").addEventListener("click", exportMap);
    ui.byId("save-settings-button").addEventListener("click", saveSettings);
    ui.byId("settings-file").addEventListener("change", loadSettingsFile);
    ui.byId("view-selection").addEventListener("change", (event) => {
      state.view.selection = event.target.value;
      state.view.draw = 0;
      renderMapTab();
    });
    ui.byId("view-draw").addEventListener("change", (event) => {
      state.view.draw = Number(event.target.value);
      renderMapTab();
    });
    ui.byId("copy-to-manual-button").addEventListener("click", copySelectionToManual);
    ui.byId("edit-manual").addEventListener("change", (event) => {
      state.view.editing = event.target.checked;
      renderMapTab();
    });
    ui.byId("clear-manual-button").addEventListener("click", () => {
      state.manual.shots.clear();
      state.manual.marks.clear();
      afterManualChange();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        ui.byId("chart-tooltip").hidden = true;
      }
    });
    renderMapTab();
  }

  start();
})(window);
