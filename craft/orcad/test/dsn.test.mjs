// OrCAD 파일 읽기 시험. 실제 설계 파일과 대조 자료는 저장소에 넣지 않고 ORCAD_TEST_DIR 에서 찾는다.
//   craft/orcad/test/fetch-evidence.sh /some/dir
//   ORCAD_TEST_DIR=/some/dir node --test craft/orcad/test/dsn.test.mjs
// ORCAD_TEST_DIR 는 : 로 여러 폴더를 줄 수 있고, 파일은 그 아래 어디에 있어도 이름으로 찾는다.
// 기대값의 출처는 test/evidence.md 에 있다. 코드가 낸 값을 옮겨 적은 것이 아니라 공개된 PDF·BOM·PCB 넷리스트와
// Capture 가 직접 만든 넷리스트(.net, .als)에서 읽은 값이다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dsnToNetlist, flatten, bom, spiceValue, busMembers, expandTemplate } from '../dsn2cir.mjs'
import { read, write } from '../../pspice/pspice.mjs'
import { walk, findPairs, parseAls, parseNet, compare, samePartition } from './capture-net.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const binary = process.env.ORCAD2JSON || path.resolve(here, '../../../../artcraft/orcad2json')
const cli = path.resolve(here, '../dsn2cir')
const fixture = (n) => path.join(here, 'fixtures', n)
const testDirs = (process.env.ORCAD_TEST_DIR || '').split(':').filter(Boolean)
const testFiles = testDirs.flatMap((d) => (fs.existsSync(d) ? walk(d) : []))

const noBinary = fs.existsSync(binary) ? false : `${binary} 가 없어요: craft/orcad/build.sh 로 만드세요`
const designPath = (name) => testFiles.find((f) => path.basename(f) === name) ?? null
const skipDesign = (name) => {
  if (noBinary) return noBinary
  if (!testDirs.length) return 'ORCAD_TEST_DIR 가 없어요: test/fetch-evidence.sh 로 내려받아 지정하세요'
  return designPath(name) ? false : `ORCAD_TEST_DIR 아래에 ${name} 이 없어요`
}
const skipFile = (design, file) => skipDesign(design) || (designPath(file) ? false : `ORCAD_TEST_DIR 아래에 ${file} 이 없어요`)

const run = (args, opts = {}) => spawnSync(args[0], args.slice(1), { encoding: 'utf8', maxBuffer: 1 << 30, ...opts })
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orcad-test-'))

const cache = new Map()
function design(name) {
  if (!cache.has(name)) {
    const r = run([binary, designPath(name)])
    assert.equal(r.status, 0, r.stderr)
    const json = JSON.parse(r.stdout)
    cache.set(name, { json, result: dsnToNetlist(json) })
  }
  return cache.get(name)
}

const pinKey = (ref, number) => `${ref}-${number}`
const netHolding = (result, ref, number) => result.nets.find((n) => n.pins.some((p) => p.ref === ref && p.number === number))
const setOf = (net) => new Set(net.pins.map((p) => pinKey(p.ref, p.number)))
function assertNet(result, label, expected) {
  const [ref, number] = expected[0].split(/-(.+)/)
  const net = netHolding(result, ref, number)
  assert.ok(net, `${label}: ${expected[0]} 이 어떤 넷에도 없어요`)
  assert.deepEqual([...setOf(net)].sort(), [...expected].sort(), `${label} (${net.node})`)
  return net
}

// ---------- 손으로 만든 도면: 규칙 하나씩 ----------
const baseSymbols = [{ kind: 'part', name: 'R.Normal', source: 'Cache', pins: [{ name: '1' }, { name: '2' }] }]
const baseParts = [{ name: 'R', refDes: 'R', footprint: 'r0402', sections: [{ unit: '', cell: 'R', pinNumbers: ['1', '2'] }] }]
const res = (ref, x1, y1, x2, y2, extra = {}) => ({ ref, value: '10K', sourcePart: 'R', part: 'R.Normal', section: 0, x: x1, y: y1, properties: {}, pins: [{ order: 1, x: x1, y: y1 }, { order: 2, x: x2, y: y2 }], ...extra })
const page = (name, body = {}) => ({ name, view: 'S', pageSize: 'A', nets: [], instances: [], wires: [], globals: [], ports: [], offPage: [], ...body })
const geo = (pages) => ({ kind: 'dsn', file: 't.dsn', pages, parts: baseParts, symbols: baseSymbols, hierarchy: [], warnings: [] })
const wire = (x1, y1, x2, y2, aliases = []) => ({ x1, y1, x2, y2, bus: false, aliases: aliases.map((name) => ({ name })) })
const sameNet = (result, a, b) => {
  const [ra, na] = a.split('-'), [rb, nb] = b.split('-')
  return netHolding(result, ra, na) === netHolding(result, rb, nb) && !!netHolding(result, ra, na)
}

test('규칙: 선 끝이 다른 선 몸통에 닿으면 이어진다(T 접합)', () => {
  const r = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 100, 50, 100, 150), res('R3', 50, 0, 50, 300)], wires: [wire(0, 0, 100, 0), wire(50, 0, 50, 50)] })]))
  assert.ok(sameNet(r, 'R1-1', 'R3-1'), '끝끼리 닿는 경우')
  const t = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 50, 50, 50, 150)], wires: [wire(0, 0, 100, 0), wire(50, 0, 50, 50)] })]))
  assert.ok(sameNet(t, 'R1-1', 'R2-1'), 'T 접합')
})

test('규칙: 끝이 닿지 않고 십자로 지나가면 잇지 않는다', () => {
  const r = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 50, 0, 200), res('R2', 50, 0, 300, 0)], wires: [wire(0, 50, 100, 50), wire(50, 0, 50, 100)] })]))
  assert.ok(!sameNet(r, 'R1-1', 'R2-1'))
})

test('규칙: 같은 페이지의 같은 별칭은 이어지고, 별칭만으로는 페이지를 넘지 못한다', () => {
  const r = dsnToNetlist(geo([
    page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 500, 0, 500, 100)], wires: [wire(0, 0, 50, 0, ['SIG']), wire(500, 0, 550, 0, ['SIG'])] }),
    page('P2', { instances: [res('R3', 0, 0, 0, 100)], wires: [wire(0, 0, 50, 0, ['SIG'])] }),
  ]))
  assert.ok(sameNet(r, 'R1-1', 'R2-1'), '같은 페이지')
  assert.ok(!sameNet(r, 'R1-1', 'R3-1'), '다른 페이지의 별칭')
})

test('규칙: 페이지 연결자와 전원 기호는 이름으로 페이지를 넘는다', () => {
  const r = dsnToNetlist(geo([
    page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R5', 300, 0, 300, 100)], wires: [wire(0, 0, 50, 0), wire(300, 0, 350, 0)], offPage: [{ name: 'CLK', x: 50, y: 0 }], globals: [{ name: 'VCC', x: 350, y: 0 }] }),
    page('P2', { instances: [res('R3', 0, 0, 0, 100), res('R4', 300, 0, 300, 100)], wires: [wire(0, 0, 50, 0), wire(300, 0, 350, 0)], offPage: [{ name: 'clk', x: 50, y: 0 }], globals: [{ name: 'VCC', x: 350, y: 0 }] }),
  ]))
  assert.ok(sameNet(r, 'R1-1', 'R3-1'), '페이지 연결자(대소문자 무시)')
  assert.ok(sameNet(r, 'R5-1', 'R4-1'), '전원 기호')
  assert.ok(!sameNet(r, 'R1-1', 'R5-1'), '다른 이름')
})

test('규칙: 버스 이름의 페이지 연결자는 구성원 이름을 페이지 너머로 잇는다', () => {
  assert.deepEqual(busMembers('A[0..2]'), ['A0', 'A1', 'A2'])
  assert.deepEqual(busMembers('D[2:0]'), ['D0', 'D1', 'D2'])
  assert.equal(busMembers('PLAIN'), null)
  const r = dsnToNetlist(geo([
    page('P1', { instances: [res('R1', 0, 0, 0, 100)], wires: [wire(0, 0, 50, 0, ['A1'])], offPage: [{ name: 'A[0..3]', x: 900, y: 900 }] }),
    page('P2', { instances: [res('R2', 0, 0, 0, 100)], wires: [wire(0, 0, 50, 0, ['A1'])], offPage: [{ name: 'A[0..3]', x: 900, y: 900 }] }),
  ]))
  assert.ok(sameNet(r, 'R1-1', 'R2-1'))
})

