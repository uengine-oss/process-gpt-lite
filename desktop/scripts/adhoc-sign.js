// macOS without a Developer ID: sign the packed app ad hoc before the DMG is made, or Apple Silicon reports a
// downloaded copy as damaged (only the linker's signature, broken by electron-builder's edits to the bundle).
// An ad hoc signed copy opens after 「확인할 수 없습니다」 → System Settings › Privacy & Security › 「그래도 열기」.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'darwin') return
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
