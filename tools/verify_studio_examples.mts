// 读取接收系统真实解析器；不复制解析逻辑、不启动服务或连接数据库。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoFlag = process.argv.indexOf('--repo');
assert(repoFlag >= 0 && process.argv[repoFlag + 1], '请用 --repo 指定接收系统仓库');
const repo = path.resolve(process.argv[repoFlag + 1]);
const skill = path.join(root, 'skills/generated-admin-hardening');
const text = (name: string) => fs.readFileSync(path.join(skill, 'assets/quick-fill-examples', name), 'utf8');
const load = (name: string) => import(pathToFileURL(path.join(repo, name)).href);
const facts: Record<string, unknown> = {};

const manifest = JSON.parse(fs.readFileSync(path.join(skill, 'references/studio-format-sources.json'), 'utf8'));
for (const [kind, sources] of Object.entries(manifest.sources)) {
  for (const source of sources as {path: string; sha256: string}[]) {
    const digest = createHash('sha256').update(fs.readFileSync(path.join(repo, source.path))).digest('hex');
    assert.equal(digest, source.sha256, `${kind} 接收源码已变化，请重查格式并更新指纹`);
  }
}
facts.sourceFingerprints = '全部匹配';

if (process.argv.includes('--diagrams-only')) {
  facts.sqlSourceFingerprints = '未跑：本次使用--diagrams-only，SQL源码兼容性不在验证范围';
} else {
const sqlManifest = JSON.parse(fs.readFileSync(path.join(skill, 'references/sql-system-sources.json'), 'utf8'));
for (const source of sqlManifest.source_files) {
  const digest = createHash('sha256').update(fs.readFileSync(path.join(repo, source.path))).digest('hex');
  assert.equal(digest, source.sha256, 'SQL 接收源码已变化，请重查兼容说明并更新指纹');
}
facts.sqlCompatibility = {sourceFingerprints: '全部匹配', verification: '源码事实核对；未执行业务 SQL 或数据库对象'};

}

const graph = (id: string, diagram = 'flowchart') => ({specVersion: 1, id, kind: 'graph', diagram,
  nodes: [], edges: [], layout: {engine: 'dagre', direction: 'TB'}});

const functionFill = await load('src/shared/capabilities/studio/functionStructureQuickFill.ts');
const functionText = text('01-function-structure.txt');
const functionSpec = functionFill.buildFunctionStructureSpecFromQuickFill(graph('app:function-structure', 'function-structure'), functionText);
assert.equal(functionSpec.nodes.length, 9);
assert.equal(functionSpec.edges.length, 8);
assert.deepEqual(functionSpec.nodes.map((node: {fsRole: string}) => node.fsRole),
  ['root', 'role', 'module', 'operation', 'detail', 'operation', 'role', 'module', 'operation']);
const roundFunction = functionFill.buildFunctionStructureSpecFromQuickFill(functionSpec, functionFill.buildFunctionStructureQuickFillTextFromSpec(functionSpec));
assert.deepEqual(roundFunction, functionSpec);
facts.functionStructure = {nodes: 9, edges: 8, roundTrip: true};

const umlSchema = await load('src/shared/contracts/validation/umlClassFigureSpec.ts');
const umlIdentity = await load('src/shared/contracts/studio/umlClassDiagramIdentity.ts');
const umlFill = await load('src/ui/components/generator/diagrams/JieFigure/domainUmlClassQuickFill.ts');
const umlSource = {ref: 'design:validation', kind: 'project-design'};
const baseUml = umlSchema.UmlClassFigureSpecSchema.parse({specVersion: 1,
  id: umlIdentity.DOMAIN_DESIGN_CLASS_DIAGRAM_FIGURE_ID, kind: 'uml-class', modelKind: 'domain', title: '验证',
  lineage: {sourceFingerprint: 'a'.repeat(64), sources: [umlSource]}, packages: [],
  classifiers: [{id: 'kept', name: '保留的既有类', kind: 'class', attributes: [], operations: [], literals: [], sourceRefs: [umlSource.ref]}],
  relations: [], layout: {engine: 'uml-class'}});
let umlNumber = 0;
const umlSpec = umlFill.buildDomainUmlClassFromQuickFill(baseUml, text('02-uml-class.txt'), {createId: (scope: string) => `${scope}:validation:${++umlNumber}`});
umlSchema.UmlClassFigureSpecSchema.parse(umlSpec);
assert.equal(umlSpec.classifiers.length, 3);
assert.equal(umlSpec.relations.length, 2);
assert(!umlSpec.classifiers.some((item: {id: string}) => item.id === 'kept'), '全文更新应移除旧类');
assert.deepEqual(umlFill.buildDomainUmlClassFromQuickFill(umlSpec, text('02-uml-class.txt')), umlSpec);
facts.umlClass = {addedClasses: 3, relations: 2, retainedOldClass: false, idempotent: true};

