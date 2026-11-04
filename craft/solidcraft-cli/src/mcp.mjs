// The MCP server. Declarative tools only: no argument is ever run as code. Calls run one at a time.
import fs from 'node:fs'
import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { ToolError } from './kernel.mjs'
import { known, text } from './args.mjs'
import { formatOf, Model } from './model.mjs'
import { confine } from './paths.mjs'
import { Renderer } from './render.mjs'

const VIEWS = ['iso', 'front', 'top', 'right', 'back', 'left', 'bottom']
const XYZ = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: '[x, y, z] in mm' }
const AXIS = { description: 'x, -x, y, -y, z, -z, or [dx, dy, dz]', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 }] }
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const num = (description) => ({ type: 'number', description })
const str = (description) => ({ type: 'string', description })

export const TOOLS = [
  {
    name: 'new',
    description: 'Start an empty model, discarding the current one. All lengths in every tool are millimetres.',
    inputSchema: object({ name: str('model name') }),
  },
  {
    name: 'import',
    description: 'Place a STEP (.step .stp) or IGES (.iges .igs) file in the model as one more part, not fused with the others. IGES usually holds surfaces only, which have no volume.',
    inputSchema: object({ path: str('file to read'), at: { ...XYZ, description: 'where the file\'s own origin goes, [x, y, z] in mm; with center_xy, where the middle of the part\'s underside goes' }, center_xy: { type: 'boolean', description: 'place by the part\'s bounding box, not the file\'s origin: its centre at at\'s x and y, its underside at at\'s z. Use it to seat a part whose origin you do not know.' }, rotate: { ...XYZ, description: 'degrees about X, then Y, then Z, about the file\'s origin, before placing it' }, name: str('part name; defaults to the file name') }, ['path']),
  },
  {
    name: 'add_box',
    description: 'Add a solid box as a new part. "at" is its smallest corner, or its centre with center: true.',
    inputSchema: object({ name: str('part name'), size: { ...XYZ, description: '[x, y, z] lengths in mm' }, at: XYZ, center: { type: 'boolean' } }, ['size']),
  },
  {
    name: 'add_cylinder',
    description: 'Add a solid cylinder as a new part. "at" is the centre of its base; it rises along "axis" (default z).',
    inputSchema: object({ name: str('part name'), diameter: num('mm'), height: num('mm'), at: XYZ, axis: AXIS }, ['diameter', 'height']),
  },
  {
    name: 'cut_hole',
    description: 'Drill a round hole in a part. "at" is where the hole starts on the surface and "axis" the direction it goes in. Without depth it goes through everything in that direction. Says so if the hole misses the part.',
    inputSchema: object({ part: str('part name'), at: XYZ, axis: AXIS, diameter: num('mm'), depth: num('mm; omit for through-all') }, ['part', 'at', 'axis', 'diameter']),
  },
  {
    name: 'fillet',
    description: 'Round a part\'s edges. "edges" is all (default), vertical, top, bottom, or a list of edge numbers from inspect\'s edges_of. A radius too large for the part returns an error and leaves the part as it was.',
    inputSchema: object({ part: str('part name'), radius: num('mm'), edges: { description: 'all, vertical, top, bottom, or a list of edge numbers', anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'integer' } }] } }, ['part', 'radius']),
  },
  {
    name: 'build_enclosure',
    description: 'Build a hollow aluminium box and its separate lid as two parts (<name>_body, <name>_lid), closed, outer size width (X) x depth (Y) x height (Z), lid included. The closed box fills x 0..width, y 0..depth, z 0..height, and every position is in those coordinates. Standoff x,y are on the floor. Hole x,y are on that face, from its lower corner: on front (y=0) and back (y=depth) x is world X and y is world Z; on left (x=0) and right (x=width) x is world Y and y is world Z; on top and bottom x is world X and y is world Y. Impossible sizes or positions return an error saying what to change and leave the model as it was.',
    inputSchema: object({
      name: str('part name prefix, default "enclosure"'),
      width: num('outer X, mm'), depth: num('outer Y, mm'), height: num('outer Z with the lid on, mm'), wall: num('wall and floor thickness, mm'),
      corner_radius: num('outer radius of the vertical corners, mm; default 0'),
      lid_height: num('lid height, mm; default = wall (a flat plate). Above wall the lid is a cap with a skirt.'),
      standoffs: { type: 'array', description: 'posts on the floor', items: object({ x: num('from the x=0 outside face, mm'), y: num('from the y=0 outside face, mm'), diameter: num('mm'), height: num('above the floor, mm'), hole_diameter: num('bore over the post\'s full height, mm; 0 or omit for none') }, ['x', 'y', 'diameter', 'height']) },
      holes: { type: 'array', description: 'round holes through a wall, the floor or the lid', items: object({ face: { type: 'string', enum: ['front', 'back', 'left', 'right', 'bottom', 'top'] }, x: num('mm'), y: num('mm'), diameter: num('mm') }, ['face', 'x', 'y', 'diameter']) },
      mount_ears: object({ hole_diameter: num('mm'), length: num('out from the wall, mm; default 2.5 x hole'), width: num('along the wall, mm; default 3 x hole'), thickness: num('mm; default = wall'), per_side: num('ears on each of the left and right walls: 1 or 2, default 2') }, ['hole_diameter']),
    }, ['width', 'depth', 'height', 'wall']),
  },
  {
    name: 'inspect',
    description: 'Bounding box, volume (mm³), face and solid counts for each part and in total, measured from the geometry. With edges_of, also lists that part\'s edges with their numbers and extents, for fillet.',
    inputSchema: object({ edges_of: str('a part name') }),
  },
  {
    name: 'export',
    description: 'Write the whole model to a STEP or IGES file. STEP keeps solids; IGES turns them into surfaces.',
    inputSchema: object({ path: str('file to write'), format: { type: 'string', description: '.step or .iges; defaults to the file\'s extension' } }, ['path']),
  },
  {
    name: 'render',
    description: 'Draw the model to a PNG of about 1600x1000 on a light background and return the picture. Hide the lid to see inside.',
    inputSchema: object({ path: str('.png file to write'), view: { type: 'string', enum: VIEWS, description: 'default iso' }, hide: { type: 'array', items: { type: 'string' }, description: 'part names to leave out of this picture' } }, ['path']),
  },
]

