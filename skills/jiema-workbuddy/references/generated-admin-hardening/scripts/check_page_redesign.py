"""检查逐页业务改造清单及证据完整性；不访问网站，也不代替业务实测。"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys


# 同时支持源码布局和发行包布局，值只由主技能 conventions.json 维护。
_policy_candidates = [base / suffix for base in Path(__file__).resolve().parents
                      for suffix in ("references/conventions.json", "jiema-workbuddy/references/conventions.json")]
_policy_path = next((path for path in _policy_candidates if path.is_file()), None)
if _policy_path is None:
    raise ValueError("缺少统一 conventions.json")
CONVENTIONS = json.loads(_policy_path.read_text(encoding="utf-8"))
MAX_ACTION_KEYS = CONVENTIONS["actions"]["maxKeysPerAction"]


class AuditError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AuditError(message)


def nonempty(value, label):
    require(isinstance(value, str) and bool(value.strip()), f"{label}不能为空")
    return value


def strings(value, label, allow_empty=False):
    require(isinstance(value, list), f"{label}必须是数组")
    require(allow_empty or bool(value), f"{label}不能为空")
    for item in value:
        nonempty(item, label)
    require(len(set(value)) == len(value), f"{label}不能重复")
    return value


def records(value, label, allow_empty=False):
    require(isinstance(value, list), f"{label}必须是数组")
    require(allow_empty or bool(value), f"{label}不能为空")
    require(all(isinstance(item, dict) for item in value), f"{label}成员必须是对象")
    return value


def choice(value, allowed, label):
    require(isinstance(value, str) and value in allowed, f"{label}无效")


def index_by(rows, key, label, allow_empty=False):
    result = {}
    for row in records(rows, label, allow_empty):
        identity = nonempty(row.get(key), f"{label}.{key}")
        require(identity not in result, f"{label}身份重复：{identity}")
        result[identity] = row
    return result


def discover_spring_jsp_views(root):
    """从控制器返回值和 JSP 文件反向发现页面，片段只按实际 include 排除。"""
    files = list(project_files(root))
    web_roots = set()
    for path in files:
        relative = path.relative_to(root).as_posix()
        for marker in ("src/main/webapp/", "src/main/resources/META-INF/resources/"):
            if marker in relative:
                web_roots.add(root / relative.split(marker)[0] / marker)
    controllers = [path for path in files if path.name.endswith("Controller.java")]
    if not web_roots:
        return {}, set()

    returned = {}
    literal_view = re.compile(r'\breturn\s+"(/?[^"\r\n]+)"\s*;')
    for controller in controllers:
        body = strip_comments(controller.read_text(encoding="utf-8-sig"))
        for match in literal_view.finditer(body):
            name = match.group(1).lstrip("/")
            if name.startswith(("redirect:", "forward:")) or "${" in name:
                continue
            for base in web_roots:
                view = base / (name if name.endswith(".jsp") else name + ".jsp")
                if view.is_file():
                    returned.setdefault(view.relative_to(root).as_posix(), set()).add(controller.relative_to(root).as_posix())

    fragments = set()
    include = re.compile(r'<%@\s*include\s+file\s*=\s*"([^"]+)"|<jsp:include\s+page\s*=\s*"([^"]+)"', re.IGNORECASE)
    for base in web_roots:
        for jsp in base.rglob("*.jsp"):
            body = strip_comments(jsp.read_text(encoding="utf-8-sig"))
            for match in include.finditer(body):
                raw = match.group(1) or match.group(2)
                target = (base / raw.lstrip("/")) if raw.startswith("/") else (jsp.parent / raw)
                target = target.resolve()
                if target.is_file() and target.is_relative_to(base.resolve()):
                    fragments.add(target.relative_to(root.resolve()).as_posix())

    candidates = {}
    for base in web_roots:
        for jsp in base.rglob("*.jsp"):
            relative = jsp.relative_to(root).as_posix()
            if relative in returned or relative not in fragments:
                candidates[relative] = returned.get(relative, set())
    return candidates, set(returned)


def check_jsp_inventory(root, inventory, pages, source):
    candidates, returned = discover_spring_jsp_views(root)
    if not candidates:
        return 0
    excluded = {}
    for item in records(inventory.get("excludedViewFiles", []), "inventory.excludedViewFiles", True):
        path = nonempty(item.get("path"), "排除页面.path")
        nonempty(item.get("reason"), f"排除页面{path}.reason")
        if path not in candidates:
            continue
        require(path not in returned, f"不能排除实际控制器返回的页面：{path}")
        require(path not in excluded, f"排除页面重复：{path}")
        source(path)
        excluded[path] = item
    registered = set()
    for page in pages.values():
        registered.update(page["sourceFiles"])
    missing = sorted(set(candidates) - registered - set(excluded))
    require(not missing, f"Spring/JSP 页面未登记到 inventory.pages：{missing}")
    for path, controllers in candidates.items():
        if path in excluded:
            continue
        matching = [page for page in pages.values() if path in page["sourceFiles"]]
        require(matching, f"页面没有角色与入口登记：{path}")
        for controller in controllers:
            source(controller)
            require(controller in inventory["sourceFiles"], f"控制器未进入路由源码清单：{controller}")
            require(any(controller in page["sourceFiles"] for page in matching),
                    f"页面缺少控制器调用依据：{path} ← {controller}")
    return len(candidates) - len(excluded)


# 声明式操作和事件的静态覆盖；动态声明必须显式消歧，不能当作空集合。
ACTION_SOURCE_SUFFIXES = {".vue", ".js", ".ts", ".jsx", ".tsx", ".jsp", ".html", ".java", ".wxml", ".cs"}
IMPORT_PATTERN = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']""")
OPERATION_OBJECT_MARKERS = {"label", "role", "onClick", "handler", "action", "operation", "permission"}
STRING_PATTERN = r'''"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`'''
COMMENT_PATTERN = re.compile(STRING_PATTERN + r"|<!--.*?-->|<%--.*?--%>|/\*.*?\*/|//[^\n]*", re.DOTALL)


def strip_comments(text):
    """保留字符串及行号；注释不能充当操作、入口或授权证据。"""
    return COMMENT_PATTERN.sub(lambda m: re.sub(r"[^\n]", " ", m.group())
                               if m.group().startswith(("//", "/*", "<!--", "<%--")) else m.group(), text)


def local_path(root, raw):
    nonempty(raw, "证据/源码路径")
    require(not Path(raw).is_absolute(), f"路径必须相对项目目录：{raw}")
    actual = (root / raw).resolve()
    require(actual.is_relative_to(root.resolve()), f"路径不能越出项目目录：{raw}")
    require(actual.is_file() and actual.stat().st_size > 0, f"文件缺失或为空：{raw}")
    return actual


def split_top_level(text, separator=","):
    """按最外层分隔符拆字段/参数，忽略字符串与嵌套表达式。"""
    quote, depth, start, index = None, 0, 0, 0
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char in "{[(":
            depth += 1
        elif char in "}])":
            depth -= 1
        elif char == separator and depth == 0:
            yield text[start:index]
            start = index + 1
        index += 1
    yield text[start:]