const sequence = await load('src/ui/lib/figures/sequenceQuickFill.ts');
const specUtils = await load('src/ui/lib/figures/specUtils.ts');
const sequenceText = text('03-sequence-submit.txt');
const parsed = sequence.parseSystemSequenceQuickFillText(sequenceText);
assert.equal(parsed.participants.length, 4);
assert.equal(parsed.events.length, 12);
assert.equal(parsed.events.filter((event: {type: string}) => event.type === 'message').length, 7);
assert.equal(parsed.events.filter((event: {type: string}) => event.type === 'fragment-else').length, 1);
const seqBase = specUtils.normalizeSequenceFigureSpec({specVersion: 1, id: 'app:system-sequence', kind: 'sequence', diagram: 'sequence', participants: [], events: []});
const seqSpec = sequence.buildSystemSequenceSpecFromQuickFill(seqBase, sequenceText);
assert.equal(seqSpec.events.length, 12);
assert.equal(sequence.parseSystemSequenceQuickFillText(sequence.buildSequenceQuickFillTextFromSpec(seqSpec)).events.length, 12);
facts.sequence = {participants: 4, messages: 7, events: 12, roundTrip: true};

const flow = await load('src/ui/lib/figures/flowchartQuickFill.ts');
const flowText = text('04-system-flowchart.txt');
const flowSpec = flow.buildFlowchartSpecFromQuickFill(graph('app:system-flowchart'), flowText, 'system-flowchart');
assert.equal(flowSpec.nodes.length, 7);
assert.equal(flowSpec.edges.length, 7);
const terminal = flowSpec.nodes[6];
assert.equal(flowSpec.edges.filter((edge: {to: string}) => edge.to === terminal.id).length, 2, '合流边不能丢');
assert(!flowSpec.edges.some((edge: {from: string}) => edge.from === terminal.id));
assert.deepEqual(flow.buildFlowchartSpecFromQuickFill(flowSpec, flow.buildFlowchartQuickFillTextFromSpec(flowSpec)), flowSpec);
assert.throws(() => flow.buildFlowchartSpecFromQuickFill(graph('app:system-flowchart'), '[1] 开始\n连接：1 -> 99'), /不存在/);
facts.flowchart = {nodes: 7, edges: 7, mergeIncoming: 2, invalidReferenceRejected: true};

const dfd = await load('src/ui/lib/figures/dataFlowQuickFill.ts');
const dfdExamples = [['05-dfd-context.txt', 2, 2], ['05-dfd-level1.txt', 3, 4], ['05-dfd-level2-1.0.txt', 5, 7]] as const;
for (const [name, nodes, edges] of dfdExamples) {
  const spec = dfd.buildDataFlowSpecFromQuickFill(graph(`validation:${name}`, 'data-flow'), text(name));
  assert.equal(spec.nodes.length, nodes);
  assert.equal(spec.edges.length, edges);
  for (const edge of spec.edges) {
    const from = spec.nodes.find((node: {id: string}) => node.id === edge.from);
    const to = spec.nodes.find((node: {id: string}) => node.id === edge.to);
    assert.equal(from.dfdRole === 'process' || to.dfdRole === 'process', true);
    assert(edge.label.length > 0);
  }
  facts[name] = {nodes, edges};
}
const boundary = (spec: {nodes: {id: string; dfdRole: string; label: string}[]; edges: {from: string; to: string; label: string}[]}, excludeStore = false) => {
  const roles = new Map(spec.nodes.map((node) => [node.id, node]));
  return spec.edges.flatMap((edge) => {
    const from = roles.get(edge.from)!; const to = roles.get(edge.to)!;
    if (from.dfdRole === 'external-entity') return [`in:${from.label}:${edge.label}`];
    if (to.dfdRole === 'external-entity') return [`out:${to.label}:${edge.label}`];
    if (!excludeStore && to.dfdRole === 'data-store') return [`store-in:${to.label}:${edge.label}`];
    if (!excludeStore && from.dfdRole === 'data-store') return [`store-out:${from.label}:${edge.label}`];
    return [];
  }).sort();
};
const dfds = dfdExamples.map(([name]) => dfd.buildDataFlowSpecFromQuickFill(graph(`validation:${name}`, 'data-flow'), text(name)));
assert.deepEqual(boundary(dfds[0], true), boundary(dfds[1], true));
assert.deepEqual(boundary(dfds[1]), boundary(dfds[2]));
facts.dfdBoundaryBalance = true;