test('규칙: 선 없이 전원 기호에 바로 닿은 핀, 핀끼리 닿은 핀', () => {
  const g = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 500, 0, 500, 100)], wires: [wire(500, 0, 550, 0)], globals: [{ name: 'VIO', x: 0, y: 0 }, { name: 'VIO', x: 550, y: 0 }] })]))
  assert.ok(sameNet(g, 'R1-1', 'R2-1'), '핀이 전원 기호에')
  const p = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 0, 100, 0, 200)] })]))
  assert.ok(sameNet(p, 'R1-2', 'R2-1'), '핀이 핀에')
  const q = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100)] })]))
  assert.equal(q.parts[0].pins[0].net, null, '아무것도 안 닿은 핀')
})

const idDesign = () => geo([page('P1', {
  nets: [{ name: 'VCC', id: 10 }, { name: 'SIG', id: 20 }],
  wires: [{ x1: 0, y1: 0, x2: 50, y2: 0, net: 10, id: 101, bus: false, aliases: [] }, { x1: 0, y1: 100, x2: 50, y2: 100, net: 20, id: 102, bus: false, aliases: [] }, { x1: 0, y1: 200, x2: 50, y2: 200, net: 30, id: 103, bus: false, aliases: [] }],
  globals: [{ name: 'VCC', x: 50, y: 0 }],
  instances: [
    { ref: 'R1', value: '1k', sourcePart: 'R', part: 'R.Normal', section: 0, x: 0, y: 0, properties: {}, pins: [{ order: 1, x: 0, y: 0, wire: 101 }, { order: 2, x: 0, y: 100, wire: 102 }] },
    { ref: 'R2', value: '2k', sourcePart: 'R', part: 'R.Normal', section: 0, x: 0, y: 0, properties: {}, pins: [{ order: 1, x: 0, y: 200, wire: 103 }, { order: 2, x: 900, y: 900, wire: 0 }] },
    { ref: 'R3', value: '3k', sourcePart: 'R', part: 'R.Normal', section: 0, x: 0, y: 0, properties: {}, pins: [{ order: 1, x: 50, y: 0, wire: -1 }, { order: 2, x: 0, y: 200, wire: 103 }] },
  ],
})])

test('파일의 id: 핀→선→넷을 그대로 따른다. wire 0 은 미연결, -1 은 선 없이 닿음', () => {
  const r = dsnToNetlist(idDesign())
  assert.equal(r.stats.mode, 'ids')
  assert.ok(sameNet(r, 'R1-1', 'R3-1'), '-1: 전원 기호 VCC 와 같은 넷')
  assert.ok(sameNet(r, 'R2-1', 'R3-2'), '이름 없는 넷')
  assert.equal(r.parts.find((p) => p.ref === 'R2').pins[1].net, null)
  assert.equal(netHolding(r, 'R1', '1').name, 'VCC')
  assert.equal(netHolding(r, 'R1', '2').name, 'SIG')
})

test('접지: 0 으로 쓰고, 다른 이름을 합쳤으면 경고한다', () => {
  const single = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100)], wires: [wire(0, 0, 50, 0)], globals: [{ name: 'GND', x: 50, y: 0 }] })]))
  assert.equal(netHolding(single, 'R1', '1').node, '0')
  assert.ok(!single.warnings.some((w) => /합쳤/.test(w)))

  const merged = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 500, 0, 500, 100), res('R3', 800, 0, 800, 100)], wires: [wire(0, 0, 50, 0), wire(500, 0, 550, 0), wire(800, 0, 850, 0)], globals: [{ name: 'GND', x: 50, y: 0 }, { name: 'AGND', x: 550, y: 0 }, { name: 'GND_EARTH', x: 850, y: 0 }] })]))
  assert.equal(netHolding(merged, 'R2', '1').node, '0')
  assert.equal(netHolding(merged, 'R1', '1').node, '0')
  assert.ok(sameNet(merged, 'R1-1', 'R2-1'))
  assert.ok(merged.warnings.some((w) => /AGND, GND/.test(w) && /합쳤/.test(w)), '합친 이름을 말한다')
  assert.notEqual(netHolding(merged, 'R3', '1').node, '0', 'GND_EARTH 는 합치지 않는다')
  assert.ok(merged.warnings.some((w) => /GND_EARTH/.test(w)), '합치지 않은 것도 말한다')
})

test('여러 조각 부품: 참조 하나로 묶고 핀 번호 순서로 쓴다', () => {
  const parts = [{ name: 'DUAL', refDes: 'U', footprint: 'so8', sections: [{ unit: 'A', cell: 'DUAL', pinNumbers: ['3', '2', '1'] }, { unit: 'B', cell: 'DUAL', pinNumbers: ['5', '6', '7'] }] }]
  const symbols = [{ kind: 'part', name: 'DUAL.Normal', pins: [{ name: 'IN+' }, { name: 'IN-' }, { name: 'OUT' }] }]
  const u = (section, y) => ({ ref: 'U1', value: 'LM358', sourcePart: 'DUAL', part: 'DUAL.Normal', section, x: 0, y, properties: {}, pins: [1, 2, 3].map((order) => ({ order, x: 100 * order, y })) })
  const wires = [[100, 0], [200, 0], [300, 0], [100, 500], [200, 500], [300, 500]].map(([x, y]) => wire(x, y, x, y + 20))
  const offPage = [[100, 20, 'A'], [200, 20, 'B'], [300, 20, 'C'], [100, 520, 'D'], [200, 520, 'E'], [300, 520, 'F']].map(([x, y, name]) => ({ name, x, y }))
  const r = dsnToNetlist({ kind: 'dsn', pages: [page('P1', { instances: [u(0, 0), u(1, 500)], wires, offPage })], parts, symbols, hierarchy: [] })
  assert.equal(r.parts.length, 1)
  assert.equal(r.parts[0].pins.length, 6)
  const line = r.text.split('\n').find((l) => l.startsWith('X_U1'))
  assert.equal(line, 'X_U1 C B A D E F DUAL', '번호 1,2,3 은 A조각의 3,2,1 번째 핀, 5,6,7 은 B조각의 1,2,3 번째 핀')
})

test('이름: 한 낱말을 깨는 글자만 바꾸고, 겹치면 번호를 붙인다. +VCC 는 Capture 처럼 그대로 둔다', () => {
  const r = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 500, 0, 500, 100), res('R3', 900, 0, 900, 100)], wires: [wire(0, 0, 50, 0, ['VDD TYPE']), wire(500, 0, 550, 0, ['VDD_TYPE']), wire(900, 0, 950, 0, ['+VCC'])] })]))
  const a = netHolding(r, 'R1', '1').node, b = netHolding(r, 'R2', '1').node
  assert.notEqual(a.toUpperCase(), b.toUpperCase(), '겹치면 안 된다')
  assert.match(a, /^VDD_TYPE/)
  assert.equal(netHolding(r, 'R3', '1').node, '+VCC')
  const doc = read(r.text)
  assert.equal(doc.elements.length, 3)
})

test('값: 도면의 값을 SPICE 값으로', () => {
  for (const [raw, letter, want] of [
    ['10K', 'R', '10K'], ['0.1uF,10V', 'C', '0.1uF'], ['DNI,10K', 'R', '10K'], ['4K7', 'R', '4.7K'], ['2R2', 'R', '2.2'], ['47R', 'R', '47'], ['0R', 'R', '0'],
    ['1M', 'R', '1MEG'], ['1Meg', 'R', '1Meg'], ['10m', 'R', '10m'], ['4.7uF,6.3V,0603', 'C', '4.7uF'], ['8.45K_1%_0603', 'R', '8.45K'], ['RES_0_0402,DNI', 'R', '0'],
    ['100pF', 'C', '100pF'], ['3.3uH', 'L', '3.3uH'], ['10µF', 'C', '10uF'], ['FERRITE, MMZ1608R301A', 'L', null], ['DNI', 'R', null], ['RL0805JR-070R1L', 'R', null],
  ]) assert.equal(spiceValue(raw, letter), want, raw)
})

