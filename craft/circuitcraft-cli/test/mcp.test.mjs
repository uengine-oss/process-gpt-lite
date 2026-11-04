// CircuitCraft MCP 를 실제 클라이언트처럼 stdio 로 부른다. 값은 이론과 비교한다.
//   cd craft/circuitcraft-cli && node --test test/mcp.test.mjs
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const BIN = fileURLToPath(new URL('../bin/circuitcraft-cli', import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out-'))
const LIB = `.SUBCKT OPA IN+ IN- OUT VCC VEE\nRin IN+ IN- 2MEG\nE1 int 0 VALUE = { LIMIT(100k*V(IN+,IN-), V(VEE,0)+1, V(VCC,0)-1) }\nRout int OUT 75\n.ENDS\n`
const CIR = `* HS-200 front end\n.LIB "hs200.lib"\n.PARAM RF=10k\nVS in 0 AC 1 SIN(0 0.1 1k)\nR1 in n 1k\nR2 n out {RF}\nCF n out 1.6n\nX1 0 n out vcc vee OPA\nVCC vcc 0 15\nVEE vee 0 -15\n.STEP PARAM RF LIST 10k 22k\n.TRAN 1u 3m\n.AC DEC 40 10 1MEG\n.PROBE\n.END\n`
fs.writeFileSync(path.join(root, 'hs200.cir'), CIR)
fs.writeFileSync(path.join(root, 'hs200.lib'), LIB)
fs.writeFileSync(path.join(outside, 'x.cir'), CIR)
let c
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args })
  const text = r.content[0].text
  if (r.isError) { const e = new Error(text); e.tool = true; throw e }
  return JSON.parse(text)
}
before(async () => {
  c = new Client({ name: 't', version: '1' })
  await c.connect(new StdioClientTransport({ command: BIN, args: ['mcp', '--automation-read-root', root, '--automation-write-root', root], stderr: 'ignore' }))
})
after(async () => { await c.close(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }) })

