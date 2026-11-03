import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


audit = module("browser_audit", ROOT / "skills/generated-admin-hardening/scripts/browser_audit.py")
installer = module("install_skill", ROOT / "tools/install_skill.py")
builder = module("build_release", ROOT / "tools/build_release.py")


def config():
    return {"base_url": "http://127.0.0.1:8008", "pages": [{"path": "/orders", "ready": "#app",
             "checks": [{"name": "布局", "kind": "layout", "selector": "table"}]}]}


class ConfigTests(unittest.TestCase):
    def test_valid_and_no_cases(self):
        self.assertEqual(audit.validate_config(config()), 1)
        value = config()
        value["pages"][0]["checks"] = []
        with self.assertRaises(audit.ConfigError):
            audit.validate_config(value)

    def test_remote_and_credentials_rejected(self):
        for url in ["https://example.com", "http://user:secret@localhost:80", "file:///tmp/a", "http://127.0.0.1/base"]:
            with self.subTest(url=url), self.assertRaises(audit.ConfigError):
                value = config()
                value["base_url"] = url
                audit.validate_config(value)

    def test_origin_escape_rejected(self):
        for path in ["//example.com", "https://example.com", "/\\example.com"]:
            with self.subTest(path=path), self.assertRaises(audit.ConfigError):
                value = config()
                value["pages"][0]["path"] = path
                audit.validate_config(value)

    def test_button_must_be_allowlisted(self):
        value = config()
        value["pages"][0]["checks"] = [{"name": "查看", "kind": "button", "selector": "button",
                                         "expect": {"kind": "url", "path": "/detail"}}]
        with self.assertRaises(audit.ConfigError):
            audit.validate_config(value)
        value["pages"][0]["checks"][0]["reviewed_read_only"] = True
        self.assertEqual(audit.validate_config(value), 1)

    def test_filter_needs_independent_result(self):
        value = config()
        value["pages"][0]["checks"] = [{"name": "筛选", "kind": "filter", "reviewed_read_only": True,
             "selector": "#status", "submit": "#query", "action": "fill", "value": "OPEN",
             "request": {"path": "/api/orders", "method": "POST", "params": {"status": "OPEN"}}}]
        with self.assertRaises(audit.ConfigError):
            audit.validate_config(value)
        value["pages"][0]["checks"][0]["result"] = {"selector": "tr", "count": 0}
        self.assertEqual(audit.validate_config(value), 1)

    def test_query_json_and_form(self):
        class Request:
            url = "http://127.0.0.1/list?blank=&tag=a&tag=b"
            method = "POST"
            post_data = '{"status":"OPEN","page":1}'
        values = audit.request_params(Request())
        self.assertEqual(values, {"blank": "", "tag": ["a", "b"], "status": "OPEN", "page": 1})
        Request.post_data = "status=OPEN&blank="
        self.assertEqual(audit.request_params(Request())["status"], "OPEN")

    def test_response_origin_path_method(self):
        class Request:
            method = "POST"
        class Response:
            url = "http://127.0.0.1:8008/api/orders"
            request = Request()
        expected = {"path": "/api/orders", "method": "POST"}
        self.assertTrue(audit.response_matches(Response(), "http://127.0.0.1:8008", expected))
        self.assertFalse(audit.response_matches(Response(), "http://127.0.0.1:9000", expected))
        self.assertFalse(audit.response_matches(Response(), "http://127.0.0.1:8008", {**expected, "method": "GET"}))

    def test_failure_and_environment_exit_codes(self):
        with tempfile.TemporaryDirectory(prefix="skill-audit-unit-") as folder:
            folder = Path(folder)
            source = folder / "config.json"
            source.write_text(json.dumps(config()))
            with patch.object(audit, "run_audit", return_value={"status": "failed", "failed": 1}):
                self.assertEqual(audit.main(["--config", str(source), "--output", str(folder / "failure.json")]), 1)
            with patch.object(audit, "run_audit", side_effect=ImportError):
                self.assertEqual(audit.main(["--config", str(source), "--output", str(folder / "missing.json")]), 3)
            self.assertEqual(json.loads((folder / "missing.json").read_text())["status"], "unverified")
            source.write_text("{}")
            self.assertEqual(audit.main(["--config", str(source), "--output", str(folder / "invalid.json")]), 2)