const useCase = await load('src/shared/capabilities/diagram/use-case/editing/useCaseDiagramQuickFill.ts');
const compiler = await load('src/shared/capabilities/diagram/use-case/compiler/UseCaseDiagramFamilyCompiler.ts');
const fixtures = await load('tests/unit/shared/capabilities/diagram/use-case/useCaseDiagramTestFixtures.ts');
const reducer = await load('src/shared/capabilities/diagram/use-case/editing/UseCaseDiagramManualReducer.ts');
const aggregate = compiler.compileUseCaseDiagramFamily(fixtures.makeUseCaseTestDesign([
  fixtures.makeUseCaseTestEntity({id: 'tmp_operator', nameCh: '既有角色', surfaces: ['PUBLIC_CLIENT']}),
]));
let commandNumber = 0;
const useText = text('07-use-case.txt');
const useResult = useCase.buildUseCaseDiagramQuickFillCommands({aggregate, text: useText, createCommandId: (kind: string) => `validation:${kind}:${++commandNumber}`});
assert.equal(useResult.addedActors, 2);
assert.equal(useResult.addedUseCases, 5);
assert(useResult.commands.some((command: {kind: string}) => command.kind === 'delete-element'));
const next = reducer.reduceUseCaseDiagramManualCommandsWithMaterialization({state: reducer.createUseCaseDiagramManualState(aggregate), commands: useResult.commands}).materialization.aggregate;
assert(!next.actors.some((actor: {name: string}) => actor.name === '既有角色'));
assert.equal(useCase.buildUseCaseDiagramQuickFillCommands({aggregate: next, text: useText, createCommandId: () => 'unused'}).commands.length, 0);
assert.throws(() => useCase.parseUseCaseDiagramQuickFillText('参与者：客户\n   提交订单'), /第 2 行/);
facts.useCase = {addedActors: 2, addedUseCases: 5, retainedOldActor: false, idempotent: true};

const architecture = await load('src/shared/capabilities/architecture-diagram/architectureDiagramQuickFill.ts');
const architectureSpec = architecture.buildArchitectureDiagramSpecFromQuickFill(graph('app:architecture-diagram:vue-fullstack:layered-block'), text('06-architecture.txt'));
assert.equal(architectureSpec.nodes.length, 3);
assert.equal(architectureSpec.edges.length, 2);
assert.deepEqual(architecture.buildArchitectureDiagramSpecFromQuickFill(architectureSpec, architecture.buildArchitectureDiagramQuickFillText(architectureSpec)), architectureSpec);
facts.architecture = {nodes: 3, edges: 2, roundTrip: true};
const familyFill = await load('src/ui/lib/figures/figureFamilyQuickFill.ts');
const familyFixture = await load('tests/unit/shared/capabilities/diagram/model/dataFlowDiagramFamily.fixture.ts');
const flowFamily = familyFill.parseSystemFlowchartFamilyQuickFill(text('04-system-flowchart-family.txt'));
assert.equal(flowFamily.members.length, 2);
const dfdFamily = familyFill.parseDataFlowFamilyQuickFill(familyFixture.validFamily(), text('05-data-flow-family.txt'));
assert.equal(dfdFamily.level2.length, 1);
assert.equal(dfdFamily.balanceProof.contextToLevel1.length, 2);
assert.equal(dfdFamily.balanceProof.level1ToLevel2.length, 4);
facts.wholeFamilies = { systemFlowcharts: 3, dataFlowDiagrams: 3, atomicFamilyInput: true };
const seqFamily = familyFill.parseSystemSequenceFamilyQuickFill(text('03-sequence-family.txt'));
assert.equal(seqFamily.members.length, 1);
assert.equal(familyFill.parseSystemSequenceFamilyQuickFill(familyFill.serializeSystemSequenceFamilyQuickFill([
  seqFamily.root, ...seqFamily.members.map((member: {spec: unknown}) => member.spec),
])).members.length, 1);
facts.wholeSequenceFamily = {members: 2, roundTrip: true};

