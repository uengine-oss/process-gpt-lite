// 가동률이 포화(97%)를 넘는 사람이 있어도 대기 계산이 끝나야 개선 화면이 열린다.
// 예전에는 포화값으로 자기 자신을 다시 불렀고, 부동소수 반올림으로 포화가 풀리지 않으면 스택이 넘쳤다.
import test from 'node:test'
import assert from 'node:assert/strict'
import { erlangWq } from '../lib/improve/whatif.js'

test('포화를 넘는 어떤 처리량에서도 대기 시간을 돌려준다', () => {
  for (let i = 1; i <= 2000; i++) {
    const mu = i / 97
    for (const c of [1, 2, 3]) {
      for (const rho of [0.97, 1, 1.5]) {
        const w = erlangWq(rho * c * mu, mu, c)
        assert.ok(Number.isFinite(w) && w > 0, `mu=${mu} c=${c} rho=${rho}`)
      }
    }
  }
})

test('포화를 넘을수록 대기가 길고, 포화 아래는 공식 값 그대로다', () => {
  assert.ok(erlangWq(1.5, 1, 1) > erlangWq(1, 1, 1))
  assert.ok(Math.abs(erlangWq(0.5, 1, 1) - 1) < 1e-9) // M/M/1: ρ/(μ-λ) = 0.5/0.5
})