def iter_object_bodies(text):
    stack, quote, index = [], None, 0
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char == "{":
            stack.append(index)
        elif char == "}" and stack:
            start = stack.pop()
            yield start, text[start + 1:index]
        index += 1


def literal_keys(expression):
    expression = expression.strip()
    if expression.startswith("[") and expression.endswith("]"):
        values = list(split_top_level(expression[1:-1]))
        result = []
        for value in values:
            if not value.strip():
                continue
            parsed = literal_keys(value)
            if parsed is None:
                return None
            result.extend(parsed)
        return result
    if not re.fullmatch(STRING_PATTERN, expression, re.DOTALL):
        return None
    value = expression[1:-1]
    if "${" in value or not re.fullmatch(r"[A-Za-z][\w.:#-]*", value):
        return None
    return [value]


def resolve_import(root, base_relative, spec):
    if spec.startswith("."):
        target = root / Path(base_relative).parent / spec
    elif spec.startswith("@/"):
        base = root / Path(base_relative).parent
        while base != root and base.name != "src":
            base = base.parent
        target = (base if base.name == "src" else root / "src") / spec[2:]
    else:
        return None
    require(target.resolve().is_relative_to(root.resolve()), f"import 路径不能越出项目：{spec}")
    suffixes = (".vue", ".js", ".ts", ".jsx", ".tsx", ".wxml", ".jsp", ".html")
    candidates = [target] + [Path(str(target) + suffix) for suffix in suffixes]
    candidates += [target / ("index" + suffix) for suffix in suffixes]
    for candidate in candidates:
        if candidate.is_file():
            actual = local_path(root, candidate.relative_to(root).as_posix())
            return actual.relative_to(root.resolve()).as_posix()
    require(target.suffix.lower() not in ACTION_SOURCE_SUFFIXES and bool(target.suffix),
            f"无法解析本地源码引用：{base_relative} → {spec}")
    return None


def action_source_files(root, page, review):
    """无固定深度的本地 import/include 闭包；循环引用按规范路径去重。"""
    seeds = list(page.get("sourceFiles") or []) + list(review.get("changedFiles") or [])
    for action in review.get("businessActions") or []:
        seeds.extend(action.get("implementationFiles") or [])
    collected, frontier = [], list(seeds)
    while frontier:
        relative = frontier.pop(0)
        if not isinstance(relative, str) or Path(relative).suffix.lower() not in ACTION_SOURCE_SUFFIXES:
            continue
        path = local_path(root, relative)
        relative = path.relative_to(root.resolve()).as_posix()
        if relative in collected:
            continue
        collected.append(relative)
        body = strip_comments(path.read_text(encoding="utf-8-sig", errors="replace"))
        # 路由目标分别登记页面；目录名本身不能豁免其中的动作实现。
        routing_path = "/" + relative
        routing_metadata = (any(part in routing_path for part in ("/router/", "/routes/"))
                            or path.stem in {"router", "routes"}) and bool(
                                re.search(r"\b(?:createRouter|VueRouter)\b|\b(?:const|let|var)\s+routes\s*=", body))
        specs = [match.group(1) for match in IMPORT_PATTERN.finditer(body)]
        for match in re.finditer(r'''<(?:script|import|include)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']|<%@\s*include\s+file\s*=\s*["']([^"']+)["']|<jsp:include\s+page\s*=\s*["']([^"']+)["']''', body):
            spec = next(value for value in match.groups() if value is not None)
            if not spec.startswith(("/", "http:", "https:", "${")):
                specs.append(spec if spec.startswith(".") else "./" + spec)
        for spec in specs:
            resolved = resolve_import(root, relative, spec)
            if routing_metadata and resolved and "/views/" in "/" + resolved:
                continue
            if resolved and resolved not in collected:
                frontier.append(resolved)
    return collected


def enumerate_action_keys(root, page, review, source_files=None):
    found, unresolved = {}, []
    for relative in source_files if source_files is not None else action_source_files(root, page, review):
        body = strip_comments((root / relative).read_text(encoding="utf-8-sig", errors="replace"))

        def add(expression, start):
            location = f"{relative}:{body.count(chr(10), 0, start) + 1}"
            keys = literal_keys(expression)
            if keys is None:
                unresolved.append(location)
            else:
                for key in keys:
                    found.setdefault(key, location)

        for start, inner in iter_object_bodies(body):
            fields = {}
            dynamic_field = False
            for field in split_top_level(inner):
                computed = re.match(r"\s*\[([^]]+)\]\s*:", field)
                if computed:
                    literal = literal_keys(computed.group(1))
                    if literal and len(literal) == 1:
                        field = literal[0] + ":" + field[computed.end():]
                    else:
                        dynamic_field = True
                match = re.match(r'''\s*(?:["']([\w]+)["']|(\w+))\s*:\s*(.*)\Z''', field, re.DOTALL)
                if match:
                    fields[match.group(1) or match.group(2)] = match.group(3)
            if dynamic_field and OPERATION_OBJECT_MARKERS & fields.keys():
                unresolved.append(f"{relative}:{body.count(chr(10), 0, start) + 1}")
            if OPERATION_OBJECT_MARKERS & fields.keys() and "key" in fields:
                add(fields["key"], start)
            for key in ("operationKey", "perm", "perms"):
                if key in fields:
                    add(fields[key], start)
        permission_spans = []
        for match in re.finditer(r'''\bv-permission(?:[:.][\w-]+)*\s*=\s*(["'])(.*?)\1''', body, re.DOTALL):
            permission_spans.append((match.start(), match.end()))
            add(match.group(2), match.start())
        for match in re.finditer(r"\bv-permission\b", body):
            if not any(start <= match.start() < end for start, end in permission_spans):
                unresolved.append(f"{relative}:{body.count(chr(10), 0, match.start()) + 1}")
        for match in re.finditer(r'''(?<![\w:-])(?:permission|operationKey)\s*=\s*(["'])(.*?)\1|<shiro:hasPermission\b[^>]*\bname\s*=\s*(["'])(.*?)\3''', body, re.DOTALL):
            value = match.group(2) if match.group(1) else match.group(4)
            add(repr(value), match.start())
        for match in re.finditer(r'''\bhas(?:Any)?Authority\s*\(([^)]*)\)|@RequiresPermissions\s*\(([^)]*)\)''', body):
            expression = (match.group(1) if match.group(1) is not None else match.group(2)).strip()
            if expression.startswith("{") and expression.endswith("}"):
                expression = expression[1:-1]
            add("[" + expression + "]", match.start())
        for match in re.finditer(r'''(?:\b(?:bind|catch):?(?:tap|submit|change)|@(?:click|submit|change)(?:\.[\w-]+)*|\bv-on:(?:click|submit|change)|\bon(?:click|submit|change))\s*=\s*(["'])(.*?)\1''', body):
            expression = match.group(2).strip()
            handler = re.fullmatch(r"([A-Za-z_$][\w$]*(?:\.[\w$]+)*)(?:\([^;]*\))?;?", expression)
            if handler:
                add(repr("event:" + handler.group(1)), match.start())
            else:
                unresolved.append(f"{relative}:{body.count(chr(10), 0, match.start()) + 1}")
        event_spans = []
        for match in re.finditer(r"\b\w+\.(?:Click|Submit|SelectedIndexChanged)\s*\+=\s*(?:this\.)?(\w+)\s*;", body):
            event_spans.append((match.start(), match.end()))
            add(repr("event:" + match.group(1)), match.start())
        for match in re.finditer(r"\b\w+\.(?:Click|Submit|SelectedIndexChanged)\s*\+=\s*new\s+(?:System\.)?EventHandler\s*\(\s*(?:this\.)?(\w+)\s*\)", body):
            event_spans.append((match.start(), match.end()))
            add(repr("event:" + match.group(1)), match.start())
        for match in re.finditer(r"\b\w+\.(?:Click|Submit|SelectedIndexChanged)\s*\+=", body):
            if not any(start <= match.start() < end for start, end in event_spans):
                unresolved.append(f"{relative}:{body.count(chr(10), 0, match.start()) + 1}")
        for match in re.finditer(r"\b(\w+)\.addActionListener\s*\(", body):
            add(repr("event:" + match.group(1)), match.start())
    return found, list(dict.fromkeys(unresolved))