test('도구 이름에 앱 접두사가 없다(craft.js 가 붙인다)', async () => {
  const names = (await c.listTools()).tools.map((t) => t.name)
  assert.deepEqual(names, ['open', 'simulate', 'measure', 'plot', 'bom', 'edit', 'save'])
})
test('허용된 폴더 밖은 읽지도 쓰지도 않는다', async () => {
  await assert.rejects(call('open', { path: path.join(outside, 'x.cir') }), /폴더 밖/)
})
test('연 문서: 옆의 라이브러리를 찾고, 해석과 스텝을 알려 준다', async () => {
  const o = await call('open', { path: path.join(root, 'hs200.cir') })
  assert.equal(o.title, 'HS-200 front end')
  assert.equal(o.parts, 7)
  assert.deepEqual(o.runs, ['TRAN RF=10k', 'AC RF=10k', 'TRAN RF=22k', 'AC RF=22k'])
  assert.deepEqual(o.unsupported, [])
})
test('돌린다: 이득과 차단 주파수가 이론과 맞다', async () => {
  const s = await call('simulate')
  assert.equal(s.ok, true)
  const near = (a, b, pct, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${m} 기대 ${b} 실제 ${a}`)
  near((await call('measure', { run: 'TRAN RF=10k', vector: 'v(out)', what: 'max' })).value, 1.0, 2, 'TRAN 진폭 0.1 V × 10')
  near((await call('measure', { run: 'TRAN RF=22k', vector: 'v(out)', what: 'max' })).value, 2.2, 3, 'TRAN 진폭 0.1 V × 22')
  const bw = await call('measure', { run: 'AC RF=10k', vector: 'v(out)', what: 'bandwidth' })
  near(bw.low_frequency_gain, 10, 1, '저주파 이득')
  near(bw.value, 1 / (2 * Math.PI * 10e3 * 1.6e-9), 3, '차단')
  const bw2 = await call('measure', { run: 'AC RF=22k', vector: 'v(out)', what: 'bandwidth' })
  near(bw2.value, 1 / (2 * Math.PI * 22e3 * 1.6e-9), 3, '차단(22k)')
})
test('없는 실행·없는 벡터는 있는 것을 알려 주며 거절한다', async () => {
  await assert.rejects(call('measure', { run: 'TRAN RF=1', vector: 'v(out)', what: 'max' }), /있는 것/)
  await assert.rejects(call('measure', { run: 'TRAN RF=10k', vector: 'v(zzz)', what: 'max' }), /있는 것/)
})
test('rms·평균·지점 값', async () => {
  const near = (a, b, pct, m) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${m} 기대 ${b} 실제 ${a}`)
  near((await call('measure', { run: 'TRAN RF=10k', vector: 'v(out)', what: 'rms' })).value, Math.SQRT1_2, 3, 'rms')
  assert.ok(Math.abs((await call('measure', { run: 'TRAN RF=10k', vector: 'v(out)', what: 'avg' })).value) < 0.02)
  near(Math.abs((await call('measure', { run: 'TRAN RF=10k', vector: 'v(out)', what: 'at', at: 0.75e-3 })).value), 1, 3, 'at')
})
test('그래프: 진짜 PNG 를 쓴다', async () => {
  const f = path.join(root, 'ac.png')
  const r = await call('plot', { path: f, runs: ['AC RF=10k', 'AC RF=22k'], vectors: ['v(out)'], title: '주파수 응답' })
  assert.deepEqual(r.series, ['RF=10k', 'RF=22k'])
  const b = fs.readFileSync(f)
  assert.equal(b.subarray(1, 4).toString(), 'PNG'); assert.ok(b.length > 10000)
  await assert.rejects(call('plot', { path: path.join(outside, 'x.png'), runs: ['AC RF=10k'], vectors: ['v(out)'] }), /폴더 밖/)
})
test('부품표: 소스는 빼고 묶는다', async () => {
  const b = await call('bom')
  assert.equal(b.parts, 4)
  const refs = Object.fromEntries(b.rows.map((r) => [r.refs.join(), r.value]))
  assert.equal(refs.R1, '1k'); assert.equal(refs.X1, 'OPA'); assert.equal(refs.CF, '1.6n')
  assert.equal(refs.R2, '10k, 22k', '.STEP 으로 도는 값을 푼다')
})
test('고치고 저장한 넷리스트를 다시 열어 돌리면 바뀐 값이 나온다', async () => {
  const e = await call('edit', { ref: 'R1', value: '2k' })
  assert.deepEqual(e, { ref: 'R1', from: '1k', to: '2k' })
  await assert.rejects(call('edit', { ref: 'X1', value: '3' }), /바꿀 수 없는/)
  await assert.rejects(call('edit', { ref: 'R1', value: '1k; .INC /etc/passwd' }), /쓸 수 없어요/)
  const out = path.join(root, 'edited.cir')
  await call('save', { path: out })
  await call('open', { path: out })
  await call('simulate')
  const v = (await call('measure', { run: 'TRAN RF=10k', vector: 'v(out)', what: 'max' })).value
  assert.ok(Math.abs(v - 0.5) < 0.02, `0.1 V × 10k/2k = 0.5, 실제 ${v}`)
})
test('옮기지 못하는 회로는 돌리지 않고 이유를 준다', async () => {
  const f = path.join(root, 'lap.cir')
  fs.writeFileSync(f, '* lap\nV1 in 0 AC 1\nE1 out 0 LAPLACE {V(in)} = {1/(1+s)}\nR1 out 0 1k\n.AC DEC 10 1 1k\n.END\n')
  const o = await call('open', { path: f })
  assert.ok(o.unsupported.some((u) => /LAPLACE/.test(u)))
  const s = await call('simulate')
  assert.equal(s.ok, false); assert.equal(s.runs.length, 0); assert.ok(s.unsupported.length)
})
