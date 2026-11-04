// Builds Chili3D unchanged for /craft/solidcraft/: its own config, with our page template (no remote
// analytics tag) and an output folder outside its source tree. Run from the Chili3D folder (build.sh).
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const CHILI = process.env.CHILI3D_SRC
const OUT = process.env.SOLIDCRAFT_BUILD_DIR
if (!CHILI || !OUT) throw new Error('set CHILI3D_SRC and SOLIDCRAFT_BUILD_DIR (build.sh does)')
const rspack = createRequire(path.join(CHILI, 'package.json'))('@rspack/core')
const upstream = (await import(pathToFileURL(path.join(CHILI, 'rspack.config.ts')).href)).default

const nameOf = (plugin) => plugin?.name || plugin?.constructor?.name
export default {
  ...upstream,
  plugins: [
    // the source is untouched, so its type check has nothing to add here
    ...upstream.plugins.filter((p) => !['TsCheckerRspackPlugin', 'HtmlRspackPlugin'].includes(nameOf(p))),
    new rspack.HtmlRspackPlugin({ template: path.join(import.meta.dirname, 'index.template.html'), inject: 'body' }),
  ],
  // "auto": chunks and WASM resolve from the script's own URL, so /craft/solidcraft/ and a product
  // served under a base path (src/base.js) both work
  output: { ...upstream.output, path: OUT, publicPath: 'auto' },
}