VIEW_SUFFIXES = {".vue", ".tsx", ".jsx", ".html", ".jsp", ".wxml", ".cs", ".java"}
SKIP_DIRECTORIES = {"node_modules", ".git", "dist", "target", "build", ".next", "bin", "obj", "__pycache__"}


def project_files(root):
    import os
    for base, directories, files in os.walk(root, followlinks=False):
        directories[:] = sorted(name for name in directories if name not in SKIP_DIRECTORIES)
        for name in sorted(files):
            yield Path(base) / name


def discover_view_files(root):
    found = {}
    markers = ("/src/views/", "/resources/views/", "/src/main/webapp/", "/src/main/resources/templates/",
               "/src/main/resources/META-INF/resources/")
    jsp_candidates, _ = discover_spring_jsp_views(root)
    for path in project_files(root):
        suffix = path.suffix.lower()
        if suffix not in VIEW_SUFFIXES:
            continue
        relative = path.relative_to(root).as_posix()
        normalized = "/" + relative
        is_view = any(marker in normalized for marker in markers)
        if suffix == ".jsp":
            is_view = relative in jsp_candidates
        elif suffix == ".wxml":
            is_view = "/pages/" in normalized
        elif suffix in {".java", ".cs"}:
            body = strip_comments(local_path(root, relative).read_text(encoding="utf-8-sig"))
            is_view = bool(re.search(r"(?:\bextends\s+J(?:Frame|Dialog|Panel)|:\s*(?:[\w.]+\.)?Form)\b", body)) or relative.endswith(".Designer.cs")
        if is_view:
            local_path(root, relative)
            found[relative] = path
    return found


def check_view_inventory(root, inventory, pages):
    views = discover_view_files(root)
    excluded = {}
    registered = {path for page in pages.values() for path in page.get("sourceFiles", [])}
    for item in records(inventory.get("excludedViewFiles", []), "inventory.excludedViewFiles", True):
        path = nonempty(item.get("path"), "排除视图.path")
        nonempty(item.get("reason"), f"排除视图{path}.reason")
        require(path in views, f"排除视图不存在：{path}")
        require(path not in excluded, f"排除视图重复：{path}")
        require(path not in registered, f"视图不能同时登记与排除：{path}")
        excluded[path] = item
    missing = sorted(set(views) - registered - set(excluded))
    require(not missing, f"有视图文件没有登记为页面：{missing[:12]}；请登记到页面 sourceFiles 或用 excludedViewFiles 说明")
    return len(views) - len(excluded)


SQL_ID = r'(?:`[^`]+`|"(?:""|[^"])+"|\[[^\]]+\]|[A-Za-z_][\w$]*)'
SQL_NAME = SQL_ID + r'(?:\s*\.\s*' + SQL_ID + r')*'
TABLE_PATTERN = re.compile(r'\b(CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE)\s+(' + SQL_NAME + r')', re.IGNORECASE)


def schema_text(path):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    # SQL 字符串与注释均不是 DDL；双引号、反引号、方括号保留为标识符。
    return re.sub(r"'(?:''|\\.|[^'\\])*'|--[^\n]*|\#[^\n]*|/\*.*?\*/",
                  lambda m: re.sub(r"[^\n]", " ", m.group()), text, flags=re.DOTALL)


def schema_sources(root):
    return [path for path in project_files(root) if path.suffix.lower() == ".sql" and TABLE_PATTERN.search(schema_text(path))]


def sql_entity(name):
    part = re.findall(SQL_ID, name)[-1]
    return part.strip('`"[]').lower()


def discover_schema_entities(root):
    """DDL 只提供实体和关系事实，业务角色由审查者判断。"""
    entities, edges = set(), set()
    for path in schema_sources(root):
        local_path(root, path.relative_to(root).as_posix())
        body = schema_text(path)
        matches = list(TABLE_PATTERN.finditer(body))
        for index, match in enumerate(matches):
            child = sql_entity(match.group(2))
            if match.group(1).upper().startswith("CREATE"):
                entities.add(child)
            end = matches[index + 1].start() if index + 1 < len(matches) else len(body)
            statement = body[match.end():end].split(";", 1)[0]
            for reference in re.finditer(r'\bREFERENCES\s+(' + SQL_NAME + ')', statement, re.IGNORECASE):
                parent = sql_entity(reference.group(1))
                if parent != child:
                    edges.add((parent, child))
    return sorted(entities), sorted(edges)


ENTITY_ROLES = {"master": "主单", "detail": "明细", "independent": "独立实体"}


def check_master_detail_groups(audit, pages, reviews, root=None):
    groups = {}
    for item in records(audit.get("masterDetailGroups", []), "masterDetailGroups", True):
        parent = nonempty(item.get("parent"), "masterDetailGroups.parent").lower()
        children = [value.lower() for value in strings(item.get("children"), f"主从组{parent}.children")]
        identity = nonempty(item.get("pageId"), f"主从组{parent}.pageId")
        require(parent not in groups, f"主从组重复：{parent}")
        require(identity in pages, f"主从组{parent}指向不存在的页面：{identity}")
        review = reviews[identity]
        require(review.get("decision") == "redesign-business", f"主从组{parent}的页面必须以 redesign-business 验收")
        require(review.get("targetForm") not in {"list", "generic-crud"}, f"主从组{parent}不能仍是列表")
        mapping = item.get("childViewFiles")
        require(isinstance(mapping, dict) and set(mapping) == set(children),
                f"主从组{parent}必须用 childViewFiles 逐个映射明细视图；只拼文件名等于没有合并")
        workspace = strings(item.get("workspaceFiles"), f"主从组{parent}.workspaceFiles")
        page_sources = set(pages[identity]["sourceFiles"])
        require(set(workspace) <= page_sources, f"主从组{parent}.workspaceFiles 必须登记到页面")
        require(root is not None, "主从组核对需要项目根目录")
        reachable = set(action_source_files(root, {"sourceFiles": workspace}, {}))
        for child in children:
            paths = strings(mapping[child], f"主从组{parent}.childViewFiles.{child}")
            for path in paths:
                require(path in page_sources and Path(path).suffix.lower() in VIEW_SUFFIXES,
                        f"明细{child}视图必须登记到同一业务页面：{path}")
                local_path(root, path)
                require(path in reachable, f"明细{child}视图未进入主单工作页引用闭包：{path}")
        groups[parent] = set(children)
    return groups


