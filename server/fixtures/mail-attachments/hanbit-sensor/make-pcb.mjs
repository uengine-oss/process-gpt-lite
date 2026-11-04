// 연습 메일에 붙는 고객 PCB 3D 모델을 만든다: 보드 80 × 50 × 1.6, M3 구멍 넷, 큰 부품 몇 개, 궤환 커패시터 자리의 1608 부품.
//   node make-pcb.mjs   (solidcraft-cli 설치 뒤) → HS-200_pcb.step
// 1608 부품은 KiCad 라이브러리의 C_0603_1608Metric.step(CC-BY-SA 4.0, 설계에 쓰는 것을 허용하는 예외 조항).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '../../../../craft/solidcraft-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'
import { StdioClientTransport } from '../../../../craft/solidcraft-cli/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(here, '../../../../craft/solidcraft-cli/bin/solidcraft-cli')
const C1608 = process.argv[2] || path.resolve(here, '../../../../craft/solidcraft/test/fixtures/C_0603_1608Metric.step')
const c = new Client({ name: 'make-pcb', version: '1' })
await c.connect(new StdioClientTransport({ command: BIN, args: ['mcp'], stderr: 'inherit' }))
const call = async (name, args) => { const r = await c.callTool({ name, arguments: args }); if (r.isError) throw new Error(`${name}: ${r.content[0].text}`); return JSON.parse(r.content[0].text) }
await call('new', { name: 'HS-200 PCB' })
const box = (name, at, size) => call('add_box', { name, at, size })
await box('PCB', [0, 0, 0], [80, 50, 1.6])
for (const [x, y] of [[3, 3], [77, 3], [3, 47], [77, 47]]) await call('cut_hole', { part: 'PCB', at: [x, y, 0], axis: 'z', diameter: 3.2 })
await box('SENSOR', [8, 20, 1.6], [12, 10, 4])
await box('U1 OPAMP', [30, 18, 1.6], [6, 5, 1.8])
await box('U2 MCU', [44, 14, 1.6], [12, 12, 1.5])
await box('J1 CONNECTOR', [36, 0, 1.6], [12, 8, 6])
await call('import', { path: C1608, at: [38.5, 26, 1.6], name: 'CF C1608', center_xy: true })
console.log(JSON.stringify(await call('inspect', {})).slice(0, 400))
await call('export', { path: path.join(here, 'HS-200_pcb.step'), format: '.step' })
await c.close()
