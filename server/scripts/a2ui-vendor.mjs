// A2UI v1.0 의 공식 JSON Schema 세 개와 기본 카탈로그(basic v1)를 Lite 로 가져온다 — 단계 입력 화면(lib/stepUi)이 쓰는 것.
//   node scripts/a2ui-vendor.mjs <a2ui 체크아웃>      (github.com/a2ui-project/a2ui, Apache-2.0)
// 하는 일:
//   - specification/v1_0/json 의 common_types · agent_to_renderer · renderer_to_agent 를 lib/stepUi/a2ui/ 에 그대로 복사한다.
//   - catalogs/basic/v1/catalog.json 에서 Lite 단계 카탈로그(lib/stepUi/catalog.json)의 컴포넌트 · 함수를 다시 뽑는다:
//     COMPONENTS · FUNCTIONS 에 적은 것만, TextField 의 obscured(비밀번호 칸)는 뺀다. 카탈로그의 이름 · 설명 · 지침(instructions)은
//     지금 catalog.json 에 쓰인 것을 그대로 둔다 — 그것은 손으로 쓴다.
// A2UI 판을 올릴 때(1.0 → 1.x) 이 스크립트를 다시 돌리고, src/components/a2ui/runtime.js 의 같은 목록과 서버 시험을 본다.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, '..', 'lib', 'stepUi')
const src = process.argv[2]
if (!src || !fs.existsSync(path.join(src, 'specification', 'v1_0', 'json'))) {
  console.error('usage: node scripts/a2ui-vendor.mjs <a2ui checkout>')
  process.exit(1)
}
const { COMPONENTS, FUNCTIONS } = await import('../lib/stepUi/catalogInfo.js')
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

fs.mkdirSync(path.join(OUT, 'a2ui'), { recursive: true })
for (const f of ['common_types.json', 'agent_to_renderer.json', 'renderer_to_agent.json']) {
  fs.copyFileSync(path.join(src, 'specification', 'v1_0', 'json', f), path.join(OUT, 'a2ui', f))
}

const basic = read(path.join(src, 'catalogs', 'basic', 'v1', 'catalog.json'))
const mine = read(path.join(OUT, 'catalog.json'))
const components = Object.fromEntries(COMPONENTS.map((n) => {
  const c = structuredClone(basic.components[n])
  if (!c) throw new Error(`basic catalog has no component ${n}`)
  return [n, c]
}))
// no password-style field: a step screen never asks for a secret
const tf = components.TextField.allOf.find((x) => x.properties?.variant).properties.variant
tf.enum = tf.enum.filter((v) => v !== 'obscured')
const functions = Object.fromEntries(FUNCTIONS.map((n) => {
  const f = basic.functions[n]
  if (!f) throw new Error(`basic catalog has no function ${n}`)
  return [n, structuredClone(f)]
}))
const out = {
  $schema: basic.$schema,
  $id: mine.$id,
  protocolVersion: '1.0',
  title: mine.title,
  description: mine.description,
  catalogId: mine.catalogId,
  instructions: mine.instructions,
  components,
  functions,
  $defs: {
    anyComponent: { oneOf: COMPONENTS.map((n) => ({ $ref: `#/components/${n}` })), discriminator: { propertyName: 'component' } },
    anyFunction: { oneOf: FUNCTIONS.map((n) => ({ $ref: `#/functions/${n}` })) },
    Weight: basic.$defs.Weight,
  },
}
fs.writeFileSync(path.join(OUT, 'catalog.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`lib/stepUi/catalog.json: ${COMPONENTS.length} components, ${FUNCTIONS.length} functions; schemas copied`)