def check_review_shape(review, label):
    """每页形态结论必填；needsWorkflow=false 必须给依据与完整操作链（不设字数门槛）。"""
    for field in ("businessGoal", "rationale", "targetForm", "businessQuestion", "scaffoldGap"):
        nonempty(review.get(field), f"{label}.{field}")
    require(isinstance(review.get("needsWorkflow"), bool), f"{label}必须明确通用CRUD是否不适配业务")
    if review.get("needsWorkflow") is False:
        nonempty(review.get("needsWorkflowBasis"), f"{label}.needsWorkflowBasis（为什么列表＋弹窗足以完成该业务）")
        chain = strings(review.get("workflowChain"), f"{label}.workflowChain（该业务在本页的完整操作链）")
        require(len(chain) >= 2, f"{label}.workflowChain 至少写两步：谁 → 做什么 → 状态怎么变")


def normalize_entity_token(value):
    return re.sub(r"[^a-z0-9]", "", value.lower())


def delimited_end(text, start, opening="(", closing=")"):
    depth, quote, index = 0, None, start
    while index < len(text):
        char = text[index]
        if quote:
            if char == "\\":
                index += 2
                continue
            if char == quote:
                quote = None
        elif char in "\"'`":
            quote = char
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise AuditError("无法静态解析未闭合的源码表达式")


def java_mappings(body):
    for match in re.finditer(r"@(Request|Post|Put|Delete|Patch|Get)Mapping\b\s*", body):
        start = match.end()
        if start < len(body) and body[start] == "(":
            end = delimited_end(body, start)
            yield match.start(), end + 1, match.group(1), body[start + 1:end]
        else:
            yield match.start(), start, match.group(1), ""


def mapping_paths(args):
    values = [""]
    for field in split_top_level(args):
        field = field.strip()
        if not field:
            continue
        assignment = re.match(r"(\w+)\s*=\s*(.*)\Z", field, re.DOTALL)
        if assignment:
            if assignment.group(1) not in {"value", "path"}:
                continue
            field = assignment.group(2).strip()
        if field.startswith("{") and field.endswith("}"):
            parts = list(split_top_level(field[1:-1]))
        else:
            parts = [field]
        require(all(re.fullmatch(r'"[^"\\]*"', part.strip()) for part in parts),
                "映射路径无法静态识别，必须使用完整字符串字面量")
        values = [part.strip()[1:-1] for part in parts]
    return values


def mapped_method(body, offset):
    signature = re.search(r"\b[\w<>\[\].?,]+\s+(\w+)\s*\([^;{}]*\)\s*(?:throws\s+[\w.,\s]+)?\{", body[offset:])
    require(signature is not None, "无法静态定位映射对应的端点方法")
    start = offset + signature.end() - 1
    end = delimited_end(body, start, "{", "}")
    return body[start + 1:end]


def code_contains(body, token):
    body = strip_comments(body)
    # 可确定不执行的字面量分支不作为证据；一般可达性仍需运行验证。
    body = re.sub(r"\b(?:if|while)\s*\(\s*false\s*\)\s*[^\s{][^;{}]*;", " ", body)
    for match in reversed(list(re.finditer(r"\b(?:if|while)\s*\(\s*false\s*\)\s*\{", body))):
        end = delimited_end(body, match.end() - 1, "{", "}")
        body = body[:match.start()] + " " * (end + 1 - match.start()) + body[end + 1:]
    strings_spans = [(m.start(), m.end()) for m in re.finditer(STRING_PATTERN, body, re.DOTALL)]
    return any(not any(start <= match.start() < end for start, end in strings_spans)
               for match in re.finditer(re.escape(token), body))


def endpoint_details(root, entity):
    token = normalize_entity_token(entity)
    found = {}
    for path in project_files(root):
        if not path.name.endswith("Controller.java"):
            continue
        relative = path.relative_to(root).as_posix()
        body = strip_comments(local_path(root, relative).read_text(encoding="utf-8-sig"))
        class_match = re.search(r"\bclass\s+\w+", body)
        if not class_match:
            continue
        mappings = list(java_mappings(body))
        class_mappings = [row for row in mappings if row[0] < class_match.start()]
        stem_matches = normalize_entity_token(path.stem.removesuffix("Controller")) == token
        bases = [""]
        if class_mappings:
            try:
                bases = mapping_paths(class_mappings[-1][3])
            except AuditError:
                require(not stem_matches, f"实体{entity}的类级映射无法静态识别：{relative}")
                continue
        route_matches = any(token == normalize_entity_token(segment) for base in bases for segment in base.split("/"))
        if not stem_matches and not route_matches:
            continue
        for start, end, kind, args in mappings:
            if start < class_match.end() or kind == "Get":
                continue
            if kind == "Request":
                method_field = re.search(r"\bmethod\s*=\s*(\{[^}]*\}|[^,]+)", args)
                methods = re.findall(r"RequestMethod\.(\w+)", method_field.group(1)) if method_field else ["POST", "PUT", "PATCH", "DELETE"]
                require(bool(methods), f"实体{entity}的方法映射无法静态识别：{relative}")
                methods = [method for method in methods if method in {"POST", "PUT", "PATCH", "DELETE"}]
            else:
                methods = [kind.upper()]
            if not methods:
                continue
            suffixes = mapping_paths(args)
            method_body = mapped_method(body, end)
            for base in bases:
                for suffix in suffixes:
                    route = "/" + "/".join(part.strip("/") for part in (base, suffix) if part.strip("/"))
                    for method in methods:
                        endpoint = f"{method} {route}"
                        location = f"{relative}:{body.count(chr(10), 0, start) + 1}"
                        require(endpoint not in found, f"实体{entity}端点重复映射，需要人工消歧：{endpoint}")
                        found[endpoint] = {"file": relative, "location": location, "body": method_body}
    return found


def discover_write_endpoints(root, entity):
    """扫描潜在写方法；名称包含 list/detail/page 不构成只读证明。"""
    return {endpoint: meta["location"] for endpoint, meta in endpoint_details(root, entity).items()}


