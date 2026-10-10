"""ブラウザ版（JavaScript）と同じ結果になるかの照合。

基準データ tests/reference/scenario_*.json は `node tools/export_reference.js` で作る。
選んだ点（Shot・Mark）は完全に一致し、残差などの数値は丸め誤差の範囲（相対 1e-9）で一致することを確かめる。
実行: cd python && .venv/bin/python -m unittest discover -s tests -v
"""

import json
import math
import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import alignment_sampling as asc  # noqa: E402
from alignment_sampling import constants as C  # noqa: E402
from alignment_sampling import constraints as K  # noqa: E402
from alignment_sampling.rng import Random, derive_seed  # noqa: E402

REFERENCE_DIRECTORY = Path(__file__).resolve().parents[2] / "tests" / "reference"
RELATIVE_TOLERANCE = 1e-9


def load_reference(name):
    return json.loads((REFERENCE_DIRECTORY / f"scenario_{name}.json").read_text(encoding="utf-8"))


def assert_close(test, actual, expected, label):
    if expected is None:
        test.assertFalse(math.isfinite(actual), f"{label}: ブラウザ版は計算できない値ですが、{actual} になりました")
        return
    test.assertLessEqual(abs(actual - expected), RELATIVE_TOLERANCE * max(1.0, abs(expected)), f"{label}: {actual} と {expected} が違います")


class RandomTest(unittest.TestCase):
    def test_same_sequence_as_javascript(self):
        random = Random(1)
        values = [random.next(), random.next(), random.normal(), random.normal(), random.normal()]
        expected = [0.6270739405881613, 0.002735721180215478, 1.1231041937525543, -0.1343525350713427, -0.049227862786499016]
        for value, reference in zip(values, expected):
            self.assertAlmostEqual(value, reference, places=15)
        self.assertEqual([derive_seed(1, 0), derive_seed(1, 1000), derive_seed(4294967295, 7919)], [2980047484, 2214279594, 1482834068])


def shift_rows(status):
    return [{"key": row["key"], "shift": row["shift"], "ok": row["ok"]} for row in K.status_rows(status)]


def check_sets(test, actual_sets, expected_sets):
    """選んだ点（Shot・Mark の完全一致）と、D・I基準・制約の満たし具合を照合する。"""
    test.assertEqual(len(actual_sets), len(expected_sets))
    for actual, expected in zip(actual_sets, expected_sets):
        label = f"{expected['method']} 試行{expected['draw'] + 1}"
        test.assertEqual(actual["method"], expected["method"])
        test.assertEqual(actual["shotIndices"], expected["shotIndices"], f"{label}: 選んだShotが違います")
        test.assertEqual(actual["markIndices"], expected["markIndices"], f"{label}: 測るMarkが違います")
        assert_close(test, actual["minSpacingMm"], expected["minSpacingMm"], f"{label} 最小間隔")
        for axis in ["x", "y"]:
            test.assertEqual(actual["criteria"][axis]["singular"], expected["criteria"][axis]["singular"])
            assert_close(test, actual["criteria"][axis]["logDet"], expected["criteria"][axis]["logDet"], f"{label} D基準 {axis}")
            assert_close(test, actual["criteria"][axis]["trace"], expected["criteria"][axis]["trace"], f"{label} I基準 {axis}")
        test.assertEqual(shift_rows(actual["status"]), expected["shifts"], f"{label}: 制約の満たし具合が違います")


