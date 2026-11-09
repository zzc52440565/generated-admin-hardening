"""按显式清单验证本地页面；不登录、不遍历点击、不安装依赖。"""
from __future__ import annotations

import argparse
import ipaddress
import json
from pathlib import Path
import sys
from urllib.parse import parse_qs, urljoin, urlsplit


class ConfigError(ValueError):
    pass


def require_text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{label} 必须是非空字符串")
    return value


def local_path(value):
    value = require_text(value, "页面路径")
    parsed = urlsplit(value)
    if not value.startswith("/") or value.startswith("//") or parsed.netloc or parsed.scheme or "\\" in value:
        raise ConfigError("页面路径必须是同源的 / 开头路径")
    return value


def validate_config(config):
    if not isinstance(config, dict):
        raise ConfigError("配置必须是 JSON 对象")
    parsed = urlsplit(require_text(config.get("base_url"), "base_url"))
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ConfigError("base_url 必须是无凭据的 HTTP(S) 地址")
    if parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ConfigError("base_url 只填写源地址，页面路径放 pages.path")
    try:
        loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        loopback = parsed.hostname == "localhost"
    if not loopback:
        raise ConfigError("此脚本仅支持 localhost 或回环 IP；远程环境请使用项目已有测试")
    if "storage_state" in config:
        require_text(config["storage_state"], "storage_state")
    pages = config.get("pages")
    if not isinstance(pages, list) or not pages:
        raise ConfigError("pages 必须包含至少一个页面")
    count = 0
    for page in pages:
        if not isinstance(page, dict):
            raise ConfigError("页面配置必须是对象")
        local_path(page.get("path"))
        require_text(page.get("ready"), "ready 选择器")
        checks = page.get("checks")
        if not isinstance(checks, list) or not checks:
            raise ConfigError("每页 checks 至少包含一个用例")
        names = set()
        for check in checks:
            if not isinstance(check, dict):
                raise ConfigError("用例必须是对象")
            name = require_text(check.get("name"), "用例名称")
            if name in names:
                raise ConfigError("同一页面内用例名称不能重复")
            names.add(name)
            kind = check.get("kind")
            if kind == "layout":
                require_text(check.get("selector"), "布局选择器")
                if type(check.get("allow_document_scroll", False)) is not bool:
                    raise ConfigError("allow_document_scroll 必须是布尔值")
            elif kind == "button":
                if check.get("reviewed_read_only") is not True:
                    raise ConfigError("按钮须先核对无业务写入并标记 reviewed_read_only=true")
                require_text(check.get("selector"), "按钮选择器")
                expectation = check.get("expect")
                if not isinstance(expectation, dict):
                    raise ConfigError("按钮缺少 expect")
                if expectation.get("kind") not in ("visible", "url", "download", "text"):
                    raise ConfigError("按钮 expect.kind 不支持")
                if expectation["kind"] in ("visible", "text"):
                    require_text(expectation.get("selector"), "结果选择器")
                if expectation["kind"] == "text":
                    require_text(expectation.get("text"), "预期文字")
                if expectation["kind"] == "url":
                    local_path(expectation.get("path"))
            elif kind == "filter":
                if check.get("reviewed_read_only") is not True:
                    raise ConfigError("筛选须先核对只读并标记 reviewed_read_only=true")
                require_text(check.get("selector"), "筛选输入选择器")
                require_text(check.get("submit"), "查询按钮选择器")
                if check.get("action") not in ("fill", "select") or not isinstance(check.get("value"), str):
                    raise ConfigError("筛选 action 为 fill/select，value 必须是字符串")
                request = check.get("request")
                if not isinstance(request, dict):
                    raise ConfigError("筛选缺少 request")
                local_path(request.get("path"))
                if request.get("method") not in ("GET", "POST"):
                    raise ConfigError("筛选 request.method 仅支持 GET/POST")
                params = request.get("params")
                if not isinstance(params, dict) or not params or any(not isinstance(k, str) for k in params):
                    raise ConfigError("筛选 request.params 必须有明确参数")
                result = check.get("result")
                if not isinstance(result, dict):
                    raise ConfigError("筛选缺少独立的预期结果")
                require_text(result.get("selector"), "筛选结果选择器")
                has_count = "count" in result
                has_text = "text" in result
                if has_count and (type(result["count"]) is not int or result["count"] < 0):
                    raise ConfigError("筛选结果 count 必须是非负整数")
                if has_text and not isinstance(result["text"], str):
                    raise ConfigError("筛选结果 text 必须是字符串")
                if not (has_count or has_text):
                    raise ConfigError("筛选结果需要预期 count 或 text，不能只比较请求参数")
            else:
                raise ConfigError("用例 kind 仅支持 layout/button/filter")
            count += 1
    return count


def request_params(request):
    values = {key: items[0] if len(items) == 1 else items
              for key, items in parse_qs(urlsplit(request.url).query, keep_blank_values=True).items()}
    if request.method == "POST":
        body = request.post_data or ""
        try:
            decoded = json.loads(body)
        except (ValueError, TypeError):
            decoded = {key: items[0] if len(items) == 1 else items
                       for key, items in parse_qs(body, keep_blank_values=True).items()}
        if isinstance(decoded, dict):
            values.update(decoded)
    return values


