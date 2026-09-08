"""HW903 v1.4 reader. Source bytes are never rewritten or normalized in place."""

import csv
import math
import re
from collections import Counter
from datetime import datetime

VERSION = "hw903-v1.4-reader-1"
TIME_FORMAT = "%Y/%m/%d %H:%M:%S_%f"
OPTICAL = re.compile(r"slot[0-4]-adc[0-3]\Z")
NUMBER = re.compile(r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")


def number(value):
    if value == "":
        return None
    if not NUMBER.fullmatch(value):
        raise ValueError("非数值字段")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("非有限数值")
    return result


def read_hw903(path):
    # Encoding fallback only; original byte identity remains in the raw file/hash.
    try:
        return _read(path, "utf-8-sig")
    except UnicodeDecodeError:
        return _read(path, "gb18030")


def _read(path, encoding):
    rows, rr, headers, issues = [], [], [], []
    hw_header = None
    rr_header = ["time", "RRInterval", "timestamp", "rawData"]
    counts = Counter()
    fields = []
    previous = {"hw": None, "rr": None}
    all_times = []

    def issue(line, code, message, severity="warning"):
        issues.append({"line": line, "code": code, "message": message, "severity": severity})

    def check_time(kind, time, line):
        prev = previous[kind]
        if prev is not None:
            dt = (time - prev).total_seconds()
            if dt < 0:
                issue(line, kind + "_time_reverse", "时间倒退：已保留原顺序；该记录需先检查，暂不允许时间区间标注。", "error" if kind == "hw" else "warning")
            elif dt == 0:
                issue(line, kind + "_time_repeat", "相同时间：保留全部记录，不去重。")
            elif dt >= 1 and kind == "hw":
                # A conservative display flag, not a scientific packet-loss claim.
                issue(line, "time_gap", "相邻 HW903 记录间隔至少 1 秒，绘图断开；不据此断言丢包。")
        previous[kind] = time
        all_times.append(time)

    with open(path, "r", encoding=encoding, newline="") as source:
        reader = csv.reader(source, strict=True)
        for row in reader:
            line = reader.line_num
            if not any(row):
                counts["blank"] += 1
                continue
            if row[0] == "time" and all(name in row for name in ("acc-x", "acc-y", "acc-z")):
                hw_header = row
                headers.append({"line": line, "stream": "hw903", "columns": row})
                counts["headers"] += 1
                for name in row:
                    if name in ("acc-x", "acc-y", "acc-z", "hr", "total_step") or OPTICAL.fullmatch(name):
                        if row.count(name) != 1:
                            issue(line, "duplicate_signal_column", "信号字段重名，无法唯一选择：" + name, "error")
                        elif name not in fields:
                            fields.append(name)
                continue
            if row[0] == "time" and all(name in row for name in ("RRInterval", "timestamp", "rawData")):
                rr_header = row
                headers.append({"line": line, "stream": "rr", "columns": row})
                counts["headers"] += 1
                continue
            if row[0].lstrip().startswith("NO."):
                counts["description"] += 1
                continue
            try:
                time = datetime.strptime(row[0], TIME_FORMAT)
            except ValueError:
                issue(line, "unknown_row", "无法识别的行或 time 格式错误；原始行保留。", "error")
                continue
            rr_indices = {name: rr_header.index(name) for name in ("RRInterval", "timestamp", "rawData")}
            raw_index = rr_indices["rawData"]
            rr_shape = len(row) > raw_index and bool(re.fullmatch(r"<[0-9a-fA-F]+>", row[raw_index]))
            if rr_shape:
                try:
                    interval = number(row[rr_indices["RRInterval"]])
                    number(row[rr_indices["timestamp"]])
                    used = {0, *rr_indices.values()}
                    if interval is None or any(value and i not in used for i, value in enumerate(row)):
                        raise ValueError("RR 行含无法归类的非空字段")
                    rr.append({"time": time, "line": line, "RRInterval": interval, "rawData": row[raw_index], "timestamp": row[rr_indices["timestamp"]]})
                    check_time("rr", time, line)
                except (ValueError, IndexError):
                    issue(line, "invalid_rr", "RR 行结构/数值异常；未猜测归类。", "error")
                continue
            if hw_header is None:
                issue(line, "missing_header", "HW903 数据行之前缺少可识别表头。", "error")
                continue
            nonempty_header = max(i for i, value in enumerate(hw_header) if value)
            if len(row) <= nonempty_header or any(value for value in row[len(hw_header):]):
                issue(line, "row_width", "行与 HW903 表头不匹配，保留原始行。", "error")
                continue
            values = {}
            try:
                for field in fields:
                    # Missing column stays absent, empty cell is None, numeric zero is 0.
                    if field in hw_header and hw_header.count(field) == 1:
                        value = number(row[hw_header.index(field)])
                        values[field] = value / 1000.0 if value is not None and field.startswith("acc-") else value
            except (ValueError, IndexError):
                issue(line, "invalid_numeric", "绘图字段含非数值内容；保留原始行并阻止标注。", "error")
                continue
            rows.append({"time": time, "line": line, "values": values})
            check_time("hw", time, line)

    if not rows:
        raise ValueError("未找到可解析的 HW903 采样数据；首版不支持 WBX61 或纯 RR 文件。")
    t0 = min(all_times)
    for stream in (rows, rr):
        for row in stream:
            row["t"] = round((row.pop("time") - t0).total_seconds() * 1000)
    minimum = min(row["t"] for row in rows)
    maximum = max(row["t"] for row in rows)
    gaps = [item for item in issues if item["code"] == "time_gap"]
    return {
        "parser_version": VERSION, "encoding": encoding,
        "t0": t0.strftime(TIME_FORMAT)[:-3], "time_unit": "ms", "timezone": None,
        "time_source": "原始第一列 time；采样/接收/写入来源未确认",
        "sample_rate": None, "sample_rate_note": "标称采样率未确认；按实际 time 绘制，不补点或重采样。",
        "min_ms": minimum, "max_ms": maximum,
        "annotation_end_ms": maximum + 1,
        "end_policy": "末记录 time 加 1 ms 仅用于半开标注区间包含末条记录，不推断后续采样时长。",
        "fields": fields, "headers": headers, "rows": rows, "rr": rr,
        "counts": {**counts, "hw903": len(rows), "rr": len(rr), "gap_flags": len(gaps)},
        "issues": issues,
        "status": "invalid" if any(item["severity"] == "error" for item in issues) else "ready",
        "units": {"acc-x": "mg", "acc-y": "mg", "acc-z": "mg", "hr": "原始值（单位/有效性待协议确认）", "total_step": "原始累计值"},
    }
