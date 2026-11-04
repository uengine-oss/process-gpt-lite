// 넷리스트를 돌리는 자식 프로세스. ngspice 치명 오류는 exit(1) 이고 약속이 끝나지 않아서, 부모가 시간을 재고 남은 것을 실패로 친다.
// 여러 건은 한 엔진으로 이어서 돌린다(점마다 .OP 를 돌리는 스윕이 빠르다): 건마다 RESULT 한 줄.
import fs from 'node:fs'
import { Simulation } from 'eecircuit-engine'
const { netlists } = JSON.parse(fs.readFileSync(0, 'utf8'))
const sim = new Simulation()
await sim.start()
const write = (s) => new Promise((r) => process.stdout.write(s, r))
for (const [i, netlist] of netlists.entries()) {
  sim.setNetList(netlist)
  const r = await sim.runSim()
  const errors = (sim.getError?.() || []).filter((e) => !/^Note: /.test(e.trim()) && e.trim())
  await write(`\nRESULT ${i} ` + JSON.stringify({ dataType: r.dataType, numPoints: r.numPoints, data: r.data.map((d) => ({ name: d.name, type: d.type, values: d.values })), errors }) + '\n')
}
process.exit(0)
