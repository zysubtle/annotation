import copy
import hashlib
import http.client
import io
import json
import os
import shutil
import tempfile
import threading
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from annotator.parser import read_hw903
from annotator.server import make_server, plot_data
from annotator.store import Problem, Store, atomic_json

REPO = Path(__file__).resolve().parents[1]
SAMPLE = REPO / "HW903_data_example_25Hz.csv"
SMALL = "time,acc-x,acc-y,acc-z,slot2-adc0,hr,total_step\n2026/08/19 14:31:08_000,1000,0,-1000,0,0,1\n2026/08/19 14:31:08_040,2000,0,-1000,,80,1\n2026/08/19 14:31:08_080,3000,0,-1000,4,81,2\n"


class ParserTests(unittest.TestCase):
    def parse(self, content):
        with tempfile.TemporaryDirectory(prefix="hw903-parser-test-") as directory:
            path = Path(directory) / "input.csv"
            path.write_text(content, encoding="utf-8")
            return read_hw903(path)

    def test_real_sample_contract(self):
        data = read_hw903(SAMPLE)
        self.assertEqual(data["counts"]["hw903"], 8936)
        self.assertEqual(data["counts"]["rr"], 60)
        self.assertEqual(data["counts"]["gap_flags"], 2)
        self.assertEqual(data["t0"], "2026/08/19 14:31:08_086")
        self.assertEqual(data["max_ms"], 203693)
        self.assertEqual(data["annotation_end_ms"], 203694)
        self.assertEqual(max(row["t"] for row in data["rr"]), 243730)
        self.assertEqual(data["rows"][0]["values"]["acc-x"], -203.125)
        self.assertEqual(data["status"], "ready")
        self.assertIsNone(data["sample_rate"])
        self.assertIsNone(data["timezone"])
        self.assertEqual(sum(i["code"] == "hw_time_repeat" for i in data["issues"]), 36)
        self.assertEqual(sum(i["code"] == "rr_time_repeat" for i in data["issues"]), 3)
        self.assertEqual(len([f for f in data["fields"] if f.startswith("slot")]), 20)

    def test_zero_empty_missing_are_distinct(self):
        data = self.parse(SMALL)
        self.assertEqual(data["rows"][0]["values"]["slot2-adc0"], 0)
        self.assertIsNone(data["rows"][1]["values"]["slot2-adc0"])
        self.assertNotIn("slot2-adc1", data["fields"])
        chart = plot_data(data, 0, 81, ["slot2-adc0", "slot2-adc1"], 100)
        self.assertTrue(chart["series"][0]["present"])
        self.assertFalse(chart["series"][1]["present"])
        self.assertEqual(chart["series"][0]["points"][1][1], None)

    def test_no_optical_columns_required(self):
        data = self.parse("time,acc-x,acc-y,acc-z\n2026/08/19 14:31:08_000,0,0,0\n")
        self.assertEqual(data["status"], "ready")
        self.assertEqual(data["annotation_end_ms"], 1)

    def test_window_statistics_distinguish_absent_empty_zero(self):
        data = self.parse(SMALL + "time,acc-x,acc-y,acc-z,hr,total_step\n2026/08/19 14:31:08_120,0,0,0,80,2\n")
        series = plot_data(data, 0, 121, ["slot2-adc0"], 100)["series"][0]
        self.assertEqual((series["column_absent_count"], series["empty_count"], series["numeric_count"], series["zero_count"]), (1, 1, 2, 1))

    def test_mixed_rr_without_repeated_header(self):
        content = "time,RRInterval,timestamp,rawData\n2026/08/19 14:31:07_000,737,1,<aa>\n" + SMALL + "2026/08/19 14:31:08_500,700,2,<bb>\n2026/08/19 14:31:08_500,710,2,<bb>\n"
        data = self.parse(content)
        self.assertEqual(len(data["rows"]), 3)
        self.assertEqual(len(data["rr"]), 3)
        self.assertEqual(data["min_ms"], 1000)
        self.assertEqual(data["status"], "ready")
        self.assertEqual([r["RRInterval"] for r in data["rr"]], [737, 700, 710])

    def test_reversal_blocks_annotation_without_sorting(self):
        data = self.parse(SMALL + "2026/08/19 14:31:07_000,0,0,0,0,80,0\n")
        self.assertEqual(data["status"], "invalid")
        self.assertEqual(data["rows"][-1]["t"], 0)

    def test_unknown_line_is_not_silently_discarded(self):
        data = self.parse(SMALL + "unrecognized explanation\n")
        self.assertEqual(data["status"], "invalid")
        self.assertEqual(data["issues"][-1]["line"], 5)

    def test_duplicate_auxiliary_names_preserved(self):
        data = self.parse("time,acc-x,acc-y,acc-z,timestamp,timestamp\n2026/08/19 14:31:08_000,0,0,0,1,2\n")
        self.assertEqual(data["headers"][0]["columns"].count("timestamp"), 2)
        self.assertEqual(data["status"], "ready")

    def test_drawing_reduction_keeps_extrema_and_breaks(self):
        data = self.parse(SMALL)
        data["rows"] = [{"t": i * 10, "line": i + 1, "values": {"acc-x": None if i == 87 else 999 if i == 81 else 0}} for i in range(1000)]
        series = plot_data(data, 0, 10000, ["acc-x"], 100)["series"][0]
        self.assertTrue(any(p[1] is None for p in series["points"]))
        self.assertTrue(any(p[1] == 999 for p in series["points"]))

    def test_plot_gaps_cover_full_record_not_just_view(self):
        data = self.parse(SMALL)
        data["rows"] = [{"t": t, "line": i + 1, "values": {"acc-x": 0}}
                        for i, t in enumerate([0, 999, 1999, 2039, 4000])]
        chart = plot_data(data, 0, 999, ["acc-x"], 100)
        self.assertEqual(chart["gaps"], [{"start_ms": 999, "end_ms": 1999},
                                         {"start_ms": 2039, "end_ms": 4000}])
        self.assertEqual([p[0] for p in chart["series"][0]["points"]], [0, 999])


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hw903-store-test-")
        self.root = Path(self.temporary.name)
        self.store = Store(self.root / "data")
        self.task = self.store.create("验证任务")
        self.upload()

    def tearDown(self):
        self.store.close()
        self.temporary.cleanup()

    def upload(self, content=SMALL, name="source.csv"):
        path = self.root / "incoming.csv"
        path.write_text(content, encoding="utf-8")
        response = self.store.upload(self.task["id"], path, name)
        self.task = response["task"]
        self.record = self.store.record(self.task, response["record_id"])
        return response

    def labels(self):
        return [{"start_ms": 0, "end_ms": 40, "label": "EXERCISE", "note": "=1+1"}]

    def annotate(self):
        self.task = self.store.annotate(self.task["id"], self.record["id"], {"revision": self.task["revision"], "annotations": self.labels(), "completed": False})
        self.record = self.task["records"][0]

    def export(self, complete=True):
        result = self.store.export(self.task["id"], self.task["revision"], complete)
        return self.store.task_path(self.task["id"]) / "exports" / (result["export_id"] + ".zip")

    def rewrite_zip(self, original, mutate, added=None):
        output = self.root / "altered.zip"
        with zipfile.ZipFile(original) as source, zipfile.ZipFile(output, "w") as target:
            for name in source.namelist():
                value = source.read(name)
                if name == "manifest.json":
                    document = json.loads(value)
                    mutate(document)
                    value = json.dumps(document).encode()
                target.writestr(name, value)
            if added:
                target.writestr(*added)
        return output

    def test_same_content_deduplicates_without_revision_change(self):
        revision = self.task["revision"]
        self.assertTrue(self.upload(name="another-name.csv")["duplicate"])
        self.assertEqual(self.task["revision"], revision)
        self.assertEqual(len(self.task["records"]), 1)

    def test_same_name_different_content_and_traversal_filename(self):
        self.upload(SMALL.replace("3000", "4000"), "../../source.csv")
        self.assertEqual(len(self.task["records"]), 2)
        self.assertEqual(self.record["filename"], "source.csv")
        self.assertFalse((self.root / "source.csv").exists())

    def test_bad_file_isolated_and_original_kept(self):
        self.upload("not a HW903 file", "broken.csv")
        self.assertEqual(self.record["status"], "invalid")
        self.assertEqual(self.task["records"][0]["status"], "ready")
        self.assertTrue(self.store.raw_path(self.task["id"], self.record["id"]).is_file())

    def test_original_unchanged_and_restart_keeps_labels(self):
        self.annotate()
        original = self.store.raw_path(self.task["id"], self.record["id"])
        self.assertEqual(original.read_text(), SMALL)
        self.store.close()
        self.store = Store(self.root / "data")
        reloaded = self.store.read(self.task["id"])
        self.assertEqual(reloaded["records"][0]["annotations"][0]["note"], "=1+1")
        self.assertEqual(self.store.data(self.task["id"], self.record["id"])["counts"]["hw903"], 3)

    def test_second_process_data_directory_lock(self):
        with self.assertRaises(Problem):
            Store(self.root / "data")

    def test_invalid_interval_and_stale_revision(self):
        for labels in ([{"start_ms": 1, "end_ms": 0, "label": "NON"}], [{"start_ms": 0, "end_ms": 90, "label": "NON"}], [{"start_ms": True, "end_ms": 40, "label": "NON"}], [{"start_ms": 0, "end_ms": 40, "label": "invalid"}], self.labels() * 2):
            with self.subTest(labels=labels), self.assertRaises(Problem):
                self.store.annotate(self.task["id"], self.record["id"], {"revision": self.task["revision"], "annotations": labels})
        stale = self.task["revision"]
        self.annotate()
        with self.assertRaises(Problem) as caught:
            self.store.annotate(self.task["id"], self.record["id"], {"revision": stale, "annotations": []})
        self.assertEqual(caught.exception.status, 409)

    def test_concurrent_writers_do_not_overwrite(self):
        barrier = threading.Barrier(2)
        results = []
        payload = {"revision": self.task["revision"], "annotations": self.labels()}
        def save():
            barrier.wait()
            try:
                self.store.annotate(self.task["id"], self.record["id"], payload)
                results.append(200)
            except Problem as error:
                results.append(error.status)
        threads = [threading.Thread(target=save) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(results), [200, 409])

    def test_atomic_json_failure_keeps_previous(self):
        target = self.root / "atomic.json"
        atomic_json(target, {"version": 1})
        with patch("annotator.store.os.replace", side_effect=OSError("disk error")), self.assertRaises(OSError):
            atomic_json(target, {"version": 2})
        self.assertEqual(json.loads(target.read_text()), {"version": 1})
        self.assertFalse(list(self.root.glob("*.pending")))

    def test_complete_roundtrip_and_csv_formula_guard(self):
        self.annotate()
        exported = self.export()
        with zipfile.ZipFile(exported) as archive:
            manifest = json.loads(archive.read("manifest.json"))
            text = archive.read("records/" + self.record["id"] + "/annotations.csv").decode("utf-8-sig")
            self.assertIn("'=1+1", text)
            self.assertEqual(manifest["records"][0]["annotations"][0]["note"], "=1+1")
        restored = self.store.restore(exported)
        self.assertNotEqual(restored["id"], self.task["id"])
        r = restored["records"][0]
        self.assertTrue(r["has_original"])
        self.assertEqual(r["annotations"], self.record["annotations"])
        self.assertEqual(self.store.raw_path(restored["id"], r["id"]).read_text(), SMALL)

    def test_results_only_restore_and_hash_checked_attach(self):
        self.annotate()
        restored = self.store.restore(self.export(False))
        r = restored["records"][0]
        self.assertFalse(r["has_original"])
        wrong = self.root / "wrong.csv"
        wrong.write_text(SMALL + "\n")
        with self.assertRaises(Problem):
            self.store.attach(restored["id"], r["id"], wrong, restored["revision"])
        correct = self.root / "correct.csv"
        correct.write_text(SMALL)
        task = self.store.attach(restored["id"], r["id"], correct, restored["revision"])
        self.assertEqual(task["records"][0]["status"], "ready")
        self.assertEqual(task["records"][0]["annotations"], self.record["annotations"])

    def test_invalid_files_also_roundtrip(self):
        self.upload("bad file", "bad.csv")
        restored = self.store.restore(self.export())
        self.assertEqual([r["status"] for r in restored["records"]], ["ready", "invalid"])

    def test_repeated_result_only_roundtrip_stays_missing(self):
        restored = self.store.restore(self.export(False))
        package = self.store.export(restored["id"], restored["revision"], False)
        path = self.store.task_path(restored["id"]) / "exports" / (package["export_id"] + ".zip")
        again = self.store.restore(path)
        self.assertEqual(again["records"][0]["status"], "missing")

    def test_missing_metadata_rejected_before_publication(self):
        exported = self.export(False)
        before = len(self.store.list())
        malformed = self.rewrite_zip(exported, lambda m: m["records"][0].pop("issues"))
        with self.assertRaises(Problem):
            self.store.restore(malformed)
        self.assertEqual(len(self.store.list()), before)

    def test_attach_rechecks_algorithm_against_real_range(self):
        exported = self.export(False)
        def enlarge(m):
            record = m["records"][0]
            record.update(max_ms=1000, annotation_end_ms=1001)
            record["algorithm"] = {"version": "untrusted", "sha256": record["sha256"], "t0": record["t0"], "intervals": [{"start_ms": 900, "end_ms": 1000, "label": "NON"}]}
        altered = self.rewrite_zip(exported, enlarge)
        restored = self.store.restore(altered)
        correct = self.root / "source.csv"
        correct.write_text(SMALL)
        with self.assertRaises(Problem):
            self.store.attach(restored["id"], restored["records"][0]["id"], correct, restored["revision"])
        self.assertFalse(self.store.read(restored["id"])["records"][0]["has_original"])

    def test_algorithm_source_validation_and_preservation(self):
        payload = {"revision": self.task["revision"], "sha256": "0" * 64, "t0": self.record["t0"], "version": "test-v1", "intervals": [{"start_ms": 0, "end_ms": 81, "label": "NON"}]}
        with self.assertRaises(Problem):
            self.store.algorithm(self.task["id"], self.record["id"], payload)
        payload["sha256"] = self.record["sha256"]
        self.task = self.store.algorithm(self.task["id"], self.record["id"], payload)
        restored = self.store.restore(self.export())
        self.assertEqual(restored["records"][0]["algorithm"]["version"], "test-v1")

    def test_bad_archive_never_publishes_task(self):
        exported = self.export()
        before = len(self.store.list())
        mutations = [lambda m: m.update(schema="unknown"), lambda m: m["records"][0].update(sha256="f" * 64), lambda m: m["records"].append(copy.deepcopy(m["records"][0])), lambda m: m["records"][0].update(annotations=[{"start_ms": 0, "end_ms": 5000, "label": "NON"}])]
        for mutate in mutations:
            malformed = self.rewrite_zip(exported, mutate)
            with self.assertRaises((Problem, ValueError)):
                self.store.restore(malformed)
            self.assertEqual(len(self.store.list()), before)
        unsafe = self.rewrite_zip(exported, lambda m: None, ("../outside.txt", "no"))
        with self.assertRaises(Problem):
            self.store.restore(unsafe)
        self.assertEqual(len(self.store.list()), before)

    def test_zip_duplicate_names_and_symlinks_rejected(self):
        import warnings
        exported = self.export()
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            duplicate = self.rewrite_zip(exported, lambda m: None, ("manifest.json", "{}"))
        with self.assertRaises(Problem):
            self.store.restore(duplicate)
        symlink = zipfile.ZipInfo("linked.csv")
        symlink.create_system = 3
        symlink.external_attr = (0o120777 << 16)
        unsafe = self.rewrite_zip(exported, lambda m: None, (symlink, "../../outside.csv"))
        with self.assertRaises(Problem):
            self.store.restore(unsafe)

    def test_complete_package_must_include_original_reference(self):
        malformed = self.rewrite_zip(self.export(), lambda m: m["records"][0].update(original_path=None))
        with self.assertRaises(Problem):
            self.store.restore(malformed)

    def test_export_rejects_changed_source_bytes(self):
        self.store.raw_path(self.task["id"], self.record["id"]).write_text(SMALL + "\n")
        with self.assertRaises(Problem):
            self.export()
        self.assertIsNone(self.store.read(self.task["id"])["last_export_revision"])

    def test_export_snapshot_then_changes_are_unexported(self):
        self.export()
        task = self.store.read(self.task["id"])
        self.assertEqual(task["last_export_revision"], task["revision"])
        self.annotate()
        self.assertLess(self.task["last_export_revision"], self.task["revision"])

    def test_clean_is_recoverable_not_permanent(self):
        for invalid in ("", "..", "/"):
            with self.assertRaises(Problem):
                self.store.trash_task(invalid, 1, "")
        with self.assertRaises(Problem):
            self.store.trash_task(self.task["id"], self.task["revision"], "wrong")
        result = self.store.trash_task(self.task["id"], self.task["revision"], self.task["name"])
        self.assertEqual(self.store.list(), [])
        self.assertTrue((Path(result["recovery_path"]) / "task.json").is_file())
        self.assertTrue(self.store.tasks.is_dir())


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="hw903-http-test-")
        self.store = Store(self.temporary.name)
        self.server = make_server(self.store, 0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = "http://127.0.0.1:" + str(self.server.server_port)
        _, config = self.request("GET", "/api/config")
        self.token = config["token"]

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.store.close()
        self.temporary.cleanup()

    def request(self, method, path, value=None, headers=None, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        outgoing = dict(headers or {})
        if value is not None:
            raw = json.dumps(value).encode()
            outgoing["Content-Type"] = "application/json"
        conn.request(method, path, body=raw, headers=outgoing)
        response = conn.getresponse()
        body = response.read()
        content = json.loads(body) if "application/json" in response.getheader("Content-Type", "") else body
        conn.close()
        return response.status, content

    def authorized(self):
        return {"Origin": self.origin, "X-Annotation-Token": self.token}

    def test_real_http_upload_annotate_export(self):
        status, task = self.request("POST", "/api/tasks", {"name": "接口验收"}, self.authorized())
        self.assertEqual(status, 201)
        headers = {**self.authorized(), "Content-Type": "application/octet-stream"}
        status, uploaded = self.request("POST", f'/api/tasks/{task["id"]}/files?filename=sample.csv', headers=headers, raw=SAMPLE.read_bytes())
        self.assertEqual(status, 201)
        task, rid = uploaded["task"], uploaded["record_id"]
        self.assertEqual(task["records"][0]["counts"]["hw903"], 8936)
        status, chart = self.request("GET", f'/api/tasks/{task["id"]}/records/{rid}/plot?start=0&end=30000&fields=slot2-adc0,slot2-adc1,slot2-adc2,slot2-adc3')
        self.assertEqual(status, 200)
        self.assertEqual(len(chart["series"]), 4)
        self.assertTrue(all(s["present"] for s in chart["series"]))
        status, task = self.request("POST", f'/api/tasks/{task["id"]}/records/{rid}/annotations', {"revision": task["revision"], "annotations": [{"start_ms": 0, "end_ms": 5000, "label": "NON"}]}, self.authorized())
        self.assertEqual(status, 200)
        status, exported = self.request("POST", f'/api/tasks/{task["id"]}/export', {"revision": task["revision"], "include_original": True}, self.authorized())
        self.assertEqual(status, 200)
        status, content = self.request("GET", f'/api/tasks/{task["id"]}/exports/{exported["export_id"]}')
        self.assertEqual(status, 200)
        with zipfile.ZipFile(io.BytesIO(content)) as package:
            self.assertIsNone(package.testzip())
            manifest = json.loads(package.read("manifest.json"))
            self.assertEqual(manifest["records"][0]["annotations"][0]["end_ms"], 5000)
        status, restored = self.request("POST", "/api/restore", headers=headers, raw=content)
        self.assertEqual(status, 201)
        self.assertNotEqual(restored["id"], task["id"])

    def test_same_origin_host_and_token_required(self):
        for headers in ({}, {"Origin": self.origin}, {"X-Annotation-Token": self.token}, {"Origin": "null", "X-Annotation-Token": self.token}, {"Origin": "https://evil.example", "X-Annotation-Token": self.token}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("POST", "/api/tasks", {"name": "bad"}, headers)[0], 403)
        self.assertEqual(self.request("GET", "/api/config", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(len(self.store.list()), 0)

    def test_no_data_directory_or_traversal_served(self):
        for path in ("/../store.py", "/api/../../etc/passwd", "/tasks", "/.server.lock"):
            self.assertEqual(self.request("GET", path)[0], 404)
        self.assertEqual(self.request("GET", "/")[0], 200)


if __name__ == "__main__":
    unittest.main()