test('부품 표: 값·부품·풋프린트로 묶는다', () => {
  const rows = bom([{ ref: 'R10', value: '10K', part: 'R', footprint: 'r0402' }, { ref: 'R2', value: '10K', part: 'R', footprint: 'r0402' }, { ref: 'R3', value: '1K', part: 'R', footprint: 'r0402' }])
  assert.deepEqual(rows.map((r) => [r.count, r.value, r.refs.join(' ')]), [[2, '10K', 'R2 R10'], [1, '1K', 'R3']])
  const r = dsnToNetlist(idDesign())
  assert.equal(r.bom().reduce((n, row) => n + row.count, 0), r.parts.length)
})

test('입력 오류: 도면이 아닌 JSON 은 분명히 거절한다', () => {
  assert.throws(() => dsnToNetlist({}), /pages/)
  assert.throws(() => dsnToNetlist({ kind: 'olb', pages: [] }), /olb/)
})

test('규칙: 접지. 0 이라는 넷이 있으면 GND 는 합치지 않는다 (Capture 도 따로 둔다)', () => {
  const r = dsnToNetlist(geo([page('P1', { instances: [res('R1', 0, 0, 0, 100), res('R2', 500, 0, 500, 100)], wires: [wire(0, 0, 50, 0), wire(500, 0, 550, 0)], globals: [{ name: '0', x: 50, y: 0 }, { name: 'GND', x: 550, y: 0 }] })]))
  assert.equal(netHolding(r, 'R1', '1').node, '0')
  assert.equal(netHolding(r, 'R2', '1').node, 'GND')
  assert.ok(r.warnings.some((w) => /GND/.test(w) && /접지로 치지 않았어요/.test(w)))
})

test('규칙: 그려지지 않는 전원 핀은 이름으로, PSpiceDefaultNet 이 있으면 그 이름으로 잇는다', () => {
  const symbols = [{ kind: 'part', name: 'G.Normal', pins: [{ name: 'A', visible: true }, { name: 'VCC', visible: false }, { name: 'GND', visible: false, defaultNet: '$G_DGND' }] }]
  const parts = [{ name: 'G', refDes: 'U', sections: [{ unit: '', pinNumbers: ['1', '14', '7'] }] }]
  const u = (ref) => ({ ref, value: 'G', sourcePart: 'G', part: 'G.Normal', section: 0, x: 0, y: 0, properties: {}, pins: [{ order: 1, x: 0, y: 0, wire: 0 }, { order: 2, x: 5, y: 5, wire: 0 }, { order: 3, x: 5, y: 5, wire: 0 }] })
  const r = dsnToNetlist({ kind: 'dsn', pages: [page('P1', { instances: [u('U1'), u('U2')] })], parts, symbols, hierarchy: [] })
  assert.ok(sameNet(r, 'U1-14', 'U2-14'))
  assert.ok(sameNet(r, 'U1-7', 'U2-7'))
  assert.ok(!sameNet(r, 'U1-14', 'U1-7'), '겹친 자리라도 이름이 다르면 다른 넷')
  assert.equal(netHolding(r, 'U1', '7').node, '$G_DGND')
  assert.equal(r.parts[0].pins.find((p) => p.number === '1').net, null)
})

const templateCtx = (props, nodes, path = []) => ({ props, pin: (n) => nodes[n.toUpperCase()] ?? `?${n}`, path })
test('PSpiceTemplate: Capture 가 쓰는 표기', () => {
  // 왼쪽 템플릿은 SOURCE.OLB, ANALOG.OLB 원본이고 오른쪽은 Capture 가 같은 값으로 낸 줄이다 (_FIG3_23_MSD.net)
  const vp = 'V^@REFDES %+ %- ?DC|DC @DC| ?AC|AC @AC|\\n+PULSE @V1 @V2 ?TD/@TD/~TD/0/ #TR/@TR/ #TF/@TF/ #PW/@PW/ #PER/@PER/'
  const nodes = { '+': 'PHI1', '-': '0' }
  assert.equal(expandTemplate(vp, templateCtx({ REFDES: 'Vphi1', DC: '', AC: '', V1: '0', V2: '1', TD: '0', TR: '200p', TF: '200p', PW: '4n', PER: '10n' }, nodes)).replace(/ +/g, ' '), 'V_Vphi1 PHI1 0 \n+PULSE 0 1 0 200p 200p 4n 10n')
  // #: 값이 없으면 그 뒤를 버린다. ~: 값이 없을 때 쓴다
  assert.equal(expandTemplate(vp, templateCtx({ REFDES: 'V', V1: '0', V2: '1', TR: '1n' }, nodes)).replace(/ +/g, ' ').trim(), 'V_V PHI1 0 \n+PULSE 0 1 0 1n')
  const cap = 'C^@REFDES %1 %2 ?TOLERANCE|C^@REFDES| @VALUE ?IC/IC=@IC/ TC=@TC1,@TC2 ?TOLERANCE|\\n.model C^@REFDES CAP C=1 DEV=@TOLERANCE% TC1=@TC1 TC2=@TC2|'
  assert.equal(expandTemplate(cap, templateCtx({ REFDES: 'C1', VALUE: '10p', TC1: '0', TC2: '0' }, { 1: 'A', 2: 'B' })).replace(/ +/g, ' ').trim(), 'C_C1 A B 10p TC=0,0')
  // 계층 경로와 %핀 대소문자
  assert.equal(expandTemplate('R^@REFDES %1 %2 @VALUE', templateCtx({ REFDES: 'R1', VALUE: '1' }, { 1: '0', 2: 'VOUT' }, ['U1'])), 'R_U1_R1 0 VOUT 1')
  assert.equal(expandTemplate('X^@REFDES %Vinm %OUT @MODEL', templateCtx({ REFDES: 'U1', MODEL: 'OP' }, { VINM: 'A', OUT: 'B' })), 'X_U1 A B OP')
  // 값 안의 ^ 도 경로가 된다 (실제 Capture 동작, _Fig3_28_MSD.net 의 V_BNOISE)
  assert.equal(expandTemplate('V^@REFDES %+ %- DC @DC', templateCtx({ REFDES: 'B', DC: 'x^2' }, { '+': 'A', '-': '0' })), 'V_B A 0 DC x_2')
})

const hierDoc = () => ({
  kind: 'dsn', file: 't.dsn', rootSchematic: 'TOP',
  symbols: [
    { kind: 'part', name: 'R.Normal', properties: { PSpiceTemplate: 'R^@REFDES %1 %2 @VALUE' }, pins: [{ name: '1' }, { name: '2' }] },
    { kind: 'part', name: 'S.Normal', properties: { PSpiceTemplate: 'S^@REFDES %3 %4 %1 %2 ^@REFDES\\nRS^@REFDES %1 %2 1G\\n.MODEL ^@REFDES VSWITCH Ron=@RON', RON: '1.0' }, pins: [{ name: '1' }, { name: '2' }, { name: '3' }, { name: '4' }] },
    { kind: 'part', name: 'BLK.Normal', properties: { Primitive: 'NO' }, pins: [{ name: 'IN' }, { name: 'OUT' }] },
  ],
  parts: [{ name: 'R', sections: [{ unit: '', pinNumbers: ['1', '2'] }] }, { name: 'S', sections: [{ unit: '', pinNumbers: ['1', '2', '3', '4'] }] }, { name: 'BLK', sections: [{ unit: '', pinNumbers: ['', ''] }] }],
  hierarchy: [], warnings: [],
  pages: [
    page('TOP', { view: 'TOP', instances: [
      { ref: 'U1', value: 'BLK', sourcePart: 'BLK', part: 'BLK.Normal', section: 0, x: 0, y: 0, properties: {}, implementation: { name: 'CHILD', path: '', type: 4 }, pins: [{ order: 1, x: 0, y: 0 }, { order: 2, x: 100, y: 0 }] },
      { ref: 'U2', value: 'BLK', sourcePart: 'BLK', part: 'BLK.Normal', section: 0, x: 0, y: 0, properties: {}, implementation: { name: 'CHILD', path: '', type: 4 }, pins: [{ order: 1, x: 100, y: 0 }, { order: 2, x: 200, y: 0 }] },
    ], wires: [wire(0, 0, 0, 50, ['A']), wire(100, 0, 100, 50, ['MID']), wire(200, 0, 200, 50, ['B'])] }),
    page('CHILD', { view: 'CHILD', instances: [res('R1', 0, 0, 100, 0, { implementation: { name: '', path: '', type: 2 } })], wires: [wire(0, 0, 0, 50), wire(100, 0, 100, 50)], ports: [{ name: 'IN', x: 0, y: 50 }, { name: 'OUT', x: 100, y: 50 }] }),
  ],
})

