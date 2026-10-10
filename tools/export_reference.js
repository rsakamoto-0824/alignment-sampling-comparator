/**
 * ブラウザ版（JavaScript）の計算結果を、Python版・MATLAB版の照合用の基準データ（JSON）として書き出す。
 * 実行: node tools/export_reference.js
 * 出力: tests/reference/scenario_a.json, scenario_b.json, scenario_c.json
 *
 * 3つの場面を用意する。どの場面も、制約なし・制約付きのD最適・I最適を含む6つの選び方と手動プランを評価し、
 * 「計画を作成」（制約付きD最適・I最適）の点と、選択点のCSVも書き出す。
 *   A: 初期設定を小さくしたもの（一筆書きのScan方向、端のShotも選ぶ。スイープを含む）
 *   B: 市松のScan方向・端のShotを選ばない・強制計測Shot・除外Shot（手動プランに除外Shotを入れる）・ソフト制約・
 *      比例配分・ガウス基底のRBF・Matérn のGP・正規分布・RMS正規化・Scanのずれ・XとYで違う多項式の項
 *   C: 一筆書きを右下から・最初はDown、強制計測Shot、スイープで選ぶ選び方を絞る（端のShotでMark数が選び方ごとに違う）
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
for (const file of ["constants.js", "math-utils.js", "zernike.js", "wafer-map.js", "evaluation-data.js", "correction.js", "constraints.js", "sampling.js", "evaluator.js"]) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, "src", "js", file), "utf8"), { filename: file });
}
const ASC = globalThis.ASC;

/** 初期設定に Zernike項の大きさを埋めたもの（アプリの createInitialSettings と同じ）。 */
function baseSettings() {
  const settings = ASC.defaultSettings();
  const data = settings.evaluationData;
  data.terms = ASC.evaluationData.defaultTermSettings(data.lowOrderAmplitudeNm, data.highOrderAmplitudeNm);
  return settings;
}

function scenarioA() {
  const settings = baseSettings();
  settings.evaluationData.waferCount = 6;
  settings.sampling.draws = 3;
  settings.sampling.optimalStarts = 2;
  settings.sweep = Object.assign({}, settings.sweep, { startShots: 10, endShots: 30, stepShots: 10, draws: 2 });
  return { name: "A", settings, manualShotIds: ["12", "23", "32", "39", "48", "57", "66", "73", "82", "93", "20", "41", "60", "70", "85", "99"] };
}

function scenarioB() {
  const settings = baseSettings();
  const data = settings.evaluationData;
  data.waferCount = 5;
  data.seed = 7;
  data.distribution = "normal";
  data.normalization = "rms";
  data.scanOffsetXnm = 0.5;
  data.scanOffsetYnm = 0.2;
  data.noiseSigmaYnm = 0.5;
  data.terms[3].enabled = false;
  data.terms[10].yValue = 0;
  settings.model.termsY = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  settings.model.rbfKernel = "gaussian";
  settings.model.rbfLambda = 0.01;
  settings.model.gpKernel = "matern52";
  settings.map.scanPattern = "checker";
  settings.sampling.excludeIncompleteShots = true;
  settings.sampling.shotCount = 18;
  settings.sampling.draws = 2;
  settings.sampling.optimalStarts = 2;
  settings.sampling.seed = 11;
  settings.constraints.scan.hard = false;
  settings.constraints.zone.allocation = "proportional";
  settings.constraints.softStrength = 0.7;
  settings.constraints.mandatoryShotIds = ["30", "45", "70"];
  settings.constraints.excludedShotIds = ["46", "47"];
  return { name: "B", settings, manualShotIds: ["5", "16", "27", "38", "49", "60", "71", "82", "93", "14", "35", "46", "56", "77", "88"] };
}

function scenarioC() {
  const settings = baseSettings();
  settings.evaluationData.waferCount = 3;
  settings.map.serpentineStart = "bottomRight";
  settings.map.serpentineFirstScan = "Down";
  settings.sampling.shotCount = 14;
  settings.sampling.draws = 1;
  settings.sampling.optimalStarts = 1;
  settings.constraints.mandatoryShotIds = ["58"];
  settings.sweep = {
    startShots: 11,
    endShots: 13,
    stepShots: 2,
    draws: 1,
    methods: { random: true, poisson: false, dOptimal: true, iOptimal: false, constrainedD: true, constrainedI: false },
  };
  return { name: "C", settings, manualShotIds: ["1", "5", "16", "27", "38", "49", "60", "71", "82", "93", "14", "35", "56", "77", "88", "104"] };
}

function round(value) {
  return Number.isFinite(value) ? value : null;
}

function summaryOf(output) {
  const result = {};
  for (const method of output.methods) {
    const summary = output.summary[method.key];
    const variants = {};
    for (const variant of output.variants) {
      variants[variant.key] = {};
      for (const axis of ["x", "y"]) {
        variants[variant.key][axis] = {};
        for (const metric of ["rms", "mean3sigma", "max"]) {
          const stats = summary.variants[variant.key][axis][metric].all;
          variants[variant.key][axis][metric] = { mean: round(stats.mean), p95: round(stats.p95), max: round(stats.max) };
        }
      }
    }
    const estimation = {};
    for (const key of Object.keys(summary.estimation)) {
      estimation[key] = {};
      for (const axis of ["x", "y"]) {
        estimation[key][axis] = { rms: round(summary.estimation[key][axis].rms.all.mean), max: round(summary.estimation[key][axis].max.all.mean) };
      }
    }
    const gpChoices = {};
    for (const [key, value] of Object.entries(summary.gpChoices)) {
      gpChoices[key] = { lengthMedian: round(value.lengthMm.median), ratioMedian: round(value.noiseRatio.median), count: value.lengthMm.count };
    }
    result[method.key] = {
      label: method.label,
      drawCount: summary.drawCount,
      variants,
      estimation,
      gpChoices,
      constraints: summary.constraints.map((entry) => ({ key: entry.key, satisfied: entry.satisfied, total: entry.total, meanShift: entry.meanShift })),
    };
  }
  return result;
}