// 可选验证用户产物：使用与网站相同的完整解析器，不能只验示例或逐节解析。
const inputIndex = process.argv.indexOf('--input-dir');
if (inputIndex >= 0) {
  assert(process.argv[inputIndex + 1], '--input-dir 缺少目录');
  const inputDir = path.resolve(process.argv[inputIndex + 1]);
  const expected = ['01-function-structure.txt', '02-uml-class.txt', '03-sequence-family.txt',
    '04-system-flowchart-family.txt', '05-data-flow-family.txt', '06-architecture.txt', '07-use-case.txt'];
  assert.deepEqual(fs.readdirSync(inputDir).filter((name) => name.endsWith('.txt')).sort(), [...expected].sort(),
    '最终必须每类一份正文，共七份；不能留旧分图文件');
  const input = (name: string) => fs.readFileSync(path.join(inputDir, name), 'utf8');
  const layoutApi = await load('src/shared/capabilities/diagram/render/jie-graph/layout.ts');
  const projection = await load('src/shared/capabilities/diagram/export/markdown/FunctionStructureDisplayProjection.ts');
  const geometry = (spec: any, noOverlap = false) => {
    const layout = layoutApi.computeGraphLayout(spec);
    assert.equal(layout.nodes.length, spec.nodes.length);
    for (const node of layout.nodes) assert([node.x, node.y, node.width, node.height].every(Number.isFinite));
    if (noOverlap) for (let i = 0; i < layout.nodes.length; i++) for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i], b = layout.nodes[j];
      assert(!(Math.abs(a.x - b.x) < (a.width + b.width) / 2 - 0.01 &&
        Math.abs(a.y - b.y) < (a.height + b.height) / 2 - 0.01), `节点重叠：${a.label} / ${b.label}`);
    }
    return {nodes: layout.nodes.length, edges: spec.edges.length, box: layoutApi.computeGraphFigureViewBox(spec, layout, 0)};
  };
  const fn = specUtils.normalizeGraphFigureSpec(functionFill.buildFunctionStructureSpecFromQuickFill(
    graph('app:function-structure', 'function-structure'), input(expected[0])));
  const depths: Record<string, unknown> = {};
  for (const depth of ['module', 'operation', 'detail']) {
    const projected = projection.projectFunctionStructureSpecForDisplay(projection.withFunctionStructureDisplayDepth(fn, depth));
    depths[depth] = geometry(projected, true);
    const auto = layoutApi.computeGraphLayoutNodes({...projected, layout: {...projected.layout, positions: undefined}});
    const coords = (nodes: any[]) => Object.fromEntries(nodes.map(({id, x, y, width, height}) => [id, {x, y, width, height}]));
    assert.deepEqual(coords(layoutApi.computeGraphLayoutNodes(projected)), coords(auto), `${depth}仍在使用隐藏层坐标`);
  }
  const classes = umlFill.buildDomainUmlClassFromQuickFill(baseUml, input(expected[1]));
  umlSchema.UmlClassFigureSpecSchema.parse(classes);
  const seqs = familyFill.parseSystemSequenceFamilyQuickFill(input(expected[2]));
  const seqSpecs = [seqs.root, ...seqs.members.map((member: {spec: unknown}) => member.spec)];
  assert.equal(familyFill.parseSystemSequenceFamilyQuickFill(familyFill.serializeSystemSequenceFamilyQuickFill(seqSpecs)).members.length, seqs.members.length);
  const flows = familyFill.parseSystemFlowchartFamilyQuickFill(input(expected[3]));
  const flowSpecs = [flows.root, ...flows.members.map((member: {spec: unknown}) => member.spec)];
  flowSpecs.forEach((spec: any) => geometry(spec));
  const wholeDfd = familyFill.parseDataFlowFamilyQuickFill(familyFixture.validFamily(), input(expected[4]));
  const materializer = await load('src/shared/capabilities/diagram/model/dataFlowDiagramFamilyMaterializer.ts');
  const dfdViews = materializer.materializeDataFlowDiagramFamily(wholeDfd);
  dfdViews.members.forEach((member: {spec: unknown}) => geometry(member.spec));
  assert.equal(familyFill.parseDataFlowFamilyQuickFill(wholeDfd, familyFill.serializeDataFlowFamilyQuickFill(wholeDfd)).level2.length, wholeDfd.level2.length);
  const arch = architecture.buildArchitectureDiagramSpecFromQuickFill(graph('app:architecture-diagram:ssm:layered-block'), input(expected[5]));
  const archGeometry = geometry(arch, true);
  const useCommands = useCase.buildUseCaseDiagramQuickFillCommands({aggregate, text: input(expected[6]),
    createCommandId: (kind: string) => `input:${kind}:${++commandNumber}`});
  const useNext = reducer.reduceUseCaseDiagramManualCommandsWithMaterialization({state: reducer.createUseCaseDiagramManualState(aggregate), commands: useCommands.commands}).materialization.aggregate;
  facts.realInput = {files: 7, functionStructure: depths, classes: classes.classifiers.length,
    sequenceDiagrams: seqSpecs.length, flowcharts: flowSpecs.length, dataFlowDiagrams: dfdViews.members.length,
    architecture: archGeometry, useCaseActors: useNext.actors.length,
    verification: '正式整套解析、schema、往返和图形投影/几何；不代表网页保存或业务真实性已验收'};
}

console.log(JSON.stringify({status: 'passed', facts}, null, 2));