def check_detail_write_endpoints(root, entity, item, source=None):
    details = endpoint_details(root, entity)
    endpoints = {endpoint: meta["location"] for endpoint, meta in details.items()}
    if source:
        for path in {meta["file"] for meta in details.values()}:
            source(path)
    kept = {}
    for entry in records(item.get("keptWriteEndpoints", []), f"实体{entity}.keptWriteEndpoints", True):
        endpoint = nonempty(entry.get("endpoint"), f"实体{entity}.keptWriteEndpoints.endpoint")
        require(endpoint in endpoints, f"实体{entity}登记的写端点{endpoint}在控制器里找不到；只需登记真实存在的端点")
        require(endpoint not in kept, f"实体{entity}重复登记端点：{endpoint}")
        evidence = entry.get("scopeEvidence")
        require(isinstance(evidence, dict), f"实体{entity}保留写端点{endpoint}必须给 scopeEvidence")
        relative = nonempty(evidence.get("file"), f"实体{entity}.scopeEvidence.file")
        require(Path(relative).suffix == ".java", f"实体{entity}.scopeEvidence 必须引用 Java 实现源码")
        token = nonempty(evidence.get("token"), f"实体{entity}.scopeEvidence.token")
        path = local_path(root, relative)
        body = path.read_text(encoding="utf-8-sig")
        require(code_contains(body, token), f"实体{entity}父级校验在非注释代码中找不到：{relative}")
        meta = details[endpoint]
        if relative == meta["file"]:
            require(code_contains(meta["body"], token), f"实体{entity}的 scopeEvidence 不在该端点方法中：{endpoint}")
        else:
            call_site = nonempty(evidence.get("callSite"), f"实体{entity}.scopeEvidence.callSite（该端点调用服务的代码）")
            require(code_contains(meta["body"], call_site), f"实体{entity}的服务调用在该端点方法中找不到：{endpoint}")
        if source:
            source(relative)
        kept[endpoint] = entry
    pending = [f"{endpoint}（{location}）" for endpoint, location in sorted(endpoints.items()) if endpoint not in kept]
    require(not pending, f"实体{entity}已判为明细，但后端仍暴露独立写端点：{pending}；请删除或用 keptWriteEndpoints 指出父级归属校验")
    return endpoints


def check_isolation_test(root, entity, item, endpoints, revision=None, digests=None):
    """明细必须有一次“拿别人的主单塞明细”的负向实测：期望 4xx，实测必须等于期望。"""
    test = item.get("isolationTest")
    require(isinstance(test, dict),
            f"实体{entity}判为明细，必须给 isolationTest：用另一个用户的主单去写这条明细，"
            f"记录请求内容与响应码（期望 4xx），并保留真实执行来源供独立复核")
    endpoint = nonempty(test.get("endpoint"), f"实体{entity}.isolationTest.endpoint")
    if endpoints:
        require(isinstance(endpoint, str) and endpoint.strip() in endpoints,
                f"实体{entity}.isolationTest.endpoint 必须是本项目真实存在的写端点：{sorted(endpoints)}")
    nonempty(test.get("scenario"), f"实体{entity}.isolationTest.scenario（谁用谁的主单做了什么）")
    nonempty(test.get("request"), f"实体{entity}.isolationTest.request")
    for field in ("expectedStatus", "actualStatus"):
        require(type(test.get(field)) is int, f"实体{entity}.isolationTest.{field} 必须是整数 HTTP 状态码")
    require(400 <= test["expectedStatus"] <= 499,
            f"实体{entity}.isolationTest.expectedStatus 必须是 4xx：越权写明细应当被拒绝，现在是 {test['expectedStatus']}")
    require(test["actualStatus"] == test["expectedStatus"],
            f"实体{entity}越权写明细的实测结果是 {test['actualStatus']}，与期望 {test['expectedStatus']} 不符；"
            f"返回 2xx 说明后端仍可脱离主单写入，属于双轨未拆")
    evidence = nonempty(test.get("evidence"), f"实体{entity}.isolationTest.evidence")
    path = local_path(root, evidence)
    stamp = nonempty(test.get("testedAt"), f"实体{entity}.isolationTest.testedAt")
    try:
        tested_at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError as error:
        raise AuditError(f"实体{entity}隔离实测时间必须为 ISO8601") from error
    require(tested_at.tzinfo is not None and tested_at <= datetime.now(timezone.utc),
            f"实体{entity}隔离实测时间必须带时区且不能在未来")
    require(path.suffix.lower() == ".json", f"实体{entity}隔离证据必须是 JSON")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise AuditError(f"实体{entity}隔离证据不是有效 JSON") from error
    require(isinstance(payload, dict), f"实体{entity}隔离证据必须为对象")
    for field, expected in (("entity", entity), ("endpoint", endpoint), ("request", test["request"]), ("testedAt", stamp)):
        require(payload.get(field) == expected, f"实体{entity}隔离证据.{field} 与审计声明不符")
    actor = nonempty(payload.get("actorId"), "隔离证据.actorId")
    owner = nonempty(payload.get("parentOwnerId"), "隔离证据.parentOwnerId")
    nonempty(payload.get("parentId"), "隔离证据.parentId")
    require(actor != owner, f"实体{entity}隔离证据必须使用另一个用户的主单")
    response = payload.get("response")
    require(isinstance(response, dict) and type(response.get("status")) is int
            and response["status"] == test["actualStatus"], f"实体{entity}隔离证据响应码与 actualStatus 不符")
    nonempty(response.get("body"), "隔离证据.response.body（拒绝原因）")
    if revision is not None:
        require(payload.get("revision") == revision, f"实体{entity}隔离证据版本与最终版本不符")
    related = {location.rsplit(":", 1)[0] for location in endpoints.values()}
    related.update(entry["scopeEvidence"]["file"] for entry in item.get("keptWriteEndpoints", []))
    if item.get("parent"):
        related.update(meta["file"] for meta in endpoint_details(root, item["parent"]).values())
    for relative in related:
        actual = local_path(root, relative)
        require(tested_at.timestamp() >= actual.stat().st_mtime - 1 and path.stat().st_mtime >= actual.stat().st_mtime - 1,
                f"实体{entity}隔离证据早于最终后端源码，必须复验：{relative}")
        if digests is not None:
            recorded = payload.get("sourceDigests")
            require(isinstance(recorded, dict) and relative in digests and recorded.get(relative) == digests[relative]
                    == hashlib.sha256(actual.read_bytes()).hexdigest(), f"实体{entity}隔离证据源码摘要不匹配：{relative}")


def check_standalone_evidence(root, entity, item):
    """独立实体必须给出真实入口：角色 + 场景 + 入口字面量 + 所在文件，且字面量能在该文件里找到。"""
    evidence = item.get("standaloneEvidence")
    require(isinstance(evidence, dict),
            f"实体{entity}判为 independent，必须给 standaloneEvidence（谁在什么场景、从哪个入口独立使用它）；"
            f"无法举证时保持未验证，由业务审查确认其角色，不能据此强判 detail")
    for field in ("role", "scenario", "entry", "entrySource"):
        nonempty(evidence.get(field), f"实体{entity}.standaloneEvidence.{field}")
    source = evidence["entrySource"].strip()
    path = local_path(root, source)
    body = strip_comments(path.read_text(encoding="utf-8-sig", errors="replace"))
    require(evidence["entry"].strip() in body,
            f"实体{entity}声称的独立入口「{evidence['entry']}」在 {source} 中找不到；入口必须在代码里真实存在")