class InstallTests(unittest.TestCase):
    def test_install_and_refuse_existing(self):
        with tempfile.TemporaryDirectory(prefix="skill-install-unit-") as folder:
            root = Path(folder)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("skill")
            target = root / "dest/skill"
            installer.install(source, target)
            (target / "SKILL.md").write_text("user-customized")
            with self.assertRaises(FileExistsError):
                installer.install(source, target)
            self.assertEqual((target / "SKILL.md").read_text(), "user-customized")

    def test_invalid_source_and_recursive_destination(self):
        with tempfile.TemporaryDirectory(prefix="skill-install-unit-") as folder:
            root = Path(folder)
            with self.assertRaises(ValueError):
                installer.install(root, root / "nested")
            (root / "SKILL.md").write_text("skill")
            with self.assertRaises(ValueError):
                installer.install(root, root / "nested")

    def test_symlinks_are_not_distributed(self):
        with tempfile.TemporaryDirectory(prefix="skill-install-unit-") as folder:
            root = Path(folder)
            source = root / "source"
            source.mkdir()
            (source / "SKILL.md").write_text("skill")
            (source / "link").symlink_to(root / "outside")
            with self.assertRaises(ValueError):
                installer.install(source, root / "dest")


class PackageTests(unittest.TestCase):
    def test_package_is_self_contained_and_excludes_output(self):
        with tempfile.TemporaryDirectory(prefix="skill-build-unit-") as folder:
            root = Path(folder)
            skill = root / "skills/generated-admin-hardening"
            (skill / "references").mkdir(parents=True)
            (skill / "assets/quick-fill-examples").mkdir(parents=True)
            (skill / "SKILL.md").write_text("skill")
            (skill / "PROMPT.md").write_text("install then continue current task")
            (skill / "references/format.md").write_text("format")
            (skill / "assets/quick-fill-examples/a.txt").write_text("example")
            (skill / "assets/sql-delivery-template.md").write_text("SQL delivery contract")
            (skill / "assets/sql-samples").mkdir()
            (skill / "assets/sql-samples/sample.sql").write_text("SELECT 1 AS fixture_only;\n")
            (skill / "__pycache__").mkdir()
            (skill / "__pycache__/a.pyc").write_text("cache")
            (root / ".env").write_text("private")
            (root / "private").mkdir()
            (root / "private/session.json").write_text("private")
            (root / "accidental.sql").write_text("private")
            with patch.object(builder, "ROOT", root), patch.object(builder, "SKILL", skill):
                hashes = builder.build(root / "dist", "2.0.0")
                first = dict(hashes)
                hashes = builder.build(root / "dist", "2.0.0")
                self.assertEqual(first, hashes)
                with zipfile.ZipFile(root / "dist/generated-admin-hardening-2.0.0-source.zip") as archive:
                    self.assertFalse(any("/dist/" in item or "__pycache__" in item for item in archive.namelist()))
                    self.assertFalse(any(".env" in item or "private" in item or "accidental.sql" in item for item in archive.namelist()))
                portable = (root / "dist/generated-admin-hardening-2.0.0-portable.md").read_text()
                self.assertIn("format", portable)
                self.assertIn("install then continue current task", portable)
                self.assertIn("example", portable)
                self.assertIn("SQL delivery contract", portable)
                self.assertIn("```sql\nSELECT 1 AS fixture_only;", portable)
                self.assertEqual((root / "dist/SHA256SUMS-2.0.0.txt").read_bytes(),
                                 (root / "dist/SHA256SUMS.txt").read_bytes())


class ContentTests(unittest.TestCase):
    def test_skill_links_resolve(self):
        import re
        skill = ROOT / "skills/generated-admin-hardening"
        for path in skill.rglob("*.md"):
            for target in re.findall(r"\]\(([^)]+)\)", path.read_text()):
                if "://" not in target and not target.startswith("#"):
                    with self.subTest(path=path.name, target=target):
                        self.assertTrue((path.parent / target.split("#")[0]).exists())


if __name__ == "__main__":
    unittest.main()