function setsOf(output) {
  return output.sets.map((set) => ({
    method: set.method,
    draw: set.draw,
    shotIndices: set.shotIndices,
    markIndices: set.markIndices,
    minSpacingMm: round(set.minSpacingMm),
    criteria: {
      x: { logDet: round(set.criteria.x.logDet), trace: round(set.criteria.x.trace), singular: set.criteria.x.singular },
      y: { logDet: round(set.criteria.y.logDet), trace: round(set.criteria.y.trace), singular: set.criteria.y.singular },
    },
    shifts: ASC.constraints.statusRows(set.status).map((row) => ({ key: row.key, shift: row.shift, ok: row.ok })),
  }));
}

async function exportScenario(scenario, withSweep) {
  const map = ASC.waferMap.generateWaferMap(scenario.settings.map).map;
  const data = ASC.evaluationData.generateEvaluationData(map, scenario.settings.evaluationData).data;
  const shotIndexById = new Map(map.shots.map((shot, index) => [shot.id, index]));
  const manualPlans = [{ key: "manual:1", label: "手動の例", shotIndices: scenario.manualShotIds.map((id) => shotIndexById.get(id)) }];
  const output = await ASC.evaluator.runEvaluation({ map, data, settings: scenario.settings, manualPlans }, () => {}, () => false);
  if (output.errors.length > 0) {
    throw new Error(output.errors.join(" / "));
  }
  const result = {
    scenario: scenario.name,
    generatedBy: "tools/export_reference.js",
    settings: scenario.settings,
    manualShotIds: scenario.manualShotIds,
    map: {
      shotCount: map.shots.length,
      markCount: map.marks.length,
      marks: map.marks.map((mark) => [mark.x, mark.y, mark.shotIndex, mark.markNo]),
      shotIds: map.shots.map((shot) => shot.id),
      scans: map.shots.map((shot) => shot.scan),
      definedMarkCounts: map.shots.map((shot) => shot.definedMarkCount),
    },
    data: {
      truthX0: Array.from(data.truthX.subarray(0, data.markCount)),
      truthYLast: Array.from(data.truthY.subarray((data.waferCount - 1) * data.markCount)),
      noiseX0: Array.from(data.noiseX.subarray(0, data.markCount)),
      noiseYLast: Array.from(data.noiseY.subarray((data.waferCount - 1) * data.markCount)),
    },
    relaxed: output.relaxed.map((entry) => entry.key),
    failedMethods: output.failedMethods,
    eligibleShots: output.context.items.map((item) => item.shotIndex),
    mandatoryItems: output.context.mandatoryItems,
    methods: output.methods.map((method) => method.key),
    variants: output.variants.map((variant) => variant.key),
    sets: setsOf(output),
    summary: summaryOf(output),
    criteriaReference: output.criteriaReference,
    baseline: ASC.evaluator.summarizeStore(output.baselines.allMarks.howa).x.rms.mean,
  };
  // 「計画を作成」の点（評価の制約付きD最適・I最適と同じになる）と、選択点のCSV（計画の制約付きD最適）
  const plan = ASC.evaluator.runPlan({ map, settings: scenario.settings });
  if (plan.errors.length > 0) {
    throw new Error(plan.errors.join(" / "));
  }
  result.plan = { relaxed: plan.relaxed.map((entry) => entry.key), sets: setsOf(plan) };
  result.selectionCsv = ASC.waferMap.selectionToCsv(map, plan.sets[0].markIndices);
  if (withSweep) {
    const sweep = await ASC.evaluator.runSweep({ map, data, settings: scenario.settings, manualPlans }, scenario.settings.sweep, () => {}, () => false);
    result.sweep = {
      points: sweep.points.map((point) => ({
        shotCount: point.shotCount,
        markCounts: point.markCounts,
        howaRmsX: Object.fromEntries(Object.entries(point.summary).map(([key, summary]) => [key, round(summary.variants.howa.x.rms.all.mean)])),
      })),
      manual: sweep.manual ? Object.fromEntries(sweep.manual.methods.map((method) => [method.key, { markCount: sweep.manual.markCounts[method.key], howaRmsX: round(sweep.manual.summary[method.key].variants.howa.x.rms.all.mean) }])) : null,
    };
  }
  return result;
}

async function main() {
  const outputDirectory = path.join(ROOT, "tests", "reference");
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [scenario, withSweep] of [[scenarioA(), true], [scenarioB(), false], [scenarioC(), true]]) {
    const started = Date.now();
    const result = await exportScenario(scenario, withSweep);
    const file = path.join(outputDirectory, `scenario_${scenario.name.toLowerCase()}.json`);
    fs.writeFileSync(file, JSON.stringify(result));
    console.log(`${path.relative(ROOT, file)}: 選択 ${result.sets.length}組、${Date.now() - started} ms`);
  }
}

main();
