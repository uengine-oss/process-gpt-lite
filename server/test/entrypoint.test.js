import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../install/docker/pgpt-entrypoint.sh')

test('entrypoint recreates the data folders an empty volume hides', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pgpt-data-'))
  execFileSync('sh', [script, 'true'], { env: { ...process.env, PGPT_DATA_ROOT: root, LOOPBACK_FORWARD: '' } })
  for (const name of ['folders', 'craft', 'browser-profiles']) {
    assert.ok(fs.statSync(path.join(root, name)).isDirectory(), name)
  }
  fs.rmSync(root, { recursive: true })
})
