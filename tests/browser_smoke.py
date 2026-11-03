"""仅对本进程本地合成网页执行真实 Chromium 回归，不触碰业务系统。"""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
from pathlib import Path
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("browser_audit", ROOT / "skills/generated-admin-hardening/scripts/browser_audit.py")
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)

HTML = b'''<!doctype html><meta charset="utf-8"><main id="app">
<button id="open" onclick="document.querySelector('#detail').hidden=false">View</button>
<section id="detail" hidden>Details</section><a id="nav" href="/detail">Details page</a>
<a id="download" href="/file" download="sample.txt">Download</a>
<input id="status"><button id="query" onclick="query()">Query</button>
<table><tbody id="rows"><tr><td>OPEN</td></tr><tr><td>CLOSED</td></tr></tbody></table>
</main><script>async function query(){ const r=await fetch('/api/orders', {method:'POST',
headers:{'Content-Type':'application/json'}, body:JSON.stringify({status:document.querySelector('#status').value})});
const rows=await r.json();document.querySelector('#rows').innerHTML=rows.map(x=>'<tr><td>'+x+'</td></tr>').join('');}</script>'''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/plain" if self.path == "/file" else "text/html")
        self.end_headers()
        self.wfile.write(b"sample" if self.path == "/file" else HTML)

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'["OPEN"]')


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    checks = [
        {"name": "layout", "kind": "layout", "selector": "table"},
        {"name": "dialog", "kind": "button", "reviewed_read_only": True, "selector": "#open",
         "expect": {"kind": "visible", "selector": "#detail"}},
        {"name": "navigation", "kind": "button", "reviewed_read_only": True, "selector": "#nav",
         "expect": {"kind": "url", "path": "/detail"}},
        {"name": "download", "kind": "button", "reviewed_read_only": True, "selector": "#download",
         "expect": {"kind": "download"}},
        {"name": "post-filter", "kind": "filter", "reviewed_read_only": True, "selector": "#status",
         "action": "fill", "value": "OPEN", "submit": "#query",
         "request": {"path": "/api/orders", "method": "POST", "params": {"status": "OPEN"}},
         "result": {"selector": "#rows tr", "count": 1, "text": "OPEN"}},
    ]
    config = {"base_url": f"http://127.0.0.1:{server.server_port}",
              "pages": [{"path": "/", "ready": "#app", "checks": checks}]}
    try:
        audit.validate_config(config)
        report = audit.run_audit(config, ROOT)
        if report["failed"]:
            raise AssertionError(report)
        negative = copy.deepcopy(config)
        negative["pages"][0]["checks"] = [copy.deepcopy(checks[-1])]
        negative["pages"][0]["checks"][0]["result"]["count"] = 2
        failed = audit.run_audit(negative, ROOT)
        if failed["status"] != "failed" or failed["failed"] != 1:
            raise AssertionError("错误结果没有使检查失败")
        print("真实 Chromium：布局、打开、导航、下载、POST 筛选 5 个正例通过；错误结果反例正确失败。")
        return 0
    except Exception as error:
        print(f"浏览器回归未通过：{error}", file=sys.stderr)
        return 1
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == "__main__":
    raise SystemExit(main())
