"""检查逐页业务改造清单及证据完整性；不访问网站，也不代替业务实测。"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


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

    reviews = index_by(audit.get("reviews"), "pageId", "reviews")
    require(set(reviews) == set(pages), f"页面覆盖不完整；漏审={sorted(set(pages)-set(reviews))}；未知={sorted(set(reviews)-set(pages))}")
    decisions = {"optimize-list": 0, "redesign-business": 0, "refine-business": 0}
    last_round = 0
    for identity, review in reviews.items():
        label = f"页面{identity}"
        for field in ("businessGoal", "rationale", "targetForm"):
            nonempty(review.get(field), f"{label}.{field}")
        require(isinstance(review.get("needsWorkflow"), bool), f"{label}必须明确通用CRUD是否不适配业务")
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
        for action in actions.values():
            nonempty(action.get("expectedResult"), f"{label}操作的业务结果")
            for path in strings(action.get("implementationFiles"), f"{label}操作的真实调用依据"):
                source(path)
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
        nonempty(latest.get("businessFitAssessment"), f"{label}最终页面形态复审依据")
        checks = latest.get("checks")
        require(isinstance(checks, dict) and all(checks.get(key) is True for key in
                ("businessFit", "actions", "states", "layout", "permissions")), f"{label}业务/操作/状态/布局/权限检查未全部通过")
        tested_actions = strings(latest.get("actionsTested"), f"{label}.actionsTested")
        require(set(actions) <= set(tested_actions), f"{label}有业务动作未实测")
        tested_states = strings(latest.get("statesTested"), f"{label}.statesTested")
        require(set(states) <= set(tested_states), f"{label}有页面状态未实测")
        evidence_kinds = set()
        for evidence in records(latest.get("evidence"), f"{label}.evidence"):
            evidence_kinds.add(nonempty(evidence.get("kind"), f"{label}证据类型"))
            local_file(evidence.get("path"))
            nonempty(evidence.get("summary"), f"{label}证据说明")
        require({"screenshot", "interaction", "layout"} <= evidence_kinds, f"{label}缺少真实截图/操作结果/尺寸证据")
        last_round = max(last_round, previous)

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
    return {"status": "passed", "menus": len(menus), "pages": len(pages), "decisions": decisions,
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
