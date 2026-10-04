/**
 * 画面全体のまとめ役。状態（設定・マップ・手動プラン・結果）を持ち、各部品をつなぐ。
 */
(function (root) {
  "use strict";
  const ASC = root.ASC;
  const C = ASC.constants;
  const ui = ASC.ui;

  // 設定ファイルの版。2 で手動プランを複数持てるようにした（1 も読める）
  const SETTINGS_FILE_VERSION = 2;
  const READABLE_SETTINGS_VERSIONS = [1, 2];

  const state = {
    settings: createInitialSettings(),
    map: null,
    mapErrors: [],
    csvText: null,
    csvFileName: null,
    context: null,
    contextErrors: [],
    plans: createInitialPlans(),
    output: null,
    outputStale: false,
    sweep: null,
    sweepStale: false,
    invalidFields: new Set(),
    running: false,
    cancelRequested: false,
    view: {
      // 表示する選択。手動プランのキー（manual:番号）か、自動の選び方のキー
      selection: `${C.MANUAL_PREFIX}1`,
      draw: 0,
      editing: false,
      metric: "rms",
      axis: "x",
      flowType: "estimateThenHowa",
      mapChoices: {},
      estimationMapMethod: null,
      sweep: { mode: "methods", metric: "rms", axis: "x", stat: "mean", scale: "linear", target: NaN },
    },
  };

  function createInitialPlans() {
    const store = ASC.manualPlans.createStore();
    ASC.manualPlans.addPlan(store, null, [], [], true);
    return store;
  }

  function isPlanKey(key) {
    return typeof key === "string" && key.startsWith(C.MANUAL_PREFIX);
  }

  /** 表示中の手動プラン（自動の選び方を表示中なら null）。 */
  function activePlan() {
    return isPlanKey(state.view.selection) ? ASC.manualPlans.findPlan(state.plans, state.view.selection) : null;
  }

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
    if (previousIds !== null && previousIds !== currentIds && state.plans.plans.some((plan) => plan.shotIds.size > 0)) {
      ui.showMessage("warning", "マップが変わりました。手動プランはShot番号で引き継いでいます。", [
        "同じShot番号でも、Shotの位置が変わっていることがあります。「マップと選択点」で確かめてください。",
        "新しいマップにないShot番号は使いません。",
      ]);
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
    if (kind === "sweep") {
      // スイープの範囲だけの変更は、評価結果には関係しない
      updateSweepEstimate();
      return;
    }
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
    if (state.sweep) {
      state.sweepStale = true;
      renderSweepTab();
    }
    updateSweepEstimate();
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
    const planGroup = ui.create(
      "optgroup",
      { label: "手動プラン（編集できます）" },
      state.plans.plans.map((plan) => ui.create("option", { value: plan.key, text: `${plan.name}${plan.included ? "" : "（評価に含めない）"}` }))
    );
    const options = [planGroup];
    const resultOptions = C.METHODS.filter((method) => methodSets(method.key).length > 0).map((method) =>
      ui.create("option", { value: method.key, text: method.label })
    );
    if (resultOptions.length > 0) {
      options.push(ui.create("optgroup", { label: "評価で選ばれた点" }, resultOptions));
    }
    select.replaceChildren(...options);
    if (!Array.from(select.options).some((option) => option.value === state.view.selection)) {
      state.view.selection = state.plans.plans.length > 0 ? state.plans.plans[0].key : resultOptions.length > 0 ? resultOptions[0].value : "";
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
    const plan = activePlan();
    ui.byId("copy-to-manual-button").hidden = Boolean(plan) || methodSets(state.view.selection).length === 0;
    ui.byId("new-plan-button").disabled = state.plans.plans.length >= C.MAX_MANUAL_PLANS;
    ui.byId("manual-panel").hidden = !plan;
    if (plan) {
      const nameInput = ui.byId("plan-name");
      if (document.activeElement !== nameInput) {
        nameInput.value = plan.name;
      }
      ui.byId("plan-included").checked = plan.included;
      const idsInput = ui.byId("plan-shot-ids");
      if (document.activeElement !== idsInput) {
        idsInput.value = ASC.manualPlans.shotIdText(plan, state.map);
      }
      ui.byId("delete-plan-button").disabled = state.plans.plans.length <= 1;
      ui.byId("duplicate-plan-button").disabled = state.plans.plans.length >= C.MAX_MANUAL_PLANS;
    }
  }

  /** 表示する選択（手動プランか、評価で選ばれたものか）の中身。 */
  function currentSelection() {
    const plan = activePlan();
    if (plan) {
      const indices = state.map ? ASC.manualPlans.planIndices(plan, state.map) : { shotIndices: [], extraMarkIndices: [], missingShotIds: [] };
      if (!state.context) {
        return { shots: new Set(indices.shotIndices), marks: new Set(), status: null, stats: null, context: null, missing: indices.missingShotIds };
      }
      const selection = ASC.sampling.manualSelection(state.context, indices.shotIndices, indices.extraMarkIndices);
      const terms = state.settings.model;
      return {
        missing: indices.missingShotIds,
        notEligible: selection.notEligible,
        shots: new Set(indices.shotIndices),
        marks: new Set(selection.markIndices),
        status: ASC.constraints.describeStatus(state.context, selection.items, selection.markIndices),
        stats: {
          shotCount: selection.items.length,
          markCount: selection.markIndices.length,
          minSpacingMm: ASC.sampling.minimumShotSpacing(state.context, selection.items),
          criteria: ASC.evaluator.criteriaOf(state.map, selection.markIndices, terms),
          // 効率は、いまのマップで出した評価結果の中で最も良いものを100%にする（結果がなければ値だけ）
          reference: outputMatchesMap() ? state.output.criteriaReference : null,
        },
        context: state.context,
        relaxedKeys: new Set(),
      };
    }
    const set = methodSets(state.view.selection)[state.view.draw];
    if (!set) {
      return { shots: new Set(), marks: new Set(), status: null, stats: null, context: state.context };
    }
    return {
      shots: new Set(set.shotIndices),
      marks: new Set(set.markIndices),
      status: set.status,
      stats: {
        shotCount: set.shotIndices.length,
        markCount: set.markIndices.length,
        minSpacingMm: set.minSpacingMm,
        criteria: set.criteria,
        reference: state.output.criteriaReference,
      },
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
    const plan = activePlan();
    const editing = Boolean(plan) && state.view.editing && Boolean(context);
    const eligibleShots = new Set(context ? context.items.map((item) => item.shotIndex) : []);
    const extraCandidates = new Set();
    if (editing && !context.exactMode) {
      for (const item of context.items) {
        if (selection.shots.has(item.shotIndex)) {
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
    ui.byId("map-hint").textContent = mapHintText(editing, context, selection);
    if (selection.stats) {
      ASC.mapView.renderStats(ui.byId("selection-stats"), selection.stats);
    } else {
      ui.byId("selection-stats").replaceChildren();
    }
    ASC.mapView.renderConstraintStatus(ui.byId("constraint-status"), selection.status, selection.relaxedKeys || new Set());
  }

  function mapHintText(editing, context, selection) {
    if (!context) {
      return "設定に誤りがあるため、手動プランの判定と制約の判定はできません: " + state.contextErrors.join(" ");
    }
    if (!activePlan()) {
      return "評価で選ばれた点です。「この選択を新しい手動プランにする」で写して手直しできます。";
    }
    const notes = [];
    if (selection.missing && selection.missing.length > 0) {
      notes.push(`今のマップにないShot番号 ${selection.missing.length}個（${selection.missing.slice(0, 5).join(", ")}${selection.missing.length > 5 ? " ほか" : ""}）は使いません。`);
    }
    if (selection.notEligible && selection.notEligible.length > 0) {
      notes.push(`必ず測るMarkが範囲外のShot ${selection.notEligible.length}個は、評価に入りません。`);
    }
    let guide;
    if (!editing) {
      guide = "「マップのクリックでShotを選ぶ」をオンにすると、Shotをクリック（またはTabで選んでEnter）して選べます。Shot番号を貼り付けて指定することもできます。";
    } else if (context.exactMode) {
      guide = "Shotをクリックすると選択・解除します。斜線のShotは必ず測るMarkが範囲外なので評価に入りません。";
    } else {
      guide = "Shotをクリックすると選択・解除します。選んだShotの中のMarkの点をクリックすると、追加のMarkを選べます。";
    }
    return [guide].concat(notes).join(" ");
  }

  function toggleManualShot(shotIndex) {
    const plan = activePlan();
    if (!plan) {
      return;
    }
    ASC.manualPlans.toggleShot(plan, state.map, shotIndex);
    afterManualChange(plan);
    focusShot(shotIndex);
  }

  function toggleManualMark(markIndex) {
    const plan = activePlan();
    if (!plan) {
      return;
    }
    ASC.manualPlans.toggleExtraMark(plan, state.map, markIndex);
    afterManualChange(plan);
  }

  /** 作り直したマップで、直前に操作したShotへフォーカスを戻す（キーボード操作を続けられるように）。 */
  function focusShot(shotIndex) {
    const rects = ui.byId("map-frame").querySelectorAll("rect.map-shot");
    const target = rects[shotIndex];
    if (target && target.getAttribute("tabindex") === "0") {
      target.focus();
    }
  }

  /** 手動プランを変えたあと。評価やスイープに入っているプランなら、結果が古くなったことを示す。 */
  function afterManualChange(plan) {
    if (plan && plan.included) {
      if (state.output) {
        state.outputStale = true;
        renderResultsTab();
      }
      if (state.sweep) {
        state.sweepStale = true;
        renderSweepTab();
      }
    }
    renderMapTab();
  }

  function selectPlan(plan) {
    state.view.selection = plan.key;
    state.view.draw = 0;
    renderMapTab();
  }

  function createNewPlan() {
    const plan = ASC.manualPlans.addPlan(state.plans, null, [], [], true);
    if (!plan) {
      ui.showMessage("warning", `手動プランは${C.MAX_MANUAL_PLANS}個までです。`, ["使わないプランを削除してから作ってください。"]);
      return;
    }
    state.view.editing = true;
    ui.byId("edit-manual").checked = true;
    selectPlan(plan);
    ui.byId("plan-name").focus();
  }

  function copySelectionToManual() {
    const set = methodSets(state.view.selection)[state.view.draw];
    if (!set) {
      return;
    }
    const method = C.METHODS.find((entry) => entry.key === set.method);
    const name = methodSets(set.method).length > 1 ? `${method.label}（試行${set.draw + 1}）の写し` : `${method.label}の写し`;
    const plan = ASC.manualPlans.addPlan(state.plans, name, [], [], true);
    if (!plan) {
      ui.showMessage("warning", `手動プランは${C.MAX_MANUAL_PLANS}個までです。`, ["使わないプランを削除してから写してください。"]);
      return;
    }
    const designated = new Set(set.items.flatMap((item) => state.output.context.items[item].designatedMarks));
    ASC.manualPlans.setFromIndices(plan, state.map, set.shotIndices, set.markIndices.filter((markIndex) => !designated.has(markIndex)));
    state.view.editing = true;
    ui.byId("edit-manual").checked = true;
    selectPlan(plan);
    afterManualChange(plan);
    ui.showMessage("success", `手動プラン「${plan.name}」を作りました。`, ["クリックで追加・解除して手直しできます。名前も変えられます。"]);
  }

  function renameActivePlan() {
    const plan = activePlan();
    const input = ui.byId("plan-name");
    const name = input.value.trim();
    const error = ui.byId("plan-name-error");
    if (!plan) {
      return;
    }
    if (name === "") {
      error.textContent = "プランの名前が空です。名前を入れてください。";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    if (state.plans.plans.some((other) => other !== plan && other.name === name)) {
      error.textContent = "同じ名前のプランがあります。別の名前にしてください。";
      input.setAttribute("aria-invalid", "true");
      return;
    }
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    plan.name = name;
    afterManualChange(plan);
  }

  function deleteActivePlan() {
    const plan = activePlan();
    if (!plan || state.plans.plans.length <= 1) {
      return;
    }
    if (!window.confirm(`手動プラン「${plan.name}」を削除します。元に戻せません。よろしいですか？`)) {
      return;
    }
    ASC.manualPlans.removePlan(state.plans, plan.key);
    afterManualChange(plan);
    selectPlan(state.plans.plans[0]);
    ui.showMessage("success", `手動プラン「${plan.name}」を削除しました。`, []);
  }

  function duplicateActivePlan() {
    const plan = activePlan();
    const copy = plan ? ASC.manualPlans.duplicatePlan(state.plans, plan.key) : null;
    if (!copy) {
      ui.showMessage("warning", `手動プランは${C.MAX_MANUAL_PLANS}個までです。`, ["使わないプランを削除してから複製してください。"]);
      return;
    }
    selectPlan(copy);
    afterManualChange(copy);
  }

  /** Shot番号の入力欄の内容で、表示中のプランのShotを置き換える。 */
  function applyShotIdsToActivePlan() {
    const plan = activePlan();
    const error = ui.byId("plan-shot-ids-error");
    if (!plan || !state.map) {
      return;
    }
    const ids = ASC.manualPlans.parseShotIdText(ui.byId("plan-shot-ids").value);
    const result = ASC.manualPlans.applyShotIds(plan, state.map, ids);
    error.textContent =
      result.unknown.length > 0
        ? `マップにないShot番号 ${result.unknown.length}個（${result.unknown.slice(0, 8).join(", ")}${result.unknown.length > 8 ? " ほか" : ""}）は使いませんでした。番号を確かめてください。`
        : "";
    afterManualChange(plan);
    ui.byId("plan-shot-ids").value = ASC.manualPlans.shotIdText(plan, state.map);
    ui.showMessage("success", `手動プラン「${plan.name}」にShot ${result.applied}個を指定しました。`, []);
  }

  /** 評価に渡す手動プラン（評価で比べるものだけ、今のマップの番号で）。 */
  function includedPlanInputs() {
    if (!state.map) {
      return [];
    }
    return state.plans.plans
      .filter((plan) => plan.included)
      .map((plan) => {
        const indices = ASC.manualPlans.planIndices(plan, state.map);
        return { key: plan.key, label: plan.name, shotIndices: indices.shotIndices, extraMarkIndices: indices.extraMarkIndices };
      })
      .filter((plan) => plan.shotIndices.length > 0);
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
    if (methods.length === 0 && includedPlanInputs().length === 0) {
      errors.push("比べる選び方を1つ以上選ぶか、Shotを選んだ手動プランを「評価で比べる」にしてください。");
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
    ui.byId("sweep-run-button").disabled = running;
    ui.byId("progress-area").hidden = !running;
  }

  function showProgress(done, total, label) {
    ui.byId("progress-bar").value = done / total;
    ui.byId("progress-label").textContent = `${label}（${Math.round((100 * done) / total)}%）`;
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
          manualPlans: includedPlanInputs(),
        },
        showProgress,
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

  // ---- 計測点数のスイープ --------------------------------------------------

  /** スイープで評価する量の目安を表示する。 */
  function updateSweepEstimate() {
    const element = ui.byId("sweep-estimate");
    const settings = state.settings;
    const sweep = settings.sweep;
    const pointCount = sweep.stepShots > 0 && sweep.endShots >= sweep.startShots ? Math.floor((sweep.endShots - sweep.startShots) / sweep.stepShots) + 1 : 0;
    const methods = C.METHODS.filter((method) => settings.sampling.methods[method.key]);
    const setsPerPoint = methods.reduce((sum, method) => sum + (method.usesDraws ? sweep.draws : 1), 0);
    const k = settings.sampling.designatedMarkNos.length;
    element.textContent =
      pointCount > 0
        ? `評価する点: ${pointCount}点（計測Mark数 ${sweep.startShots * k}〜${sweep.endShots * k} 程度）、1点あたり選択 ${setsPerPoint}組 × Wafer ${settings.evaluationData.waferCount}枚。点や試行回数が多いほど時間がかかります。`
        : "";
  }

  async function runSweep() {
    if (state.running) {
      return;
    }
    const errors = collectRunErrors().filter((text) => !text.includes("手動プラン"));
    if (!C.METHODS.some((method) => state.settings.sampling.methods[method.key])) {
      errors.push("スイープには、自動の選び方（ランダム・ポアソン・D最適・I最適）を1つ以上選んでください（4. サンプリングの「比べる選び方」）。");
    }
    if (errors.length > 0) {
      ui.showMessage("error", "スイープを始められません。次の点を直してください。", errors);
      return;
    }
    ui.clearMessage();
    const generated = ASC.evaluationData.generateEvaluationData(state.map, state.settings.evaluationData);
    if (generated.errors.length > 0) {
      ui.showMessage("error", "評価データを作れません。次の点を直してください。", generated.errors);
      return;
    }
    const settings = JSON.parse(JSON.stringify(state.settings));
    state.cancelRequested = false;
    setRunning(true);
    const started = performance.now();
    try {
      const output = await ASC.evaluator.runSweep(
        { map: state.map, data: generated.data, settings, manualPlans: includedPlanInputs() },
        settings.sweep,
        showProgress,
        () => state.cancelRequested
      );
      if (output.cancelled) {
        ui.showMessage("warning", "スイープを中止しました。", ["前の結果はそのまま残しています。"]);
        return;
      }
      if (output.errors.length > 0) {
        ui.showMessage("error", "スイープできませんでした。次の点を直してください。", output.errors);
        return;
      }
      state.sweep = output;
      state.sweepStale = false;
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      ui.showMessage("success", "スイープが終わりました。", [`計測Shot数 ${output.points.length}点を、${seconds}秒で評価しました。`]);
      renderSweepTab();
      selectTab("tab-sweep");
    } catch (error) {
      ui.showMessage("error", "スイープの途中で問題が起きました。", [`内容: ${error.message}`, "計測Shot数の範囲や設定を見直して、もう一度実行してください。"]);
    } finally {
      setRunning(false);
    }
  }

  function renderSweepTab() {
    const container = ui.byId("sweep-content");
    if (!state.sweep) {
      container.replaceChildren(ui.create("p", { className: "empty-state", text: "「スイープを実行」を押すと、ここにトレードオフカーブが出ます。" }));
      return;
    }
    ASC.sweepView.render(
      container,
      state.sweep,
      state.view.sweep,
      {
        onViewChange: (change, focusId) => {
          Object.assign(state.view.sweep, change);
          renderSweepTab();
          ui.byId(focusId).focus();
        },
        onExport: () => ui.download(`スイープ結果_${ui.timestampForFile()}.csv`, ASC.sweepView.sweepCsv(state.sweep), "text/csv"),
      },
      state.sweepStale
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
        // 手動プランは、編集できるプランそのものを表示する
        state.view.selection = methodKey;
        state.view.draw = isPlanKey(methodKey) ? 0 : drawIndex;
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
    const content = {
      version: SETTINGS_FILE_VERSION,
      settings: state.settings,
      csvText: state.settings.map.source === "csv" ? state.csvText : null,
      manual: ASC.manualPlans.toJson(state.plans),
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
      if (!content || !READABLE_SETTINGS_VERSIONS.includes(content.version) || !content.settings) {
        throw new Error("このアプリで保存した設定ファイルではありません。");
      }
      const settings = mergeSettings(createInitialSettings(), content.settings);
      if (!Array.isArray(settings.evaluationData.terms) || settings.evaluationData.terms.length !== ASC.zernike.TERMS.length) {
        settings.evaluationData.terms = createInitialSettings().evaluationData.terms;
      }
      state.settings = settings;
      state.csvText = typeof content.csvText === "string" ? content.csvText : null;
      ui.byId("csv-file-name").textContent = state.csvText ? "設定ファイルに含まれていたCSVを使います。" : "";
      state.plans = ASC.manualPlans.fromJson(content.manual);
      if (state.plans.plans.length === 0) {
        state.plans = createInitialPlans();
      }
      state.view.selection = state.plans.plans[0].key;
      state.output = null;
      state.sweep = null;
      state.view.mapChoices = {};
      rebuildMap();
      ASC.settingsForm.writeAll();
      rebuildContext();
      ASC.settingsForm.updateDerivedTexts();
      renderMapTab();
      renderResultsTab();
      renderMapsTab();
      renderSweepTab();
      updateSweepEstimate();
      ui.showMessage("success", "設定を読み込みました。", [`ファイル: ${file.name}`]);
    } catch (error) {
      ui.showMessage("error", "設定を読み込めませんでした。", [`内容: ${error.message}`, "このアプリの「設定をJSONで保存」で作ったファイルを選んでください。"]);
    } finally {
      event.target.value = "";
    }
  }

  // ---- タブ ----------------------------------------------------------------

  const TAB_IDS = ["tab-map", "tab-results", "tab-maps", "tab-sweep", "tab-help"];

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
    ui.byId("sweep-run-button").addEventListener("click", runSweep);
    updateSweepEstimate();
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
      const plan = activePlan();
      if (plan) {
        plan.shotIds.clear();
        plan.extraMarks.clear();
        afterManualChange(plan);
      }
    });
    ui.byId("new-plan-button").addEventListener("click", createNewPlan);
    ui.byId("duplicate-plan-button").addEventListener("click", duplicateActivePlan);
    ui.byId("delete-plan-button").addEventListener("click", deleteActivePlan);
    ui.byId("plan-name").addEventListener("input", renameActivePlan);
    ui.byId("plan-name").addEventListener("blur", () => renderMapTab());
    ui.byId("plan-included").addEventListener("change", (event) => {
      const plan = activePlan();
      if (plan) {
        plan.included = event.target.checked;
        // 含める・外すの切り替えは、評価に入るプランが変わるので結果を古い扱いにする
        if (state.output) {
          state.outputStale = true;
          renderResultsTab();
        }
        if (state.sweep) {
          state.sweepStale = true;
          renderSweepTab();
        }
        renderMapTab();
      }
    });
    ui.byId("apply-shot-ids-button").addEventListener("click", applyShotIdsToActivePlan);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        ui.byId("chart-tooltip").hidden = true;
      }
    });
    renderMapTab();
  }

  start();
})(window);
