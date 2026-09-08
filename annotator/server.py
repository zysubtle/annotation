"""Loopback-only service. Not an Internet-facing production HTTP server."""

import argparse
import json
import math
import os
import secrets
import shutil
import sys
import tempfile
import traceback
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import VERSION
from .store import ID, MAX_FILE, MAX_ZIP_TOTAL, Problem, Store

WEB = Path(__file__).parent / "web"


def plot_data(data, start, end, fields, limit):
    rows = [row for row in data["rows"] if start <= row["t"] <= end]
    result = []
    for field in fields:
        if field not in data["fields"]:
            result.append({"field": field, "present": False, "points": [], "column_absent_count": len(rows), "empty_count": 0, "numeric_count": 0, "zero_count": 0})
            continue
        absent_count = sum(field not in row["values"] for row in rows)
        empty_count = sum(field in row["values"] and row["values"][field] is None for row in rows)
        points = []
        previous = None
        for row in rows:
            if previous is not None and (row["t"] - previous >= 1000 or row["t"] < previous):
                points.append([row["t"], None, row["line"]])
            points.append([row["t"], row["values"].get(field), row["line"]])
            previous = row["t"]
        values = [point[1] for point in points if point[1] is not None]
        # Min/max envelope for drawing only. Labels always reference full source time.
        if len(points) > limit:
            bucket_size = math.ceil(len(points) / max(1, limit // 4))
            reduced = []
            for offset in range(0, len(points), bucket_size):
                bucket = points[offset:offset + bucket_size]
                finite = [(i, point) for i, point in enumerate(bucket) if point[1] is not None]
                indices = {0, len(bucket) - 1}
                if finite:
                    indices.add(min(finite, key=lambda item: item[1][1])[0])
                    indices.add(max(finite, key=lambda item: item[1][1])[0])
                # A missing observation/gap must break a path, even inside a display bucket.
                indices.update(i for i, point in enumerate(bucket) if point[1] is None)
                reduced.extend(bucket[i] for i in sorted(indices))
            points = reduced
        result.append({"field": field, "present": absent_count < len(rows) if rows else True, "points": points,
                       "min": min(values) if values else None, "max": max(values) if values else None,
                       "unit": data["units"].get(field, "原始数字读数"), "observations": len(rows),
                       "column_absent_count": absent_count, "empty_count": empty_count,
                       "numeric_count": len(values), "zero_count": sum(value == 0 for value in values)})
    # Return the full-record gaps so a draft outside the viewport is still checked.
    # Same display-only 1 s interval rule as path breaking; not a packet-loss verdict.
    gaps = [{"start_ms": a["t"], "end_ms": b["t"]}
            for a, b in zip(data["rows"], data["rows"][1:]) if b["t"] - a["t"] >= 1000]
    return {"start_ms": start, "end_ms": end, "series": result, "gaps": gaps,
            "display_note": "宽范围时仅绘图按分桶极值抽稀；标注基于完整原始时间。≥1秒时间间隔断线，不自动判定丢包。"}


def make_server(store, port=8000):
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, format, *args):
            # Do not log filenames, labels, or request bodies containing personal data.
            return

        def guard(self, write=False):
            expected = {"127.0.0.1:" + str(self.server.server_port), "localhost:" + str(self.server.server_port)}
            if self.headers.get("Host") not in expected:
                raise Problem("仅允许本机地址访问", 403)
            origin = self.headers.get("Origin")
            if (origin or write) and origin not in {"http://" + host for host in expected}:
                raise Problem("拒绝跨站请求", 403)
            if write and self.headers.get("X-Annotation-Token") != token:
                raise Problem("会话已失效，请刷新页面；跨站写入被拒绝", 403)
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise Problem("拒绝跨站访问本地数据", 403)

        def headers_common(self):
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")

        def respond(self, value, status=200):
            payload = json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.headers_common()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def file(self, path, mime, download=None):
            with open(path, "rb") as stream:
                self.send_response(200)
                self.headers_common()
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(os.fstat(stream.fileno()).st_size))
                if download:
                    self.send_header("Content-Disposition", 'attachment; filename="' + download + '"')
                self.end_headers()
                shutil.copyfileobj(stream, self.wfile)

        def body_length(self, maximum):
            try:
                length = int(self.headers.get("Content-Length", "-1"))
            except ValueError:
                raise Problem("无效的上传大小")
            if not 0 <= length <= maximum or self.headers.get("Transfer-Encoding"):
                raise Problem("上传超过首版大小限制，或缺少明确长度", 413)
            return length

        def json_body(self):
            if self.headers.get_content_type() != "application/json":
                raise Problem("需要 JSON 请求", 415)
            length = self.body_length(4 * 1024 * 1024)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise Problem("请求未完整接收")
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise Problem("请求必须为 JSON 对象")
            return value

        def upload_body(self, maximum=MAX_FILE):
            if self.headers.get_content_type() != "application/octet-stream":
                raise Problem("需要二进制文件上传", 415)
            remaining = self.body_length(maximum)
            if not remaining:
                raise Problem("不能上传空文件")
            fd, name = tempfile.mkstemp(prefix="upload-", dir=store.staging)
            try:
                with os.fdopen(fd, "wb") as target:
                    while remaining:
                        block = self.rfile.read(min(1024 * 1024, remaining))
                        if not block:
                            raise Problem("上传中断，未创建可用记录")
                        target.write(block)
                        remaining -= len(block)
                    target.flush()
                    os.fsync(target.fileno())
                return Path(name)
            except BaseException:
                Path(name).unlink(missing_ok=True)
                raise

        def handle_error(self, error):
            if isinstance(error, (BrokenPipeError, ConnectionResetError)):
                return
            if isinstance(error, Problem):
                self.respond({"error": str(error)}, error.status)
            elif isinstance(error, (ValueError, KeyError, TypeError, zipfile.BadZipFile, UnicodeError)):
                self.respond({"error": "输入格式或任务包校验失败：" + str(error)}, 400)
            else:
                traceback.print_exc()
                self.respond({"error": "本机保存/读取失败，未确认保存成功；请检查磁盘空间或服务日志。"}, 500)

        def do_GET(self):
            try:
                self.guard()
                parsed = urlsplit(self.path)
                parts = parsed.path.strip("/").split("/")
                query = parse_qs(parsed.query)
                if parsed.path in ("/", "/app.js", "/style.css"):
                    name = "index.html" if parsed.path == "/" else parts[0]
                    self.file(WEB / name, {"index.html": "text/html; charset=utf-8", "app.js": "application/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8"}[name])
                elif parsed.path == "/api/config":
                    self.respond({"token": token, "version": VERSION, "storage_path": str(store.root), "max_file_bytes": MAX_FILE, "max_package_bytes": MAX_ZIP_TOTAL})
                elif parsed.path == "/api/tasks":
                    self.respond({"tasks": store.list()})
                elif len(parts) == 3 and parts[:2] == ["api", "tasks"]:
                    self.respond(store.read(parts[2]))
                elif len(parts) == 6 and parts[:2] == ["api", "tasks"] and parts[3] == "records" and parts[5] == "plot":
                    data = store.data(parts[2], parts[4])
                    start, end = int(query.get("start", [data["min_ms"]])[0]), int(query.get("end", [data["max_ms"]])[0])
                    if not data["min_ms"] <= start <= end <= data["annotation_end_ms"]:
                        raise Problem("绘图时间范围超出记录")
                    fields = query.get("fields", ["acc-x,acc-y,acc-z,hr,total_step"])[0].split(",")
                    if len(fields) > 25:
                        raise Problem("每次最多 25 个绘图通道")
                    self.respond(plot_data(data, start, end, fields, max(100, min(3000, int(query.get("limit", [1200])[0])))))
                elif len(parts) == 5 and parts[:2] == ["api", "tasks"] and parts[3] == "exports" and ID.fullmatch(parts[4]):
                    store.read(parts[2])
                    target = store.task_path(parts[2]) / "exports" / (parts[4] + ".zip")
                    if not target.is_file():
                        raise Problem("导出文件不存在", 404)
                    self.file(target, "application/zip", "HW903-annotations.zip")
                else:
                    raise Problem("接口不存在", 404)
            except Exception as error:
                self.handle_error(error)

        def do_POST(self):
            temporary = None
            try:
                self.guard(write=True)
                parsed = urlsplit(self.path)
                parts = parsed.path.strip("/").split("/")
                query = parse_qs(parsed.query)
                if parsed.path == "/api/tasks":
                    self.respond(store.create(self.json_body().get("name")), 201)
                elif parsed.path == "/api/restore":
                    temporary = self.upload_body(MAX_ZIP_TOTAL)
                    self.respond(store.restore(temporary), 201)
                elif len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "files":
                    temporary = self.upload_body()
                    self.respond(store.upload(parts[2], temporary, query.get("filename", [""])[0]), 201)
                elif len(parts) == 6 and parts[:2] == ["api", "tasks"] and parts[3] == "records":
                    action = parts[5]
                    if action == "annotations":
                        self.respond(store.annotate(parts[2], parts[4], self.json_body()))
                    elif action == "algorithm":
                        self.respond(store.algorithm(parts[2], parts[4], self.json_body()))
                    elif action == "attach":
                        temporary = self.upload_body()
                        self.respond(store.attach(parts[2], parts[4], temporary, int(query.get("revision", ["-1"])[0])))
                    else:
                        raise Problem("操作不存在", 404)
                elif len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "export":
                    payload = self.json_body()
                    self.respond(store.export(parts[2], payload.get("revision"), payload.get("include_original") is True))
                elif len(parts) == 4 and parts[:2] == ["api", "tasks"] and parts[3] == "trash":
                    payload = self.json_body()
                    self.respond(store.trash_task(parts[2], payload.get("revision"), payload.get("confirmation")))
                else:
                    raise Problem("接口不存在", 404)
            except Exception as error:
                self.handle_error(error)
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)

        def setup(self):
            super().setup()
            self.connection.settimeout(120)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description="HW903 本地标注器")
    default_root = Path.home() / ("Library/Application Support/HW903 Annotator" if sys.platform == "darwin" else ".local/share/hw903-annotator")
    parser.add_argument("--data-dir", type=Path, default=default_root)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    os.umask(0o077)
    store = Store(args.data_dir)
    server = make_server(store, args.port)
    print("http://127.0.0.1:" + str(server.server_port) + "/", flush=True)
    print("数据保存在：" + str(store.root), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        store.close()


if __name__ == "__main__":
    main()
