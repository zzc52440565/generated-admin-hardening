"""仅用合成文件验证检查器行为；不是浏览器/业务验收。"""
import copy
from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'skills/generated-admin-hardening/scripts/check_page_redesign.py'
spec = importlib.util.spec_from_file_location('check_page_redesign', SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class PageRedesignTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='page-redesign-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'project'
        self.root.mkdir()
        sources = ['src/routes.ts', 'src/order.ts', 'src/order-service.ts', 'src/customer.ts', 'src/shared.css']
        for name in sources:
            self.write(name, 'synthetic test source: ' + name)
        evidence = [('screenshot', 'screen.png'), ('interaction', 'actions.json'), ('layout', 'layout.json')]
        for _, name in evidence:
            self.write('docs/audit/' + name, 'synthetic evidence; not a browser result')
        self.write('docs/audit/inventory.md', 'synthetic final enumeration')
        pages = []
        menus = []
        reviews = []
        for name, workflow in [('orders', True), ('customers', False)]:
            page_id = 'operator.' + name
            source = 'src/order.ts' if workflow else 'src/customer.ts'
            actions = [{'name': '提交单据' if workflow else '筛选客户',
                        'implementationFiles': [source, 'src/order-service.ts'] if workflow else [source],
                        'expectedResult': '真实业务结果'}]
            pages.append({'id': page_id, 'role': 'operator', 'entry': '/' + name,
                          'originalForm': 'generic-crud', 'menuIds': [name], 'sourceFiles': [source]})
            menus.append({'id': name, 'role': 'operator', 'pageIds': [page_id]})
            reviews.append({'pageId': page_id, 'businessGoal': '完成当前业务目标',
                            'needsWorkflow': workflow, 'decision': 'redesign-business' if workflow else 'optimize-list',
                            'targetForm': 'document-workspace' if workflow else 'list',
                            'rationale': '合成测试中的业务判定依据', 'changedFiles': [source],
                            'changeAreas': ['workflow', 'interaction'] if workflow else ['information'],
                            'businessActions': actions, 'requiredStates': ['ready', 'empty', 'failure'],
                            'rounds': [{'round': 1, 'revision': 'final-r1', 'status': 'passed', 'issues': [],
                                        'resolvedIssueIds': [], 'businessFitAssessment': '合成测试中的最终形态复审',
                                        'checks': dict.fromkeys(['businessFit', 'actions', 'states', 'layout', 'permissions'], True),
                                        'actionsTested': [a['name'] for a in actions],
                                        'statesTested': ['ready', 'empty', 'failure'],
                                        'evidence': [{'kind': kind, 'path': 'docs/audit/' + name, 'summary': '合成测试证据'}
                                                     for kind, name in evidence]}]})
        self.value = {'schemaVersion': 1, 'targetRevision': 'final-r1',
                      'sourceDigests': {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in sources},
                      'inventory': {'sourceFiles': ['src/routes.ts'], 'menus': menus, 'pages': pages},
                      'reviews': reviews,
                      'sweeps': [{'round': 1, 'revision': 'final-r1', 'status': 'passed',
                                  'pageIds': [p['id'] for p in pages], 'inventoryEvidence': 'docs/audit/inventory.md'}]}

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def validate(self, value=None):
        return checker.validate_audit(self.value if value is None else value, self.root)

    def assert_invalid(self, change, pattern=None):
        value = copy.deepcopy(self.value)
        change(value)
        if pattern:
            with self.assertRaisesRegex(checker.AuditError, pattern):
                self.validate(value)
        else:
            with self.assertRaises(checker.AuditError):
                self.validate(value)

    def test_business_redesign_and_reasonable_list_pass(self):
        result = self.validate()
        self.assertEqual((result['menus'], result['pages']), (2, 2))
        self.assertEqual(result['decisions'], {'redesign-business': 1, 'optimize-list': 1, 'refine-business': 0})
        self.assertIn('不证明业务合理性', result['scope'])

    def test_purpose_built_page_can_be_refined(self):
        self.value['inventory']['pages'][0]['originalForm'] = 'purpose-built'
        self.value['reviews'][0]['decision'] = 'refine-business'
        self.assertEqual(self.validate()['decisions']['refine-business'], 1)

    def test_no_menu_app_and_login_are_supported(self):
        self.value['inventory']['menus'] = []
        for page in self.value['inventory']['pages']:
            page['menuIds'] = []
        self.assertEqual(self.validate()['menus'], 0)

    def test_missing_review_and_unknown_page_are_rejected(self):
        self.assert_invalid(lambda v: v['reviews'].pop(), '漏审')
        self.assert_invalid(lambda v: v['reviews'][0].update(pageId='invented'), '未知')

    def test_duplicate_page_menu_and_review_rejected(self):
        for group in ['pages', 'menus']:
            self.assert_invalid(lambda v: v['inventory'][group].append(copy.deepcopy(v['inventory'][group][0])), '重复')
        self.assert_invalid(lambda v: v['reviews'].append(copy.deepcopy(v['reviews'][0])), '重复')

    def test_menu_mapping_and_role_mismatch_rejected(self):
        self.assert_invalid(lambda v: v['inventory']['menus'][0].update(pageIds=['missing']))
        self.assert_invalid(lambda v: v['inventory']['pages'][0].update(menuIds=[]), '不对称')
        self.assert_invalid(lambda v: v['inventory']['pages'][0].update(role='other'), '角色')
        self.assert_invalid(lambda v: v['inventory']['pages'][0].update(menuIds=['unknown']))

    def test_workflow_cannot_be_certified_as_list_or_css_only(self):
        self.assert_invalid(lambda v: v['reviews'][0].update(decision='optimize-list', targetForm='list'), '特殊业务')
        self.assert_invalid(lambda v: v['reviews'][0].update(targetForm='generic-crud'))
        self.assert_invalid(lambda v: v['reviews'][0].update(changeAreas=['visual']), '仅换皮')
        self.assert_invalid(lambda v: v['reviews'][0].update(decision='refine-business'))

    def test_no_fake_redesign_for_list_and_no_fake_refine(self):
        self.assert_invalid(lambda v: v['reviews'][1].update(decision='redesign-business', targetForm='cards'))
        self.assert_invalid(lambda v: v['reviews'][1].update(targetForm='cards'))
        self.value['inventory']['pages'][0]['originalForm'] = 'purpose-built'
        self.assert_invalid(lambda v: v['reviews'][0].update(decision='refine-business', changeAreas=['visual']))

    def test_changed_files_and_implementation_required(self):
        self.assert_invalid(lambda v: v['reviews'][0].update(changedFiles=[]))
        self.assert_invalid(lambda v: v['reviews'][0]['businessActions'][0].update(implementationFiles=[]))
        self.assert_invalid(lambda v: v['reviews'][0]['businessActions'][0].update(expectedResult=''))

    def test_every_action_and_state_must_be_tested(self):
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(actionsTested=['无关按钮']), '动作未实测')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(statesTested=['ready']), '状态未实测')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1]['checks'].update(permissions=False))
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(businessFitAssessment=''))

    def test_missing_evidence_kind_file_and_empty_file_rejected(self):
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1]['evidence'].pop(), '缺少真实截图')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1]['evidence'][0].update(path='missing.png'), '文件缺失')
        self.write('docs/audit/screen.png', '')
        with self.assertRaisesRegex(checker.AuditError, '为空'):
            self.validate()

    def test_changed_source_shared_dependency_and_wrong_digest_rejected(self):
        for name in ['src/order.ts', 'src/routes.ts', 'src/shared.css']:
            old = (self.root / name).read_text()
            self.write(name, old + ' new change')
            with self.subTest(name=name), self.assertRaisesRegex(checker.AuditError, '旧验收失效'):
                self.validate()
            self.write(name, old)
        self.assert_invalid(lambda v: v['sourceDigests'].pop('src/order.ts'), '缺少有效SHA256')
        self.assert_invalid(lambda v: v['sourceDigests'].update({'src/order.ts': 'not-a-hash'}))

    def test_real_rework_then_retest_closes_issue(self):
        latest = self.value['reviews'][0]['rounds'][0]
        latest.update(round=2, resolvedIssueIds=['missing-flow'])
        self.value['reviews'][0]['rounds'].insert(0, {'round': 1, 'revision': 'old-r1', 'status': 'rework',
            'issues': [{'id': 'missing-flow', 'description': '旧页缺少真实业务操作'}], 'resolvedIssueIds': []})
        self.value['sweeps'][0]['round'] = 2
        self.assertEqual(self.validate()['lastRound'], 2)

    def test_open_issue_fake_resolution_and_blocked_rejected(self):
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(
            issues=[{'id': 'open', 'description': '尚未修复'}]), '未解决')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(resolvedIssueIds=['never-existed']), '不存在')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(status='blocked',
            issues=[{'id': 'credential', 'description': '缺少凭据'}]), '未复验')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(status='rework'), '具体问题')

    def test_round_order_and_revision_rejected(self):
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'].append(copy.deepcopy(v['reviews'][0]['rounds'][0])), '递增')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(revision='old'), '最终版本')
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(round=True))

    def test_final_sweep_covers_all_pages_and_latest_round(self):
        self.assert_invalid(lambda v: v['sweeps'][0]['pageIds'].pop(), '遗漏页面')
        self.assert_invalid(lambda v: v['sweeps'][0].update(revision='old'))
        self.assert_invalid(lambda v: v['sweeps'][0].update(status='rework'))
        self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1].update(round=2), '早于')
        self.assert_invalid(lambda v: v['sweeps'][0].update(inventoryEvidence='missing.md'))

    def test_path_traversal_absolute_and_symlink_escape_rejected(self):
        outside = Path(self.temp.name) / 'outside.png'
        outside.write_text('outside evidence')
        (self.root / 'escape.png').symlink_to(outside)
        for path in [str(outside), '../outside.png', 'escape.png']:
            self.assert_invalid(lambda v: v['reviews'][0]['rounds'][-1]['evidence'][0].update(path=path))

    def test_bad_json_shapes_are_reported_without_typeerror(self):
        mutations = [lambda v: v.update(schemaVersion=True),
                     lambda v: v.update(inventory=[]), lambda v: v.update(reviews={}),
                     lambda v: v.update(sourceDigests=[]),
                     lambda v: v['reviews'][0].update(decision=[]),
                     lambda v: v['reviews'][0].update(needsWorkflow='true'),
                     lambda v: v['reviews'][0].update(targetForm=[]),
                     lambda v: v['reviews'][0].update(changedFiles=[[]]),
                     lambda v: v['reviews'][0].update(businessActions=[None]),
                     lambda v: v['reviews'][0]['rounds'][-1].update(status={}),
                     lambda v: v['inventory']['pages'][0].update(originalForm=[])]
        for change in mutations:
            self.assert_invalid(change)
        for value in [None, [], 'text']:
            with self.assertRaises(checker.AuditError):
                self.validate(value if value is not None else False)

    def test_cli_exit_codes_and_readonly_source(self):
        audit_path = self.write('docs/page-redesign-audit.json', json.dumps(self.value))
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        run = subprocess.run([sys.executable, '-B', str(SCRIPT), '--project-root', str(self.root), '--audit', str(audit_path)],
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)['pages'], 2)
        after = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        args = ['--project-root', str(self.root), '--audit', str(audit_path)]
        for content in ['{invalid', '{}']:
            audit_path.write_text(content)
            with redirect_stdout(io.StringIO()):
                self.assertEqual(checker.main(args), 1)
        audit_path.write_bytes(b'\xff')
        with redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main(args), 1)
            self.assertEqual(checker.main(['--project-root', str(self.root), '--audit', str(self.root / 'absent')]), 2)
        audit_path.write_text(json.dumps(self.value))
        with redirect_stdout(io.StringIO()):
            self.assertEqual(checker.main(['--project-root', str(self.root / 'absent'), '--audit', str(audit_path)]), 2)


if __name__ == '__main__':
    unittest.main()
