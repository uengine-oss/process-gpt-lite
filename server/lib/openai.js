// The OpenAI key and address for speech and translation (meeting transcription and interpretation, the
// interpreter's voice, message translation). Read like every other key here: this server's environment first, then
// process-gpt's .env (OPENAI_API_KEY). It never leaves the server — browsers get none of it.
//   PRO_INTERP_API_KEY > PRO_TRANSCRIBE_API_KEY > OPENAI_API_KEY > process-gpt/.env OPENAI_API_KEY
import fs from 'node:fs'
import path from 'node:path'
import dotenv from 'dotenv'
import { PGPT_ROOT } from './paths.js'

let fromFile = null
function pgptKey() {
  if (fromFile !== null) return fromFile
  try { fromFile = dotenv.parse(fs.readFileSync(path.join(PGPT_ROOT, '.env'))).OPENAI_API_KEY || '' } catch { fromFile = '' }
  return fromFile
}
export const transcribeKey = () => process.env.PRO_TRANSCRIBE_API_KEY || process.env.OPENAI_API_KEY || pgptKey()
export const openaiKey = () => process.env.PRO_INTERP_API_KEY || transcribeKey()
export const openaiBase = () => (process.env.PRO_INTERP_BASE_URL || process.env.PRO_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '')