test('계층: 블록의 핀이 아래 회로도의 포트로 이어지고, 인스턴스마다 따로 펼친다', () => {
  const r = dsnToNetlist(hierDoc())
  assert.deepEqual(r.parts.map((p) => p.ref).sort(), ['U1_R1', 'U2_R1'])
  assert.deepEqual(r.elements.map((e) => e.spiceRef).sort(), ['R_U1_R1', 'R_U2_R1'])
  assert.ok(sameNet(r, 'U1_R1-2', 'U2_R1-1'), '두 블록 사이의 MID')
  assert.ok(!sameNet(r, 'U1_R1-1', 'U2_R1-1'), '다른 인스턴스의 같은 포트 이름은 잇지 않는다')
  const line = r.text.split('\n').find((l) => l.startsWith('R_U1_R1'))
  assert.match(line, /^R_U1_R1 A MID 10K$/)
})

test('계층: 아래 회로도가 다른 파일에 있으면 resolve 로 찾고, 못 찾으면 말한다', () => {
  const top = hierDoc()
  const childPage = top.pages.pop()
  const child = { ...top, pages: [childPage], file: 'lib.dsn' }
  top.pages[0].instances.forEach((i) => { i.implementation = { name: 'CHILD', path: '.\\lib.dsn', type: 4 } })
  const found = dsnToNetlist(top, { resolve: (p, n) => (p === '.\\lib.dsn' && n === 'CHILD' ? child : null) })
  assert.ok(found.parts.some((p) => p.ref === 'U1_R1'))
  const lost = dsnToNetlist(top, { resolve: () => null })
  assert.ok(lost.warnings.some((w) => /아래 회로도 CHILD/.test(w)))
  assert.ok(lost.parts.some((p) => p.ref === 'U1'), '부품 하나로 남는다')
})

test('템플릿: 소자 줄이 둘 이상이면 Capture 처럼 .subckt 로 싼다', () => {
  const doc = hierDoc()
  doc.pages[1].instances = [{ ref: 'S1', value: 'S', sourcePart: 'S', part: 'S.Normal', section: 0, x: 0, y: 0, properties: { RON: '2' }, implementation: { name: '', path: '', type: 2 }, pins: [{ order: 1, x: 0, y: 0 }, { order: 2, x: 100, y: 0 }, { order: 3, x: 300, y: 300 }, { order: 4, x: 400, y: 400 }] }]
  const r = dsnToNetlist(doc)
  assert.ok(r.text.includes('.subckt CHILD_U1_S1 1 2 3 4\nS_U1_S1 3 4 1 2 _U1_S1\nRS_U1_S1 1 2 1G\n.MODEL _U1_S1 VSWITCH Ron=2\n.ends CHILD_U1_S1'), r.text)
  assert.match(r.text, /^X_U1_S1 A MID NC_U1_S1_\S+ NC_U1_S1_\S+ CHILD_U1_S1$/m)
  assert.equal(read(r.text).subckts.length, 2)
})

test('대조 도구: 틀린 넷리스트를 틀렸다고 한다', () => {
  // 비교기 자체가 느슨하면 합격률이 의미가 없다
  const als = '.ALIASES\nR_R1 R1(1=A 2=B ) CN @x\nR_R2 R2(1=B 2=C ) CN @x\n.ENDALIASES\n'
  const net = '* t\nR_R1 A B 1k\nR_R2 B C 2k\n'
  const mine = (text, refs = ['R_R1', 'R_R2']) => ({ text, elements: refs.map((ref) => ({ spiceRef: ref, ref, text: text.split('\n').find((l) => l.startsWith(ref)) })) })
  assert.equal(compare(mine('R_R1 X Y 1k\nR_R2 Y Z 2k'), net, als).ok, true, '넷 이름만 다르면 같다')
  assert.equal(compare(mine('R_R1 X Y 1k\nR_R2 W Z 2k'), net, als).connectivityOk, false, '끊어진 넷')
  assert.equal(compare(mine('R_R1 X Y 1k\nR_R2 X Z 2k'), net, als).connectivityOk, false, '다른 핀에 붙은 넷')
  assert.equal(compare(mine('R_R1 X Y 1k\nR_R2 Y Z 3k'), net, als).valuesOk, false, '값')
  assert.equal(compare(mine('R_R1 X Y 1k', ['R_R1']), net, als).refsOk, false, '빠진 소자')
  assert.equal(compare(mine('R_R1 X Y 1k\nR_R2 Y Z 2k\nR_R3 Y Z 2k', ['R_R1', 'R_R2', 'R_R3']), net, als).refsOk, false, '더 있는 소자')
  assert.deepEqual(samePartition([{ key: 'a', a: 'X', b: 'A' }, { key: 'b', a: 'X', b: 'A' }]), [])
  assert.equal(samePartition([{ key: 'a', a: 'X', b: 'A' }, { key: 'b', a: 'Y', b: 'A' }]).length, 1)
  assert.equal(parseAls(als).elements.get('R_R2').pins[1].net, 'C')
  assert.equal(parseNet(net).elements.size, 2)
})

// ---------- 망가진 입력: 바이너리 ----------
test('망가진 입력: CFBF 가 아니면 분명한 오류와 0 이 아닌 종료 코드', { skip: noBinary }, () => {
  const dir = tmpDir()
  const f = path.join(dir, 'not-cfbf.dsn')
  fs.writeFileSync(f, 'this is just a text file, not an OrCAD design\n'.repeat(40))
  const r = run([binary, f])
  assert.equal(r.status, 2, r.stderr)
  assert.equal(r.signal, null)
  assert.equal(r.stdout, '', 'stdout 에 아무것도 없어야 한다')
  assert.match(r.stderr, /not an OrCAD file/)

  const empty = path.join(dir, 'empty.dsn')
  fs.writeFileSync(empty, '')
  const e = run([binary, empty])
  assert.equal(e.status, 2)
  assert.match(e.stderr, /not an OrCAD file/)

  const missing = run([binary, path.join(dir, 'nothing-here.dsn')])
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /not found/)

  const usage = run([binary])
  assert.equal(usage.status, 1)
  fs.rmSync(dir, { recursive: true })
})

test('망가진 입력: 잘린 파일', { skip: noBinary }, () => {
  const dir = tmpDir()
  const whole = fs.readFileSync(fixture('0000.OLB'))
  for (const keep of [0.9, 0.5, 0.2, 0.09]) {
    const f = path.join(dir, `cut-${keep}.olb`)
    fs.writeFileSync(f, whole.subarray(0, Math.floor(whole.length * keep)))
    const r = run([binary, f])
    assert.equal(r.status, 2, `${keep}: ${r.stderr}`)
    assert.equal(r.signal, null)
    assert.equal(r.stdout, '')
    assert.match(r.stderr, /truncated|not an OrCAD file/, `${keep}: ${r.stderr}`)
  }
  fs.rmSync(dir, { recursive: true })
})

test('망가진 입력: 진짜 설계를 자르면', { skip: skipDesign('BeagleBoard-xM_ORCAD.DSN') }, () => {
  const dir = tmpDir()
  const whole = fs.readFileSync(designPath('BeagleBoard-xM_ORCAD.DSN'))
  for (const keep of [0.7, 0.3]) {
    const f = path.join(dir, 'cut.dsn')
    fs.writeFileSync(f, whole.subarray(0, Math.floor(whole.length * keep)))
    const r = run([binary, f])
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /truncated/)
  }
  fs.rmSync(dir, { recursive: true })
})