export async function startMcp({ readRoot, writeRoot, webRoot, wasmDir }) {
  const model = await new Model({ wasmDir }).start()
  const renderer = new Renderer({ webRoot })
  const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] })

  const handlers = {
    new: (args) => json(model.new(args)),
    import: async (args) => json(await model.import(args, confine(text(args.path, 'path'), readRoot, 'read'))),
    add_box: async (args) => json(await model.addBox(args)),
    add_cylinder: async (args) => json(await model.addCylinder(args)),
    cut_hole: async (args) => json(await model.cutHole(args)),
    fillet: async (args) => json(await model.fillet(args)),
    build_enclosure: async (args) => json(await model.buildEnclosure(args)),
    inspect: async (args) => json(await model.inspect(args)),
    export: async (args) => {
      known(args, 'export', ['path', 'format'])
      const raw = text(args.path, 'path')
      const ext = path.extname(raw)
      const format = formatOf(args.format ?? ext, args.format ? 'format' : 'the file\'s extension (or give format)')
      if (ext && formatOf(ext, 'the file\'s extension') !== format) throw new ToolError(`${raw} says ${ext} but the format is ${format}`)
      // answers name the path as asked: craft.js maps exactly that back to /workspace
      const named = ext ? raw : `${raw}.${format}`
      const file = confine(named, writeRoot, 'write')
      const data = await model.export(format)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data)
      return json({ path: named, format, bytes: Buffer.byteLength(data), parts: model.parts.length })
    },
    render: async (args) => {
      known(args, 'render', ['path', 'view', 'hide'])
      const raw = text(args.path, 'path')
      if (path.extname(raw).toLowerCase() !== '.png') throw new ToolError(`render writes a .png, got ${raw}`)
      const file = confine(raw, writeRoot, 'write')
      const view = text(args.view, 'view', { optional: true, fallback: 'iso' })
      if (!VIEWS.includes(view)) throw new ToolError(`view must be one of ${VIEWS.join(', ')}, got "${view}"`)
      const hide = args.hide ?? []
      for (const name of hide) model.part(name)
      const parts = model.parts.filter((p) => !hide.includes(p.name)).map(({ name, brep, color }) => ({ name, brep, color }))
      if (!parts.length) throw new ToolError('nothing to draw: the model is empty or every part is hidden')
      const { png, foreground } = await renderer.render({ parts, name: model.name, view })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, png)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ path: raw, view, bytes: png.length, foreground: Math.round(foreground * 1000) / 1000 }) },
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
        ],
      }
    },
  }

  const server = new Server({ name: 'solidcraft', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  let queue = Promise.resolve()
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => {
    const call = queue.then(async () => {
      const handler = handlers[params.name]
      if (!handler) throw new ToolError(`no tool named "${params.name}"; there are ${Object.keys(handlers).join(', ')}`)
      return handler(params.arguments || {})
    }).catch((error) => {
      if (!(error instanceof ToolError)) console.error(`[solidcraft] ${params.name}:`, error)
      return { isError: true, content: [{ type: 'text', text: error instanceof ToolError ? error.message : `${params.name} failed: ${error?.message || error}` }] }
    })
    queue = call
    return call
  })

  let closing = false
  const shutdown = async () => {
    if (closing) return
    closing = true
    await renderer.close().catch(() => {})
    process.exit(0)
  }
  process.stdin.on('end', shutdown)
  process.stdin.on('close', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  await server.connect(new StdioServerTransport())
}
