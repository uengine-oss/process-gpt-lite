// Where the process-gpt checkout and the ArtCraft apps live. Everything is overridable by env;
// the defaults follow the process-gpt-lite repository layout (backends/process-gpt, artcraft/).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// repository root: server/lib/ → ../..
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// PGPT_ROOT → backends/process-gpt (git submodule) → ~/process-gpt (a separate checkout)
const candidates = [path.join(REPO_ROOT, 'backends', 'process-gpt'), path.join(os.homedir(), 'process-gpt')]
export const PGPT_ROOT = process.env.PGPT_ROOT
  || candidates.find((p) => fs.existsSync(path.join(p, 'services')))
  || candidates[0]

// ArtCraft (see artcraft/README.md): web builds under artcraft/web, CLIs on PATH unless set
export const ARTCRAFT_ROOT = process.env.PRO_ARTCRAFT_ROOT || path.join(REPO_ROOT, 'artcraft')