test('망가진 입력: CFBF 인데 OrCAD 가 아니면', { skip: noBinary }, () => {
  const dir = tmpDir()
  const bytes = Buffer.from(fs.readFileSync(fixture('0000.OLB')))
  const name = Buffer.from('Library', 'utf16le')
  const at = bytes.indexOf(name)
  assert.ok(at > 0, '디렉터리에서 Library 항목을 찾아야 한다')
  bytes.write('X', at + 12, 'utf16le') // Librarr → 다른 이름의 스트림이 된다
  const f = path.join(dir, 'other.bin')
  fs.writeFileSync(f, bytes)
  const r = run([binary, f])
  assert.equal(r.status, 3, r.stderr)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /no Library stream/)
  fs.rmSync(dir, { recursive: true })
})

test('망가진 입력: 내용이 깨져도 죽지 않고 코드로 알린다', { skip: noBinary }, () => {
  const dir = tmpDir()
  const whole = fs.readFileSync(fixture('0000.OLB'))
  // 고정 시드로 스트림 영역의 바이트를 흐트러뜨린다
  let seed = 12345
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
  for (let round = 0; round < 12; round++) {
    const bytes = Buffer.from(whole)
    for (let k = 0; k < 40; k++) bytes[1024 + (next() % (bytes.length - 1024))] = next() & 0xff
    const f = path.join(dir, `fuzz-${round}.olb`)
    fs.writeFileSync(f, bytes)
    const r = run([binary, f], { timeout: 120000 })
    assert.ok(r.signal === null, `signal ${r.signal}`)
    assert.ok([0, 2, 3, 4].includes(r.status), `status ${r.status}: ${r.stderr}`)
    if (r.status === 0) JSON.parse(r.stdout)
    else { assert.equal(r.stdout, ''); assert.match(r.stderr, /orcad2json:/) }
  }
  fs.rmSync(dir, { recursive: true })
})

test('임시 파일을 남기지 않고, 표준 출력에는 JSON 만 나온다', { skip: noBinary }, () => {
  const tmp = tmpDir(), cwd = tmpDir()
  const r = run([binary, fixture('0000.OLB')], { cwd, env: { ...process.env, TMPDIR: tmp } })
  assert.equal(r.status, 0, r.stderr)
  const json = JSON.parse(r.stdout)
  assert.deepEqual(fs.readdirSync(tmp), [], '임시 폴더')
  assert.deepEqual(fs.readdirSync(cwd), [], '현재 폴더 (파서는 logs/ 를 여기에 만든다)')
  assert.equal(json.kind, 'olb')
  fs.rmSync(tmp, { recursive: true }); fs.rmSync(cwd, { recursive: true })
})

test('심볼 라이브러리: OrCAD 가 내보낸 XML 과 같다', { skip: noBinary }, () => {
  // artcraft/openorcad-src/test/test_cases/0000.xml: Package name="0000" refdesPrefix="U", CellName="0000"
  const r = run([binary, fixture('0000.OLB')])
  const json = JSON.parse(r.stdout)
  assert.deepEqual(json.pages, [])
  assert.equal(json.parts.length, 1)
  assert.equal(json.parts[0].name, '0000')
  assert.equal(json.parts[0].refDes, 'U')
  assert.deepEqual(json.symbols.map((s) => s.name), ['0000.Normal'])
  assert.ok(Array.isArray(json.warnings))
  assert.throws(() => dsnToNetlist(json), /olb/)
})

// ---------- 실제 설계: BeagleBoard-xM ----------
const XM = 'BeagleBoard-xM_ORCAD.DSN'
const AI = 'BeagleBone-AI.dsn'

test('BeagleBoard-xM: 페이지와 부품 수 (PDF 10쪽, 쪽마다 찾은 부품)', { skip: skipDesign(XM) }, () => {
  const { json, result } = design(XM)
  assert.deepEqual(json.pages.map((p) => [p.name, p.instances.length]), [
    ['P01_COVER', 0], ['P02_USB OTG and POWER', 39], ['P03_PROCESSOR_A', 7], ['P04_PROCESSOR_B', 57], ['P05_PROCESSOR_C', 75],
    ['P06_PMIC_PERIPH', 48], ['P07_PMIC _POWER', 55], ['P08_SD,RS232,CAMERA,EXPANSION', 35], ['P09_DVI-D, LCD', 81], ['P10_USB, HUB, & ETHERNET', 90],
  ])
  assert.equal(result.stats.instances, 487)
  assert.equal(result.parts.length, 438)
  assert.equal(result.nets.length, 398)
  assert.equal(result.parts.reduce((n, p) => n + p.pins.length, 0), 2143)
})

test('BeagleBoard-xM: 이름 있는 부품의 값 (PDF·BOM 에서 읽은 값)', { skip: skipDesign(XM) }, () => {
  const { result } = design(XM)
  const by = new Map(result.parts.map((p) => [p.ref, p]))
  for (const [ref, value, page] of [
    ['R121', '510', 'P02_USB OTG and POWER'], // 부품 이름은 RES_620K 인데 도면 값은 510. 값을 진짜 값 자리에서 읽는지 가른다
    ['R12', '330', 'P02_USB OTG and POWER'], ['R11', '10K,DNI', 'P02_USB OTG and POWER'], ['C3', '0.1uF,10V', 'P02_USB OTG and POWER'],
    ['D13', 'LTST-C150CKT', 'P02_USB OTG and POWER'], ['U2', 'TPS2141PWP', 'P02_USB OTG and POWER'], ['U3', 'TL1963A', 'P02_USB OTG and POWER'],
    ['U4', 'DM3730_ES1.2', 'P03_PROCESSOR_A'], ['U7', 'TPS65950', 'P06_PMIC_PERIPH'], ['U12', 'TXS0102DCU', 'P09_DVI-D, LCD'], ['Y3', '32KHz Crystal', 'P06_PMIC_PERIPH'],
  ]) {
    assert.equal(by.get(ref)?.value, value, ref)
    assert.ok(by.get(ref).pages.includes(page), `${ref} 는 ${page} 에`)
  }
  assert.equal(by.get('U4').pins.length, 515, 'BGA 515볼, 조각 3개')
  assert.equal(by.get('U4').sections, 3)
  assert.equal(by.get('U7').pins.length, 209, 'BGA 209볼')
  assert.equal(by.get('Q2').sections, 2, 'Q2A, Q2B')
  assert.equal(by.get('Y3').pins.length, 2, 'Y3: Cache 의 2핀 사본이 맞다(Packages 사본은 4핀)')
})

test('BeagleBoard-xM: PDF 에서 핀까지 대조한 넷', { skip: skipDesign(XM) }, () => {
  const { result } = design(XM)
  assertNet(result, 'PWRLED_R (2쪽 D5-R12)', ['D5-1', 'R12-2'])
  assertNet(result, '3V3_ADJ (2쪽 U2.9 ADJ, R9, R10)', ['U2-9', 'R9-2', 'R10-1'])
  assertNet(result, 'VBAT_FB (2쪽 U3.5 ADJ, R14, R15)', ['U3-5', 'R14-1', 'R15-1'])
  assertNet(result, 'U31 FLAG→R121 (2쪽)', ['U31-3', 'R121-1'])
  assertNet(result, 'R121→D13 (2쪽, 이름 없는 넷)', ['R121-2', 'D13-1'])
  assertNet(result, 'nDC_PWR (2쪽 R138, Q2A.6 → 6쪽 U7.M4)', ['R138-2', 'Q2-6', 'U7-M4'])
  assertNet(result, 'I2C1_SCL (4쪽 U4.K21, R19 → 6쪽 U7.D5)', ['U4-K21', 'R19-2', 'U7-D5'])
  assertNet(result, 'I2C3_SCL (4쪽 U4.AF14 → 9쪽 U12.5, P13.14)', ['U4-AF14', 'U12-5', 'P13-14'])
  assertNet(result, 'I2C3_SDA (4쪽 U4.AG14 → 9쪽 U12.4, P11.15)', ['U4-AG14', 'U12-4', 'P11-15'])
  assertNet(result, 'HSUSB_DP (2쪽 P1.3 D+, D4 → 6쪽 U7.T10)', ['P1-3', 'D4-2', 'U7-T10'])
  // PDF(2011-01-03)에는 Q2A.2 가 R144 를 거쳐 DC_IN 에 간다. 파일(2011-02-04 저장)에는 R144 가 없고 Q2.2 가 nUSB_PWR 에 있다.
  assertNet(result, 'nUSB_PWR (파일 기준)', ['R11-2', 'P2-3', 'U2-5', 'P13-12', 'Q2-2'])
  assert.equal(netHolding(result, 'R11', '2').node, 'NUSB_PWR')
  assert.equal(netHolding(result, 'U4', 'K21').node, 'I2C1_SCL')
  assert.ok(!result.parts.some((p) => p.ref === 'R144'), 'R144 는 파일에 없다')
})