class ScenarioTest:
    """場面ごとの照合（A・B・Cで共通）。"""

    name = None

    @classmethod
    def setUpClass(cls):
        cls.reference = load_reference(cls.name)
        settings = cls.reference["settings"]
        cls.map = asc.generate_wafer_map(settings["map"])
        cls.data = asc.generate_evaluation_data(cls.map, settings["evaluationData"])
        plan = asc.plan_from_shot_ids("手動の例", cls.reference["manualShotIds"], cls.map, key="manual:1")
        cls.plans = [plan]
        cls.output = asc.run_evaluation(cls.map, cls.data, settings, cls.plans)

    def test_map_and_data(self):
        reference = self.reference
        self.assertEqual(len(self.map["shots"]), reference["map"]["shotCount"])
        self.assertEqual([shot["id"] for shot in self.map["shots"]], reference["map"]["shotIds"])
        self.assertEqual([shot["scan"] for shot in self.map["shots"]], reference["map"]["scans"])
        self.assertEqual([shot["definedMarkCount"] for shot in self.map["shots"]], reference["map"]["definedMarkCounts"])
        marks = np.array([[mark["x"], mark["y"], mark["shotIndex"], mark["markNo"]] for mark in self.map["marks"]])
        np.testing.assert_allclose(marks, np.array(reference["map"]["marks"]), atol=1e-12)
        np.testing.assert_allclose(self.data["truthX"][0], reference["data"]["truthX0"], rtol=1e-9, atol=1e-12)
        np.testing.assert_allclose(self.data["truthY"][-1], reference["data"]["truthYLast"], rtol=1e-9, atol=1e-12)
        np.testing.assert_allclose(self.data["noiseX"][0], reference["data"]["noiseX0"], rtol=1e-12, atol=1e-15)
        np.testing.assert_allclose(self.data["noiseY"][-1], reference["data"]["noiseYLast"], rtol=1e-12, atol=1e-15)

    def test_selected_points_are_identical(self):
        self.assertEqual([method["key"] for method in self.output["methods"]], self.reference["methods"])
        self.assertEqual([variant["key"] for variant in self.output["variants"]], self.reference["variants"])
        self.assertEqual([entry["key"] for entry in self.output["relaxed"]], self.reference["relaxed"])
        self.assertEqual(self.output["failedMethods"], self.reference["failedMethods"])
        self.assertEqual([item["shotIndex"] for item in self.output["context"]["items"]], self.reference["eligibleShots"])
        self.assertEqual(self.output["context"]["mandatoryItems"], self.reference["mandatoryItems"])
        check_sets(self, self.output["sets"], self.reference["sets"])

    def test_plan_and_selection_csv(self):
        """「計画を作成」の点（制約付きD最適・I最適）と、選択点のCSVの文字が同じ。"""
        plan = asc.run_plan(self.map, self.reference["settings"])
        self.assertEqual([entry["key"] for entry in plan["relaxed"]], self.reference["plan"]["relaxed"])
        check_sets(self, plan["sets"], self.reference["plan"]["sets"])
        self.assertEqual(asc.selection_to_csv(self.map, plan["sets"][0]["markIndices"]), self.reference["selectionCsv"])

    def test_summary_values(self):
        for method_key, expected in self.reference["summary"].items():
            actual = self.output["summary"][method_key]
            self.assertEqual(actual["drawCount"], expected["drawCount"])
            for variant_key, axes in expected["variants"].items():
                for axis, metrics in axes.items():
                    for metric, values in metrics.items():
                        stats = actual["variants"][variant_key][axis][metric]["all"]
                        for statistic in ["mean", "p95", "max"]:
                            assert_close(self, stats[statistic], values[statistic], f"{method_key} {variant_key} {axis} {metric} {statistic}")
            for key, axes in expected["estimation"].items():
                for axis, values in axes.items():
                    assert_close(self, actual["estimation"][key][axis]["rms"]["all"]["mean"], values["rms"], f"{method_key} 推定精度 {key} {axis}")
                    assert_close(self, actual["estimation"][key][axis]["max"]["all"]["mean"], values["max"], f"{method_key} 推定精度 {key} {axis} 最大")
            for key, values in expected["gpChoices"].items():
                self.assertEqual(actual["gpChoices"][key]["lengthMm"]["count"], values["count"])
                assert_close(self, actual["gpChoices"][key]["lengthMm"]["median"], values["lengthMedian"], f"{method_key} {key} 相関の長さ")
                assert_close(self, actual["gpChoices"][key]["noiseRatio"]["median"], values["ratioMedian"], f"{method_key} {key} ノイズ比")
            self.assertEqual(
                [{"key": e["key"], "satisfied": e["satisfied"], "total": e["total"], "meanShift": e["meanShift"]} for e in actual["constraints"]],
                expected["constraints"],
            )
        for axis in ["x", "y"]:
            for key in ["logDet", "trace"]:
                assert_close(self, self.output["criteriaReference"][axis][key], self.reference["criteriaReference"][axis][key], f"効率の基準 {axis} {key}")
        baseline = asc.summarize_store(self.output["baselines"]["allMarks"]["howa"])["x"]["rms"]["mean"]
        assert_close(self, baseline, self.reference["baseline"], "全点計測")

    def test_sweep(self):
        if "sweep" not in self.reference:
            self.skipTest("この場面にはスイープの基準データがありません")
        reference = self.reference["sweep"]
        sweep = asc.run_sweep(self.map, self.data, self.reference["settings"], manual_plans=self.plans)
        self.assertEqual([point["shotCount"] for point in sweep["points"]], [point["shotCount"] for point in reference["points"]])
        for actual, expected in zip(sweep["points"], reference["points"]):
            self.assertEqual(actual["markCounts"], expected["markCounts"])
            for method_key, value in expected["howaRmsX"].items():
                assert_close(self, actual["summary"][method_key]["variants"]["howa"]["x"]["rms"]["all"]["mean"], value, f"スイープ Shot {actual['shotCount']} {method_key}")
        for method_key, expected in reference["manual"].items():
            self.assertEqual(sweep["manual"]["markCounts"][method_key], expected["markCount"])
            assert_close(self, sweep["manual"]["summary"][method_key]["variants"]["howa"]["x"]["rms"]["all"]["mean"], expected["howaRmsX"], "スイープ 手動プラン")


