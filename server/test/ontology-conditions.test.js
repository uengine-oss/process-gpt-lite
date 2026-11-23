// 갈림길 조건(design-v0.3 §25, lib/ontology/conditions.js): 건마다 일의 순서에서 갈래별 예시를 모은다. 모델 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import { stepsOf, branchesOf } from '../lib/ontology/conditions.js'

test('건의 순서에서 갈래마다 그쪽으로 간 건을 모은다: 이어진 같은 일은 한 걸음, 마지막 일은 「끝」', () => {
  const ev = (c, task, at, ref) => ({ case: c, task, at: `2026-10-0${at}T00:00:00Z`, ref, said: task })
  const steps = stepsOf([ev('a', '접수', 1, 'm1'), ev('a', '접수', 2, 'm2'), ev('a', '회신', 3, 'm3'), ev('b', '접수', 1, 'm4'), ev('b', '미팅', 2, 'm5'), ev('c', '접수', 4, 'm6')])
  assert.deepEqual(steps.get('a').map((s) => s.task), ['접수', '회신'])
  const br = branchesOf(steps).get('접수')
  assert.deepEqual([...br.keys()].sort(), ['__end__', '미팅', '회신'])
  assert.equal(br.get('회신')[0].x.ref, 'm2')   // the step's last record: what was said right before the branch
  assert.equal(br.get('회신')[0].y.ref, 'm3')
  assert.equal(br.get('__end__')[0].y, null)
})
