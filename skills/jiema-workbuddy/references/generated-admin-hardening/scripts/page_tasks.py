"""按角色/目标菜单/业务页面编译和续跑；只校验证据一致性，不认证实测发生。"""
import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.dont_write_bytecode = True

from check_page_redesign import (AuditError, require, nonempty, strings, records, index_by,
    local_path, project_files, discover_view_files, enumerate_action_keys, strip_comments,
    java_mappings, mapping_paths)

PLAN_FILE = 'docs/page-task-plan.json'
CONTRACT_FILE = 'docs/page-business-plan.json'
RESULT_FILE = 'docs/page-task-results.json'
SOURCE_SUFFIXES = {'.vue', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.java', '.cs', '.jsp', '.html', '.wxml', '.wxss', '.css', '.scss', '.sql', '.xml', '.json', '.yaml', '.yml', '.properties', '.gradle', '.py'}
METHODS = {'browser', 'native-client', 'http', 'database', 'test-run', 'static', 'simulation'}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def file_hash(root, name):
    return hashlib.sha256(local_path(root, name).read_bytes()).hexdigest()


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        with temporary.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def scan(root):
    """复用审计器的静态发现；不从当前权限推导应有权限，不将未知语法当空集合。"""
    root = Path(root).resolve()
    sources, observations, gaps = {}, {}, []
    views = discover_view_files(root)
    def add(kind, file, key):
        identity = kind + ':' + digest([file, key])[:20]
        observations[identity] = {'id': identity, 'kind': kind, 'file': file, 'key': key}
    for path in project_files(root):
        name = path.relative_to(root).as_posix()
        if name.startswith(('docs/', 'test/', 'tests/', '.trellis/', '.codex/')) or path.suffix.lower() not in SOURCE_SUFFIXES:
            continue
        sources[name] = file_hash(root, name)
        body = strip_comments(local_path(root, name).read_text(encoding='utf-8-sig', errors='replace'))
        if name in views:
            add('view', name, name)
        if path.suffix.lower() in {'.vue', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.html', '.jsp', '.wxml', '.java', '.cs'}:
            keys, unknown = enumerate_action_keys(root, {'sourceFiles': [name]}, {}, source_files=[name])
            for key, location in keys.items():
                source = location.rsplit(':', 1)[0]
                add('action', source, key)
            for location in unknown:
                file, line = location.rsplit(':', 1)
                add('unresolved-action', file, 'line:' + line)
        if re.search(r'/(?:router|routes)/|(?:router|routes)\.[cm]?[jt]s$', '/' + name):
            for match in re.finditer(r'''\bpath\s*:\s*(['"])(.*?)\1''', body):
                add('route', name, match.group(2))
            for match in re.finditer(r'''\bpath\s*:\s*(?!['"\s])([^,\n}]+)''', body):
                add('unresolved-route', name, match.group(1).strip())
        if path.name.endswith('Controller.java'):
            cls = re.search(r'\bclass\s+\w+', body)
            if not cls:
                add('unresolved-api', name, 'class'); continue
            mappings = list(java_mappings(body))
            base = [m for m in mappings if m[0] < cls.start()]
            try:
                prefixes = mapping_paths(base[-1][3]) if base else ['']
                for start, end, kind, args in mappings:
                    if start < cls.end():
                        continue
                    methods = re.findall(r'RequestMethod\.(\w+)', args) if kind == 'Request' else [kind.upper()]
                    methods = methods or ['ANY']
                    for prefix in prefixes:
                        for suffix in mapping_paths(args):
                            route = '/' + '/'.join(x.strip('/') for x in (prefix, suffix) if x.strip('/'))
                            for method in methods:
                                add('api', name, method + ' ' + route)
            except AuditError:
                add('unresolved-api', name, 'mapping')
    require(sources, '项目没有可扫描源码；不得以空清单证明覆盖')
    for file in views:
        if file not in sources:
            add('view', file, file)
    if not observations:
        add('unresolved-capability', sorted(sources)[0],
            '未识别任何支持的入口；需以源码与真实界面清单核对框架、路由和程序化事件')
    result = {'schemaVersion': 1, 'sourceDigests': dict(sorted(sources.items())),
              'observations': sorted(observations.values(), key=lambda x: x['id']), 'gaps': gaps,
              'scope': '静态候选；角色/动态菜单/运行入口和实际权限必须与业务依据及真实界面对账',
              'businessStatus': 'unverified'}
    return {**result, 'inventoryDigest': digest(result)}


def task_id(page):
    for key in ('role', 'menuId', 'pageId'):
        require(re.fullmatch(r'[a-zA-Z0-9_-]+', page.get(key, '')), key + '须为稳定字母数字ID')
    return 'page.' + '.'.join(page[key] for key in ('role', 'menuId', 'pageId'))


def compile_plan(root, contract=None):
    root = Path(root).resolve()
    contract = contract if contract is not None else read(root / CONTRACT_FILE)
    require(contract.get('schemaVersion') == 2, 'page-business-plan需要schemaVersion=2；旧报告保留为历史，不追认验收')
    sources = index_by(contract.get('sources'), 'id', 'sources')
    for source in sources.values():
        require(source.get('kind') in {'business', 'design', 'code'}, '来源kind须business/design/code')
        require(file_hash(root, source['path']) == source.get('sha256'), '业务来源变化：' + source['id'])
    require(any(s['kind'] == 'business' for s in sources.values()), '缺独立业务事实来源，不能只用当前源码当预期')
    def refs(value):
        values = strings(value, 'sourceRefs')
        require(set(values) <= sources.keys(), 'sourceRefs引用不存在')
        return values
    requirements = index_by(contract.get('requirements'), 'id', 'requirements')
    for requirement in requirements.values():
        nonempty(requirement.get('description'), '业务需求description'); refs(requirement.get('sourceRefs'))
        require(any(sources[r]['kind'] == 'business' for r in requirement['sourceRefs']), '需求必须引用独立业务来源')
    inventory = scan(root)
    tasks, assigned, gaps, audit_ids = [], set(), [], set()
    pages = records(contract.get('pages'), 'pages')
    roles = index_by(contract.get('roles'), 'id', 'roles')
    for role in roles.values():
        refs(role.get('sourceRefs')); nonempty(role.get('purpose'), '角色purpose')
    all_ids = {task_id(p) for p in pages}
    require(len(all_ids) == len(pages), '重复角色/菜单/业务页面')
    for page in pages:
        identity = task_id(page)
        require(page['role'] in roles, '页面角色未在业务角色清单登记')
        refs(page.get('sourceRefs'))
        for field in ('title', 'menuLabel', 'businessGoal', 'rationale', 'layout', 'scaffoldGap'):
            nonempty(page.get(field), field)
        require(page['layout'] != 'generic-crud', '须按业务判断目标形态；合理列表可用list并给依据')
        sections = strings(page.get('sections'), 'sections')
        for path in strings(page.get('sourceFiles'), 'sourceFiles'):
            file_hash(root, path)
        page_audit = strings(page.get('auditPageIds'), 'auditPageIds')
        require(not audit_ids.intersection(page_audit), '审计页面不得重复归属多个任务')
        audit_ids.update(page_audit)
        required = strings(page.get('requirementIds'), 'requirementIds')
        require(set(required) <= requirements.keys(), '页面引用不存在的业务需求')
        checks = [{'id': 'business.' + key, 'kind': 'business', 'expected': requirements[key]['description']} for key in required]
        checks += [{'id': 'layout', 'kind': 'layout', 'expected': page['layout'] + '：' + '、'.join(sections)},
                   {'id': 'states', 'kind': 'states', 'expected': '、'.join(strings(page.get('states'), 'states'))}]
        for permission in records(page.get('permissions'), 'permissions'):
            require(permission.get('outcome') in {'allow', 'deny'}, '权限须明确allow/deny')
            for key in ('id', 'actor', 'operation', 'scope', 'expected'):
                nonempty(permission.get(key), 'permission.' + key)
            refs(permission.get('sourceRefs'))
            checks.append({'id': 'permission.' + permission['id'], **{k: v for k, v in permission.items() if k not in {'id', 'kind'}}, 'kind': 'permission'})
        require(any(p['outcome'] == 'deny' for p in page['permissions']), '每页须有无权/跨用户/字段/直达拒绝样本')
        for action in records(page.get('actions'), 'actions'):
            for key in ('id', 'description', 'expected'):
                nonempty(action.get(key), 'action.' + key)
            for path in strings(action.get('implementationFiles'), 'implementationFiles'):
                file_hash(root, path)
            checks.append({'id': 'action.' + action['id'], **{k: v for k, v in action.items() if k not in {'id', 'kind'}}, 'kind': 'action'})
        for group in records(page.get('masterDetail', []), 'masterDetail', True):
            for key in ('id', 'parent', 'child', 'rationale', 'writeOwner'):
                nonempty(group.get(key), 'masterDetail.' + key)
            require(group.get('detailSection') in sections, '主从明细必须在同一业务页区域内')
            require(group.get('strategy') == 'embedded', '主从不能拆两个独立CRUD任务')
            for check in ('ownership', 'atomicity', 'server-values', 'state-guard'):
                checks.append({'id': 'aggregate.' + group['id'] + '.' + check, 'kind': 'master-detail', 'expected': group['parent'] + '/' + group['child'] + ' ' + check})
        observed = []
        for observation in inventory['observations']:
            if observation['file'] in page['sourceFiles'] or any(observation['file'] in a['implementationFiles'] for a in page['actions']):
                observed.append(observation['id']); assigned.add(observation['id'])
                checks.append({'id': 'source.' + observation['id'], 'kind': 'source-observation', 'expected': observation['key'], 'observation': observation})
        require(len({c['id'] for c in checks}) == len(checks), '页内检查ID重复')
        deps = strings(page.get('dependsOn', []), 'dependsOn', True)
        require(set(deps) <= all_ids and identity not in deps, '页面依赖不存在或依赖自己')
        task = {**page, 'id': identity, 'kind': 'business-page', 'checks': checks, 'observations': observed, 'dependsOn': deps}
        tasks.append(task)
    require(set(roles) == {t['role'] for t in tasks}, '业务角色有遗漏页面')
    covered_requirements = {key for t in tasks for key in t['requirementIds']}
    require(covered_requirements == set(requirements), '存在未归属页面的真实业务需求')
    dispositions = index_by(contract.get('dispositions', []), 'observationId', 'dispositions', True)
    for observation in inventory['observations']:
        disposition = dispositions.get(observation['id'])
        if disposition:
            require(disposition.get('decision') in {'retired', 'fragment', 'resolved'}, '未知源码处置类型')
            nonempty(disposition.get('reason'), '源码处置reason'); refs(disposition.get('sourceRefs'))
            require(file_hash(root, disposition['evidence']['path']) == disposition['evidence'].get('sha256'), '源码处置证据变化')
            assigned.add(observation['id'])
        if observation['id'] not in assigned or observation['kind'].startswith('unresolved') and not disposition:
            gaps.append(observation)
    require(set(dispositions) <= {o['id'] for o in inventory['observations']}, '源码处置已过期，重新扫描后核对')
    done = set()
    while len(done) < len(tasks):
        ready = [t for t in tasks if t['id'] not in done and set(t['dependsOn']) <= done]
        require(ready, '页面依赖成环；跨页业务往返放页内场景，不把页面互相锁死')
        done.update(t['id'] for t in ready)
    data = read(root / 'docs/seed-data-spec.json') if (root / 'docs/seed-data-spec.json').is_file() else {}
    objects = read(root / 'docs/sql-object-inventory.json') if (root / 'docs/sql-object-inventory.json').is_file() else {}
    binding = {'dataVersion': data.get('dataVersion'), 'objectsVersion': objects.get('objectsVersion'),
               'dataDigest': digest(data), 'objectsDigest': digest(objects)}
    for task in tasks:
        task['fingerprint'] = digest({'task': task, 'inventoryDigest': inventory['inventoryDigest'], 'sources': sources, 'binding': binding})
    plan = {'schemaVersion': 1, 'taskUnit': 'role-menu-business-page', 'contractDigest': digest(contract),
            'inventoryDigest': inventory['inventoryDigest'], 'sourceDigests': inventory['sourceDigests'],
            'binding': binding, 'tasks': tasks, 'gaps': gaps, 'businessStatus': 'unverified',
            'summary': {'pageTasks': len(tasks), 'internalChecks': sum(len(t['checks']) for t in tasks),
                        'observations': len(inventory['observations']), 'mapped': len(assigned)}}
    return {**plan, 'planDigest': digest(plan)}


def current_plan(root):
    plan = read(Path(root) / PLAN_FILE)
    require(plan == compile_plan(root), 'PAGE_PLAN_STALE：源码/事实/数据变化，compile后sync；不能沿用旧验收')
    return plan


def new_page(task, run):
    return {'fingerprint': task['fingerprint'], 'status': 'pending', 'implemented': False, 'issues': [],
            'checks': {c['id']: {'status': 'unverified', 'operationKey': digest([run, task['id'], c['id']]), 'attempt': 0} for c in task['checks']}}


def verify_evidence(root, task, check, path, result, ticket=None, plan=None):
    evidence = read(local_path(root, path))
    require(evidence.get('schemaVersion') == 1, '证据schemaVersion须1')
    require(evidence.get('taskId') == task['id'] and evidence.get('checkId') == check and evidence.get('fingerprint') == task['fingerprint'], '证据绑定的页面/检查/源码版本不符')
    require(evidence.get('status') == result and result in {'passed', 'failed', 'unverified'}, '证据结果不一致')
    require(evidence.get('method') in METHODS, '证据method不支持')
    if result == 'passed':
        require(evidence['method'] not in {'static', 'simulation'}, '静态/模拟不能标业务passed')
        expected_method = next(c['kind'] for c in task['checks'] if c['id'] == check)
        if expected_method == 'layout':
            require(evidence['method'] in {'browser', 'native-client'}, '布局必须浏览器或目标原生客户端实测')
    for key in ('expected', 'actual'):
        nonempty(evidence.get(key), '证据' + key)
    if ticket:
        require(evidence.get('operationKey') == ticket['operationKey'] and evidence.get('attempt') == ticket['attempt'], '证据不属于当前请求/复测轮次')
    try:
        tested = datetime.fromisoformat(evidence['testedAt'].replace('Z', '+00:00'))
        require(tested.tzinfo is not None and tested.timestamp() <= datetime.now(timezone.utc).timestamp() + 1, '证据时间无效')
    except (ValueError, KeyError, TypeError) as error:
        raise AuditError('证据testedAt须带时区ISO8601') from error
    latest_source = max((local_path(root, name).stat().st_mtime for name in (plan or current_plan(root))['sourceDigests']), default=0)
    require(tested.timestamp() >= latest_source - 0.001, '证据早于当前源码，必须复测')
    if ticket and ticket.get('startedAt'):
        require(tested.timestamp() >= datetime.fromisoformat(ticket['startedAt']).timestamp(), '证据早于本次复测')
    expected = next(c['expected'] for c in task['checks'] if c['id'] == check)
    require(evidence['expected'] == expected, '证据预期与业务合同不一致')
    for artifact in records(evidence.get('artifacts'), '证据artifacts'):
        require(file_hash(root, artifact['path']) == artifact.get('sha256'), '实际回执文件变化')
    return {'path': path, 'sha256': file_hash(root, path), 'status': result, 'attempt': evidence.get('attempt'), 'method': evidence['method']}


def validate_state(plan, state):
    require(state.get('schemaVersion') == 1 and state.get('planDigest') == plan['planDigest'], 'PAGE_STATE_STALE：先sync，不重新init')
    require(set(state.get('pages', {})) == {t['id'] for t in plan['tasks']}, '页面队列覆盖不一致')
    for task in plan['tasks']:
        page = state['pages'][task['id']]
        require(page.get('fingerprint') == task['fingerprint'], '页面状态指纹变化')
        require(set(page.get('checks', {})) == {c['id'] for c in task['checks']}, '页面内部检查遗漏')


def queue(root, state_path, action, args=None):
    args = args or {}; root = Path(root).resolve(); state_path = Path(state_path).resolve()
    require(not state_path.is_relative_to(root), '可变页内状态必须在项目外，避免污染最终源码绑定')
    plan = current_plan(root)
    if action == 'status':
        state = read(state_path); validate_state(plan, state); return state
    state_path.parent.mkdir(parents=True, exist_ok=True)
    lock = state_path.with_name(state_path.name + '.lock')
    try:
        handle = lock.open('x'); handle.write(json.dumps({'pid': os.getpid(), 'state': str(state_path)})); handle.close()
    except FileExistsError as error:
        raise AuditError('QUEUE_BUSY：核对锁内PID；不得删除仍在用或无归属的锁') from error
    try:
        if action == 'init':
            require(not state_path.exists(), '状态已存在，请status/next续跑')
            run = uuid.uuid4().hex
            state = {'schemaVersion': 1, 'runId': run, 'planDigest': plan['planDigest'], 'activePage': None,
                     'pages': {t['id']: new_page(t, run) for t in plan['tasks']}, 'history': []}
            write(state_path, state); return {'pageTasks': len(plan['tasks']), 'state': str(state_path)}
        state = read(state_path)
        if action == 'sync':
            require(state.get('schemaVersion') == 1, '未知旧队列格式，不追认结果')
            ids = {t['id'] for t in plan['tasks']}
            for identity, old in state['pages'].items():
                require(identity in ids or not (old.get('cursor') or old.get('pending') or any(i['status'] == 'open' for i in old['issues'])), '退役页面须先核实在途请求并处置问题')
            changed = []
            for task in plan['tasks']:
                old = state['pages'].get(task['id'])
                if old and old['fingerprint'] == task['fingerprint']:
                    continue
                fresh = new_page(task, state['runId']); changed.append(task['id'])
                if old:
                    for key in fresh['checks']:
                        if key in old['checks']:
                            prior = old['checks'][key]
                            fresh['checks'][key]['operationKey'] = prior['operationKey']
                            fresh['checks'][key]['attempt'] = prior['attempt']
                            if prior.get('evidence') or prior.get('reconciled'):
                                fresh['checks'][key]['reconciled'] = 'readback-required'
                    state['history'].append({'event': 'invalidate', 'taskId': task['id'], 'previous': old})
                    for issue in old['issues']:
                        if issue['status'] == 'open':
                            require(issue['checkId'] in fresh['checks'], '未解决问题的检查不能删除')
                            fresh['issues'].append({k: v for k, v in issue.items() if k != 'repair'})
                    pending = old.get('pending') or ({'checkId': old['cursor'], **old['checks'][old['cursor']]} if old.get('cursor') else None)
                    if pending:
                        fresh['pending'] = pending; fresh['status'] = 'blocked'
                state['pages'][task['id']] = fresh
            for identity in list(state['pages']):
                if identity not in ids:
                    state['history'].append({'event': 'retire', 'taskId': identity, 'previous': state['pages'].pop(identity)})
            if state['activePage'] not in ids:
                state['activePage'] = None
            state['planDigest'] = plan['planDigest']; write(state_path, state); return {'changed': changed, 'preservedBusinessIdentity': True}
        validate_state(plan, state)
        if action == 'next':
            task = next((t for t in plan['tasks'] if t['id'] == state['activePage']), None)
            if task is None:
                candidates = [t for t in plan['tasks'] if state['pages'][t['id']]['status'] != 'passed' and all(state['pages'][d]['implemented'] for d in t['dependsOn'])]
                task = next((t for t in candidates if not state['pages'][t['id']]['implemented']), candidates[0] if candidates else None)
            if task is None:
                return {'status': 'no-ready-page', 'gaps': plan['gaps']}
            state['activePage'] = task['id']; page = state['pages'][task['id']]
            write(state_path, state)
            return {'task': task, 'pageState': page, 'gaps': plan['gaps'], 'next': '继续当前页面内部检查；不新增按钮任务'}
        task = next((t for t in plan['tasks'] if t['id'] == args.get('taskId', state['activePage'])), None)
        require(task is not None, '未知页面taskId'); page = state['pages'][task['id']]
        if action == 'implemented':
            require(not page.get('cursor') and not page.get('pending'), '先核实在途请求')
            nonempty(args.get('note'), '具体实施说明')
            require(file_hash(root, args['evidence']['path']) == args['evidence'].get('sha256'), '实施证据变化')
            page['implemented'] = True; page['implementation'] = args; page['status'] = 'unverified'
            state['activePage'] = None
        elif action == 'begin':
            require(state['activePage'] == task['id'] and not page.get('cursor') and not page.get('pending') and page['status'] != 'blocked', '先恢复当前页面或核实原请求')
            check = args.get('checkId'); require(check in page['checks'], '检查不属于此页')
            ticket = page['checks'][check]; require(ticket['status'] != 'passed', '检查已通过，不重复执行')
            ticket['attempt'] += 1; ticket['startedAt'] = datetime.now(timezone.utc).isoformat(); ticket['status'] = 'in_progress'; page['cursor'] = check
            write(state_path, state)
            return {'taskId': task['id'], 'checkId': check, 'fingerprint': task['fingerprint'], 'operationKey': ticket['operationKey'], 'attempt': ticket['attempt'], 'execution': 'readback-before-any-write' if ticket.get('reconciled') or ticket['attempt'] > 1 else 'execute-authorized-check'}
        elif action == 'result':
            check = args.get('checkId'); require(page.get('cursor') == check, '检查游标不一致')
            result = args.get('status'); ticket = page['checks'][check]
            ref = verify_evidence(root, task, check, args['evidence'], result, ticket, plan)
            ticket['status'] = result; ticket['evidence'] = ref; page.pop('cursor')
            if result == 'passed':
                for issue in page['issues']:
                    if issue['checkId'] == check and issue.get('repair'):
                        issue['status'] = 'resolved'
                page['status'] = 'in_progress'
            else:
                recovery = nonempty(args.get('recovery'), '失败或未验证须精确recovery')
                failure_key = digest([check, args.get('code'), args.get('progress')])
                page['failures'] = page.get('failures', {})
                page['failures'][failure_key] = page['failures'].get(failure_key, 0) + 1
                page['status'] = 'blocked' if page['failures'][failure_key] >= 3 else result
                page['recovery'] = recovery
        elif action == 'issue':
            issue = args['issue']; require(issue.get('checkId') in page['checks'], '问题须归原页面检查')
            for field in ('id', 'description'):
                nonempty(issue.get(field), 'issue.' + field)
            require(file_hash(root, issue['evidence']['path']) == issue['evidence'].get('sha256'), '问题证据变化')
            old = next((i for i in page['issues'] if i['id'] == issue['id']), None)
            if old and old['status'] == 'open':
                return {'status': 'already-recorded', 'taskId': task['id']}
            if old:
                state['history'].append({'event': 'reopen', 'issue': old}); page['issues'].remove(old)
            page['issues'].append({**issue, 'status': 'open'}); page['checks'][issue['checkId']]['status'] = 'unverified'; page['status'] = 'unverified'
        elif action == 'repair':
            issue = next((i for i in page['issues'] if i['id'] == args.get('issueId') and i['status'] == 'open'), None)
            require(issue is not None, '未知未解决问题')
            nonempty(args.get('note'), '修复说明'); nonempty(args.get('changeDigest'), '改动摘要')
            issue['repair'] = args; page['checks'][issue['checkId']]['status'] = 'unverified'
        elif action == 'recover':
            if page.get('cursor'):
                check = page.pop('cursor'); page['pending'] = {'checkId': check, **page['checks'][check]}
            if page.get('pending'):
                page['status'] = 'blocked'
            else:
                nonempty(args.get('note'), '恢复需实际进展说明')
                page['status'] = 'unverified'; page['failures'] = {}
        elif action == 'reconcile':
            pending = page.get('pending'); require(pending and args.get('operationKey') == pending['operationKey'], '须核实原operationKey')
            require(args.get('outcome') in {'applied', 'not-applied'}, '核实结果须applied/not-applied')
            ref = args['evidence']; require(file_hash(root, ref['path']) == ref.get('sha256'), '回读证据变化')
            receipt = read(local_path(root, ref['path']))
            require(receipt.get('operationKey') == pending['operationKey'] and receipt.get('outcome') == args['outcome'] and receipt.get('method') in {'http', 'database', 'browser', 'native-client'}, '必须真实回读原请求结果')
            state['history'].append({'event': 'reconcile', 'taskId': task['id'], 'pending': pending, 'receipt': ref, 'outcome': args['outcome']})
            check = page['checks'].get(pending['checkId'])
            if check:
                check['status'] = 'unverified'; check['reconciled'] = args['outcome']
            page.pop('pending'); page['status'] = 'unverified'
        elif action == 'finish':
            require(state['activePage'] == task['id'], '只能完成当前页面')
            require(page['implemented'] and not page.get('cursor') and not page.get('pending'), '页面尚未实施或有未决请求')
            require(all(c['status'] == 'passed' for c in page['checks'].values()) and all(i['status'] == 'resolved' for i in page['issues']), '页面还有未通过检查或未复验问题')
            page['status'] = 'passed'; state['activePage'] = None
        else:
            raise AuditError('未知队列动作')
        state['history'].append({'event': action, 'taskId': task['id'], 'at': datetime.now(timezone.utc).isoformat()})
        write(state_path, state)
        return {'taskId': task['id'], 'pageState': page, 'businessStatus': '仅记录者的实测声明，须结合原始回执审查'}
    finally:
        lock.unlink()


def verify_plan(root, state_path=None, phase='complete'):
    root = Path(root).resolve(); plan = current_plan(root)
    require(not plan['gaps'], '页面覆盖有未处置源码缺口：' + str(len(plan['gaps'])))
    if phase == 'plan':
        return {'valid': True, 'businessStatus': 'unverified', **plan['summary']}
    state = read(state_path) if state_path else read(root / RESULT_FILE)['state']
    validate_state(plan, state)
    for task in plan['tasks']:
        page = state['pages'][task['id']]
        require(page.get('implemented'), '页面未实施：' + task['id'])
        require(not page.get('cursor') and not page.get('pending'), '页面有在途请求须先核实')
        evidence = page['implementation']['evidence']
        require(file_hash(root, evidence['path']) == evidence.get('sha256'), '实施证据变化')
        if phase == 'implemented':
            continue
        require(page['status'] == 'passed' and not page.get('cursor') and not page.get('pending'), '页面未完成：' + task['id'])
        require(all(i['status'] == 'resolved' for i in page['issues']), '页面问题未闭环')
        for check, ticket in page['checks'].items():
            require(ticket['status'] == 'passed', '页内检查未通过：' + check)
            ref = ticket.get('evidence', {})
            require(file_hash(root, ref['path']) == ref.get('sha256'), '检查回执被修改')
            verify_evidence(root, task, check, ref['path'], 'passed', ticket, plan)
    if phase == 'complete':
        audit = read(root / 'docs/page-redesign-audit.json')
        audit_pages = index_by(audit['inventory']['pages'], 'id', 'audit.pages')
        require({i for t in plan['tasks'] for i in t['auditPageIds']} == set(audit_pages), '页面任务与最终审计覆盖不一致')
        for task in plan['tasks']:
            require(all(audit_pages[i]['role'] == task['role'] for i in task['auditPageIds']), '页面任务与审计角色不一致')
        if not state_path:
            report = read(root / RESULT_FILE)
            require(report.get('planDigest') == plan['planDigest'] and report.get('dataBinding') == plan['binding'], '最终页面报告绑定失效')
    return {'valid': True, 'evidenceConsistency': 'passed', 'businessStatus': 'unverified-by-validator', **plan['summary']}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['scan', 'compile', 'verify', 'report', 'init', 'status', 'next', 'implemented', 'begin', 'result', 'issue', 'repair', 'recover', 'reconcile', 'sync', 'finish'])
    parser.add_argument('--project-root', required=True, type=Path)
    parser.add_argument('--state', type=Path)
    parser.add_argument('--args', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--phase', choices=['plan', 'implemented', 'complete'], default='complete')
    opts = parser.parse_args(argv); root = opts.project_root.resolve()
    try:
        if opts.action == 'scan':
            result = scan(root)
            if opts.output:
                write(opts.output, result)
        elif opts.action == 'compile':
            result = compile_plan(root); write(root / PLAN_FILE, result)
        elif opts.action == 'verify':
            result = verify_plan(root, opts.state, opts.phase)
        elif opts.action == 'report':
            require(opts.state is not None, 'report需要项目外--state')
            result = verify_plan(root, opts.state)
            plan = current_plan(root)
            write(root / RESULT_FILE, {'schemaVersion': 1, 'planDigest': plan['planDigest'], 'dataBinding': plan['binding'], 'state': read(opts.state), 'validation': result})
        else:
            require(opts.state is not None, '队列需要项目外--state')
            result = queue(root, opts.state, opts.action, read(opts.args) if opts.args else {})
        print(json.dumps(result, ensure_ascii=False)); return 0
    except (AuditError, OSError, ValueError, KeyError, TypeError) as error:
        print(json.dumps({'valid': False, 'status': 'unverified', 'reason': str(error)}, ensure_ascii=False)); return 2


if __name__ == '__main__':
    sys.exit(main())
