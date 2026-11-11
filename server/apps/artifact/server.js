// 산출물 보기 (docs/robo-dlc/plan-review.md §3.3): one document of a folder's AI-DLC record, whole,
// focused on the part a review or a question points at. Reads through the host context only.
import { renderDoc, findHeading } from './render.js'

export default (ctx) => ({
  routes(r) {
    // ?path=<record path>&focus=<section name or ID>
    r.get('/:folder/doc', async (req) => {
      const w = await ctx.aidlc.open(req.params.folder, req.user)
      const d = await w.readDoc(String(req.query.path || ''))
      const { html, headings, title } = renderDoc(d.text)
      const all = await w.docs()
      const stage = w.describeStage(d.stage)
      const siblings = all.filter((x) => x.phase === d.phase && x.stage === d.stage && x.unit === d.unit).map((x) => ({ path: x.path, name: x.path.split('/').pop() }))
      const focus = String(req.query.focus || '').slice(0, 200)
      return {
        path: d.path, name: d.path.split('/').pop(), phase: d.phase, unit: d.unit || null, stage: { slug: d.stage, name: stage.name, role: stage.role },
        title, html, headings, mtime: d.mtime, siblings, docs: all.map((x) => x.path),
        focus: focus ? { text: focus, heading: findHeading(headings, focus)?.id || null } : null,
        intent: w.intent,
      }
    })
    // the documents of the record, by stage (the viewer's list when nothing is open yet)
    r.get('/:folder/docs', async (req) => {
      const w = await ctx.aidlc.open(req.params.folder, req.user)
      const all = await w.docs()
      return { intent: w.intent, docs: all.map((x) => ({ ...x, stageName: w.describeStage(x.stage).name, name: x.path.split('/').pop() })) }
    })
  },
})
