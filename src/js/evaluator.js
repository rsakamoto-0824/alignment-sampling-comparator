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

  // スイープの点の数の上限（計測時間が長くなりすぎないように）
  const SWEEP_MAX_POINTS = 30;

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

  /** out = P y（P は Mark数×計測点数）。 */
  function applyOperator(operator, measured, n, markCount, out) {
    for (let i = 0; i < markCount; i++) {
      let sum = 0;
      const rowOffset = i * n;
      for (let j = 0; j < n; j++) {
        sum += operator[rowOffset + j] * measured[j];
      }
      out[i] = sum;
    }
  }

  function storeMetrics(store, axis, wafer, truth, waferOffset, correction, markCount, residual) {
    for (let i = 0; i < markCount; i++) {
      residual[i] = truth[waferOffset + i] - correction[i];
    }
    const metrics = residualMetrics(residual, markCount);
    for (const metric of METRIC_KEYS) {
      store[axis][metric][wafer] = metrics[metric];
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
   * 全Markでの多項式の当てはめの部品。選んだ点によらないので、項の組み合わせごとに1回だけ作る。
   */
  function createModelCache(map) {
    const cache = new Map();
    const allIndices = Array.from({ length: map.marks.length }, (_, i) => i);
    return function (terms) {
      const key = terms.join(",");
      if (!cache.has(key)) {
        const allDesign = ASC.correction.polynomialDesign(map.marks, allIndices, terms);
        const allLeastSquares = ASC.correction.leastSquaresOperator(allDesign, map.marks.length, terms.length);
        cache.set(key, { allDesign, allLeastSquares });
      }
      return cache.get(key);
    };
  }

  /** 推定手法ごとの前準備（選んだ点ごとに1回、XとYで共通）。 */
  function prepareEstimators(marks, sampleIndices, modelSettings, estimatorList, warnings) {
    const prepared = {};
    for (const estimator of estimatorList) {
      if (estimator.type === "rbf") {
        const result = ASC.correction.rbfOperator(
          marks,
          sampleIndices,
          { kernel: modelSettings.rbfKernel, lambda: modelSettings.rbfLambda, shapeFactor: modelSettings.rbfShapeFactor },
          estimator.features
        );
        prepared[estimator.key] = result.error ? { error: result.error } : { type: "linear", operator: result.operator };
      } else {
        const result = ASC.correction.prepareGp(marks, sampleIndices, estimator.features, modelSettings.gpKernel);
        prepared[estimator.key] = result.error ? { error: result.error } : { type: "gp", gp: result };
      }
      if (prepared[estimator.key].error) {
        warnings.push(`${estimator.longLabel}: ${prepared[estimator.key].error}`);
      }
    }
    return prepared;
  }

  /** 推定精度を評価する推定手法（設定で選んだもの）。 */
  function selectedEstimators(modelSettings) {
    return C.ESTIMATORS.filter((estimator) => modelSettings.estimators[estimator.key]);
  }

  /**
   * 1組の計測Markについて、次を求める。
   *   results: 補正ごと（HOWAのみ、流れ × 推定手法）・軸ごとの残差の指標（全Mark）
   *   estimation: 推定手法ごとの推定精度。計測値から推定した未計測Markの値と真のずれの差の指標。
   *               "howa" は多項式で予測した場合（比べる基準）
   *   estimationSquares: 推定誤差の2乗をWaferで足したもの（Markごと。誤差のマップに使う。計測Markは NaN）
   *   gpChoices: ガウス過程回帰がWaferごとに選んだ相関の長さ [mm] とノイズ比
   * options.estimation が false なら推定精度は求めない（全点計測の基準など、未計測Markがないとき）。
   */
  function evaluateSampleSet(map, data, modelSettings, sampleIndices, variants, modelCache, options) {
    const marks = map.marks;
    const markCount = marks.length;
    const n = sampleIndices.length;
    const warnings = [];
    const getAllFit = modelCache || createModelCache(map);
    const measuredSet = new Set(sampleIndices);
    const unmeasured = [];
    for (let i = 0; i < markCount; i++) {
      if (!measuredSet.has(i)) {
        unmeasured.push(i);
      }
    }
    const withEstimation = !(options && options.estimation === false) && unmeasured.length > 0;
    // 推定精度の対象と、補正に使う推定手法を合わせて前準備する
    const estimatorList = withEstimation ? selectedEstimators(modelSettings) : [];
    for (const variant of variants) {
      if (variant.estimator && !estimatorList.includes(variant.estimator)) {
        estimatorList.push(variant.estimator);
      }
    }
    const estimators = prepareEstimators(marks, sampleIndices, modelSettings, estimatorList, warnings);

    const results = {};
    const gpChoices = {};
    for (const variant of variants) {
      results[variant.key] = createMetricStore(data.waferCount);
      if (variant.estimator && variant.estimator.type === "gp") {
        gpChoices[variant.key] = { lengthMm: [], noiseRatio: [] };
      }
    }
    const estimationKeys = withEstimation ? ["howa"].concat(selectedEstimators(modelSettings).map((estimator) => estimator.key)) : [];
    const estimation = {};
    const estimationSquares = {};
    for (const key of estimationKeys) {
      estimation[key] = createMetricStore(data.waferCount);
      estimationSquares[key] = {};
      for (const axis of AXES) {
        const squares = new Float64Array(markCount);
        for (const markIndex of sampleIndices) {
          squares[markIndex] = NaN;
        }
        estimationSquares[key][axis] = squares;
      }
    }

    const measured = new Float64Array(n);
    const howaCorrection = new Float64Array(markCount);
    const correction = new Float64Array(markCount);
    const residual = new Float64Array(markCount);
    const leftover = new Float64Array(n);
    const estimateBuffer = new Float64Array(markCount);
    const errorBuffer = new Float64Array(unmeasured.length);
    const howaCache = new Map();
    const gpProjectors = new Map();

    /** 未計測Markでの推定誤差（推定値 − 真のずれ）を記録する。 */
    function recordEstimation(key, axis, wafer, prediction, truth, waferOffset) {
      if (!estimation[key]) {
        return;
      }
      const squares = estimationSquares[key][axis];
      for (let j = 0; j < unmeasured.length; j++) {
        const markIndex = unmeasured[j];
        const error = prediction[markIndex] - truth[waferOffset + markIndex];
        errorBuffer[j] = error;
        squares[markIndex] += error * error;
      }
      const metrics = residualMetrics(errorBuffer, unmeasured.length);
      for (const metric of METRIC_KEYS) {
        estimation[key][axis][metric][wafer] = metrics[metric];
      }
    }

    function markMissing(store, axis, wafer) {
      for (const metric of METRIC_KEYS) {
        store[axis][metric][wafer] = NaN;
      }
    }

    for (const axis of AXES) {
      const terms = axis === "x" ? modelSettings.termsX : modelSettings.termsY;
      const termsKey = terms.join(",");
      if (!howaCache.has(termsKey)) {
        const allFit = getAllFit(terms);
        const howaParts = ASC.correction.prepareHowa(marks, sampleIndices, terms, allFit.allDesign, allFit.allLeastSquares);
        warnings.push(...howaParts.warnings);
        // 線形の補正（HOWAのみ・RBFを使う流れ）は、演算子を先に作っておく
        const operators = {};
        for (const variant of variants) {
          if (!variant.estimator) {
            operators[variant.key] = howaParts.howa;
          } else {
            const estimator = estimators[variant.estimator.key];
            if (estimator.type === "linear") {
              operators[variant.key] = ASC.correction.linearFlowOperator(howaParts, estimator.operator, sampleIndices, variant.flowType, markCount);
            }
          }
        }
        howaCache.set(termsKey, { howaParts, operators });
      }
      const { howaParts, operators } = howaCache.get(termsKey);
      const p = howaParts.p;
      const coefficients = new Float64Array(p);
      const truth = axis === "x" ? data.truthX : data.truthY;
      const noise = axis === "x" ? data.noiseX : data.noiseY;

      for (let wafer = 0; wafer < data.waferCount; wafer++) {
        const waferOffset = wafer * markCount;
        for (let j = 0; j < n; j++) {
          const markIndex = sampleIndices[j];
          measured[j] = truth[waferOffset + markIndex] + noise[waferOffset + markIndex];
        }
        applyOperator(howaParts.howa, measured, n, markCount, howaCorrection);
        recordEstimation("howa", axis, wafer, howaCorrection, truth, waferOffset);

        // 計測値そのものに推定手法を当てはめる（推定精度と「推定→HOWA」で使う）。GPはここで1回だけ学習する
        const rawFits = {};
        for (const estimator of estimatorList) {
          const prepared = estimators[estimator.key];
          if (prepared.error) {
            if (estimation[estimator.key]) {
              markMissing(estimation[estimator.key], axis, wafer);
            }
            continue;
          }
          const needsEstimate = Boolean(estimation[estimator.key]);
          if (prepared.type === "gp") {
            rawFits[estimator.key] = ASC.correction.gpFit(prepared.gp, measured);
            if (needsEstimate) {
              recordEstimation(estimator.key, axis, wafer, ASC.correction.gpPredictAll(prepared.gp, rawFits[estimator.key]), truth, waferOffset);
            }
          } else if (needsEstimate) {
            applyOperator(prepared.operator, measured, n, markCount, estimateBuffer);
            recordEstimation(estimator.key, axis, wafer, estimateBuffer, truth, waferOffset);
          }
        }

        for (const variant of variants) {
          const store = results[variant.key];
          if (operators[variant.key]) {
            applyOperator(operators[variant.key], measured, n, markCount, correction);
            storeMetrics(store, axis, wafer, truth, waferOffset, correction, markCount, residual);
            continue;
          }
          const estimator = estimators[variant.estimator.key];
          if (estimator.error) {
            // 推定できなかったとき。0のままだと「残差0」と誤解されるので、値なしにする
            markMissing(store, axis, wafer);
            continue;
          }
          // ガウス過程回帰はWaferごとに調整値を学習する
          let fit;
          if (variant.flowType === "estimateThenHowa") {
            // 未計測Markを推定して全Markを埋め、全Markに多項式を当てはめる（係数を直接求める）
            fit = rawFits[variant.estimator.key];
            const projectorKey = `${termsKey}|${variant.estimator.key}`;
            if (!gpProjectors.has(projectorKey)) {
              gpProjectors.set(projectorKey, ASC.correction.gpHowaProjector(estimator.gp, howaParts, sampleIndices));
            }
            ASC.correction.gpThenHowaCoefficients(estimator.gp, gpProjectors.get(projectorKey), fit, measured, coefficients);
            for (let i = 0; i < markCount; i++) {
              let sum = 0;
              const offset = i * p;
              for (let k = 0; k < p; k++) {
                sum += howaParts.allDesign[offset + k] * coefficients[k];
              }
              correction[i] = sum;
            }
          } else {
            for (let j = 0; j < n; j++) {
              let fittedValue = 0;
              for (let k = 0; k < n; k++) {
                fittedValue += howaParts.fitted[j * n + k] * measured[k];
              }
              leftover[j] = measured[j] - fittedValue;
            }
            fit = ASC.correction.gpFit(estimator.gp, leftover);
            const estimate = ASC.correction.gpPredictAll(estimator.gp, fit);
            for (let i = 0; i < markCount; i++) {
              correction[i] = howaCorrection[i] + estimate[i];
            }
          }
          storeMetrics(store, axis, wafer, truth, waferOffset, correction, markCount, residual);
          if (Number.isFinite(fit.length)) {
            gpChoices[variant.key].lengthMm.push(fit.length * C.NORMALIZATION_RADIUS_MM);
            gpChoices[variant.key].noiseRatio.push(fit.noiseRatio);
          }
        }
      }
    }
    return { results, estimation, estimationSquares, gpChoices, warnings: Array.from(new Set(warnings)) };
  }

  /**
   * 全Markを計測してHOWAで補正したときの基準。
   * 多項式で表せない成分だけが残るので、選び方による悪化を測る物差しになる。
   * （全Markを測ると未計測Markがなく推定の出番がないため、推定を使う流れは基準に使わない）
   */
  function evaluateAllMarks(map, data, modelSettings, modelCache) {
    const allIndices = Array.from({ length: map.marks.length }, (_, i) => i);
    const howaOnly = [{ key: "howa", flowType: "howa", estimator: null, label: "HOWAのみ" }];
    return evaluateSampleSet(map, data, modelSettings, allIndices, howaOnly, modelCache, { estimation: false });
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
    const variants = ASC.correction.buildVariants(settings.model);
    const modelCache = createModelCache(map);
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
      const evaluation = evaluateSampleSet(map, data, settings.model, set.markIndices, variants, modelCache);
      set.results = evaluation.results;
      set.estimation = evaluation.estimation;
      set.estimationSquares = evaluation.estimationSquares;
      set.gpChoices = evaluation.gpChoices;
      set.warnings.push(...evaluation.warnings);
      doneSteps++;
      onProgress(doneSteps, totalSteps, "補正して残差を求めています");
      await yieldToBrowser();
    }
    const uncorrected = evaluateUncorrected(data);
    const allMarks = evaluateAllMarks(map, data, settings.model, modelCache);
    doneSteps += 2;
    onProgress(doneSteps, totalSteps, "集計しています");

    return {
      errors: [],
      context,
      relaxed,
      sets,
      baselines: { uncorrected, allMarks: allMarks.results },
      variants,
      estimationKeys: estimationKeysOf(settings.model),
      summary: summarizeResults(sets, variants, estimationKeysOf(settings.model)),
      waferCount: data.waferCount,
    };
  }

  /** スイープする計測Shot数の一覧と、設定の誤り。 */
  function sweepShotCounts(sweepSettings, eligibleCount) {
    const { startShots, endShots, stepShots } = sweepSettings;
    const errors = [];
    if (![startShots, endShots, stepShots].every(Number.isInteger) || startShots < 1 || stepShots < 1 || endShots < startShots) {
      errors.push("計測Shot数の範囲は「1 ≦ 開始 ≦ 終了」、刻みは1以上の整数にしてください。");
    } else if (endShots > eligibleCount) {
      errors.push(`終了の計測Shot数（${endShots}）が選べるShot数（${eligibleCount}）を超えています。${eligibleCount}以下にしてください。`);
    }
    if (!Number.isInteger(sweepSettings.draws) || sweepSettings.draws < 1) {
      errors.push("スイープの試行回数は1以上の整数にしてください。");
    }
    const values = [];
    if (errors.length === 0) {
      for (let value = startShots; value <= endShots; value += stepShots) {
        values.push(value);
      }
      if (values.length > SWEEP_MAX_POINTS) {
        errors.push(`スイープの点が${values.length}個あります。刻みを大きくして${SWEEP_MAX_POINTS}個以下にしてください。`);
      }
    }
    return { values, errors };
  }

  /**
   * 計測Shot数を変えながら評価する（計測コストと精度のトレードオフ）。
   * 「k個以上」のときは、Shotあたりの総Mark数の比（総Mark数 ÷ 計測Shot数）を保つ。手動選択は対象にしない。
   * sweepSettings: { startShots, endShots, stepShots, draws }
   * 戻り値: { points: [{ shotCount, markCounts, summary, relaxed, warnings }], variants, estimationKeys, baseline, uncorrected }
   */
  async function runSweep(input, sweepSettings, onProgress, isCancelled) {
    const { map, data, settings } = input;
    const built = ASC.constraints.buildContext(map, settings);
    if (built.errors.length > 0) {
      return { errors: built.errors };
    }
    const { values, errors } = sweepShotCounts(sweepSettings, built.context.items.length);
    if (errors.length > 0) {
      return { errors };
    }
    const sampling = settings.sampling;
    const marksPerShot = sampling.markMode === "exact" ? built.context.markCountPerShot : sampling.totalMarkCount / sampling.shotCount;
    const points = [];
    let last = null;
    for (let index = 0; index < values.length; index++) {
      const shotCount = values[index];
      const pointSettings = JSON.parse(JSON.stringify(settings));
      pointSettings.sampling.shotCount = shotCount;
      pointSettings.sampling.totalMarkCount = Math.max(shotCount * built.context.markCountPerShot, Math.round(shotCount * marksPerShot));
      pointSettings.sampling.draws = sweepSettings.draws;
      pointSettings.sampling.methods.manual = false;
      const output = await runEvaluation(
        { map, data, settings: pointSettings, manual: null },
        (done, total, label) => onProgress(index + done / total, values.length, `計測Shot数 ${shotCount}（${index + 1}/${values.length}）: ${label}`),
        isCancelled
      );
      if (output.cancelled) {
        return { cancelled: true };
      }
      if (output.errors.length > 0) {
        points.push({ shotCount, errors: output.errors });
        continue;
      }
      const markCounts = {};
      for (const [methodKey, summary] of Object.entries(output.summary)) {
        markCounts[methodKey] = summary.markCount.mean;
      }
      points.push({
        shotCount,
        markCounts,
        summary: output.summary,
        relaxed: output.relaxed,
        warnings: Array.from(new Set(output.sets.flatMap((set) => set.warnings))),
      });
      last = output;
    }
    if (!last) {
      return { errors: points.flatMap((point) => point.errors || []) };
    }
    return {
      errors: [],
      points,
      variants: last.variants,
      estimationKeys: last.estimationKeys,
      baseline: summarizeStore(last.baselines.allMarks.howa),
      uncorrected: summarizeStore(last.baselines.uncorrected),
      waferCount: data.waferCount,
      draws: sweepSettings.draws,
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
      gpChoices: null,
    };
  }

  /**
   * 選び方 × 補正 × 軸 × 指標ごとに、全試行・全Waferの値をまとめる。
   * ランダム系は、試行ごとの平均（Wafer平均）のばらつきも出す。
   */
  function summarizeResults(sets, variants, estimationKeys) {
    const summary = {};
    for (const method of C.METHODS) {
      const methodSets = sets.filter((set) => set.method === method.key && set.results);
      if (methodSets.length === 0) {
        continue;
      }
      summary[method.key] = { drawCount: methodSets.length, variants: {}, estimation: {}, gpChoices: {} };
      for (const variant of variants) {
        const variantSummary = {};
        for (const axis of AXES) {
          variantSummary[axis] = {};
          for (const metric of METRIC_KEYS) {
            const all = [];
            const perDraw = [];
            for (const set of methodSets) {
              const values = set.results[variant.key][axis][metric];
              all.push(...values);
              perDraw.push(M.summarize(values).mean);
            }
            variantSummary[axis][metric] = { all: M.summarize(all), perDraw: M.summarize(perDraw) };
          }
        }
        summary[method.key].variants[variant.key] = variantSummary;
        if (variant.estimator && variant.estimator.type === "gp") {
          const lengths = methodSets.flatMap((set) => set.gpChoices[variant.key].lengthMm);
          const ratios = methodSets.flatMap((set) => set.gpChoices[variant.key].noiseRatio);
          summary[method.key].gpChoices[variant.key] = { lengthMm: M.summarize(lengths), noiseRatio: M.summarize(ratios) };
        }
      }
      for (const key of estimationKeys) {
        if (!methodSets[0].estimation[key]) {
          continue;
        }
        summary[method.key].estimation[key] = summarizeStores(methodSets.map((set) => set.estimation[key]));
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

  /** 試行ごとの指標の箱をまとめて集計する（全試行・全Waferの分布と、試行ごとの平均の分布）。 */
  function summarizeStores(stores) {
    const result = {};
    for (const axis of AXES) {
      result[axis] = {};
      for (const metric of METRIC_KEYS) {
        const all = [];
        const perDraw = [];
        for (const store of stores) {
          all.push(...store[axis][metric]);
          perDraw.push(M.summarize(store[axis][metric]).mean);
        }
        result[axis][metric] = { all: M.summarize(all), perDraw: M.summarize(perDraw) };
      }
    }
    return result;
  }

  /** 推定精度を比べる対象（多項式の予測と、選んだ推定手法）。 */
  function estimationKeysOf(modelSettings) {
    return ["howa"].concat(selectedEstimators(modelSettings).map((estimator) => estimator.key));
  }

  /** 推定精度の表やグラフに使う名前。 */
  function estimationLabel(key) {
    if (key === "howa") {
      return "HOWA（多項式の予測）";
    }
    return C.ESTIMATORS.find((estimator) => estimator.key === key).label;
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
    runSweep,
    sweepShotCounts,
    summarizeStore,
    estimationLabel,
  };
})(typeof window !== "undefined" ? window : globalThis);
