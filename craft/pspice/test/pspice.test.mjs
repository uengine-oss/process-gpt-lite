// PSpice 호환: 옮긴 넷리스트를 실제 ngspice(WASM)로 돌려 값을 이론과 비교한다. 실제 벤더 모델도 넣는다(fixtures, PySpice 저장소의 공개 라이브러리).
//   cd craft/circuitcraft-cli && npm i && cd ../pspice && node --test test/pspice.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { read, write, toNgspice, rewriteExpr, number, safeNode } from '../pspice.mjs'
import { simulateText, magnitude } from '../../circuitcraft-cli/sim.mjs'

// 벤더 모델은 재배포 조건이 있어 저장소에 넣지 않는다: test/fetch-models.sh 로 받으면 함께 돈다
const fx = (n) => fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'latin1')
const vendor = (n) => ({ skip: fs.existsSync(new URL(`./fixtures/${n}`, import.meta.url)) ? false : `${n} 없음(test/fetch-models.sh)` })
const near = (a, b, pct, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${msg || ''} 기대 ${b}, 실제 ${a}`)
const vec = (run, name) => run.data.find((d) => d.name.toLowerCase() === name)?.values.map(magnitude)
const max = (a) => Math.max(...a), min = (a) => Math.min(...a)
const one = async (text, files) => { const r = await simulateText(text, { files }); assert.ok(r.ok, JSON.stringify(r).slice(0, 400)); return r }

test('식: IF·LIMIT·PWR·PWRS·STP·TABLE·논리곱을 옮긴다', () => {
  assert.equal(rewriteExpr('IF(V(a)>1,2,3)'), '((V(a)>1) ? (2) : (3))')
  assert.equal(rewriteExpr('LIMIT(x,0,5)'), 'min(max(x,0),5)')
  assert.match(rewriteExpr('LIMIT(x,0,5)', () => {}, { behavioral: true }), /tanh/)
  assert.equal(rewriteExpr('PWR(x,2)'), 'pow(abs(x),2)')
  assert.equal(rewriteExpr('STP(x)'), 'u(x)')
  assert.equal(rewriteExpr('IF(a>1&b<2,1,0)'), '((a>1&&b<2) ? (1) : (0))')
  assert.equal(rewriteExpr('V(IN+,IN-)'), 'V(IN_P,IN_N)')
  assert.equal(rewriteExpr('IF(IF(a,1,2)>1,3,4)'), '((((a) ? (1) : (2))>1) ? (3) : (4))')
})
test('수: SPICE 단위 글자', () => {
  for (const [s, v] of [['1k', 1e3], ['1MEG', 1e6], ['1M', 1e-3], ['10uF', 10e-6], ['5Vdc', 5], ['1.5e3', 1500], ['100n', 100e-9], ['2mil', 50.8e-6]]) near(number(s), v, 1e-6, s)
  assert.equal(safeNode('IN+'), 'IN_P'); assert.equal(safeNode('N001'), 'N001'); assert.equal(safeNode('+5V'), '_P5V')
})

test('RC 저역통과: 차단 주파수가 이론과 맞다(.AC, .PARAM)', async () => {
  const r = await one(`* RC\nV1 in 0 AC 1 DC 0\nR1 in out {RV}\nC1 out 0 100n\n.PARAM RV=1.6k\n.AC DEC 200 10 100k\n.PROBE\n.END`)
  const f = vec(r.runs[0], 'frequency'), v = vec(r.runs[0], 'v(out)')
  const corner = f[v.findIndex((x) => x < Math.SQRT1_2)]
  near(corner, 1 / (2 * Math.PI * 1600 * 100e-9), 2, '차단')
})
test('E VALUE = IF(): 3 V 에서 자른다. ngspice 그대로면 프로세스가 죽는 문법이다', async () => {
  const r = await one(`* if\n.PARAM VCC=5V\nV1 in 0 PULSE(0 {VCC} 1m 1u 1u 5m 10m)\nR1 in a 1k\nD1 a out DMOD\nC1 out 0 10u\nR2 out 0 10k\nE1 lim 0 VALUE = { IF(V(out) > 3, 3, V(out)) }\nRlim lim 0 1k\n.MODEL DMOD D(IS=1E-14 N=1.05 RS=0.5)\n.TRAN 10u 30m 0 10u\n.PROBE V(out) V(lim)\n.END`)
  near(max(vec(r.runs[0], 'v(lim)')), 3, 1, 'V(lim)')
  assert.ok(max(vec(r.runs[0], 'v(out)')) > 3.01)
})
const OPAMP = `.SUBCKT OPAMP1 IN+ IN- OUT VCC VEE\nRin IN+ IN- 2MEG\nE1 int 0 VALUE = { LIMIT(100k*V(IN+,IN-), V(VEE,0)+1, V(VCC,0)-1) }\nRout int OUT 75\n.ENDS\n`
test('op-amp 매크로(IN+ IN-, LIMIT): 이득 -10 이 맞다. 옮기지 않으면 99 kV 를 낸다', async () => {
  const r = await one(`* inv\n${OPAMP}VCC vcc 0 DC 15\nVEE vee 0 DC -15\nVS in 0 SIN(0 0.5 1k)\nR1 in n 1k\nR2 n out 10k\nX1 0 n out vcc vee OPAMP1\n.TRAN 1u 3m\n.PROBE\n.END`)
  near(max(vec(r.runs[0], 'v(out)')), 5, 1, 'V(out) 진폭')
  near(min(vec(r.runs[0], 'v(out)')), -5, 1, 'V(out) 진폭')
  assert.ok(r.warnings.some((w) => /LIMIT/.test(w)), '근사를 했다고 말한다')
})
test('op-amp 포화: 레일 근처에서 멈춘다', async () => {
  const r = await one(`* sat\n${OPAMP}VCC vcc 0 DC 15\nVEE vee 0 DC -15\nVS in 0 SIN(0 2 1k)\nR1 in n 1k\nR2 n out 10k\nX1 0 n out vcc vee OPAMP1\n.TRAN 1u 3m\n.END`)
  const peak = max(vec(r.runs[0], 'v(out)'))
  assert.ok(peak > 13.5 && peak < 14.1, `${peak}`)
})
test('.STEP PARAM LIST·구간: 값마다 따로 돈다', async () => {
  const net = (s) => `* step\nV1 in 0 DC 1\nR1 in out {R}\nR2 out 0 1k\n.PARAM R=1k\n${s}\n.OP\n.END`
  const r = await one(net('.STEP PARAM R LIST 1k 3k'))
  assert.deepEqual(r.runs.map((x) => x.step), ['R=1k', 'R=3k'])
  near(vec(r.runs[0], 'v(out)')[0], 0.5, 0.1); near(vec(r.runs[1], 'v(out)')[0], 0.25, 0.1)
  const two = await one(`* two\nV1 in 0 DC 1\nR1 in out {R}\nR2 out 0 {S}\n.PARAM R=1k S=1k\n.STEP PARAM R LIST 1k\n.STEP PARAM S LIST 3k\n.OP\n.END`)
  near(vec(two.runs[0], 'v(out)')[0], 0.75, 0.1, '한 줄의 두 값을 다 바꾼다')
  const q = await one(net('.STEP PARAM R 1k 3k 1k'))
  assert.equal(q.runs.length, 3); near(vec(q.runs[1], 'v(out)')[0], 1 / 3, 0.1)
})
test('.TEMP 여러 값·.STEP TEMP: 온도마다 다이오드 전압이 달라진다', async () => {
  const r = await one(`* t\nI1 0 a DC 1m\nD1 a 0 D1N\n.MODEL D1N D(IS=1e-14)\n.TEMP 27 85\n.OP\n.END`)
  assert.equal(r.runs.length, 2)
  assert.ok(vec(r.runs[1], 'v(a)')[0] < vec(r.runs[0], 'v(a)')[0], '온도가 오르면 순방향 전압이 준다')
})
test('TABLE: 범위 밖은 평평하다(PSpice 동작)', async () => {
  const r = await one(`* table\nV1 a 0 PWL(0 -3 1m 8)\nE1 b 0 TABLE {V(a)} = (0,0) (5,10)\nRb b 0 1k\n.TRAN 10u 1m\n.PROBE\n.END`)
  near(max(vec(r.runs[0], 'v(b)')), 10, 0.5); assert.ok(Math.abs(min(vec(r.runs[0], 'v(b)'))) < 0.01)
})
test('Capture 넷리스트 꼴: R_R1, 5Vdc, TC=0,0, .TRAN 0, .PROBE64, 줄 이음', async () => {
  const r = await one(`* source DEMO\nV_V1 N1 0\n+PULSE 0 5Vdc 0 1n 1n 5m 10m\nR_R1 N1 OUT 1k TC=0,0\nC_C1 OUT 0 1u\n.TRAN 0 10ms\n.PROBE64 V(alias(*)) I(alias(*))\n.END`)
  assert.ok(max(vec(r.runs[0], 'v(out)')) > 4.9)
})
test('VSWITCH: 켜지면 통한다', async () => {
  const r = await one(`* sw\nV1 c 0 PULSE(0 5 1m 1u 1u 1m 2m)\nV2 a 0 DC 10\nS1 a b c 0 SMOD\nR1 b 0 1k\n.MODEL SMOD VSWITCH(RON=1 ROFF=1MEG VON=3 VOFF=1)\n.TRAN 10u 4m\n.END`)
  near(max(vec(r.runs[0], 'v(b)')), 10, 1); assert.ok(min(vec(r.runs[0], 'v(b)')) < 0.1)
})
test('.TRAN 과 .AC 가 같이 있으면 둘 다 돌린다', async () => {
  const r = await one(`* two\nV1 in 0 DC 0 AC 1 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 100n\n.TRAN 10u 2m\n.AC DEC 10 100 100k\n.END`)
  assert.deepEqual(r.runs.map((x) => x.label), ['TRAN', 'AC'])
  assert.equal(r.runs[1].dataType, 'complex')
})
test('못 옮기는 것은 돌리지 않고 말한다: LAPLACE·FREQ·OPTIONAL:', async () => {
  for (const [line, word] of [['E1 out 0 LAPLACE {V(in)} = {1/(1+s)}', 'LAPLACE'], ['E1 out 0 FREQ {V(in)} = (1,0,0) (2,1,0)', 'FREQ']]) {
    const r = await simulateText(`* x\nV1 in 0 AC 1\n${line}\nR1 out 0 1k\n.AC DEC 10 1 1k\n.END`)
    assert.equal(r.ok, false); assert.equal(r.runs.length, 0); assert.ok(r.unsupported.some((u) => u.includes(word)), JSON.stringify(r.unsupported))
  }
  assert.ok(toNgspice(`* x\nU1 DPWR DGND a b D_LS04 IO_LS\n.OP\n.END`).unsupported.some((u) => /디지털/.test(u)))
  assert.ok(toNgspice(`* x\n.SUBCKT A 1 2 OPTIONAL: 3=0\nR1 1 2 1k\n.ENDS\nX1 a b A\nR2 a 0 1k\nR3 b 0 1k\n.OP\n.END`).unsupported.some((u) => /OPTIONAL/.test(u)))
})
test('돌리지 않은 것을 말한다: .MC·.WCASE·해석 명령 없음', () => {
  assert.ok(toNgspice(`* x\nR1 a 0 1k\nV1 a 0 1\n.TRAN 1u 1m\n.MC 10 TRAN V(a) YMAX\n.END`).warnings.some((w) => /\.MC/.test(w)))
  assert.ok(toNgspice(`* x\nR1 a 0 1k\nV1 a 0 1\n.END`).warnings.some((w) => /해석 명령/.test(w)))
})
test('실제 프로젝트에서 나온 꼴: 이름에 빈칸이 있는 .INC, V([OUT]), 안쪽 LIN, 소스 이름 별칭', async () => {
  const net = `V_Vin VIN 0 DC 1\nR_R1 VIN VOUT 1k TC=0,0\nR_R2 0 VOUT 2k TC=0,0\n`
  const r = await one(`** Profile\n.lib "nomd.lib"\n.OP\n.TF V([VOUT]) V_Vin\n.OPTIONS ADVCONV\n.PROBE64 V(alias(*))\n.INC "..\\Fig 1_11.net"\n.END`, { 'fig 1_11.net': net })
  near(vec(r.runs[0], 'v(vout)')[0], 2 / 3, 0.1)
  const d = await one(`** dc\n.DC LIN Vin 0 2 1 LIN V_Vb 0 1 1\nV_Vin a 0 0\nV_Vb b 0 0\nR1 a b 1k\n.END`)
  assert.equal(d.runs[0].ok, true)
})
test('브레이크아웃 부품은 값으로, 손실 전송선은 LTRA 로', async () => {
  const r = await one(`* b\nV1 a 0 PULSE(0 1 0 1n 1n 1 2)\nC_C1 b 0 Cbreak 1n IC=0\nR_R1 a b Rbreak 1k\n.TRAN 10n 10u\n.END`)
  near(max(vec(r.runs[0], 'v(b)')), 1, 1)
  assert.ok(r.warnings.some((w) => /Cbreak/.test(w)))
  const t = await one(`* t\nV1 a 0 PULSE(0 1 0 1n 1n 1 2)\nT_T1 a 0 b 0 LEN=1 R=100 L=0 G=0 C=10p\nRL b 0 1MEG\n.TRAN 1n 2u\n.END`)
  near(max(vec(t.runs[0], 'v(b)')), 1, 2)
})
test('.DC PARAM: 점마다 돌려 곡선 하나로 묶는다', async () => {
  const r = await one(`* p\n.PARAM RX=1k\nV1 a 0 1\nR1 a b {RX}\nR2 b 0 1k\n.DC LIN PARAM RX 1k 3k 1k\n.END`)
  assert.equal(r.runs.length, 1); assert.equal(r.runs[0].label, 'DC RX'); assert.equal(r.runs[0].numPoints, 3)
  const v = vec(r.runs[0], 'v(b)')
  near(v[0], 0.5, 0.1); near(v[2], 0.25, 0.1)
  const dual = await one(`* p\n.PARAM A=1 B=1\nV1 a 0 {A}\nR1 a b {B*1k}\nR2 b 0 1k\n.DC LIN PARAM A 1 2 1 LIN PARAM B 1 3 2\n.END`)
  assert.deepEqual(dual.runs.map((x) => x.label), ['DC A B=1', 'DC A B=3'])
  near(vec(dual.runs[1], 'v(b)')[1], 0.5, 0.1)
})
test('없는 부품 모델·넷리스트·암호화 모델·회로 없는 파일은 이유를 말한다', () => {
  const miss = toNgspice(`* m\nX1 a 0 Sw_tClose\nQ1 a b 0 Q2N3904\nR1 a 0 1\n.OP\n.END`)
  assert.deepEqual(miss.missing.map((m) => m.name), ['Sw_tClose', 'Q2N3904']); assert.ok(miss.unsupported.some((u) => /Q2N3904/.test(u)))
  const many = toNgspice(`* m\nX1 a 0 P1\nX2 a 0 P2\nX3 a 0 P3\nX4 a 0 P4\nX5 a 0 P5\nR1 a 0 1\n.OP\n.END`)
  assert.equal(many.unsupported.length, 1, '많으면 한 줄로 묶는다'); assert.match(many.unsupported[0], /부품 모델 5개가 없어요: P1, P2, P3, P4 외 1개/); assert.equal(many.missing.length, 5)
  assert.ok(toNgspice(`* n\n.INC "gone.net"\n.AC DEC 1 1 10\n.END`).unsupported.some((u) => /gone\.net/.test(u)), '빈 회로를 성공으로 치지 않는다')
  assert.ok(toNgspice(`* l\n.SUBCKT A 1 2\nR1 1 2 1\n.ENDS\n`).unsupported.some((u) => /돌릴 회로가 없어요/.test(u)))
  const sealed = toNgspice(`* e\n.LIB "t.lib"\nX1 a 0 TPS\nR1 a 0 1\n.OP\n.END`, { files: { 't.lib': `.SUBCKT TPS 1 2\n$CDNENCSTART\nabcdef\n$CDNENCFINISH\n.ENDS TPS\n` } })
  assert.ok(sealed.unsupported.some((u) => /TPS 모델은 Cadence 로 암호화/.test(u)), JSON.stringify(sealed.unsupported))
})
test('Q 의 기판 노드와 면적, PARAMS 없는 호출을 구별한다', () => {
  const nodes = (l) => read(`* t\n${l}\n.END`).elements[0]
  assert.deepEqual([nodes('Q1 c b e 0 QM').nodes.length, nodes('Q1 c b e 0 QM').model], [4, 'QM'])
  assert.deepEqual([nodes('Q1 c b e QM 2').nodes.length, nodes('Q1 c b e QM 2').model], [3, 'QM'])
  assert.deepEqual([nodes('Q1 c b e SUB QM').nodes.length, nodes('Q1 c b e SUB QM').model], [4, 'QM'])
  assert.deepEqual([nodes('Q1 c b e QM').nodes.length, nodes('Q1 c b e QM').model], [3, 'QM'])
  assert.equal(nodes('X1 a 0 SUB R=1k').model, 'SUB')
  assert.equal(nodes('X1 a 0 SUB PARAMS: R=1k').model, 'SUB')
})
test('.FOUR 은 .TRAN 에 붙고, 라이브러리 안의 .LIB 를 따라가고, .END 뒤는 돌리지 않고, 서브회로의 .PARAM 은 건드리지 않는다', () => {
  const four = toNgspice(`* f\nV1 a 0 SIN(0 1 1k)\nR1 a 0 1k\n.TRAN 1u 3m\n.FOUR 1k V([a])\n.END`)
  assert.equal(four.runs.length, 1); assert.match(four.runs[0].netlist, /\.TRAN[^\n]*\n\.FOUR 1k V\(a\)/)
  const nested = toNgspice(`* n\n.LIB "a.lib"\nI1 0 x 1m\nD1 x 0 DX\n.OP\n.END`, { files: { 'a.lib': '.LIB "b.lib"\n', 'b.lib': '.MODEL DX D(IS=1e-14)\n' } })
  assert.deepEqual(nested.unsupported, []); assert.ok(nested.runs[0].netlist.includes('.MODEL DX'))
  const two = toNgspice(`* c\nR1 a 0 1\nV1 a 0 1\n.OP\n.END\n* d\nR9 b 0 1\n.OP\n.END`)
  assert.ok(!two.runs[0].netlist.includes('R9')); assert.equal((two.runs[0].netlist.match(/\.OP/g) || []).length, 1); assert.ok(two.warnings.some((w) => /\.END 뒤/.test(w)))
  const sub = toNgspice(`* s\n.PARAM R=1k\n.SUBCKT A 1 2\n.PARAM R=5\nR1 1 2 {R}\n.ENDS\nX1 a 0 A\nV1 a 0 1\nR2 a 0 {R}\n.STEP PARAM R LIST 2k\n.OP\n.END`)
  assert.match(sub.runs[0].netlist, /^\.PARAM R=2k$/m); assert.match(sub.runs[0].netlist, /^\.PARAM R=5$/m)
  assert.ok(toNgspice(`* z\nZ1 c g e MY\nR1 c 0 1\n.OP\n.END`).unsupported.some((u) => /IGBT/.test(u)))
})
test('큰 라이브러리도 빠르게 읽는다', () => {
  const big = Array.from({ length: 200000 }, (_, i) => (i % 2 ? `+ P${i}=1` : `.MODEL M${i} D(IS=1)`)).join('\n')
  const t0 = Date.now(); toNgspice(`* l\n.LIB "b.lib"\nI1 0 a 1m\nD1 a 0 M0\n.OP\n.END`, { files: { 'b.lib': big } })
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`)
})
test('치명 오류가 나도 다음 회로는 돈다', async () => {
  const bad = await simulateText(`* bad\nV1 a 0 1\nB1 b 0 V = nosuchfunction(V(a))\nR1 b 0 1k\n.OP\n.END`)
  assert.equal(bad.ok, false); assert.ok(bad.runs[0].error, JSON.stringify(bad.runs[0]))
  const good = await one(`* ok\nV1 a 0 1\nR1 a 0 1k\n.OP\n.END`)
  near(vec(good.runs[0], 'v(a)')[0], 1, 0.1)
})

