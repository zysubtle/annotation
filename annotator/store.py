"""Durable task storage. One process owns a data directory; writes are atomic."""

import copy
import csv
import hashlib
import io
import json
import os
import re
import shutil
import threading
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from . import VERSION
from .parser import read_hw903

LABELS = {"EXERCISE", "NON", "TRANSITION", "UNKNOWN"}
ID = re.compile(r"[0-9a-f]{32}\Z")
SCHEMA = "hw903-annotation-task/1"
MAX_FILE = 64 * 1024 * 1024  # First-release engineering guard, not a device limit.
MAX_ZIP_TOTAL = 512 * 1024 * 1024
MAX_TASK_RAW = 256 * 1024 * 1024
MAX_METADATA = 32 * 1024 * 1024


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def now():
    return datetime.now(timezone.utc).isoformat()


def uid():
    return uuid.uuid4().hex


def sync_directory(path):
    descriptor = os.open(str(path), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, data):
    payload = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_METADATA:
        raise Problem("任务元数据超过首版 32 MiB 限制，请拆分任务")
    temporary = path.with_name(path.name + "." + uid() + ".pending")
    try:
        with open(temporary, "xb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


def load_json(path):
    with open(path, encoding="utf-8") as stream:
        return json.load(stream)


def filename(name):
    if not isinstance(name, str):
        raise Problem("文件名必须是文本")
    value = str(name).replace("\\", "/").split("/")[-1]
    value = "".join(char for char in value if ord(char) >= 32 and char != "\x7f")[:200]
    if not value or value in (".", ".."):
        raise Problem("文件名无效")
    return value


def validate_labels(labels, record):
    if not isinstance(labels, list) or len(labels) > 10000:
        raise Problem("标签应为列表，最多 10000 个区间")
    result, identifiers = [], set()
    for item in labels:
        if not isinstance(item, dict):
            raise Problem("标签格式错误")
        start, end = item.get("start_ms"), item.get("end_ms")
        if type(start) is not int or type(end) is not int or not record["min_ms"] <= start < end <= record["annotation_end_ms"]:
            raise Problem("区间需使用整数毫秒，位于数据范围内，且开始小于结束")
        if item.get("label") not in LABELS:
            raise Problem("标签必须为 EXERCISE、NON、TRANSITION 或 UNKNOWN")
        identifier = item.get("id") or uid()
        if not isinstance(identifier, str) or not ID.fullmatch(identifier) or identifier in identifiers:
            raise Problem("标签标识无效或重复")
        identifiers.add(identifier)
        note = item.get("note", "")
        if not isinstance(note, str) or len(note) > 2000:
            raise Problem("备注最多 2000 字")
        result.append({"id": identifier, "start_ms": start, "end_ms": end, "label": item["label"], "note": note})
    result.sort(key=lambda item: (item["start_ms"], item["end_ms"]))
    if any(a["end_ms"] > b["start_ms"] for a, b in zip(result, result[1:])):
        raise Problem("同一标签轨道的区间不能重叠；相邻半开区间可以共用边界")
    return result


class Store:
    def __init__(self, directory):
        self.root = Path(directory).expanduser().resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.tasks = self.root / "tasks"
        self.trash = self.root / "trash"
        self.staging = self.root / "staging"
        for path in (self.tasks, self.trash, self.staging):
            path.mkdir(exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.cache = {}
        self.process_lock = open(self.root / ".server.lock", "a+b")
        import fcntl
        try:
            fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            self.process_lock.close()
            raise Problem("该数据目录已有服务运行，请使用原服务或选择其他目录")

    def close(self):
        self.process_lock.close()

    def task_path(self, task_id):
        if not isinstance(task_id, str) or not ID.fullmatch(task_id):
            raise Problem("任务标识无效", 404)
        return self.tasks / task_id

    def read(self, task_id):
        path = self.task_path(task_id) / "task.json"
        if not path.is_file():
            raise Problem("任务不存在或已移入回收区", 404)
        return load_json(path)

    def save(self, task, changed=True):
        if changed:
            task["revision"] += 1
            task["updated_at"] = now()
        atomic_json(self.task_path(task["id"]) / "task.json", task)
        return task

    def create(self, name):
        with self.lock:
            task = {"id": uid(), "name": str(name or "新建标注任务")[:160], "schema": SCHEMA,
                    "created_at": now(), "updated_at": now(), "revision": 0, "last_export_revision": None,
                    "records": [], "app_version": VERSION}
            path = self.task_path(task["id"])
            path.mkdir(mode=0o700)
            (path / "records").mkdir(mode=0o700)
            (path / "exports").mkdir(mode=0o700)
            self.save(task, changed=False)
            sync_directory(self.tasks)
            return task

    def list(self):
        result = []
        for path in self.tasks.glob("*/task.json"):
            try:
                task = load_json(path)
                result.append({key: task[key] for key in ("id", "name", "created_at", "updated_at", "revision", "last_export_revision")})
                result[-1].update(record_count=len(task["records"]), bytes=sum(p.stat().st_size for p in path.parent.rglob("*") if p.is_file()))
            except (OSError, ValueError, KeyError):
                result.append({"id": path.parent.name, "name": "任务元数据异常（原文件保留）", "error": True, "record_count": 0, "bytes": 0, "updated_at": ""})
        return sorted(result, key=lambda item: item["updated_at"], reverse=True)

    def record(self, task, record_id):
        for item in task["records"]:
            if item["id"] == record_id:
                return item
        raise Problem("记录不存在", 404)

    def raw_path(self, task_id, record_id):
        if not ID.fullmatch(record_id):
            raise Problem("记录标识无效", 404)
        return self.task_path(task_id) / "records" / record_id / "original.csv"

    def check_revision(self, task, expected):
        if type(expected) is not int or expected != task["revision"]:
            raise Problem("任务已在其他页面更新。请重新加载后再修改；本次内容未覆盖已保存版本。", 409)

    def _parse_record(self, path, name, digest, size, record_id=None):
        record = {"id": record_id or uid(), "filename": filename(name), "sha256": digest, "bytes": size,
                  "annotations": [], "algorithm": None, "completed": False, "has_original": True,
                  "imported_at": now(), "issues": []}
        try:
            data = read_hw903(path)
            record.update({key: value for key, value in data.items() if key not in ("rows", "rr")})
            self.cache[digest] = data
            # Bound the cache by record count; raw files remain authoritative.
            while len(self.cache) > 2:
                self.cache.pop(next(iter(self.cache)))
        except (ValueError, UnicodeError, csv.Error) as error:
            record.update(status="invalid", issues=[{"severity": "error", "line": None, "code": "parse_error", "message": str(error)}])
        return record

    def upload(self, task_id, uploaded, name):
        with self.lock:
            task = self.read(task_id)
            if len(task["records"]) >= 500:
                raise Problem("首版每个任务最多 500 个文件，请另建任务")
            digest = self.digest(uploaded)
            duplicate = next((r for r in task["records"] if r["sha256"] == digest and r["has_original"]), None)
            if duplicate:
                return {"task": task, "record_id": duplicate["id"], "duplicate": True}
            if sum(r["bytes"] for r in task["records"]) + Path(uploaded).stat().st_size > MAX_TASK_RAW:
                raise Problem("首版每任务原始数据总量最多 256 MiB，请另建任务")
            record = self._parse_record(uploaded, name, digest, Path(uploaded).stat().st_size)
            target = self.raw_path(task_id, record["id"])
            target.parent.mkdir(mode=0o700)
            os.replace(uploaded, target)
            sync_directory(target.parent)
            sync_directory(target.parent.parent)
            task["records"].append(record)
            self.save(task)
            return {"task": task, "record_id": record["id"], "duplicate": False}

    @staticmethod
    def digest(path):
        digest = hashlib.sha256()
        with open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def data(self, task_id, record_id):
        with self.lock:
            record = self.record(self.read(task_id), record_id)
            if not record["has_original"]:
                raise Problem("请补传匹配的原始文件后查看波形", 409)
            if record["sha256"] not in self.cache:
                self.cache[record["sha256"]] = read_hw903(self.raw_path(task_id, record_id))
                while len(self.cache) > 2:
                    self.cache.pop(next(iter(self.cache)))
            return self.cache[record["sha256"]]

    def annotate(self, task_id, record_id, payload):
        with self.lock:
            task = self.read(task_id)
            self.check_revision(task, payload.get("revision"))
            record = self.record(task, record_id)
            if record["status"] != "ready" or not record["has_original"]:
                raise Problem("记录未通过检查或缺少原始文件，不能修改标注")
            labels = validate_labels(payload.get("annotations"), record)
            if type(payload.get("completed", False)) is not bool:
                raise Problem("完成状态必须为布尔值")
            history = self.raw_path(task_id, record_id).parent / "history"
            history.mkdir(exist_ok=True)
            atomic_json(history / (str(task["revision"]) + ".json"), {"annotations": record["annotations"], "completed": record["completed"], "saved_at": now()})
            record["annotations"] = labels
            record["completed"] = bool(payload.get("completed", False))
            return self.save(task)

    def attach(self, task_id, record_id, uploaded, expected):
        with self.lock:
            task = self.read(task_id)
            self.check_revision(task, expected)
            record = self.record(task, record_id)
            if record["has_original"]:
                raise Problem("记录已存在原始文件，不覆盖")
            if self.digest(uploaded) != record["sha256"]:
                raise Problem("内容指纹不匹配：不是这份标注对应的原始文件")
            fresh = self._parse_record(uploaded, record["filename"], record["sha256"], Path(uploaded).stat().st_size, record_id)
            if fresh.get("t0") != record.get("t0"):
                raise Problem("解析器时间基准与结果包不一致，未附加文件")
            if fresh["status"] == "ready":
                validate_labels(record["annotations"], fresh)
                if record["algorithm"]:
                    algorithm = record["algorithm"]
                    if algorithm.get("sha256") != fresh["sha256"] or algorithm.get("t0") != fresh.get("t0"):
                        raise Problem("算法来源与重新解析的原始文件不匹配")
                    validate_labels(algorithm.get("intervals"), fresh)
            elif record["annotations"] or record["algorithm"]:
                raise Problem("原文件重新解析未通过检查，不能附加到已有标注/算法结果")
            for key in ("annotations", "algorithm", "completed"):
                fresh[key] = record[key]
            record.update(fresh)
            target = self.raw_path(task_id, record_id)
            target.parent.mkdir(exist_ok=True, mode=0o700)
            os.replace(uploaded, target)
            sync_directory(target.parent)
            return self.save(task)

    def algorithm(self, task_id, record_id, payload):
        with self.lock:
            task = self.read(task_id)
            self.check_revision(task, payload.get("revision"))
            record = self.record(task, record_id)
            if record["status"] != "ready" or not record["has_original"]:
                raise Problem("记录尚未通过检查")
            if payload.get("sha256") != record["sha256"] or payload.get("t0") != record["t0"]:
                raise Problem("算法结果的源文件指纹或时间起点不匹配")
            version = payload.get("version")
            if not isinstance(version, str) or not version.strip() or len(version) > 160:
                raise Problem("请提供算法版本/来源（最多 160 字）")
            intervals = validate_labels(payload.get("intervals"), record)
            record["algorithm"] = {"version": version, "sha256": record["sha256"], "t0": record["t0"], "intervals": intervals, "imported_at": now()}
            return self.save(task)

    def export(self, task_id, expected, include_original):
        with self.lock:
            task = self.read(task_id)
            self.check_revision(task, expected)
            if include_original and any(not r["has_original"] for r in task["records"]):
                raise Problem("有记录缺少原始文件，不能导出完整任务包")
            snapshot = copy.deepcopy(task)
            snapshot["exported_at"] = now()
            snapshot["package_type"] = "complete" if include_original else "results"
            snapshot["source_task_id"] = task["id"]
            if sum(r["bytes"] for r in task["records"]) > MAX_TASK_RAW:
                raise Problem("任务原始数据超过完整恢复上限，请拆分任务")
            export_id = uid()
            target = self.task_path(task_id) / "exports" / (export_id + ".zip")
            with zipfile.ZipFile(target, "x", compression=zipfile.ZIP_DEFLATED) as package:
                for record in snapshot["records"]:
                    folder = "records/" + record["id"] + "/"
                    record["original_path"] = folder + "original.csv" if include_original else None
                    if include_original:
                        if self.digest(self.raw_path(task_id, record["id"])) != record["sha256"]:
                            raise Problem("原始数据内容发生变化，无法生成可信的完整任务包")
                        package.write(self.raw_path(task_id, record["id"]), record["original_path"])
                    output = io.StringIO(newline="")
                    writer = csv.writer(output)
                    writer.writerow(["source_sha256", "source_filename", "t0", "start_ms", "end_ms", "label", "note"])
                    for label in record["annotations"]:
                        # CSV exported for spreadsheet use: neutralize formula-like text.
                        safe = lambda value: "'" + value if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r")) else value
                        writer.writerow([record["sha256"], safe(record["filename"]), record.get("t0", ""), label["start_ms"], label["end_ms"], label["label"], safe(label["note"])])
                    package.writestr(folder + "annotations.csv", "\ufeff" + output.getvalue())
                    if record["algorithm"]:
                        package.writestr(folder + "algorithm.json", json.dumps(record["algorithm"], ensure_ascii=False))
                package.writestr("manifest.json", json.dumps(snapshot, ensure_ascii=False, allow_nan=False))
                package.writestr("说明.txt", "HW903 标注结果包。manifest.json 是无损恢复依据，CSV 用于查看/分析（公式样式文本加单引号）。\n时间单位：相对 t0 的整数毫秒；区间含开始不含结束；t0 时区未确认，不自动转换。\n未标注区间不是非运动；UNKNOWN/TRANSITION 不作为二分类对照。\n末条记录之后的 1ms 仅为半开区间边界，不证明后续信号时长。\n下载是当时版本的快照，不等于已获得异地备份。结果包需补传同指纹原始数据，完整包可直接恢复。\n")
            with zipfile.ZipFile(target) as check:
                if target.stat().st_size > MAX_ZIP_TOTAL or sum(i.file_size for i in check.infolist()) > MAX_ZIP_TOTAL or check.getinfo("manifest.json").file_size > MAX_METADATA:
                    target.unlink()
                    raise Problem("导出包超过本工具可恢复的大小限制，未生成下载，请拆分任务")
            with open(target, "rb") as stream:
                os.fsync(stream.fileno())
            task["last_export_revision"] = task["revision"]
            task["last_export_at"] = snapshot["exported_at"]
            self.save(task, changed=False)
            return {"task": task, "export_id": export_id, "filename": "HW903-" + ("完整任务" if include_original else "标注结果") + "-" + datetime.now().strftime("%Y%m%d-%H%M%S") + ".zip"}

    def restore(self, uploaded):
        # Never extract paths provided by an archive. Validate then stream specific members.
        with self.lock, zipfile.ZipFile(uploaded) as package:
            infos = package.infolist()
            names = [info.filename for info in infos]
            if len(infos) > 10000 or len(names) != len(set(names)) or sum(i.file_size for i in infos) > MAX_ZIP_TOTAL:
                raise Problem("任务包文件数、重复路径或解压总大小不符合限制")
            for info in infos:
                parts = info.filename.split("/")
                if info.filename.startswith("/") or ".." in parts or "\\" in info.filename or ((info.external_attr >> 16) & 0o170000) == 0o120000:
                    raise Problem("任务包含不安全路径或符号链接")
                if info.file_size > MAX_FILE or info.flag_bits & 1:
                    raise Problem("任务包成员过大或已加密")
            if "manifest.json" not in names or package.getinfo("manifest.json").file_size > 32 * 1024 * 1024:
                raise Problem("缺少或过大的 manifest.json")
            manifest = json.loads(package.read("manifest.json"))
            if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or not isinstance(manifest.get("records"), list) or len(manifest["records"]) > 500:
                raise Problem("不支持的任务包格式/版本或记录数超过 500")
            if manifest.get("package_type") not in ("complete", "results"):
                raise Problem("缺少有效的任务包类型")
            prepared, seen = [], set()
            staging_dir = self.staging / uid()
            staging_dir.mkdir(mode=0o700)
            try:
                total_raw = 0
                for source in manifest["records"]:
                    if not isinstance(source, dict):
                        raise Problem("记录格式错误")
                    self.validate_manifest_record(source)
                    old_id = source.get("id", "")
                    digest = source.get("sha256", "")
                    if not isinstance(old_id, str) or not ID.fullmatch(old_id) or old_id in seen or not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                        raise Problem("记录标识/内容指纹无效")
                    seen.add(old_id)
                    if type(source.get("bytes")) is not int or not 0 <= source["bytes"] <= MAX_FILE:
                        raise Problem("源文件大小无效")
                    total_raw += source["bytes"]
                    if total_raw > MAX_TASK_RAW:
                        raise Problem("任务原始数据总量超过首版 256 MiB 限制")
                    record_id = uid()
                    raw = staging_dir / (record_id + ".csv")
                    original = source.get("original_path")
                    if manifest["package_type"] == "complete" and not original:
                        raise Problem("完整任务包缺少原始文件引用")
                    if original:
                        if original != "records/" + old_id + "/original.csv" or original not in names:
                            raise Problem("原始文件路径与清单不一致")
                        with package.open(original) as incoming, open(raw, "xb") as outgoing:
                            actual_bytes = 0
                            while True:
                                block = incoming.read(1024 * 1024)
                                if not block:
                                    break
                                actual_bytes += len(block)
                                if actual_bytes > source["bytes"] or actual_bytes > MAX_FILE:
                                    raise Problem("解压实际大小超出清单或资源限制")
                                outgoing.write(block)
                            outgoing.flush()
                            os.fsync(outgoing.fileno())
                        if self.digest(raw) != digest or raw.stat().st_size != source["bytes"]:
                            raise Problem("任务包原始文件指纹或大小校验失败")
                        record = self._parse_record(raw, source.get("filename"), digest, raw.stat().st_size, record_id)
                        if record.get("t0") != source.get("t0"):
                            raise Problem("任务包时间起点与重新解析结果不一致")
                    else:
                        record = {key: copy.deepcopy(value) for key, value in source.items() if key not in ("id", "original_path", "annotations", "algorithm")}
                        record.update(id=record_id, has_original=False, filename=filename(source.get("filename", "")))
                        record["status"] = "missing" if source.get("status") in ("ready", "missing") else "invalid"
                    if "min_ms" in source:
                        if any(type(source.get(key)) is not int for key in ("min_ms", "max_ms", "annotation_end_ms")) or not 0 <= source["min_ms"] <= source["max_ms"] < source["annotation_end_ms"] or source["annotation_end_ms"] != source["max_ms"] + 1:
                            raise Problem("任务包时间范围无效")
                        datetime.strptime(source["t0"], "%Y/%m/%d %H:%M:%S_%f")
                        record["annotations"] = validate_labels(source.get("annotations", []), record)
                    else:
                        if source.get("annotations"):
                            raise Problem("缺少时间基准但包含标注")
                        record["annotations"] = []
                    algorithm = source.get("algorithm")
                    if algorithm:
                        if not isinstance(algorithm, dict) or algorithm.get("sha256") != digest or algorithm.get("t0") != source.get("t0") or not isinstance(algorithm.get("version"), str) or not algorithm["version"].strip():
                            raise Problem("算法来源与记录不匹配")
                        algorithm["intervals"] = validate_labels(algorithm.get("intervals"), record)
                    record["algorithm"] = algorithm
                    record["completed"] = bool(source.get("completed"))
                    prepared.append((record, raw))
                # Build the complete task off-list, then publish with one directory rename.
                task = {"id": uid(), "name": (str(manifest.get("name", "标注任务")) + "（恢复）")[:160],
                        "schema": SCHEMA, "created_at": now(), "updated_at": now(), "revision": 1,
                        "last_export_revision": None, "records": [], "app_version": VERSION}
                task_dir = staging_dir / "task"
                task_dir.mkdir(mode=0o700)
                (task_dir / "records").mkdir()
                (task_dir / "exports").mkdir()
                for record, raw in prepared:
                    target = task_dir / "records" / record["id"] / "original.csv"
                    target.parent.mkdir(mode=0o700)
                    if raw.exists():
                        os.replace(raw, target)
                    sync_directory(target.parent)
                    task["records"].append(record)
                task["restored_from"] = {"task_id": manifest.get("source_task_id"), "revision": manifest.get("revision"), "exported_at": manifest.get("exported_at")}
                sync_directory(task_dir / "records")
                atomic_json(task_dir / "task.json", task)
                os.replace(task_dir, self.task_path(task["id"]))
                sync_directory(self.tasks)
                return task
            finally:
                # Generated staging directory only; no user original paths are followed.
                shutil.rmtree(staging_dir)

    @staticmethod
    def validate_manifest_record(source):
        """Reject malformed result-only packages before publishing any visible task."""
        if source.get("status") not in ("ready", "missing", "invalid") or type(source.get("completed")) is not bool:
            raise Problem("记录状态/完成标记缺失或无效")
        filename(source.get("filename"))
        issues = source.get("issues")
        if not isinstance(issues, list) or len(issues) > 250000:
            raise Problem("缺少有效的数据检查列表")
        for issue in issues:
            if not isinstance(issue, dict) or issue.get("severity") not in ("warning", "error") or not isinstance(issue.get("message"), str) or len(issue["message"]) > 5000:
                raise Problem("数据检查项目结构无效")
            if issue.get("line") is not None and (type(issue["line"]) is not int or issue["line"] < 1):
                raise Problem("检查项目源行号无效")
        if not isinstance(source.get("annotations"), list) or "algorithm" not in source:
            raise Problem("人工/算法标注结构缺失")
        if source["algorithm"] is not None and not isinstance(source["algorithm"], dict):
            raise Problem("算法结果应为对象或空值")
        if source["status"] in ("ready", "missing") or "min_ms" in source:
            counts = source.get("counts")
            fields = source.get("fields")
            if not isinstance(counts, dict) or any(type(v) is not int or v < 0 for v in counts.values()):
                raise Problem("缺少有效的采样统计")
            if not isinstance(fields, list) or any(not isinstance(f, str) or len(f) > 200 for f in fields):
                raise Problem("缺少有效的字段列表")
            if any(type(source.get(key)) is not int for key in ("min_ms", "max_ms", "annotation_end_ms")):
                raise Problem("缺少有效的毫秒时间范围")
            if not 0 <= source["min_ms"] <= source["max_ms"] < source["annotation_end_ms"] < 2 ** 53:
                raise Problem("时间范围无效或超出浏览器安全整数范围")
            if source["annotation_end_ms"] != source["max_ms"] + 1 or source.get("time_unit") != "ms" or source.get("timezone") is not None:
                raise Problem("不支持的时间单位、边界约定或时区")
            if not isinstance(source.get("t0"), str):
                raise Problem("缺少时间起点")
            datetime.strptime(source["t0"], "%Y/%m/%d %H:%M:%S_%f")

    def trash_task(self, task_id, expected, confirmation):
        with self.lock:
            task = self.read(task_id)
            self.check_revision(task, expected)
            if confirmation != task["name"]:
                raise Problem("请准确输入任务名以确认清理")
            target = self.trash / (task_id + "-" + uid())
            os.replace(self.task_path(task_id), target)
            sync_directory(self.tasks)
            sync_directory(self.trash)
            return {"message": "已移入本地回收区，未永久删除", "recovery_path": str(target)}