def response_matches(response, origin, wanted):
    actual = urlsplit(response.url)
    if f"{actual.scheme}://{actual.netloc}" != origin or actual.path != urlsplit(wanted["path"]).path:
        return False
    return response.request.method == wanted["method"]


def run_check(page, check, base_url, expect):
    kind = check["kind"]
    if kind == "layout":
        locator = page.locator(check["selector"])
        expect(locator).to_be_visible()
        box = locator.bounding_box()
        if box is None or box["height"] <= 0 or box["width"] <= 0:
            raise AssertionError("控件尺寸不可见")
        overflow = page.evaluate("() => document.documentElement.scrollWidth > innerWidth + 2")
        if overflow and not check.get("allow_document_scroll", False):
            raise AssertionError("页面出现未允许的横向滚动")
        return {"width": round(box["width"]), "height": round(box["height"])}
    if kind == "button":
        button = page.locator(check["selector"])
        expected = check["expect"]
        if expected["kind"] == "download":
            with page.expect_download() as download:
                button.click()
            if download.value.failure():
                raise AssertionError("下载未成功")
            return {"observed": "download"}
        if expected["kind"] == "url":
            button.click()
            expect(page).to_have_url(urljoin(base_url, expected["path"]))
            return {"observed": "navigation"}
        target = page.locator(expected["selector"])
        if expected["kind"] == "visible":
            expect(target).to_be_hidden()
        else:
            # 结果必须相对点击前有变化，避免既有提示制造假通过。
            expect(target).not_to_have_text(expected["text"])
        button.click()
        if expected["kind"] == "visible":
            expect(target).to_be_visible()
        else:
            expect(target).to_have_text(expected["text"])
        page.keyboard.press("Escape")
        return {"observed": expected["kind"]}
    control = page.locator(check["selector"])
    if check["action"] == "fill":
        control.fill(check["value"])
    else:
        control.select_option(value=check["value"])
    wanted = check["request"]
    with page.expect_response(lambda response: response_matches(response, base_url, wanted)) as capture:
        page.locator(check["submit"]).click()
    response = capture.value
    if not 200 <= response.status < 300:
        raise AssertionError("筛选接口返回非成功状态")
    params = request_params(response.request)
    if any(key not in params or str(params[key]) != str(value) for key, value in wanted["params"].items()):
        raise AssertionError("请求缺少预期筛选值")
    result = check["result"]
    target = page.locator(result["selector"])
    if "count" in result:
        expect(target).to_have_count(result["count"])
    if "text" in result:
        expect(target).to_have_text(result["text"])
    return {"observed": "request-and-result"}


def run_audit(config, config_dir):
    from playwright.sync_api import expect, sync_playwright

    results = []
    base_url = config["base_url"].rstrip("/")
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        try:
            options = {"viewport": {"width": 1440, "height": 900}}
            if config.get("storage_state"):
                options["storage_state"] = str((config_dir / config["storage_state"]).resolve())
            context = browser.new_context(**options)
            page = context.new_page()
            # 不接受 JS 确认框，防止“打开”意外执行确认动作。
            page.on("dialog", lambda dialog: dialog.dismiss())
            page.set_default_timeout(5000)
            for route in config["pages"]:
                for check in route["checks"]:
                    errors = []
                    def on_error(_error):
                        errors.append("pageerror")
                    page.on("pageerror", on_error)
                    record = {"page": route["path"], "name": check["name"], "kind": check["kind"]}
                    try:
                        page.goto(urljoin(base_url, route["path"]), wait_until="domcontentloaded")
                        expect(page.locator(route["ready"])).to_be_visible()
                        observed = run_check(page, check, base_url, expect)
                        if errors:
                            raise AssertionError("用例期间出现未处理的页面脚本错误")
                        record.update(status="passed", **observed)
                    except Exception as error:
                        # 不输出 Playwright 的完整调用日志，避免带出 token/业务数据。
                        record.update(status="failed", error_type=type(error).__name__)
                    finally:
                        page.remove_listener("pageerror", on_error)
                    results.append(record)
        finally:
            browser.close()
    failed = sum(record["status"] == "failed" for record in results)
    return {"status": "failed" if failed else "passed", "total": len(results), "failed": failed,
            "scope": "仅覆盖显式配置用例，不代表整个项目验收", "results": results}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.output.exists():
        parser.error("输出文件已存在，请选择新路径")
    try:
        config = json.loads(args.config.read_text(encoding="utf-8"))
        validate_config(config)
    except (OSError, ValueError, TypeError) as error:
        print(f"配置无效：{type(error).__name__}", file=sys.stderr)
        return 2
    try:
        report = run_audit(config, args.config.resolve().parent)
        code = 1 if report["failed"] else 0
    except Exception as error:
        report = {"status": "unverified", "reason": type(error).__name__,
                  "scope": "浏览器依赖、会话或环境未就绪；不能视为通过"}
        code = 3
    try:
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
    except OSError:
        print("无法保存验证报告，请检查输出目录与同名文件", file=sys.stderr)
        return 2
    print(json.dumps({key: value for key, value in report.items() if key != "results"}, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
