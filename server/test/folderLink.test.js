// 「저장소 연결」 — registering a repository on this server's own disk as a folder is for an install that
// serves one company: off behind the ProcessGPT gateway (PRO_TENANT_FROM_HEADER=1, production) and with more
// tenants by host name (PRO_TENANT_HOSTS), and PRO_FOLDERS_LINK=0 turns it off on an install too. Who may (an
// administrator) and where (never a place this server keeps folders in) is in e2e F-FO-02.
//   cd server && node --test test/folderLink.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { linkingOn, mayLink } from '../lib/folders/service.js'

test('linking a repository on the server is only for an install that serves one company', async () => {
  const saved = { fromHeader: config.tenantFromHeader, hosts: config.tenantHosts, env: process.env.PRO_FOLDERS_LINK }
  try {
    Object.assign(config, { tenantFromHeader: false, tenantHosts: '' })
    delete process.env.PRO_FOLDERS_LINK
    assert.equal(linkingOn(), true)
    config.tenantFromHeader = true
    assert.equal(linkingOn(), false, 'behind the gateway (production)')
    assert.equal(await mayLink({ id: '00000000-0000-0000-0000-000000000001' }), false)
    config.tenantFromHeader = false
    config.tenantHosts = 'en.localhost=en-demo'
    assert.equal(linkingOn(), false, 'more tenants by host name')
    config.tenantHosts = ''
    process.env.PRO_FOLDERS_LINK = '0'
    assert.equal(linkingOn(), false, 'turned off on an install')
    delete process.env.PRO_FOLDERS_LINK
    assert.equal(await mayLink(null), false, 'nobody signed in')
  } finally {
    Object.assign(config, { tenantFromHeader: saved.fromHeader, tenantHosts: saved.hosts })
    if (saved.env === undefined) delete process.env.PRO_FOLDERS_LINK
    else process.env.PRO_FOLDERS_LINK = saved.env
  }
})