def check_entity_roles(root, audit, entities, edges, groups, source=None):
    """每个实体给出业务角色；判独立必须有真实入口，判明细必须并入主单页。"""
    if not entities:
        return 0
    roles = {}
    for item in records(audit.get("entityRoles"), "entityRoles"):
        entity = nonempty(item.get("entity"), "entityRoles.entity").lower()
        nonempty(item.get("basis"), f"实体{entity}.basis（按业务判断主单/明细/独立的依据）")
        role = item.get("role")
        require(role in ENTITY_ROLES, f"实体{entity}.role 只能是 master/detail/independent")
        require(entity not in roles, f"实体角色重复：{entity}")
        roles[entity] = item
    missing = sorted(entity for entity in entities if entity not in roles)
    require(not missing,
            f"以下实体没有给出业务角色：{missing}；请逐个判断它是主单、明细还是独立实体并写明依据。"
            f"判断要看真实操作流程，不能按表名、字段名或外键直接认定")
    unknown = sorted(entity for entity in roles if entity not in entities)
    require(not unknown, f"entityRoles 登记了数据库结构里不存在的实体：{unknown}")
    for parent, children in groups.items():
        require(parent in roles and roles[parent]["role"] == "master", f"主从组{parent}必须对应 master 实体")
        for child in children:
            require(child in roles and roles[child]["role"] == "detail" and roles[child].get("parent", "").lower() == parent,
                    f"主从组{parent}的明细{child}与 entityRoles 不一致")
    for entity, item in roles.items():
        if item["role"] == "independent":
            check_standalone_evidence(root, entity, item)
            if source:
                source(item["standaloneEvidence"]["entrySource"])
        if item["role"] != "detail":
            continue
        parent = item.get("parent")
        require(isinstance(parent, str) and parent.strip(),
                f"实体{entity}声明为明细，必须写 parent 指向其主单")
        parent = parent.strip().lower()
        require(parent in roles, f"实体{entity}的 parent 不在实体清单：{parent}")
        require(parent != entity and roles[parent]["role"] == "master", f"实体{entity}的 parent 必须指向不同的 master 实体")
        require(entity in groups.get(parent, set()),
                f"实体{entity}声明为明细，但没有并入主单{parent}的合并组；单据型业务的明细必须在同一业务工作页维护")
        if (parent, entity) not in edges:
            nonempty(item.get("relationEvidence"),
                     f"实体{entity}判为{parent}的明细，但数据库结构里没有对应的外键边；"
                     f"请在 relationEvidence 写明这条关系落在哪（ORM 映射 / 代码关联），否则无法核对")
        endpoints = check_detail_write_endpoints(root, entity, item, source)
        if source:
            for meta in endpoint_details(root, parent).values():
                source(meta["file"])
        check_isolation_test(root, entity, item, endpoints, audit.get("targetRevision"), audit.get("sourceDigests"))
    return len(entities)


def check_action_coverage(root, identity, page, review, actions):
    """源码枚举出的每个操作键都要被独立动作登记并逐键实测，或结构化说明去向。"""
    enumerated, unresolved = enumerate_action_keys(root, page, review)
    require(not unresolved,
            f"页面{identity}有无法静态识别的操作/权限/事件声明：{unresolved}；"
            f"动态键或未支持的事件写法无法核对操作清单，请使用静态字面量或可识别的命名处理器后复验")
    require("excludedActions" not in review, f"页面{identity}.excludedActions 已废弃，请迁移到 displacedActions")
    covered = {}
    for action in actions.values():
        keys = action.get("actionKeys")
        if keys is None:
            continue
        declared = strings(keys, f"页面{identity}操作{action.get('name')}.actionKeys")
        require(len(declared) <= MAX_ACTION_KEYS,
                f"页面{identity}的动作「{action.get('name')}」登记了 {len(declared)} 个操作键 {declared}；"
                f"一个动作最多覆盖 {MAX_ACTION_KEYS} 个键，业务动作要拆开逐个实测，不能一个名字吞掉一批按钮")
        for key in declared:
            require(key not in covered, f"页面{identity}的操作键{key}被多个动作重复登记")
            covered[key] = action.get("name")
    displaced = {}
    for item in records(review.get("displacedActions") or [], f"页面{identity}.displacedActions", True):
        key = nonempty(item.get("key"), f"页面{identity}去向.key")
        kind = item.get("kind")
        require(kind in {"otherPage", "superseded", "noBinding"},
                f"页面{identity}操作{key}.kind 只能是 otherPage/superseded/noBinding")
        nonempty(item.get("evidence"), f"页面{identity}操作{key}.evidence")
        if kind == "otherPage":
            target = nonempty(item.get("targetPageId"), f"页面{identity}操作{key}.targetPageId")
            require(target != identity, f"页面{identity}操作的去向页不能是自己")
        if kind == "superseded":
            replacements = strings(item.get("replacementKeys"), f"页面{identity}.replacementKeys")
            require(set(replacements) <= set(covered), f"页面{identity}替代操作必须在本页登记并实测")
        if kind == "noBinding":
            binding = item.get("bindingEvidence")
            require(isinstance(binding, dict), f"页面{identity}.noBinding 必须给 bindingEvidence（未绑定的源码依据）")
            path = nonempty(binding.get("file"), f"页面{identity}.bindingEvidence.file")
            token = nonempty(binding.get("token"), f"页面{identity}.bindingEvidence.token")
            require(path in action_source_files(root, page, review), f"页面{identity}的 bindingEvidence 必须属于本页引用闭包")
            require(token in strip_comments(local_path(root, path).read_text(encoding="utf-8-sig")),
                    f"页面{identity}.bindingEvidence 在非注释源码中找不到")
        require(key in enumerated, f"页面{identity}去向登记了源码中不存在的操作键：{key}")
        require(key not in displaced, f"页面{identity}操作去向重复：{key}")
        displaced[key] = item
    require(not (set(covered) & set(displaced)),
            f"页面{identity}同一操作既登记又标去向：{sorted(set(covered) & set(displaced))}")
    require(set(covered) <= set(enumerated),
            f"页面{identity}登记了源码中不存在的操作键：{sorted(set(covered) - set(enumerated))}")
    missing = [f"{key}（{enumerated[key]}）" for key in sorted(enumerated)
               if key not in covered and key not in displaced]
    require(not missing,
            f"页面{identity}有源码枚举出的业务操作未覆盖：{missing}；"
            f"请把每个键拆成独立动作写进 businessActions[].actionKeys（一个动作最多 {MAX_ACTION_KEYS} 个键）并逐键实测，"
            f"或用 displacedActions 说明它被哪个页面承接、已被替代、或本页确实没有绑定")
    rounds = records(review.get("rounds"), f"页面{identity}.rounds")
    tested = set(strings(rounds[-1].get("testedActionKeys", []),
                         f"页面{identity}.testedActionKeys", True))
    untested = sorted(set(covered) - tested)
    require(not untested,
            f"页面{identity}这些操作键没有逐键实测记录：{untested}；"
            f"请在最终轮次的 testedActionKeys 里逐个登记（不能只写动作名）")
    require(tested <= set(enumerated) | set(covered),
            f"页面{identity}.testedActionKeys 出现源码中不存在的键：{sorted(tested - set(enumerated) - set(covered))}")
    return len(enumerated)