class ScenarioATest(ScenarioTest, unittest.TestCase):
    name = "a"


class ScenarioBTest(ScenarioTest, unittest.TestCase):
    name = "b"


class ScenarioCTest(ScenarioTest, unittest.TestCase):
    """一筆書きを右下から・強制計測Shot・スイープで選ぶ選び方を絞る（端のShotでMark数が選び方ごとに違う）。"""

    name = "c"


class SettingsTest(unittest.TestCase):
    def test_default_settings_match_browser(self):
        """初期設定がブラウザ版と同じ（基準データの場面Aは初期設定を一部変えたもの）。"""
        reference = load_reference("a")["settings"]
        settings = C.default_settings()
        for section in ["map", "zones", "model", "constraints"]:
            self.assertEqual(settings[section], reference[section], f"{section} の初期設定が違います")
        self.assertEqual(settings["sweep"]["methods"], reference["sweep"]["methods"])
        self.assertEqual(sorted(settings["sampling"]), sorted(reference["sampling"]), "sampling の項目が違います")
        self.assertEqual(settings["evaluationData"]["terms"], reference["evaluationData"]["terms"])

    def test_old_settings_file(self):
        """版2の設定ファイル: D最適・I最適は制約付きとして読み、なくなった項目は使わない。"""
        import json
        import tempfile

        old = {"version": 2, "settings": {"sampling": {"shotCount": 12, "designatedMarkNos": [1, 4], "markMode": "atLeast", "methods": {"random": False, "poisson": True, "dOptimal": True, "iOptimal": False}}, "model": {"flows": {"howa": True, "estimateThenHowa": False, "howaPlusEstimate": True}}}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "old.json"
            path.write_text(json.dumps(old), encoding="utf-8")
            loaded = asc.load_settings_file(path)
        sampling_settings = loaded["settings"]["sampling"]
        self.assertEqual(sampling_settings["shotCount"], 12)
        self.assertNotIn("designatedMarkNos", sampling_settings)
        self.assertEqual(sampling_settings["methods"], {"random": False, "poisson": True, "dOptimal": False, "iOptimal": False, "constrainedD": True, "constrainedI": False})
        self.assertEqual(loaded["settings"]["model"]["flows"], {"howa": True, "estimateThenHowa": False})

    def test_csv_round_trip(self):
        settings = C.default_settings()
        wafer_map = asc.generate_wafer_map(settings["map"])
        parsed = asc.parse_map_csv(asc.map_to_csv(wafer_map), settings["map"])
        self.assertEqual(len(parsed["marks"]), len(wafer_map["marks"]))
        np.testing.assert_allclose([[m["x"], m["y"]] for m in parsed["marks"]], [[m["x"], m["y"]] for m in wafer_map["marks"]], atol=1e-9)


if __name__ == "__main__":
    unittest.main()