test('BeagleBoard-xM: 미연결 핀과 no-connect 표시 (6쪽의 X 표시, 2쪽의 Q2B)', { skip: skipDesign(XM) }, () => {
  const { result } = design(XM)
  const u7 = new Map(result.parts.find((p) => p.ref === 'U7').pins.map((p) => [p.number, p]))
  for (const n of ['D2', 'N14', 'P13', 'A2', 'K9', 'F9']) {
    assert.equal(u7.get(n).net, null, n)
    assert.equal(u7.get(n).noConnect, true, n)
  }
  const q2 = new Map(result.parts.find((p) => p.ref === 'Q2').pins.map((p) => [p.number, p]))
  for (const n of ['3', '4', '5']) { assert.equal(q2.get(n).net, null, n); assert.equal(q2.get(n).noConnect, false, n) }
  assert.equal(result.stats.unconnectedPins, 245)
})

test('BeagleBoard-xM: 넷 이름과 수가 Capture 자신의 표와 같다', { skip: skipDesign(XM) }, () => {
  const { json, result } = design(XM)
  const h = json.hierarchy[0]
  assert.equal(h.instances, 487, '부품 조각')
  assert.equal(h.offPages, 299, '페이지 연결자')
  assert.equal(h.pages, 10)
  const flat = flatten(json)
  assert.deepEqual(flat.nets.map((n) => n.name.toUpperCase()).sort(), h.nets.map((n) => n.name.toUpperCase()).sort())
  assert.equal(result.nets.length, h.nets.length)
})

const partition = (nets) => new Set(nets.filter((n) => n.pins.length).map((n) => n.pins.map((p) => `${p.ref}|${p.pin.page}|${p.pin.order}|${p.pin.x}|${p.pin.y}`).sort().join(',')))

for (const name of [XM, AI]) {
  test(`${name}: 파일의 id 와 좌표만으로 구한 연결이 같다`, { skip: skipDesign(name) }, () => {
    const { json } = design(name)
    const ids = flatten(json, { mode: 'ids' }), geom = flatten(json, { mode: 'geometry' })
    assert.equal(ids.mode, 'ids')
    assert.equal(geom.mode, 'geometry')
    const a = partition(ids.nets), b = partition(geom.nets)
    assert.equal(a.size, b.size)
    assert.deepEqual([...a].filter((x) => !b.has(x)), [])
    assert.deepEqual([...b].filter((x) => !a.has(x)), [])
  })

  test(`${name}: 회전·반전·연결점 해독이 도면 좌표를 그대로 설명한다`, { skip: skipDesign(name) }, () => {
    const { json } = design(name)
    const symbols = new Map(json.symbols.filter((s) => s.kind === 'part').map((s) => [s.name, s]))
    const turn = (dx, dy, deg, mirror) => {
      let x = mirror ? -dx : dx, y = dy
      for (let i = 0; i < deg / 90; i++) [x, y] = [y, -x]
      return [x, y]
    }
    let pairs = 0, seenTurned = 0
    for (const p of json.pages) for (const i of p.instances) {
      const s = symbols.get(i.part)
      if (i.rotation) seenTurned++
      const [a, ...rest] = i.pins
      if (!a) continue
      const sa = s.pins[a.order - 1]
      for (const b of rest) {
        const sb = s.pins[b.order - 1]
        const [wx, wy] = turn(sb.x - sa.x, sb.y - sa.y, i.rotation, i.mirror)
        assert.deepEqual([b.x - a.x, b.y - a.y].map((v) => v + 0), [wx + 0, wy + 0], `${i.ref} ${b.order}`)
        pairs++
      }
    }
    assert.ok(pairs > 1000)
    assert.ok(seenTurned > 50)

    // 전원 기호와 페이지 연결자의 연결점은 같은 이름 넷의 선 위나 핀 위에 있다
    const onWire = (w, x, y) => (w.x1 === w.x2 ? x === w.x1 && y >= Math.min(w.y1, w.y2) && y <= Math.max(w.y1, w.y2) : y === w.y1 && x >= Math.min(w.x1, w.x2) && x <= Math.max(w.x1, w.x2))
    for (const p of json.pages) {
      const idsOf = new Map()
      for (const n of p.nets) { const k = n.name.toUpperCase(); if (!idsOf.has(k)) idsOf.set(k, new Set()); idsOf.get(k).add(n.id) }
      for (const c of [...p.globals, ...p.offPage]) {
        assert.equal(c.exact, true, c.symbol)
        const hit = p.wires.some((w) => onWire(w, c.x, c.y) && idsOf.get(c.name.toUpperCase())?.has(w.net))
        const pin = p.instances.some((i) => i.pins.some((q) => q.x === c.x && q.y === c.y))
        assert.ok(hit || pin, `${p.name} ${c.name} (${c.x},${c.y})`)
      }
    }
  })

  test(`${name}: 넷리스트를 pspice.mjs 가 다시 읽으면 소자 수가 같다`, { skip: skipDesign(name) }, () => {
    const { result } = design(name)
    const doc = read(result.text)
    assert.equal(doc.elements.length, result.elements.length)
    assert.deepEqual(doc.warnings, [])
    assert.equal(doc.title, result.title)
    assert.ok(doc.elements.length >= result.parts.length * 0.9, '조각마다 한 줄이어도 부품 수보다 크게 적을 수 없다')
    const known = new Map(result.parts.map((p) => [p.ref, p.pins.length]))
    for (const e of doc.elements) {
      const ref = e.ref.replace(/^[A-Z]+_/, '')
      if (known.has(ref)) assert.equal(e.nodes.length, known.get(ref), e.ref)
    }
    const again = read(write(doc))
    assert.equal(again.elements.length, doc.elements.length, 'write() 를 거쳐도')
    assert.deepEqual(again.elements.map((e) => e.nodes.join(' ')), doc.elements.map((e) => e.nodes.join(' ')))
  })
}

test('BeagleBoard-xM: PCB 넷리스트(IPC-356A) 전체와 대조', { skip: skipFile(XM, 'BeagleBoard_xM_RevC1_IPC356A.ipc') }, () => {
  const { result } = design(XM)
  const pcb = new Map()
  for (const line of fs.readFileSync(designPath('BeagleBoard_xM_RevC1_IPC356A.ipc'), 'latin1').split(/\r?\n/)) {
    if (!/^3[0-9][0-9]/.test(line)) continue
    const net = line.slice(3, 17).trim(), ref = line.slice(20, 26).trim(), pin = line.slice(27, 31).trim()
    if (ref && ref !== 'VIA') pcb.set(`${ref}-${pin}`, net)
  }
  const mine = new Map()
  for (const p of result.parts) for (const q of p.pins) mine.set(`${p.ref}-${q.number}`, q.net)
  // R144 는 PCB(2011-08)에 있고 이 파일에 없다. 그것 말고는 모든 패드가 있어야 한다.
  assert.deepEqual([...pcb.keys()].filter((k) => !mine.has(k)).sort(), ['R144-1', 'R144-2'])
  assert.deepEqual([...mine.keys()].filter((k) => !pcb.has(k)), [])
  const pcbToMine = new Map(), mineToPcb = new Map()
  for (const [k, net] of pcb) {
    const m = mine.get(k)
    if (m === undefined) continue
    if (m === null) { assert.ok(net === 'N/C' || [...pcb.values()].filter((v) => v === net).length === 1, `${k}: 미연결로 읽었는데 PCB 는 ${net}`); continue }
    if (!pcbToMine.has(net)) pcbToMine.set(net, new Set())
    pcbToMine.get(net).add(m)
    if (!mineToPcb.has(m)) mineToPcb.set(m, new Set())
    mineToPcb.get(m).add(net)
  }
  const split = [...pcbToMine].filter(([, s]) => s.size > 1), spread = [...mineToPcb].filter(([, s]) => s.size > 1)
  assert.deepEqual(split, [], '하나의 PCB 넷이 내 넷 여럿으로 갈린 경우')
  assert.deepEqual(spread.map(([m, s]) => [m, [...s].sort()]), [['NUSB_PWR', ['N28217649', 'NUSB_PWR']]], 'R144 때문에 Q2.2 하나만 다르다')
})

