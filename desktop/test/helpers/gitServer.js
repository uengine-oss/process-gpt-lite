'use strict'
// A small git smart-HTTP server for the runner's tests: one repository, a Bearer token required (as the Lite server's
// /api/git/<folder>.git — server/lib/folders/gitHttp.js), git http-backend doing the protocol. Records every Authorization it saw.
const http = require('node:http')
const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function gitServer({ repo, token, prefix = '/api/git/f.git' }) {
  const seen = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (!url.pathname.startsWith(prefix)) { res.statusCode = 404; return res.end() }
    seen.push(req.headers.authorization || '')
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.setHeader('WWW-Authenticate', 'Basic realm="t"'); return res.end('no') }
    const env = { ...process.env, GIT_PROJECT_ROOT: path.dirname(repo), GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: `/${path.basename(repo)}${url.pathname.slice(prefix.length)}`,
      REQUEST_METHOD: req.method, QUERY_STRING: url.search.slice(1), CONTENT_TYPE: req.headers['content-type'] || '', REMOTE_USER: 'agent',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'http.receivepack', GIT_CONFIG_VALUE_0: 'true', GIT_CONFIG_KEY_1: 'receive.denyCurrentBranch', GIT_CONFIG_VALUE_1: 'ignore' }
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding']
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol']
    const child = spawn('git', ['http-backend'], { env })
    let head = Buffer.alloc(0); let started = false
    child.stdout.on('data', (d) => {
      if (started) return res.write(d)
      head = Buffer.concat([head, d])
      const i = head.indexOf('\r\n\r\n')
      if (i < 0) return
      started = true
      for (const line of head.subarray(0, i).toString().split('\r\n')) {
        const [k, ...v] = line.split(':')
        if (/^status$/i.test(k)) res.statusCode = parseInt(v.join(':'), 10)
        else res.setHeader(k.trim(), v.join(':').trim())
      }
      res.write(head.subarray(i + 4))
    })
    child.on('close', () => res.end())
    req.pipe(child.stdin)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, path: prefix, seen, close: () => new Promise((r) => server.close(r)) })))
}

// a repository like a Lite folder: main with a file, and the instance line inst/<id> one step ahead
function makeRepo(dir, files = { '안내문.md': '# 안내문\n초안\n' }) {
  fs.mkdirSync(dir, { recursive: true })
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, stdio: 'pipe' }).toString()
  g('init', '-q', '-b', 'main')
  for (const [k, v] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, k)), { recursive: true }); fs.writeFileSync(path.join(dir, k), v) }
  g('add', '-A'); g('commit', '-qm', 'start')
  return { dir, git: g }
}

module.exports = { gitServer, makeRepo }
