// A server of the MCP gateways only (test/mcpAuth.integration.test.js), for one setting given by the environment: the request chain
// of index.js up to the gateways (body parser → the tenant middleware → mcp/*.js mounts, in index.js's order), without index.js itself.
// /mcp/__probe answers who the call is for and the tenant its handler runs in — behind the same check (lib/mcpAuth.js).
// Prints PORT=<n> once it listens on a free port of 127.0.0.1.
import express from 'express'

const { config } = await import('../../config.js')
const { tenantMiddleware } = await import('../../lib/tenant.js')
const { mcpRoute } = await import('../../lib/mcpAuth.js')
// (entered the way the server's imports reach them: test/craftInstall.test.js)
await import('../../lib/craftWork.js')
const { mountCraft } = await import('../../mcp/craft.js')
const { mountOffice } = await import('../../mcp/office.js')
const { mountFolders } = await import('../../mcp/folders.js')
const { mountImprove } = await import('../../mcp/improve.js')
const { mountMail } = await import('../../mcp/mail.js')
const { mountPanelApps } = await import('../../mcp/panelapps.js')
const { mountTeam } = await import('../../mcp/team.js')
const { mountConnectors } = await import('../../mcp/connectors.js')

const app = express()
app.use(express.json({ limit: '2mb' }))
app.use(tenantMiddleware())
app.post('/mcp/__probe', mcpRoute(async (req, res, { user, placeholder }) => res.json({ user: user?.id || null, placeholder, tenant: config.tenantId })))
mountCraft(app)
mountOffice(app)
mountFolders(app)
mountImprove(app)
mountMail(app)
mountPanelApps(app)
mountTeam(app)
mountConnectors(app)

const server = app.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`))
process.on('SIGTERM', () => { server.close(); process.exit(0) })