// ---------- 실제 설계: BeagleBone AI ----------
test('BeagleBone AI: 페이지와 부품 수', { skip: skipDesign(AI) }, () => {
  const { json, result } = design(AI)
  assert.deepEqual(json.pages.map((p) => p.instances.length), [0, 0, 54, 50, 55, 44, 10, 77, 50, 28, 12, 44, 70, 59, 32, 65, 49, 31, 17])
  assert.equal(json.pages[4].name, '05 AM572x SYSTEM')
  assert.equal(result.stats.instances, 747)
  assert.equal(result.parts.length, 716)
  assert.equal(result.nets.length, 595)
  assert.equal(result.parts.reduce((n, p) => n + p.pins.length, 0), 3135)
  const by = new Map(result.parts.map((p) => [p.ref, p]))
  for (const [ref, value] of [['U4', 'AM5729BABCXEAR'], ['U3', 'TPS6590377ZWSR'], ['R193', '4.7K'], ['R57', '18K'], ['R58', '20K'], ['X7', '20MHz'], ['J91', '10118241-001RLF'], ['U78', 'STMPE811QTR'], ['U10', 'TPS3808G33DBVT']]) {
    assert.equal(by.get(ref)?.value, value, ref)
  }
  assert.equal(by.get('U4').pins.length, 760)
})

test('BeagleBone AI: PDF 에서 핀까지 대조한 넷', { skip: skipDesign(AI) }, () => {
  const { result } = design(AI)
  assertNet(result, 'I2C1_SCL (5쪽 U4.C20, R193 / 3쪽 R148, R149 / 17쪽 R542 / 18쪽 R706)', ['U4-C20', 'R193-1', 'R148-1', 'R149-1', 'R542-2', 'R706-1'])
  assertNet(result, 'I2C1_SDA', ['U4-C21', 'R194-1', 'R145-1', 'R146-1', 'R543-2', 'R707-1'])
  assertNet(result, 'RST_PMIC_L (5쪽 R57, R58 / 3쪽 R159)', ['R57-2', 'R58-1', 'R159-1'])
  assertNet(result, 'OSC0_IN (5쪽 U4.AE15, X7.3, C13, R11)', ['U4-AE15', 'X7-3', 'C13-1', 'R11-1'])
  assertNet(result, 'HDMI_CKN (19쪽 J91.14 CLK-, U91.A3)', ['J91-14', 'U91-A3'])
  assertNet(result, '3V3_USB (3쪽 U3.B9, C134 / 12쪽 U4.AA12, U4.Y12, C148)', ['U3-B9', 'C134-1', 'U4-AA12', 'U4-Y12', 'C148-1'])
})

test('BeagleBone AI: 넷 이름과 수가 Capture 자신의 표와 같다', { skip: skipDesign(AI) }, () => {
  const { json } = design(AI)
  const h = json.hierarchy[0]
  assert.equal(h.instances, 747)
  assert.equal(h.offPages, 480)
  const flat = flatten(json)
  assert.deepEqual(flat.nets.map((n) => n.name.toUpperCase()).sort(), h.nets.map((n) => n.name.toUpperCase()).sort())
})

test('BeagleBone AI: Allegro 핀 표 전체와 대조', { skip: skipFile(AI, 'cds2f_BeagleBone-AI.txt') }, () => {
  const { result } = design(AI)
  const pcb = new Map()
  let inNets = false
  for (const line of fs.readFileSync(designPath('cds2f_BeagleBone-AI.txt'), 'latin1').split(/\r?\n/)) {
    if (line.startsWith('A!')) { inNets = line.startsWith('A!NET_NAME!REFDES!PIN_NUMBER!'); continue }
    if (inNets && line.startsWith('S!')) { const f = line.split('!'); pcb.set(`${f[2]}-${f[3]}`, f[1]) }
  }
  assert.equal(pcb.size, 3135)
  const mine = new Map()
  for (const p of result.parts) for (const q of p.pins) mine.set(`${p.ref}-${q.number}`, q.net)
  assert.deepEqual([...pcb.keys()].filter((k) => !mine.has(k)), [])
  assert.deepEqual([...mine.keys()].filter((k) => !pcb.has(k)), [])
  const a = new Map(), b = new Map()
  const add = (m, k, v) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(v) }
  for (const [k, net] of pcb) {
    const m = mine.get(k)
    if (m === null) { assert.ok(!net || [...pcb.values()].filter((v) => v === net).length === 1, `${k}: 미연결로 읽었는데 PCB 는 ${net}`); continue }
    add(a, net, m); add(b, m, net)
  }
  assert.deepEqual([...a].filter(([, s]) => s.size > 1), [])
  assert.deepEqual([...b].filter(([, s]) => s.size > 1), [])
})

// ---------- Capture 가 직접 만든 넷리스트 ----------
// 설계마다 파일 안의 회로도 이름과 맞는 넷리스트 하나를 고른다. 같은 설계의 다른 넷리스트는 이름을 바꾸기 전의 옛것이다.
// 아래는 이유가 확인된 실패다. 여기에 없는 실패는 시험을 깨뜨린다. 이유는 evidence.md 에 있다.
const KNOWN_FAILURES = new Map([
  ['UA741.DSN', '넷리스트가 파일보다 옛것: 파일에는 V3, V6, VIN, R15 가 없고 파일의 넷 표에서 VI1, VI2 는 0 과 같은 넷이다'],
  ['AMPLIFICATOR AUDIO DE PUTERE.DSN', '넷리스트가 파일보다 옛것: 파일은 R28A·R28B, 넷리스트는 R28-1·R28-2'],
  ['LED5.DSN', '넷리스트가 지금 없는 회로도 SCHEMATIC1 의 것'],
  ['MULTIVIBRATOR.DSN', '넷리스트가 지금 없는 회로도 SCHEMATIC1 의 것'],
])

