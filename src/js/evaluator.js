/**
 * 評価の全体の流れ。
 *   1. サンプリングの前提を作り、ハード制約を同時に満たせるか確かめる
 *   2. 選び方ごとに計測Markを選ぶ（ランダム系は試行回数ぶん）
 *   3. 選んだ点ごとに補正の演算子を作り、全Waferの残差を求める
 *   4. 選び方 × 補正の流れ × 軸 で集計する
 * 計算は少しずつ区切って進め、画面が固まらないようにする（進み具合の表示と中止のため）。
 */
(function (root) {
  "use strict";
  const ASC = (root.ASC = root.ASC || {});
  const C = ASC.constants;
  const M = ASC.math;

  const METRIC_KEYS = ["rms", "mean3sigma", "max"];
  const AXES = ["x", "y"];

  // 乱数列の番号（評価データとは別）
  const STREAM_METHOD_BASE = 1000;

  // 計算をこの時間ごとに区切り、画面の更新（進み具合の表示）と中止ボタンの操作を受け付ける
  const YIELD_INTERVAL_MS = 100;

  // setTimeout はブラウザの画面が裏にあると1秒単位に間引かれるため、ブラウザでは MessageChannel で区切る
  // （Node.js のテストでは間引かれないので setTimeout を使う）
  const yieldChannel = typeof window !== "undefined" && typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  const pendingYields = [];
  if (yieldChannel) {
    yieldChannel.port1.onmessage = () => {
      const resolve = pendingYields.shift();
      if (resolve) {
        resolve();
      }
    };
  }
  let lastYieldTime = 0;

  function now() {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }

  /** 前に区切ってから一定時間たっていれば、画面を更新する機会を作る。 */
  function yieldToBrowser() {
    if (now() - lastYieldTime < YIELD_INTERVAL_MS) {
      return Promise.resolve();
    }
    lastYieldTime = now();
    if (!yieldChannel) {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }
    return new Promise((resolve) => {
      pendingYields.push(resolve);
      yieldChannel.port2.postMessage(null);
    });
  }

  /** 1枚のWaferの残差から指標を求める。 */
  function residualMetrics(residual, count) {
    let sum = 0;
    let sumSquares = 0;
    let maxAbs = 0;
    for (let i = 0; i < count; i++) {
      const value = residual[i];
      sum += value;
      sumSquares += value * value;
      const absolute = Math.abs(value);
      if (absolute > maxAbs) {
        maxAbs = absolute;
      }
    }
    const mean = sum / count;
    const variance = Math.max(0, sumSquares / count - mean * mean);
    return { rms: Math.sqrt(sumSquares / count), mean3sigma: Math.abs(mean) + 3 * Math.sqrt(variance), max: maxAbs };
  }

  /** 指標を入れる箱（Wafer数ぶん）。 */
  function createMetricStore(waferCount) {
    const store = {};
    for (const axis of AXES) {
      store[axis] = {};
      for (const metric of METRIC_KEYS) {
        store[axis][metric] = new Float64Array(waferCount);
      }
    }
    return store;
  }

  /**
   * 補正の演算子 P（Mark数×計測点数）を全Waferに掛け、残差の指標を求める。
   */
  function evaluateOperator(operator, sampleIndices, truth, noise, data, store, axis) {
    const markCount = data.markCount;
    const n = sampleIndices.length;
    const measured = new Float64Array(n);
    const residual = new Float64Array(markCount);
    for (let wafer = 0; wafer < data.waferCount; wafer++) {
      const waferOffset = wafer * markCount;
      for (let j = 0; j < n; j++) {
        const markIndex = sampleIndices[j];
        measured[j] = truth[waferOffset + markIndex] + noise[waferOffset + markIndex];
      }
      for (let i = 0; i < markCount; i++) {
        let correction = 0;
        const rowOffset = i * n;
        for (let j = 0; j < n; j++) {
          correction += operator[rowOffset + j] * measured[j];
        }
        residual[i] = truth[waferOffset + i] - correction;
      }
      const metrics = residualMetrics(residual, markCount);
      for (const metric of METRIC_KEYS) {
        store[axis][metric][wafer] = metrics[metric];
      }
    }
  }

  /** 補正なし（真のずれそのもの）の指標。 */
  function evaluateUncorrected(data) {
    const store = createMetricStore(data.waferCount);
    for (const axis of AXES) {
      const truth = axis === "x" ? data.truthX : data.truthY;
      for (let wafer = 0; wafer < data.waferCount; wafer++) {
        const metrics = residualMetrics(truth.subarray(wafer * data.markCount, (wafer + 1) * data.markCount), data.markCount);
        for (const metric of METRIC_KEYS) {
          store[axis][metric][wafer] = metrics[metric];
        }
      }
    }
    return store;
  }

  /**
   * 1組の計測Markについて、補正の流れごと・軸ごとの残差の指標を求める。
   */
  function evaluateSampleSet(map, data, modelSettings, sampleIndices, flows) {
    const marks = map.marks;
    const allIndices = Array.from({ length: marks.length }, (_, i) => i);
    const warnings = [];
    let rbf = null;
    if (flows.rbfThenHowa || flows.howaPlusRbf) {
      const result = ASC.correction.rbfOperator(marks, sampleIndices, {
        kernel: modelSettings.rbfKernel,
        lambda: modelSettings.rbfLambda,
        shapeFactor: modelSettings.rbfShapeFactor,
      });
      if (result.error) {
        warnings.push(result.error);
      }
      rbf = result.operator;
    }

    const results = {};
    for (const flow of C.FLOWS) {
      if (flows[flow.key]) {
        results[flow.key] = createMetricStore(data.waferCount);
      }
    }
    const cache = new Map();
    for (const axis of AXES) {
      const terms = axis === "x" ? modelSettings.termsX : modelSettings.termsY;
      const cacheKey = terms.join(",");
      let built = cache.get(cacheKey);
      if (!built) {
        const allDesign = ASC.correction.polynomialDesign(marks, allIndices, terms);
        built = ASC.correction.buildAxisOperators({ marks, sampleIndices, termIndices: terms, allDesign, rbf, flows });
        cache.set(cacheKey, built);
        warnings.push(...built.warnings);
      }
      const truth = axis === "x" ? data.truthX : data.truthY;
      const noise = axis === "x" ? data.noiseX : data.noiseY;
      for (const flowKey of Object.keys(results)) {
        if (built.operators[flowKey]) {
          evaluateOperator(built.operators[flowKey], sampleIndices, truth, noise, data, results[flowKey], axis);
        } else {
          // RBFが解けなかったときなど。0のままだと「残差0」と誤解されるので、値なしにする
          for (const metric of METRIC_KEYS) {
            results[flowKey][axis][metric].fill(NaN);
          }
        }
      }
    }
    return { results, warnings: Array.from(new Set(warnings)) };
  }

  /**
   * 全Markを計測してHOWAで補正したときの基準。
   * 多項式で表せない成分だけが残るので、選び方による悪化を測る物差しになる。
   * （全Markを測るとRBFは計測値をそのまま通るため、RBFの流れは基準に使わない）
   */
  function evaluateAllMarks(map, data, modelSettings) {
    const allIndices = Array.from({ length: map.marks.length }, (_, i) => i);
    const baselineFlows = { howa: true, rbfThenHowa: false, howaPlusRbf: false };
    return evaluateSampleSet(map, data, modelSettings, allIndices, baselineFlows);
  }

  /**
   * 評価を実行する。
   * input: { map, data, settings, manual: { shotIndices, extraMarkIndices } }
   * onProgress(done, total, label)、isCancelled() で進み具合と中止を扱う。
   */
  async function runEvaluation(input, onProgress, isCancelled) {
    const { map, data, settings } = input;
    const built = ASC.constraints.buildContext(map, settings);
    if (built.errors.length > 0) {
      return { errors: built.errors };
    }
    const context = built.context;
    const sampling = settings.sampling;
    const relaxed = ASC.constraints.resolveHardConstraints(context, sampling.seed, (ctx, random) =>
      Boolean(ASC.sampling.findFeasibleState(ctx, random))
    );
    const flows = settings.model.flows;
    const termSets = [settings.model.termsX, settings.model.termsY];

    // ---- 選ぶ ----
    const plan = [];
    for (const method of C.METHODS) {
      if (!sampling.methods[method.key]) {
        continue;
      }
      if (method.key === "manual") {
        if (input.manual && input.manual.shotIndices.length > 0) {
          plan.push({ method: method.key, draw: 0 });
        }
        continue;
      }
      const drawCount = method.usesDraws ? sampling.draws : 1;
      for (let draw = 0; draw < drawCount; draw++) {
        plan.push({ method: method.key, draw });
      }
    }
    const totalSteps = plan.length * 2 + 2;
    let doneSteps = 0;

    const sets = [];
    for (const entry of plan) {
      if (isCancelled()) {
        return { cancelled: true };
      }
      const methodIndex = C.METHODS.findIndex((method) => method.key === entry.method);
      const random = M.createRandom(M.deriveSeed(sampling.seed, STREAM_METHOD_BASE + methodIndex * 100000 + entry.draw));
      let selection = null;
      switch (entry.method) {
        case "random":
          selection = ASC.sampling.selectRandom(context, random);
          break;
        case "poisson":
          selection = ASC.sampling.selectPoisson(context, random);
          break;
        case "dOptimal":
          selection = ASC.sampling.selectOptimal(context, random, "D", termSets, sampling.optimalStarts);
          break;
        case "iOptimal":
          selection = ASC.sampling.selectOptimal(context, random, "I", termSets, sampling.optimalStarts);
          break;
        case "manual":
          selection = ASC.sampling.manualSelection(context, input.manual.shotIndices, input.manual.extraMarkIndices);
          break;
      }
      doneSteps++;
      onProgress(doneSteps, totalSteps, "計測Markを選んでいます");
      if (!selection || selection.markIndices.length === 0) {
        continue;
      }
      sets.push(describeSet(context, settings, entry, selection));
      await yieldToBrowser();
    }

    // ---- 補正して残差を求める ----
    for (const set of sets) {
      if (isCancelled()) {
        return { cancelled: true };
      }
      const evaluation = evaluateSampleSet(map, data, settings.model, set.markIndices, flows);
      set.results = evaluation.results;
      set.warnings.push(...evaluation.warnings);
      doneSteps++;
      onProgress(doneSteps, totalSteps, "補正して残差を求めています");
      await yieldToBrowser();
    }
    const uncorrected = evaluateUncorrected(data);
    const allMarks = evaluateAllMarks(map, data, settings.model);
    doneSteps += 2;
    onProgress(doneSteps, totalSteps, "集計しています");

    return {
      errors: [],
      context,
      relaxed,
      sets,
      baselines: { uncorrected, allMarks: allMarks.results },
      summary: summarizeResults(sets, flows),
      waferCount: data.waferCount,
    };
  }

  /** 選んだ点の情報（Shot数・Mark数・最小間隔・κ・制約の状況）をまとめる。 */
  function describeSet(context, settings, entry, selection) {
    const map = context.map;
    const markIndices = Array.from(new Set(selection.markIndices)).sort((a, b) => a - b);
    const warnings = [];
    if (selection.notEligible && selection.notEligible.length > 0) {
      warnings.push(`必ず測るMarkが有効範囲外のShot ${selection.notEligible.length}個は、手動選択から外しました。`);
    }
    return {
      method: entry.method,
      draw: entry.draw,
      items: selection.items.slice(),
      shotIndices: selection.items.map((item) => context.items[item].shotIndex),
      markIndices,
      minSpacingMm: ASC.sampling.minimumShotSpacing(context, selection.items),
      kappaX: ASC.sampling.kappaOf(map, markIndices, settings.model.termsX),
      kappaY: ASC.sampling.kappaOf(map, markIndices, settings.model.termsY),
      status: ASC.constraints.describeStatus(context, selection.items, markIndices),
      warnings,
      results: null,
    };
  }

  /**
   * 選び方 × 補正の流れ × 軸 × 指標ごとに、全試行・全Waferの値をまとめる。
   * ランダム系は、試行ごとの平均（Wafer平均）のばらつきも出す。
   */
  function summarizeResults(sets, flows) {
    const summary = {};
    for (const method of C.METHODS) {
      const methodSets = sets.filter((set) => set.method === method.key && set.results);
      if (methodSets.length === 0) {
        continue;
      }
      summary[method.key] = { drawCount: methodSets.length, flows: {} };
      for (const flow of C.FLOWS) {
        if (!flows[flow.key]) {
          continue;
        }
        const flowSummary = {};
        for (const axis of AXES) {
          flowSummary[axis] = {};
          for (const metric of METRIC_KEYS) {
            const all = [];
            const perDraw = [];
            for (const set of methodSets) {
              const values = set.results[flow.key][axis][metric];
              all.push(...values);
              perDraw.push(M.mean(values));
            }
            flowSummary[axis][metric] = { all: M.summarize(all), perDraw: M.summarize(perDraw) };
          }
        }
        summary[method.key].flows[flow.key] = flowSummary;
      }
      summary[method.key].kappaX = M.summarize(methodSets.map((set) => set.kappaX));
      summary[method.key].kappaY = M.summarize(methodSets.map((set) => set.kappaY));
      summary[method.key].minSpacingMm = M.summarize(methodSets.map((set) => set.minSpacingMm));
      summary[method.key].markCount = M.summarize(methodSets.map((set) => set.markIndices.length));
      summary[method.key].shotCount = M.summarize(methodSets.map((set) => set.shotIndices.length));
      summary[method.key].constraintsMet = methodSets.filter(
        (set) => set.status.rows.every((row) => row.ok) && (!set.status.center || set.status.center.ok)
      ).length;
    }
    return summary;
  }

  /** 1つの基準（Wafer数ぶんの値）を集計する。 */
  function summarizeStore(store) {
    const result = {};
    for (const axis of AXES) {
      result[axis] = {};
      for (const metric of METRIC_KEYS) {
        result[axis][metric] = M.summarize(store[axis][metric]);
      }
    }
    return result;
  }

  ASC.evaluator = {
    METRIC_KEYS,
    AXES,
    residualMetrics,
    evaluateSampleSet,
    runEvaluation,
    summarizeStore,
  };
})(typeof window !== "undefined" ? window : globalThis);
