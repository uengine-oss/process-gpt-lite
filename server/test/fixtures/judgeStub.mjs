// A stand-in for the judge server (context-router POST /judge: {state, question, options} →
// {probabilities}) for unit tests: the test decides the answer, the module under test does the rest.
// Start it and set PRO_JUDGE_URL before the modules that read it are imported.
import http from 'node:http'

export async function startJudge(answer) {
  const calls = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}')
      calls.push(body)
      const pick = await answer(body, calls.length)
      const keys = (body.options || []).map((o) => o.key)
      const [key, p] = Array.isArray(pick) ? pick : [pick, 0.95]
      const probabilities = Object.fromEntries(keys.map((k) => [k, k === key ? p : (1 - p) / Math.max(1, keys.length - 1)]))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ probabilities, model: 'stub' }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/judge`, calls, close: () => new Promise((r) => server.close(r)) }
}
