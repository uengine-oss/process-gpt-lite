// Vault key management for operators. Never prints a secret or a key.
//   node scripts/vault-admin.mjs status              keyring, DEK distribution, item counts
//   node scripts/vault-admin.mjs verify              open every item; back-fill v2 fingerprints
//   node scripts/vault-admin.mjs rotate-kek          new KEK becomes current, every DEK rewrapped
//   node scripts/vault-admin.mjs rewrap              rewrap DEKs still under a retired KEK (after an env KEK change)
//   node scripts/vault-admin.mjs prune-kek           drop retired KEKs no DEK uses
//   node scripts/vault-admin.mjs rotate-dek <user-id|--all>   new DEK, items re-encrypted
// Restart the server after rotate-kek / prune-kek so it loads the new keyring.
import * as vault from '../lib/vault.js'
import { q, pool } from '../lib/supa.js'

const [cmd, arg] = process.argv.slice(2)
const print = (o) => console.log(JSON.stringify(o, null, 2))

try {
  switch (cmd) {
    case 'status': {
      print({
        keyring: vault.vaultInfo(),
        deks: await q('select kek_id, dek_version, count(*)::int users from pro_vault_keys group by 1, 2 order by 1'),
        items: await q('select kind, coalesce(status, \'active\') status, count(*)::int n from pro_vault_items group by 1, 2 order by 1, 2'),
      })
      break
    }
    case 'verify': print(await vault.verifyAll()); break
    case 'rotate-kek': print(await vault.rotateKek()); break
    case 'rewrap': print(await vault.rewrap()); break
    case 'prune-kek': print(await vault.pruneKeks()); break
    case 'rotate-dek': {
      if (!arg) throw new Error('usage: rotate-dek <user-id|--all>')
      const users = arg === '--all' ? (await q('select user_id from pro_vault_keys')).map((r) => r.user_id) : [arg]
      const out = []
      for (const u of users) out.push(await vault.rotateDek(u))
      print(out)
      break
    }
    default:
      console.log('commands: status | verify | rotate-kek | rewrap | prune-kek | rotate-dek <user-id|--all>')
      process.exitCode = 1
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