// ---------- 실제 벤더 모델 ----------
test('벤더 다이오드 1N4148(.LIB, 서브회로): 1 mA 순방향 전압', vendor('1N4148.lib'), async () => {
  const r = await one(`* d\n.LIB "1N4148.lib"\nI1 0 a DC 1m\nX1 a 0 1N4148\n.OP\n.END`, { '1n4148.lib': fx('1N4148.lib') })
  const v = vec(r.runs[0], 'v(a)')[0]
  assert.ok(v > 0.55 && v < 0.75, `${v}`)
})
test('벤더 트랜지스터 2N2222A: 전류 이득이 자료 범위 안이다', vendor('2N2222A.lib'), async () => {
  const r = await one(`* q\n.LIB 2N2222A.lib\nVC c 0 5\nIB 0 b DC 100u\nQ1 c b 0 2n2222a\n.OP\n.END`, { '2n2222a.lib': fx('2N2222A.lib') })
  const ic = Math.abs(vec(r.runs[0], 'i(vc)')[0])
  assert.ok(ic / 100e-6 > 50 && ic / 100e-6 < 500, `hFE ${ic / 100e-6}`)
})
test('벤더 MOSFET irf150: 켜진 저항이 작다', vendor('irf150.lib'), async () => {
  const r = await one(`* m\n.LIB irf150.lib\nVG g 0 10\nVD d 0 5\nRD d x 10\nX1 x g 0 irf150\n.OP\n.END`, { 'irf150.lib': fx('irf150.lib') })
  assert.ok(vec(r.runs[0], 'v(x)')[0] < 0.1, `${vec(r.runs[0], 'v(x)')[0]}`)
})
test('벤더 op-amp LMV981(.MOD, 복잡한 매크로): 전압 추종기', vendor('LMV981.MOD'), async () => {
  const r = await one(`* f\n.INC "LMV981.MOD"\nVP p 0 DC 5\nVS in 0 DC 2\nRL out 0 10k\nXU1 in out p 0 out p LMV981\n.OP\n.END`, { 'lmv981.mod': fx('LMV981.MOD') })
  near(vec(r.runs[0], 'v(out)')[0], 2, 2, 'V(out)')
})
test('큰 라이브러리에서 쓰는 부품만 가져온다: 안 쓰는 깨진 부품이 회로를 멈추지 않는다', async () => {
  const lib = `.SUBCKT BROKEN 1 2\nE1 1 2 LAPLACE {V(1)} = {1/s}\n.ENDS\n.MODEL DX D(IS=1e-14)\n.SUBCKT GOOD 1 2\nD1 1 2 DX\n.ENDS\n`
  const t = toNgspice(`* c\n.LIB "big.lib"\nI1 0 a 1m\nX1 a 0 GOOD\n.OP\n.END`, { files: { 'big.lib': lib } })
  assert.deepEqual(t.unsupported, []); assert.ok(!t.runs[0].netlist.includes('BROKEN')); assert.ok(t.runs[0].netlist.includes('.MODEL DX'))
})
test('없는 라이브러리는 말한다', () => {
  assert.ok(toNgspice(`* c\n.LIB "gone.lib"\nR1 a 0 1\nV1 a 0 1\n.OP\n.END`).warnings.some((w) => /gone\.lib/.test(w)))
})

