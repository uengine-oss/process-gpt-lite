// After packing, before the DMG · installer is made (electron-builder's afterPack):
//   1. the app's fuses (0.2.6): cookies on disk sealed with the system's keychain, as Chrome does (EnableCookieEncryption). Flipped here,
//      before signing: electron-builder's own `electronFuses` flips them after this hook, which would break the signature made below.
//      Sealing is one-way for a profile — a cookie is sealed when it is written again.
//   2. macOS without a Developer ID: sign the packed app ad hoc, or Apple Silicon reports a downloaded copy as damaged (only the
//      linker's signature, broken by electron-builder's edits to the bundle). An ad hoc signed copy opens after 「확인할 수 없습니다」 →
//      System Settings › Privacy & Security › 「그래도 열기」.
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.FUSES = { enableCookieEncryption: true }

exports.default = async function afterPack(ctx) {
  await ctx.packager.addElectronFuses(ctx, await ctx.packager.generateFuseConfig(exports.FUSES))
  if (ctx.electronPlatformName !== 'darwin') return
  const app = path.join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
}