function otherDesign(dsn, docs) {
  return (implPath) => {
    if (!implPath) return null
    const rel = implPath.replace(/\\/g, '/')
    const base = path.dirname(dsn), name = path.basename(rel).toLowerCase()
    const dirs = [path.resolve(base, path.dirname(rel)), base]
    for (const e of fs.readdirSync(base, { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(base, e.name))
    for (const d of dirs) {
      if (!fs.existsSync(d)) continue
      const hit = fs.readdirSync(d).find((f) => f.toLowerCase() === name)
      if (!hit) continue
      const file = path.join(d, hit)
      if (!docs.has(file)) {
        const r = run([binary, file])
        docs.set(file, r.status === 0 ? JSON.parse(r.stdout) : null)
      }
      if (docs.get(file)) return docs.get(file)
    }
    return null
  }
}

const capturePairs = () => findPairs(null, testFiles)
const noCorpus = () => noBinary || (capturePairs().length ? false : 'ORCAD_TEST_DIR 아래에 설계와 Capture 넷리스트 짝이 없어요')

test('Capture 넷리스트 대조: 부품 이름, 값, 연결(넷 이름 빼고)', { skip: noCorpus(), timeout: 900000 }, (t) => {
  const byDsn = new Map()
  for (const p of capturePairs()) { if (!byDsn.has(p.dsn)) byDsn.set(p.dsn, []); byDsn.get(p.dsn).push(p) }
  const docs = new Map()
  const load = (file) => {
    if (!docs.has(file)) {
      const r = run([binary, file])
      docs.set(file, r.status === 0 ? JSON.parse(r.stdout) : null)
    }
    return docs.get(file)
  }

  let pass = 0, elements = 0, values = 0, pins = 0
  const failures = []
  for (const [dsn, list] of byDsn) {
    const name = path.basename(dsn)
    const doc = load(dsn)
    if (!doc) { failures.push({ name, why: '읽지 못함' }); continue }
    const views = new Set(doc.pages.map((p) => p.view.toUpperCase()))
    const chosen = list.find((p) => views.has(p.view.toUpperCase())) ?? list[0]
    const res = dsnToNetlist(doc, { view: views.has(chosen.view.toUpperCase()) ? chosen.view : undefined, resolve: otherDesign(dsn, docs) })
    const c = compare(res, fs.readFileSync(chosen.net, 'latin1'), chosen.als ? fs.readFileSync(chosen.als, 'latin1') : null)
    elements += c.compared; values += c.valuesCompared; pins += c.pinsCompared
    if (c.ok) pass++
    else failures.push({ name, why: `빠짐 ${c.missing.slice(0, 3)} 더 있음 ${c.extra.slice(0, 3)} 연결 ${c.partitionBad.length} 값 ${JSON.stringify(c.valueDiffs.slice(0, 2))}` })
  }
  t.diagnostic(`설계 ${byDsn.size}개 중 ${pass}개 통과. 소자 ${elements}, 핀 ${pins}, 값 ${values} 대조. 실패: ${failures.map((f) => f.name).join(', ')}`)
  const unexpected = failures.filter((f) => !KNOWN_FAILURES.has(f.name))
  assert.deepEqual(unexpected, [])
  assert.ok(pass > 0)
})

test('Capture 넷리스트 대조: 계층 설계 하나를 글자까지', { skip: skipDesign('_FIG3_23_MSD.DSN') }, () => {
  // 아래 회로도(스위치, 이상 op-amp)가 _library_CMOSedu_MSD/CMOSEDU_MSD.DSN 에 있다
  const r = run([cli, designPath('_FIG3_23_MSD.DSN')])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.split('\n')
  // _Fig3_23_MSD.net 에서 옮긴 줄 (자동 넷 이름 N02284 등은 이름만 다르다)
  for (const want of ['V_VDD VDD 0 DC 1', 'V_VCM VCM 0 DC .5', '+PULSE 0 1 0 200p 200p 4n 10n', '+SIN .5 500m 1.59Meg 0 0 0', 'R_U2_R1 0 U2_VTRIP  100Meg TC=0,0', '.MODEL _U2_S1 VSWITCH Roff=1e9 Ron=1.0 Voff=-1e-3 Von=1e-3', 'S_U2_S1 3 4 1 2 _U2_S1']) {
    assert.ok(lines.includes(want), want)
  }
  assert.ok(lines.some((l) => /^G_U1_G1 0 VOUT VCM \S+ 1Meg$/.test(l)))
  assert.ok(lines.some((l) => /^X_U2_S1 PHI1 U2_VTRIP VOUT \S+ switches_2_U2_S1$/.test(l)))
})

test('그려지지 않는 전원 핀은 Capture 처럼 $G_DPWR, $G_DGND 로 간다', { skip: skipDesign('SPICE_DIFFCIRCUIT.DSN') }, () => {
  // 넷 이름을 보지 않는 대조로는 잡히지 않는다. 오른쪽은 Capture 의 SCHEMATIC1.net 그대로다
  const { result } = design('SPICE_DIFFCIRCUIT.DSN')
  assert.equal(result.stats.hiddenPowerPins, 14)
  const line = (ref) => result.text.split('\n').find((l) => l.startsWith(`${ref} `))
  assert.equal(line('X_U1A'), 'X_U1A N00440 N00433 $G_DPWR $G_DGND 7405 PARAMS:')
  assert.equal(line('X_U2A'), 'X_U2A N00454 N00447 $D_HI $D_HI OUTPUT OUTPUT_BAR $G_DPWR $G_DGND 74107 PARAMS:')
})

// ---------- 스트림 이름 겹침 ----------
test('마지막 점 뒤만 다른 부품을 둘 다 읽는다', { skip: skipDesign('wwng2333__lib1.OLB') }, () => {
  // 파서는 AMS1117-3.3 과 AMS1117-3.3V 를 같은 파일에 풀어 하나를 잃는다. wwng2333 공개 저장소의 lib1.OLB
  const r = run([binary, designPath('wwng2333__lib1.OLB')])
  assert.equal(r.status, 0, r.stderr)
  const parts = new Map(JSON.parse(r.stdout).parts.map((p) => [p.name, p]))
  assert.equal(parts.get('AMS1117-3.3')?.pins.length, 3)
  assert.equal(parts.get('AMS1117-3.3V')?.pins.length, 4)
})

// ---------- 옛 형식 (Library 2.0) ----------
test('옛 형식: PSpice Model Editor 가 만든 심볼 라이브러리', { skip: skipDesign('TPS72301.OLB') }, () => {
  const r = run([binary, designPath('TPS72301.OLB')])
  assert.equal(r.status, 0, r.stderr)
  const json = JSON.parse(r.stdout)
  assert.equal(json.format.version, '2.0')
  assert.equal(json.parts.length, 1)
  // 같은 프로젝트의 넷리스트 X_U1 0 VIN VIN N08163 VOUT TPS72301 과 템플릿 순서가 같다
  assert.deepEqual(json.parts[0].pins.map((p) => [p.name, p.number]), [['GND', '1'], ['IN', '2'], ['EN', '3'], ['FB', '4'], ['OUT', '5']])
  assert.match(json.symbols[0].properties.PSpiceTemplate, /^X\^@REFDES %GND %IN %EN %FB %OUT @MODEL/)
})

test('옛 형식: 설계. 넷리스트와 공통인 소자의 값과 모델 이름이 같다', { skip: skipFile('UA741.DSN', 'UA741-SCHEMATIC1.net') }, () => {
  const r = run([binary, designPath('UA741.DSN')])
  assert.equal(r.status, 0, r.stderr)
  const json = JSON.parse(r.stdout)
  assert.equal(json.format.version, '2.0')
  assert.equal(json.pages[0].instances.length, 39)
  const result = dsnToNetlist(json)
  const c = compare(result, fs.readFileSync(designPath('UA741-SCHEMATIC1.net'), 'latin1'), fs.readFileSync(designPath('UA741-SCHEMATIC1.ALS'), 'latin1'))
  // 넷리스트가 파일보다 옛것이라 다음 넷만 다르다: V3, V6, VIN, R15 가 지워졌고 VI1, VI2 가 접지에 붙었다
  assert.deepEqual(c.missing.sort(), ['R_R15', 'V_V3', 'V_V6', 'V_VIN'])
  assert.deepEqual(c.extra, [])
  assert.ok(c.compared >= 35, `대조한 소자 ${c.compared}`)
  assert.ok(c.valueDiffs.every((d) => d.ref.startsWith('.')), JSON.stringify(c.valueDiffs))
  const by = new Map(result.parts.map((p) => [p.ref, p]))
  assert.equal(by.get('R1').value, read(fs.readFileSync(designPath('UA741-SCHEMATIC1.net'), 'latin1')).elements.find((e) => e.ref === 'R_R1').value.replace(/\s*TC=.*$/, ''))
  assert.match(result.text, /^Q_Q7 \+VCC \S+ \S+ QbreakN$/m)
})

// ---------- 명령 ----------
test('dsn2cir 명령: -o, --bom, 오류 코드', { skip: skipDesign(XM) }, () => {
  const dir = tmpDir()
  const out = path.join(dir, 'out.cir')
  const r = run([cli, designPath(XM), '-o', out])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  const text = fs.readFileSync(out, 'utf8')
  assert.match(text, /^\* BeagleBoard-xM_ORCAD/)
  assert.match(text, /^R_R121 \S+ \S+ 510$/m)
  assert.match(text, /\.END\n$/)
  assert.equal(read(text).elements.length, design(XM).result.elements.length)

  const b = run([cli, designPath(XM), '--bom'])
  assert.equal(b.status, 0)
  assert.match(b.stdout, /^count,value,part,footprint,refs/)
  assert.match(b.stdout, /510,RES_620K_1%_0603,.*R121/)
  fs.rmSync(dir, { recursive: true })
})

test('dsn2cir 명령: 망가진 입력은 같은 오류 코드로 끝난다', { skip: noBinary }, () => {
  const dir = tmpDir()
  const f = path.join(dir, 'bad.dsn')
  fs.writeFileSync(f, 'not cfbf'.repeat(200))
  const r = run([cli, f])
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /not an OrCAD file/)
  const n = run([cli])
  assert.equal(n.status, 1)
  fs.rmSync(dir, { recursive: true })
})
