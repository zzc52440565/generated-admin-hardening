"""正式页面编排行为回归；合成证据仅测试验证器，不代表真实项目通过。"""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'skills/jiema-workbuddy/references/generated-admin-hardening/scripts'))
import page_tasks as tasks
from check_page_redesign import AuditError


def fixture(root):
    (root / 'src/views').mkdir(parents=True)
    (root / 'docs').mkdir()
    (root / 'docs/business-facts.md').write_text('实验规格：客户整单办理订单与明细，读取本人，拒绝其他客户。运营负责履约。')
    (root / 'src/views/Order.vue').write_text('<template><button @click="submitOrder">整单提交</button></template>')
    (root / 'src/rules.js').write_text('export const status = "submitted";')
    contract = {'schemaVersion': 2, 'sources': [{'id': 'facts', 'kind': 'business', 'path': 'docs/business-facts.md', 'sha256': tasks.file_hash(root, 'docs/business-facts.md')}],
        'roles': [{'id': 'customer', 'purpose': '本人下单及读取', 'sourceRefs': ['facts']}],
        'requirements': [{'id': 'order', 'description': '整单提交且只有本人可读', 'sourceRefs': ['facts']}],
        'pages': [{'role': 'customer', 'menuId': 'orders', 'pageId': 'workspace', 'title': '订单办理', 'menuLabel': '订单',
            'businessGoal': '客户完整办理主从订单', 'rationale': '订单明细随主单一起保存，不独立建项', 'layout': 'master-detail-form',
            'scaffoldGap': '两个CRUD列表应合成表头明细同页提交', 'sections': ['主单', '明细', '金额'], 'sourceRefs': ['facts'],
            'sourceFiles': ['src/views/Order.vue', 'src/rules.js'], 'requirementIds': ['order'], 'auditPageIds': ['customer.order'],
            'states': ['empty', 'submitted', 'error'], 'dependsOn': [],
            'permissions': [{'id': 'own', 'actor': 'customer', 'operation': 'read', 'outcome': 'allow', 'scope': 'self', 'expected': '本人可读', 'sourceRefs': ['facts']},
                {'id': 'other', 'actor': 'other-customer', 'operation': 'read', 'outcome': 'deny', 'scope': 'self', 'expected': '他人404且无数据', 'sourceRefs': ['facts']}],
            'actions': [{'id': 'submit', 'description': '整单提交', 'expected': '主单与明细同时创建', 'implementationFiles': ['src/views/Order.vue', 'src/rules.js']}],
            'masterDetail': [{'id': 'order-lines', 'parent': 'order', 'child': 'line', 'rationale': '明细随订单生命周期', 'writeOwner': 'OrderService', 'strategy': 'embedded', 'detailSection': '明细'}]}],
        'dispositions': []}
    tasks.write(root / tasks.CONTRACT_FILE, contract)
    tasks.write(root / 'docs/page-redesign-audit.json', {'inventory': {'pages': [{'id': 'customer.order', 'role': 'customer'}]}})
    return contract


class PageTaskTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.base = Path(self.temp.name); self.root = self.base / 'project'; self.root.mkdir()
        self.contract = fixture(self.root); self.plan = tasks.compile_plan(self.root); tasks.write(self.root / tasks.PLAN_FILE, self.plan)
        self.state = self.base / 'checkpoint/page-task-state.json'; self.task = self.plan['tasks'][0]
    def tearDown(self):
        self.temp.cleanup()
    def q(self, action, **args):
        return tasks.queue(self.root, self.state, action, args)
    def start(self):
        self.q('init'); self.q('next')
    def artifact(self, name='proof', text='合成测试原始回执'):
        path = 'docs/proof/' + name + '.txt'; tasks.write(self.root / path, {'text': text})
        return {'path': path, 'sha256': tasks.file_hash(self.root, path)}
    def implemented(self):
        self.q('implemented', note='已改成业务主从表单，记录变更清单', evidence=self.artifact('implementation'))
        self.q('next')
    def proof(self, check, ticket, status='passed', method=None):
        method = method or ('browser' if check['kind'] == 'layout' else 'http')
        path = 'docs/proof/' + hashlib.sha256(check['id'].encode()).hexdigest() + '-' + str(ticket['attempt']) + '.json'
        payload = {'schemaVersion': 1, **ticket, 'status': status, 'method': method, 'expected': check['expected'],
            'actual': '测试夹具专用回执：仅验证门禁，不代表真实业务', 'testedAt': datetime.now(timezone.utc).isoformat(), 'artifacts': [self.artifact()]}
        tasks.write(self.root / path, payload); return path
    def complete(self, check):
        ticket = self.q('begin', checkId=check['id']); path = self.proof(check, ticket)
        self.q('result', checkId=check['id'], status='passed', evidence=path)
    def seal_all(self):
        self.start(); self.implemented()
        for check in self.task['checks']:
            self.complete(check)
        self.q('finish')
    def recompile(self):
        tasks.write(self.root / tasks.CONTRACT_FILE, self.contract); self.plan = tasks.compile_plan(self.root); tasks.write(self.root / tasks.PLAN_FILE, self.plan); self.task = self.plan['tasks'][0]

    def test_one_page_owns_buttons_permissions_and_master_detail(self):
        self.assertEqual(len(self.plan['tasks']), 1)
        self.assertEqual(self.task['id'], 'page.customer.orders.workspace')
        self.assertGreater(len(self.task['checks']), 9)
        self.assertEqual(len([c for c in self.task['checks'] if c['kind'] == 'master-detail']), 4)
        self.assertEqual(self.plan['gaps'], [])
        self.assertEqual(self.plan, tasks.compile_plan(self.root))

    def test_new_route_view_and_unlinked_api_are_not_silently_lost(self):
        (self.root / 'src/views/Missing.vue').write_text('<template><button @click="forgotten">遗漏</button></template>')
        (self.root / 'src/OrderController.java').write_text('@RequestMapping("/orders") class OrderController { @GetMapping("/{id}") public Object read(){ return null; } @PostMapping("/{id}/approve") public Object approve(){return null;} }')
        (self.root / 'src/router').mkdir(); (self.root / 'src/router/index.js').write_text('const routes=[{path:"/new",component:Missing}];')
        plan = tasks.compile_plan(self.root)
        self.assertTrue({'view', 'action', 'api', 'route'} <= {g['kind'] for g in plan['gaps']})
        self.assertTrue(any('POST /orders/{id}/approve' == g['key'] for g in plan['gaps']))

    def test_unsupported_entry_style_cannot_look_like_zero_gaps(self):
        root = self.base / 'plain-js'; root.mkdir()
        (root / 'app.js').write_text('document.addEventListener("click", handleOrder);')
        inventory = tasks.scan(root)
        self.assertTrue(any(o['kind'] == 'unresolved-capability' for o in inventory['observations']))

    def test_locked_queue_and_removal_of_open_issue_are_rejected(self):
        self.start()
        lock = self.state.with_name(self.state.name + '.lock'); lock.write_text('{"pid":1}')
        with self.assertRaisesRegex(AuditError, 'QUEUE_BUSY'):
            self.q('next')
        self.assertTrue(lock.exists()); lock.unlink()
        self.q('issue', issue={'id': 'missing-owner', 'checkId': 'action.submit',
            'description': '主从归属待核对', 'evidence': self.artifact('owner')})
        self.contract['pages'][0]['actions'][0]['id'] = 'replacement'
        self.recompile()
        with self.assertRaisesRegex(AuditError, '未解决问题的检查不能删除'):
            self.q('sync')

    def test_independent_business_and_every_requirement_are_mandatory(self):
        c = deepcopy(self.contract); c['sources'][0]['kind'] = 'code'
        with self.assertRaisesRegex(AuditError, '独立业务'):
            tasks.compile_plan(self.root, c)
        c = deepcopy(self.contract); c['requirements'].append({'id': 'missing', 'description': '退款需求', 'sourceRefs': ['facts']})
        with self.assertRaisesRegex(AuditError, '未归属'):
            tasks.compile_plan(self.root, c)
        (self.root / 'docs/business-facts.md').write_text('业务事实更新')
        with self.assertRaisesRegex(AuditError, '来源变化'):
            tasks.compile_plan(self.root)

    def test_child_must_be_embedded_and_rejection_case_required(self):
        for mutate, message in [(lambda p: p.update(layout='generic-crud'), '目标形态'), (lambda p: p['masterDetail'][0].update(detailSection='独立明细页'), '同一业务页'), (lambda p: p.update(permissions=p['permissions'][:1]), '拒绝样本')]:
            c = deepcopy(self.contract); mutate(c['pages'][0])
            with self.assertRaisesRegex(AuditError, message):
                tasks.compile_plan(self.root, c)

    def test_resume_keeps_same_page_and_completed_checks(self):
        self.start(); self.implemented(); self.complete(self.task['checks'][0])
        next_page = self.q('next'); self.assertEqual(next_page['task']['id'], self.task['id'])
        self.assertEqual(next_page['pageState']['checks'][self.task['checks'][0]['id']]['status'], 'passed')
        with self.assertRaisesRegex(AuditError, '未通过'):
            self.q('finish')
        with self.assertRaisesRegex(AuditError, '已存在'):
            self.q('init')

    def test_simulation_static_wrong_expected_and_old_attempt_cannot_pass(self):
        self.start(); check = self.task['checks'][0]; ticket = self.q('begin', checkId=check['id'])
        for method in ['simulation', 'static']:
            path = self.proof(check, ticket, method=method)
            with self.assertRaisesRegex(AuditError, '不能标业务'):
                self.q('result', checkId=check['id'], status='passed', evidence=path)
        path = self.proof(check, ticket); e = tasks.read(self.root / path); e['expected'] = '自说自话'; tasks.write(self.root / path, e)
        with self.assertRaisesRegex(AuditError, '预期与业务合同'):
            self.q('result', checkId=check['id'], status='passed', evidence=path)
        e['expected'] = check['expected']; e['attempt'] = 0; tasks.write(self.root / path, e)
        with self.assertRaisesRegex(AuditError, '轮次'):
            self.q('result', checkId=check['id'], status='passed', evidence=path)

    def test_three_identical_failures_block_without_user_continue(self):
        self.start(); check = self.task['checks'][0]
        for number in range(3):
            ticket = self.q('begin', checkId=check['id']); path = self.proof(check, ticket, status='failed')
            self.q('result', checkId=check['id'], status='failed', evidence=path, code='WRONG_PERMISSION', progress='same', recovery='修复服务端归属过滤后回读同一测试账号原订单')
        self.assertEqual(self.q('status')['pages'][self.task['id']]['status'], 'blocked')
        with self.assertRaisesRegex(AuditError, '恢复当前页面'):
            self.q('begin', checkId=check['id'])
        self.q('recover', note='服务端修复有进展，回读日志已登记')

    def test_inflight_sync_preserves_identity_and_requires_readback(self):
        self.start(); check = self.task['checks'][0]; ticket = self.q('begin', checkId=check['id'])
        (self.root / 'src/rules.js').write_text('export const version = 2;'); self.recompile(); self.q('sync')
        page = self.q('next')['pageState']; self.assertEqual(page['pending']['operationKey'], ticket['operationKey'])
        receipt = {'method': 'http', 'operationKey': ticket['operationKey'], 'outcome': 'applied'}
        tasks.write(self.root / 'docs/readback.json', receipt)
        self.q('reconcile', operationKey=ticket['operationKey'], outcome='applied', evidence={'path': 'docs/readback.json', 'sha256': tasks.file_hash(self.root, 'docs/readback.json')})
        new = self.q('begin', checkId=check['id']); self.assertEqual(new['operationKey'], ticket['operationKey']); self.assertEqual(new['execution'], 'readback-before-any-write')

    def test_repair_does_not_complete_and_sync_keeps_open_issues(self):
        self.seal_all(); check = self.task['checks'][0]
        self.q('issue', taskId=self.task['id'], issue={'id': 'gap', 'checkId': check['id'], 'description': '新发现权限错误', 'evidence': self.artifact('issue')})
        self.q('next'); self.q('repair', issueId='gap', note='修复服务端过滤', changeDigest='fixed')
        with self.assertRaisesRegex(AuditError, '未通过'):
            self.q('finish')
        self.contract['pages'][0]['rationale'] += '补充业务依据'; self.recompile(); self.q('sync')
        page = self.q('next')['pageState']; self.assertEqual(page['issues'][0]['status'], 'open'); self.assertNotIn('repair', page['issues'][0])

    def test_data_rebuild_invalidates_plan_without_recreating_task(self):
        identity = self.task['id']; old = self.task['fingerprint']
        tasks.write(self.root / 'docs/seed-data-spec.json', {'dataVersion': 'new-seed'})
        with self.assertRaisesRegex(AuditError, 'STALE'):
            tasks.current_plan(self.root)
        self.recompile(); self.assertEqual(self.task['id'], identity); self.assertNotEqual(self.task['fingerprint'], old)

    def test_final_report_checks_files_roles_and_complete_coverage(self):
        self.seal_all(); result = tasks.verify_plan(self.root, self.state)
        self.assertTrue(result['valid']); self.assertEqual(result['businessStatus'], 'unverified-by-validator')
        self.assertEqual(tasks.main(['report', '--project-root', str(self.root), '--state', str(self.state)]), 0)
        self.assertTrue(tasks.verify_plan(self.root)['valid'])
        (self.root / 'docs/proof/proof.txt').write_text('篡改原始回执')
        with self.assertRaisesRegex(AuditError, '回执文件变化'):
            tasks.verify_plan(self.root)

    def test_plan_file_cannot_be_hand_edited_to_drop_checks(self):
        plan = deepcopy(self.plan); plan['tasks'][0]['checks'] = []; tasks.write(self.root / tasks.PLAN_FILE, plan)
        with self.assertRaisesRegex(AuditError, 'STALE'):
            tasks.current_plan(self.root)

    def test_state_in_project_and_symlink_escape_rejected(self):
        with self.assertRaisesRegex(AuditError, '项目外'):
            tasks.queue(self.root, self.root / 'state.json', 'init')
        external = self.base / 'outside.txt'; external.write_text('outside')
        (self.root / 'src/external.js').symlink_to(external)
        with self.assertRaises(AuditError):
            tasks.compile_plan(self.root)

    def test_implemented_next_moves_to_other_page_before_acceptance(self):
        second = deepcopy(self.contract['pages'][0]); second.update(pageId='tracking', menuId='mine', auditPageIds=['customer.tracking'])
        self.contract['pages'].append(second); self.recompile(); self.start(); self.q('implemented', note='页面实现已完成', evidence=self.artifact('impl'))
        self.assertEqual(self.q('next')['task']['pageId'], 'tracking')

    def test_explicit_scope_dependencies_cycle_rejected(self):
        second = deepcopy(self.contract['pages'][0]); second.update(pageId='tracking', menuId='mine', auditPageIds=['customer.tracking'], dependsOn=[self.task['id']])
        self.contract['pages'][0]['dependsOn'] = ['page.customer.mine.tracking']; self.contract['pages'].append(second)
        with self.assertRaisesRegex(AuditError, '成环'):
            tasks.compile_plan(self.root, self.contract)


if __name__ == '__main__':
    unittest.main()