// ---------- 읽고 쓰기 ----------
const HS = `* HS-200 front end\n.PARAM RF=10k\nV1 in 0 AC 1 SIN(0 0.1 1k)\nR1 in n 1k\nR2 n out {RF}\nC1 out 0 1n\nX1 0 n out vcc vee OPAMP1\nVCC vcc 0 15\nVEE vee 0 -15\n.MODEL DX D(IS=1e-14)\n${OPAMP}.TRAN 1u 2m\n.AC DEC 20 10 1MEG\n.PROBE\n.END`
test('읽기: 소자·모델·서브회로·해석을 나눈다', () => {
  const d = read(HS)
  assert.equal(d.title, 'HS-200 front end')
  assert.deepEqual(d.elements.map((e) => e.ref), ['V1', 'R1', 'R2', 'C1', 'X1', 'VCC', 'VEE'])
  const x = d.elements.find((e) => e.ref === 'X1')
  assert.deepEqual(x.nodes, ['0', 'n', 'out', 'vcc', 'vee']); assert.equal(x.model, 'OPAMP1')
  assert.equal(d.models[0].kind, 'D'); assert.deepEqual(d.subckts[0].pins, ['IN+', 'IN-', 'OUT', 'VCC', 'VEE'])
  assert.deepEqual(d.analyses, ['.TRAN 1u 2m', '.AC DEC 20 10 1MEG'])
})
test('쓰고 다시 읽어 돌리면 값이 같다(읽기 → 쓰기 왕복)', async () => {
  const again = write(read(HS))
  assert.deepEqual(read(again).elements.map((e) => e.raw), read(HS).elements.map((e) => e.raw))
  const a = await one(HS), b = await one(again)
  assert.equal(a.runs.length, b.runs.length)
  for (let i = 0; i < a.runs.length; i++) near(max(vec(b.runs[i], 'v(out)')), max(vec(a.runs[i], 'v(out)')), 0.01, a.runs[i].label)
})
test('라이브러리 파일: 제목 줄이 없어도 첫 서브회로를 잃지 않는다', vendor('irf150.lib'), () => {
  const d = read(fx('irf150.lib'))
  assert.equal(d.isLibrary, true); assert.equal(d.subckts[0].name, 'irf150'); assert.ok(d.subckts[0].lines.length > 5)
  const out = write(d)
  assert.equal(read(out).subckts[0].lines.length, d.subckts[0].lines.length); assert.ok(!/\.END\s*$/i.test(out))
})

// TDK 모델 파일은 재배포 금지라 저장소에 넣지 않는다: TDK_MODEL 에 받은 .mod 경로를 주면 돈다
test('진짜 TDK MLCC 모델: 임피던스가 커패시턴스와 맞고 자기 공진이 보인다', { skip: process.env.TDK_MODEL ? false : 'TDK_MODEL 없음' }, async () => {
  const text = fs.readFileSync(process.env.TDK_MODEL, 'latin1')
  const name = /\.SUBCKT\s+(\S+)/i.exec(text)[1]
  const farads = Number(process.env.TDK_FARADS)
  const r = await one(`* z\n.INC "m.mod"\nI1 0 a AC 1\nX1 a 0 ${name}\n.AC DEC 100 1MEG 10G\n.END`, { 'm.mod': text })
  const f = vec(r.runs[0], 'frequency'), z = vec(r.runs[0], 'v(a)')
  near(z[0], 1 / (2 * Math.PI * f[0] * farads), 6, '1 MHz 임피던스')
  const i = z.indexOf(min(z))
  assert.ok(i > 0 && i < z.length - 1 && f[i] > 100e6, `자기 공진 ${f[i]}`)
})
