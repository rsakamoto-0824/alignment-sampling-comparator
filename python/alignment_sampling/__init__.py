"""アライメント計測Markの選び方の比較（Python版）。

ブラウザ版（index.html）と同じ計算・同じ乱数で、同じ設定なら同じ点を選び、同じ残差になる。
主な使い方:

    import alignment_sampling as asc
    settings = asc.default_settings()
    wafer_map = asc.generate_wafer_map(settings["map"])
    data = asc.generate_evaluation_data(wafer_map, settings["evaluationData"])
    output = asc.run_evaluation(wafer_map, data, settings)
"""

from .constants import default_settings
from .evaluation_data import default_term_settings, generate_evaluation_data
from .evaluator import estimation_label, run_evaluation, run_sweep, summarize, summarize_store
from .sampling import design_criteria, efficiencies
from .settings_io import copy_settings, load_settings_file, manual_plan_inputs, map_from_loaded, plan_from_shot_ids
from .wafer_map import build_map_from_settings, generate_wafer_map, map_to_csv, parse_map_csv

__all__ = [
    "build_map_from_settings",
    "copy_settings",
    "default_settings",
    "default_term_settings",
    "design_criteria",
    "efficiencies",
    "estimation_label",
    "generate_evaluation_data",
    "generate_wafer_map",
    "load_settings_file",
    "manual_plan_inputs",
    "map_from_loaded",
    "map_to_csv",
    "parse_map_csv",
    "plan_from_shot_ids",
    "run_evaluation",
    "run_sweep",
    "summarize",
    "summarize_store",
]