def check_displaced_destinations(reviews):
    for identity, review in reviews.items():
        for item in review.get("displacedActions") or []:
            if item["kind"] != "otherPage":
                continue
            target = item["targetPageId"]
            require(target in reviews, f"页面{identity}的承接页面不存在：{target}")
            other = reviews[target]
            keys = {key for action in other["businessActions"] for key in action.get("actionKeys", [])}
            require(item["key"] in keys and item["key"] in other["rounds"][-1].get("testedActionKeys", []),
                    f"页面{identity}的承接页面{target}必须直接登记并在最终轮次实测{item['key']}，不能循环转交")


def check_interaction_records(path, latest, actions):
    require(path.suffix.lower() == ".json", f"交互证据必须为结构化 JSON：{path.name}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise AuditError(f"交互证据不是有效 JSON：{path.name}") from error
    require(isinstance(payload, dict), f"交互证据必须为对象：{path.name}")
    require(payload.get("revision") == latest["revision"], f"交互证据版本与最终轮次不符：{path.name}")
    require(payload.get("sourceFingerprint") == latest["sourceFingerprint"],
            f"交互证据源码指纹与最终轮次不符：{path.name}")
    keys, names = set(), set()
    for row in records(payload.get("records"), "交互证据.records"):
        name = nonempty(row.get("actionName"), "交互证据.actionName")
        require(name in actions, f"交互证据引用未知动作：{name}")
        nonempty(row.get("expected"), "交互证据.expected")
        nonempty(row.get("actual"), "交互证据.actual")
        require(row.get("result") == "passed", f"交互证据动作未通过：{name}")
        key = row.get("actionKey")
        if key is not None:
            require(key in actions[name].get("actionKeys", []), f"交互证据操作键与动作不匹配：{name}/{key}")
            keys.add(key)
        names.add(name)
    return keys, names


def check_evidence_truth(path, kind):
    if kind != "interaction" or path.suffix.lower() != ".json":
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (json.JSONDecodeError, UnicodeError) as error:
        raise AuditError(f"交互证据不是有效JSON：{path.name}") from error

    def walk(value, key=""):
        if isinstance(value, dict):
            for name, child in value.items():
                walk(child, name.lower())
        elif isinstance(value, list):
            for child in value:
                walk(child, key)
        elif isinstance(value, str):
            normalized = value.strip().lower()
            require(not any(marker in normalized for marker in ("需人工核对", "待核对", "未验证", "未测试", "无法确认")),
                    f"交互证据仍未核实：{path.name}: {value}")
            if key in {"result", "status", "verified"}:
                require(normalized not in {"失败", "fail", "failed", "blocked", "false", "unverified"},
                        f"交互证据与页面通过状态冲突：{path.name}: {value}")
        elif key in {"passed", "verified"} and value is False:
            raise AuditError(f"交互证据标记未通过：{path.name}")

    walk(payload)


def validate_audit(audit, project_root):
    root = Path(project_root).resolve()
    if not root.is_dir():
        raise NotADirectoryError("项目目录不存在或不是目录")
    require(isinstance(audit, dict) and type(audit.get("schemaVersion")) is int and audit["schemaVersion"] == 1, "需要schemaVersion=1的审查对象")
    revision = nonempty(audit.get("targetRevision"), "targetRevision")
    digests = audit.get("sourceDigests")
    require(isinstance(digests, dict), "需要sourceDigests记录验收时源码SHA256")
    checked_sources = set()

    def local_file(raw):
        nonempty(raw, "证据/源码路径")
        relative = Path(raw)
        require(not relative.is_absolute(), f"路径必须相对项目目录：{raw}")
        actual = (root / relative).resolve()
        require(actual.is_relative_to(root), f"路径不能越出项目目录：{raw}")
        require(actual.is_file() and actual.stat().st_size > 0, f"文件缺失或为空：{raw}")
        return actual

    def source(raw):
        nonempty(raw, "源码路径")
        if raw in checked_sources:
            return
        actual = local_file(raw)
        digest = digests.get(raw)
        require(isinstance(digest, str) and re.fullmatch(r"[a-f0-9]{64}", digest), f"源码缺少有效SHA256：{raw}")
        require(hashlib.sha256(actual.read_bytes()).hexdigest() == digest, f"源码已变化，旧验收失效：{raw}")
        checked_sources.add(raw)

    for path in digests:
        source(path)

    inventory = audit.get("inventory")
    require(isinstance(inventory, dict), "需要inventory菜单/页面清单")
    for path in strings(inventory.get("sourceFiles"), "inventory.sourceFiles"):
        source(path)
    menus = index_by(inventory.get("menus"), "id", "menus", True)
    pages = index_by(inventory.get("pages"), "id", "pages")
    for identity, menu in menus.items():
        role = nonempty(menu.get("role"), f"菜单{identity}.role")
        for page_id in strings(menu.get("pageIds"), f"菜单{identity}.pageIds"):
            require(page_id in pages, f"菜单{identity}引用了未登记页面：{page_id}")
            page = pages[page_id]
            require(page.get("role") == role, f"菜单{identity}遗漏或混用了角色页面：{page_id}")
            require(identity in strings(page.get("menuIds"), f"页面{page_id}.menuIds", True), f"菜单与页面映射不对称：{page_id}")
    for identity, page in pages.items():
        nonempty(page.get("role"), f"页面{identity}.role")
        nonempty(page.get("entry"), f"页面{identity}.entry")
        choice(page.get("originalForm"), {"generic-crud", "purpose-built", "mixed"}, f"页面{identity}.originalForm")
        for menu_id in strings(page.get("menuIds"), f"页面{identity}.menuIds", True):
            require(menu_id in menus and identity in menus[menu_id]["pageIds"], f"页面{identity}未映射到真实菜单：{menu_id}")
        for path in strings(page.get("sourceFiles"), f"页面{identity}.sourceFiles"):
            source(path)

    discovered_views = check_jsp_inventory(root, inventory, pages, source)
    registered_views = check_view_inventory(root, inventory, pages)
    for item in inventory.get("excludedViewFiles", []):
        source(item["path"])

    reviews = index_by(audit.get("reviews"), "pageId", "reviews")
    require(set(reviews) == set(pages), f"页面覆盖不完整；漏审={sorted(set(pages)-set(reviews))}；未知={sorted(set(reviews)-set(pages))}")
    decisions = {"optimize-list": 0, "redesign-business": 0, "refine-business": 0}
    last_round = 0
    covered_actions = 0
    for identity, review in reviews.items():
        label = f"页面{identity}"
        check_review_shape(review, label)
        decision = review.get("decision")
        choice(decision, decisions, f"{label}改造结论")
        areas = strings(review.get("changeAreas"), f"{label}.changeAreas")
        require(set(areas) <= {"visual", "information", "interaction", "workflow", "integration"}, f"{label}改造范围无效")
        if decision == "optimize-list":
            require(not review["needsWorkflow"] and review["targetForm"] == "list", f"{label}特殊业务不能仍以通用列表验收")
        elif decision == "redesign-business":
            require(review["needsWorkflow"] and review["targetForm"] not in {"list", "generic-crud"}, f"{label}业务改造必须有真实业务页面形态")
            require({"workflow", "interaction"} <= set(areas), f"{label}仅换皮不能当业务功能改造")
        else:
            require(pages[identity]["originalForm"] == "purpose-built", f"{label}不能把通用CRUD直接标成已有专用业务页")
            require(bool({"information", "interaction", "workflow"} & set(areas)), f"{label}业务页改进不能只换色")
        if pages[identity]["originalForm"] == "generic-crud" and review["needsWorkflow"]:
            require(decision == "redesign-business", f"{label}通用CRUD不适配业务时必须实施业务改造")
        decisions[decision] += 1
        for path in strings(review.get("changedFiles"), f"{label}.changedFiles"):
            source(path)
        actions = index_by(review.get("businessActions"), "name", f"{label}.businessActions")
        page_sources = set(pages[identity]["sourceFiles"]) | set(review["changedFiles"])
        for path in action_source_files(root, pages[identity], review):
            source(path)
            page_sources.add(path)
        for action in actions.values():
            nonempty(action.get("expectedResult"), f"{label}操作的业务结果")
            for path in strings(action.get("implementationFiles"), f"{label}操作的真实调用依据"):
                source(path)
                page_sources.add(path)
        covered_actions += check_action_coverage(root, identity, pages[identity], review, actions)
        states = strings(review.get("requiredStates"), f"{label}.requiredStates")
        rounds = records(review.get("rounds"), f"{label}.rounds")
        previous = 0
        open_issues = set()
        for run in rounds:
            number = run.get("round")
            require(type(number) is int and number > previous, f"{label}复查轮次必须递增")
            previous = number
            choice(run.get("status"), {"passed", "rework", "blocked"}, f"{label}复查状态")
            nonempty(run.get("revision"), f"{label}复查版本")
            resolved = strings(run.get("resolvedIssueIds"), f"{label}.resolvedIssueIds", True)
            require(set(resolved) <= open_issues, f"{label}不能虚报关闭不存在的问题")
            open_issues.difference_update(resolved)
            for issue in records(run.get("issues"), f"{label}.issues", True):
                issue_id = nonempty(issue.get("id"), f"{label}问题ID")
                nonempty(issue.get("description"), f"{label}问题证据")
                require(issue_id not in open_issues, f"{label}问题重复：{issue_id}")
                open_issues.add(issue_id)
            if run["status"] != "passed":
                require(open_issues, f"{label}返工/阻塞必须写具体问题")
            else:
                require(not open_issues, f"{label}有未解决问题的轮次不能标为通过")
        latest = rounds[-1]
        require(latest["status"] == "passed" and not open_issues, f"{label}仍有未修复或未复验问题")
        require(latest["revision"] == revision, f"{label}验收不对应最终版本")
        fingerprint_input = "\n".join(f"{path}:{digests[path]}" for path in sorted(page_sources))
        fingerprint = hashlib.sha256(fingerprint_input.encode("utf-8")).hexdigest()
        require(latest.get("sourceFingerprint") == fingerprint,
                f"{label}验收未绑定最终页面/调用源码摘要")
        verified_at = nonempty(latest.get("verifiedAt"), f"{label}最终实测时间")
        try:
            verified_time = datetime.fromisoformat(verified_at.replace("Z", "+00:00"))
        except ValueError as error:
            raise AuditError(f"{label}最终实测时间不是ISO8601") from error
        require(verified_time.tzinfo is not None, f"{label}最终实测时间必须带时区")
        latest_source_mtime = max((root / path).stat().st_mtime for path in page_sources)
        require(verified_time.timestamp() >= latest_source_mtime - 1,
                f"{label}实测时间早于最终源码修改，必须复验")
        require(verified_time <= datetime.now(timezone.utc), f"{label}实测时间不能在未来")
        nonempty(latest.get("businessFitAssessment"), f"{label}最终页面形态复审依据")
        checks = latest.get("checks")
        require(isinstance(checks, dict) and all(checks.get(key) is True for key in
                ("businessFit", "actions", "states", "layout", "permissions")), f"{label}业务/操作/状态/布局/权限检查未全部通过")
        tested_actions = strings(latest.get("actionsTested"), f"{label}.actionsTested")
        require(set(actions) <= set(tested_actions), f"{label}有业务动作未实测")
        tested_states = strings(latest.get("statesTested"), f"{label}.statesTested")
        require(set(states) <= set(tested_states), f"{label}有页面状态未实测")
        evidence_kinds = set()
        evidence_keys, evidence_actions = set(), set()
        for evidence in records(latest.get("evidence"), f"{label}.evidence"):
            kind = nonempty(evidence.get("kind"), f"{label}证据类型")
            evidence_kinds.add(kind)
            evidence_path = local_file(evidence.get("path"))
            check_evidence_truth(evidence_path, kind)
            if kind == "interaction":
                keys, names = check_interaction_records(evidence_path, latest, actions)
                evidence_keys.update(keys)
                evidence_actions.update(names)
            require(evidence_path.stat().st_mtime >= latest_source_mtime - 1,
                    f"{label}证据早于最终源码修改：{evidence.get('path')}")
            nonempty(evidence.get("summary"), f"{label}证据说明")
        require({"screenshot", "interaction", "layout"} <= evidence_kinds, f"{label}缺少真实截图/操作结果/尺寸证据")
        declared_keys = {key for action in actions.values() for key in action.get("actionKeys", [])}
        require(declared_keys <= evidence_keys, f"{label}交互证据缺少逐键预期/实际结果：{sorted(declared_keys - evidence_keys)}")
        require(set(actions) <= evidence_actions, f"{label}交互证据缺少动作结果：{sorted(set(actions) - evidence_actions)}")
        last_round = max(last_round, previous)

    check_displaced_destinations(reviews)
    entities, edges = discover_schema_entities(root)
    for path in schema_sources(root):
        source(path.relative_to(root).as_posix())
    groups = check_master_detail_groups(audit, pages, reviews, root)
    entity_count = check_entity_roles(root, audit, entities, edges, groups, source)

    sweeps = records(audit.get("sweeps"), "sweeps")
    previous = 0
    for sweep in sweeps:
        number = sweep.get("round")
        require(type(number) is int and number > previous, "全量复查轮次必须递增")
        previous = number
    final = sweeps[-1]
    require(final.get("status") == "passed" and final.get("revision") == revision, "缺少最终版本全量复查")
    require(final["round"] >= last_round, "全量复查早于最后一次页面返工")
    require(set(strings(final.get("pageIds"), "最终复查.pageIds")) == set(pages), "最终复查遗漏页面")
    local_file(final.get("inventoryEvidence"))
    return {"status": "passed", "menus": len(menus), "pages": len(pages), "discoveredViews": discovered_views, "decisions": decisions, "enumeratedActions": covered_actions, "registeredViews": registered_views, "entities": entity_count,
            "lastRound": final["round"], "scope": "仅清单、源码指纹与本地证据完整性；不证明业务合理性或网站操作已实际发生"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = validate_audit(json.loads(args.audit.read_text(encoding="utf-8-sig")), args.project_root)
    except (AuditError, json.JSONDecodeError, UnicodeError) as error:
        print(json.dumps({"status": "failed", "reason": str(error)}, ensure_ascii=False))
        return 1
    except OSError as error:
        print(json.dumps({"status": "unverified", "reason": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
