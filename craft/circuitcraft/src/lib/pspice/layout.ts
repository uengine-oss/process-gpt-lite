/**
 * Auto-layout: ELK places the parts in signal-flow layers; a small maze router draws the wires on the
 * schematic grid. The wires come out electrically exact: other nets are never touched (a crossing
 * has no junction and cannot turn), and a net the router cannot complete gets net labels instead.
 * Ground is a symbol at each pin; supply rails and wide nets are net labels.
 */
import type { Component, Junction, NodeLabel, Pin, Schematic, Wire } from '$lib/schematic/types';
import { COMPONENT_DEFS } from '$lib/schematic/component-defs';
import { PIN_ORDER } from '$lib/netlist/types';
import { analyzeConnectivity } from '$lib/netlist/connectivity';
import type { ElementSpec } from './elements';

type Side = 'left' | 'right' | 'top' | 'bottom';
const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;
const ceilTo = (v: number, step: number) => Math.ceil(v / step) * step;
const DIRS: Record<Side, { x: number; y: number }> = {
	left: { x: -1, y: 0 },
	right: { x: 1, y: 0 },
	top: { x: 0, y: -1 },
	bottom: { x: 0, y: 1 }
};
const CHAR = 7.4; // width of one monospace character at the label font

export const isGroundNet = (net: string) => net === '0';

const NEGATIVE_RAIL = /(EE|SS|NEG|-|VN)\d*$|^-|^V-/i;
const SUPPLY_NAME = /^(\+|-)?(V?CC|V?DD|V?EE|V?SS|VBAT|VPOS|VNEG|VS[+\-PN]?|V[+\-PN]|\d+V\d*|-?\d+V)$/i;
const INPUT_PIN = /^(\+|-)?(IN|INP|INN|INV|NINV|NON|I|A|B|D|G|C|VI|VIN|VP|VM|VN|NC|CLK|EN|SET|RST|S|R)[+\-_]?\d*$|^(IN|VI|INPUT|C)[+\-_]|[+\-]IN$|^NC[+\-]$|^C[+\-]$/i;
const OUTPUT_PIN = /^(OUT|OUTP|OUTN|O|Q|Y|VO|VOUT|OUTPUT|Z)[+\-_]?\d*$|^N[+\-]$/i;
const TOP_PIN = /^(V?CC|V?DD|V\+|VS\+|VPOS|VP|AVDD|DVDD|VIN\+|POS|\+V|\+VS)\d*$/i;
const BOTTOM_PIN = /^(V?EE|V?SS|V-|VS-|VNEG|VN|GND|AGND|DGND|PGND|NEG|-V|-VS|SUB)\d*$/i;

// -- geometry of one placed element ---------------------------------------------------------------

interface PlacedPin {
	name: string;
	net: string;
	spiceIndex: number;
	side: Side;
	/** relative to the centre of the body */
	x: number;
	y: number;
	attach: 'wire' | 'ground' | 'flag';
	stub: number;
	world?: { x: number; y: number };
}

interface Footprint {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

interface Shape {
	spec: ElementSpec;
	type: Component['type'];
	rotation: 0 | 90 | 180 | 270;
	mirror: boolean;
	pins: PlacedPin[];
	/** body rectangle around the centre: half sizes */
	hw: number;
	hh: number;
	box?: { w: number; h: number; title?: string };
	foot: Footprint;
	labels: { x: number; y: number; w: number; h: number }[];
	center?: { x: number; y: number };
}

function netClass(net: string, rails: Set<string>): PlacedPin['attach'] {
	if (isGroundNet(net)) return 'ground';
	return rails.has(net.toUpperCase()) ? 'flag' : 'wire';
}

function flagSize(net: string) {
	return { w: Math.max(30, net.length * CHAR + 12), h: 20 };
}

/** A 2-pin part: a shunt to ground or a rail stands up, a series part lies down */
function twoPinShape(spec: ElementSpec, rails: Set<string>): Shape {
	const def = COMPONENT_DEFS[spec.symbol];
	const [a, b] = spec.pins;
	const ca = netClass(a.net, rails);
	const cb = netClass(b.net, rails);
	const vertical = spec.symbol === 'voltage' || spec.symbol === 'current' || ca !== 'wire' || cb !== 'wire';
	// which pin goes down: ground and negative rails below, a positive rail above (a pull-up hangs from it)
	const low = (p: { net: string }, c: PlacedPin['attach']) => c === 'ground' || (c === 'flag' && NEGATIVE_RAIL.test(p.net));
	const high = (p: { net: string }, c: PlacedPin['attach']) => c === 'flag' && !NEGATIVE_RAIL.test(p.net);
	const valueWidth = Math.min(spec.value.length, 22) * CHAR;
	const nameWidth = spec.ref.length * CHAR;
	const pin = (p: { name: string; net: string }, i: number, x: number, y: number, side: Side): PlacedPin => ({
		name: p.name, net: p.net, spiceIndex: i, side, x, y, attach: netClass(p.net, rails), stub: 0
	});
	if (vertical) {
		// rotation 0: pin 1 up. A source keeps its + on top; a part with pin 1 on the low side turns over.
		const flip = low(a, ca) || (high(b, cb) && !high(a, ca));
		const rotation: 0 | 180 = flip && spec.symbol !== 'voltage' && spec.symbol !== 'current' ? 180 : 0;
		const hh = def.height / 2;
		const pins = rotation === 0
			? [pin(a, 0, 0, -hh, 'top'), pin(b, 1, 0, hh, 'bottom')]
			: [pin(a, 0, 0, hh, 'bottom'), pin(b, 1, 0, -hh, 'top')];
		const textW = Math.max(valueWidth, nameWidth);
		const lx = def.labelOffset.x;
		return {
			spec, type: spec.symbol, rotation, mirror: false, pins, hw: def.width / 2, hh: hh - 10,
			foot: { left: def.width / 2 + 10, right: lx + textW + 8, top: hh + 10, bottom: hh + 10 },
			labels: [{ x: lx, y: -18, w: textW, h: 34 }]
		};
	}
	const hw = def.height / 2;
	const textW = Math.max(valueWidth, nameWidth);
	const half = Math.max(hw, textW / 2 + 4);
	return {
		spec, type: spec.symbol, rotation: 270, mirror: false,
		pins: [pin(a, 0, -hw, 0, 'left'), pin(b, 1, hw, 0, 'right')],
		hw: hw - 10, hh: def.width / 2,
		foot: { left: half + 10, right: half + 10, top: def.width / 2 + 20, bottom: def.width / 2 + 20 },
		labels: [{ x: -textW / 2, y: -def.width / 2 - 18, w: textW, h: 16 }, { x: -textW / 2, y: def.width / 2 + 2, w: textW, h: 16 }]
	};
}

/** A transistor symbol keeps its own orientation */
function transistorShape(spec: ElementSpec, rails: Set<string>): Shape {
	const def = COMPONENT_DEFS[spec.symbol];
	const order = PIN_ORDER[spec.symbol];
	const pins: PlacedPin[] = def.pins.map((p) => {
		const i = order.indexOf(p.name);
		const net = spec.pins[i].net;
		const side: Side = p.x < 0 ? 'left' : p.y < 0 ? 'top' : 'bottom';
		return { name: p.name, net, spiceIndex: i, side, x: p.x, y: p.y, attach: netClass(net, rails), stub: 0 };
	});
	const textW = Math.max(Math.min(spec.value.length, 22), spec.ref.length) * CHAR;
	return {
		spec, type: spec.symbol, rotation: 0, mirror: false, pins, hw: def.width / 2, hh: def.height / 2 - 10,
		foot: { left: 40, right: 15 + textW + 8, top: 40, bottom: 40 },
		labels: [{ x: 15, y: -32, w: textW, h: 14 }, { x: 15, y: 18, w: textW, h: 14 }]
	};
}

function sideFor(name: string, spec: ElementSpec, index: number, total: number): Side {
	const n = name.toUpperCase();
	if (spec.letter === 'X' || spec.letter === 'U') {
		if (TOP_PIN.test(n)) return 'top';
		if (BOTTOM_PIN.test(n)) return 'bottom';
		if (OUTPUT_PIN.test(n)) return 'right';
		if (INPUT_PIN.test(n)) return 'left';
		return index < Math.ceil(total / 2) ? 'left' : 'right';
	}
	if ('EGFHBSW'.includes(spec.letter)) return OUTPUT_PIN.test(n) ? 'right' : 'left';
	if (spec.letter === 'T') return n.startsWith('A') ? 'left' : 'right';
	if (spec.letter === 'J' || spec.letter === 'Z') return n === 'G' ? 'left' : n === 'D' ? 'top' : 'bottom';
	if (spec.letter === 'Q') return n === 'B' ? 'left' : n === 'C' ? 'top' : n === 'E' ? 'bottom' : 'right';
	if (spec.letter === 'M') return n === 'G' ? 'left' : n === 'D' ? 'top' : n === 'S' ? 'bottom' : 'right';
	return index % 2 === 0 ? 'left' : 'right';
}

function boxShape(spec: ElementSpec, rails: Set<string>): Shape {
	const sides: Record<Side, PlacedPin[]> = { left: [], right: [], top: [], bottom: [] };
	spec.pins.forEach((p, i) => {
		sides[sideFor(p.name, spec, i, spec.pins.length)].push({
			name: p.name, net: p.net, spiceIndex: i, side: 'left', x: 0, y: 0, attach: netClass(p.net, rails), stub: 0
		});
	});
	// a 2-pin device: the signal comes in on the left, the rail or ground leaves on the right
	if (sides.left.length === 1 && sides.right.length === 1 && sides.left[0].attach !== 'wire' && sides.right[0].attach === 'wire') {
		[sides.left, sides.right] = [sides.right, sides.left];
	}
	for (const s of ['left', 'right'] as Side[]) {
		// labelled and grounded pins sit at the bottom of the edge, where their symbols have room
		sides[s].sort((a, b) => (a.attach === 'wire' ? 0 : 1) - (b.attach === 'wire' ? 0 : 1) || a.spiceIndex - b.spiceIndex);
	}
	const pitch = 20;
	const nameLen = (ps: PlacedPin[]) => Math.max(0, ...ps.map((p) => p.name.length));
	const titleW = Math.max(spec.ref.length, spec.title.length) * (CHAR + 0.6);
	const width = ceilTo(Math.max(80, titleW + (nameLen(sides.left) + nameLen(sides.right)) * CHAR * 0.9 + 18, (sides.top.length + 1) * 40, (sides.bottom.length + 1) * 40), 20);
	const rows = Math.max(sides.left.length, sides.right.length);
	const hasTB = sides.top.length + sides.bottom.length > 0;
	const height = ceilTo(Math.max(hasTB ? 80 : 40, (rows + 1) * pitch), 20);
	const hw = width / 2;
	const hh = height / 2;
	const spread = (i: number, n: number, step: number) => (i - (n - 1) / 2) * step;
	sides.left.forEach((p, i) => { p.side = 'left'; p.x = -hw; p.y = snap(spread(i, sides.left.length, pitch)); });
	sides.right.forEach((p, i) => { p.side = 'right'; p.x = hw; p.y = snap(spread(i, sides.right.length, pitch)); });
	sides.top.forEach((p, i) => { p.side = 'top'; p.y = -hh; p.x = snap(spread(i, sides.top.length, 40)); });
	sides.bottom.forEach((p, i) => { p.side = 'bottom'; p.y = hh; p.x = snap(spread(i, sides.bottom.length, 40)); });
	const pins = [...sides.left, ...sides.right, ...sides.top, ...sides.bottom];
	return {
		spec, type: 'generic', rotation: 0, mirror: false, pins, hw, hh,
		box: { w: width, h: height, title: spec.title },
		foot: { left: hw + 10, right: hw + 10, top: hh + 10, bottom: hh + 10 },
		labels: []
	};
}

function shapeOf(spec: ElementSpec, rails: Set<string>): Shape {
	let shape: Shape;
	if (spec.symbol === 'generic') shape = boxShape(spec, rails);
	else if (spec.pins.length === 2) shape = twoPinShape(spec, rails);
	else shape = transistorShape(spec, rails);
	// room for the ground symbols and net labels hanging off the pins
	const bySide: Record<Side, number> = { left: 0, right: 0, top: 0, bottom: 0 };
	const ordered = [...shape.pins].sort((a, b) => b.y - a.y);
	for (const p of ordered) {
		if (p.attach === 'wire') continue;
		const d = DIRS[p.side];
		const k = bySide[p.side]++;
		// stacked ground symbols on one edge step outwards so they do not sit on each other
		p.stub = p.attach === 'ground' ? (p.side === 'bottom' ? 0 : p.side === 'top' ? 20 : 30 * (k + 1)) : 20;
		const reach = p.attach === 'ground'
			? { w: 16, h: p.side === 'top' ? 20 : 20 }
			: flagSize(p.net);
		const outward = p.stub + (d.x ? reach.w : d.y ? reach.h : 0);
		if (p.side === 'left') shape.foot.left = Math.max(shape.foot.left, -p.x + outward + 4);
		if (p.side === 'right') shape.foot.right = Math.max(shape.foot.right, p.x + outward + 4);
		if (p.side === 'top') shape.foot.top = Math.max(shape.foot.top, -p.y + outward + 4);
		if (p.side === 'bottom') shape.foot.bottom = Math.max(shape.foot.bottom, p.y + outward + 4);
		if (d.x && p.attach === 'ground') shape.foot.bottom = Math.max(shape.foot.bottom, p.y + 24);
		if (d.y && p.attach === 'flag') {
			const w = reach.w / 2 + 4;
			shape.foot.left = Math.max(shape.foot.left, -p.x + w);
			shape.foot.right = Math.max(shape.foot.right, p.x + w);
		}
	}
	return shape;
}

// -- which nets are rails --------------------------------------------------------------------------

/** Supply rails and very wide nets read better as labels than as wires across the sheet */
export function findRails(specs: ElementSpec[]): Set<string> {
	const fanout = new Map<string, number>();
	const driven = new Set<string>();
	for (const s of specs) {
		for (const p of s.pins) fanout.set(p.net.toUpperCase(), (fanout.get(p.net.toUpperCase()) ?? 0) + 1);
		if (s.letter === 'V' && s.pins.length === 2) {
			const [plus, minus] = s.pins;
			const dcOnly = !/\b(AC|PULSE|SIN|EXP|PWL|SFFM|AM)\b/i.test(s.value);
			if (dcOnly && isGroundNet(minus.net)) driven.add(plus.net.toUpperCase());
			if (dcOnly && isGroundNet(plus.net)) driven.add(minus.net.toUpperCase());
		}
	}
	const rails = new Set<string>();
	for (const [net, count] of fanout) {
		if (net === '0' || count < 2) continue;
		if (driven.has(net) || SUPPLY_NAME.test(net) || count > 8) rails.add(net);
	}
	return rails;
}

// -- placement with ELK ----------------------------------------------------------------------------

async function runElk(graph: unknown): Promise<{ children: { id: string; x: number; y: number }[] }> {
	const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
	return (await new ELK().layout(graph as never)) as never;
}

const ELK_SIDE: Record<Side, string> = { left: 'WEST', right: 'EAST', top: 'NORTH', bottom: 'SOUTH' };

async function place(shapes: Shape[]) {
	if (!shapes.length) return;
	const children = shapes.map((s) => ({
		id: s.spec.ref,
		width: s.foot.left + s.foot.right,
		height: s.foot.top + s.foot.bottom,
		layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
		ports: s.pins.map((p) => ({
			id: `${s.spec.ref}::${p.spiceIndex}`,
			x: s.foot.left + p.x,
			y: s.foot.top + p.y,
			width: 1,
			height: 1,
			layoutOptions: { 'elk.port.side': ELK_SIDE[p.side] }
		}))
	}));
	// signal flows from drivers (a source's + pin, right-side pins) to the left-side pins
	const nets = new Map<string, { id: string; driver: boolean }[]>();
	for (const s of shapes) {
		for (const p of s.pins) {
			if (p.attach !== 'wire') continue;
			const key = p.net.toUpperCase();
			if (!nets.has(key)) nets.set(key, []);
			const driver = p.side === 'right' || ((s.spec.letter === 'V' || s.spec.letter === 'I') && p.side === 'top');
			nets.get(key)!.push({ id: `${s.spec.ref}::${p.spiceIndex}`, driver });
		}
	}
	const edges: { id: string; sources: string[]; targets: string[] }[] = [];
	let n = 0;
	for (const pins of nets.values()) {
		if (pins.length < 2) continue;
		const drivers = pins.filter((p) => p.driver);
		const sinks = pins.filter((p) => !p.driver);
		if (!drivers.length) {
			for (const t of sinks.slice(1)) edges.push({ id: `e${n++}`, sources: [sinks[0].id], targets: [t.id] });
		} else if (!sinks.length) {
			for (const t of drivers.slice(1)) edges.push({ id: `e${n++}`, sources: [drivers[0].id], targets: [t.id] });
		} else {
			for (const d of drivers) for (const t of sinks) edges.push({ id: `e${n++}`, sources: [d.id], targets: [t.id] });
		}
	}
	const graph = {
		id: 'root',
		layoutOptions: {
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.spacing.nodeNode': '30',
			'elk.layered.spacing.nodeNodeBetweenLayers': '60',
			'elk.spacing.componentComponent': '40',
			'elk.separateConnectedComponents': 'true',
			'elk.aspectRatio': '2.6',
			'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
			'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
			'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX'
		},
		children,
		edges
	};
	const laid = await runElk(graph);
	const byId = new Map(laid.children.map((c) => [c.id, c]));
	for (const s of shapes) {
		const c = byId.get(s.spec.ref)!;
		setCenter(s, c.x + s.foot.left, c.y + s.foot.top);
	}
}

// -- routing ---------------------------------------------------------------------------------------

const cell = (x: number, y: number) => `${x},${y}`;
const STEP = [
	{ dx: GRID, dy: 0 },
	{ dx: 0, dy: GRID },
	{ dx: -GRID, dy: 0 },
	{ dx: 0, dy: -GRID }
];
const dirIndex = (side: Side) => ({ right: 0, bottom: 1, left: 2, top: 3 })[side];
const edgeKey = (x: number, y: number, d: number) => {
	// one key per unit edge whichever end it is seen from
	if (d === 2) return `${x - GRID},${y},h`;
	if (d === 0) return `${x},${y},h`;
	if (d === 3) return `${x},${y - GRID},v`;
	return `${x},${y},v`;
};

interface Vertex {
	net: string;
	/** the wire goes straight through here in this axis (a crossing is allowed), or null for an end or a bend */
	through: 'h' | 'v' | null;
	pin?: boolean;
}

class Router {
	blocked = new Set<string>();
	soft = new Set<string>();
	vertices = new Map<string, Vertex>();
	edges = new Map<string, string>();
	wires: Wire[] = [];
	junctions: Junction[] = [];
	minX = Infinity;
	minY = Infinity;
	maxX = -Infinity;
	maxY = -Infinity;
	wireId = 0;

	extend(x1: number, y1: number, x2: number, y2: number) {
		this.minX = Math.min(this.minX, x1);
		this.maxX = Math.max(this.maxX, x2);
		this.minY = Math.min(this.minY, y1);
		this.maxY = Math.max(this.maxY, y2);
	}

	blockRect(x1: number, y1: number, x2: number, y2: number) {
		for (let x = snap(x1); x <= x2; x += GRID) for (let y = snap(y1); y <= y2; y += GRID) this.blocked.add(cell(x, y));
	}

	softRect(x1: number, y1: number, x2: number, y2: number) {
		for (let x = Math.floor(x1 / GRID) * GRID; x <= x2; x += GRID) for (let y = Math.floor(y1 / GRID) * GRID; y <= y2; y += GRID) this.soft.add(cell(x, y));
	}

	markPin(x: number, y: number, net: string) {
		this.blocked.delete(cell(x, y));
		this.vertices.set(cell(x, y), { net, through: null, pin: true });
	}

	/** Lay a path of grid points as wires of one net */
	lay(path: { x: number; y: number }[], net: string) {
		if (path.length < 2) return;
		let start = path[0];
		let dir: number | null = null;
		const emit = (a: { x: number; y: number }, b: { x: number; y: number }) => {
			this.wires.push({ id: `w${this.wireId++}`, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
		};
		for (let i = 1; i < path.length; i++) {
			const a = path[i - 1];
			const b = path[i];
			const d = STEP.findIndex((s) => s.dx === Math.sign(b.x - a.x) * GRID && s.dy === Math.sign(b.y - a.y) * GRID);
			this.edges.set(edgeKey(a.x, a.y, d), net);
			if (dir !== null && d !== dir) {
				emit(start, a);
				start = a;
			}
			dir = d;
		}
		emit(start, path[path.length - 1]);

		// bookkeeping of what each point became
		for (let i = 0; i < path.length; i++) {
			const p = path[i];
			const key = cell(p.x, p.y);
			const prev = path[i - 1];
			const next = path[i + 1];
			const straight = prev && next && (prev.x === next.x || prev.y === next.y);
			const before = this.vertices.get(key);
			if (before?.net === net) {
				if (before.through) {
					// landed on our own wire: that needs a dot to be a connection
					before.through = null;
					this.junctions.push({ id: `j${this.junctions.length}`, x: p.x, y: p.y });
				}
				continue;
			}
			if (before?.pin) continue;
			this.vertices.set(key, { net, through: straight ? (prev.x === next.x ? 'v' : 'h') : null });
		}
	}

	/** Connect a terminal to the set of points already belonging to the net */
	connect(net: string, from: { x: number; y: number }, fromSide: Side | null, targets: Set<string>): { x: number; y: number }[] | null {
		const startDir = fromSide ? dirIndex(fromSide) : 4;
		const tx = [...targets].map((t) => t.split(',').map(Number));
		const box = {
			x1: Math.min(...tx.map((t) => t[0])), x2: Math.max(...tx.map((t) => t[0])),
			y1: Math.min(...tx.map((t) => t[1])), y2: Math.max(...tx.map((t) => t[1]))
		};
		const h = (x: number, y: number) => {
			const dx = x < box.x1 ? box.x1 - x : x > box.x2 ? x - box.x2 : 0;
			const dy = y < box.y1 ? box.y1 - y : y > box.y2 ? y - box.y2 : 0;
			return (dx + dy) / GRID;
		};
		const margin = 200;
		const lim = { x1: this.minX - margin, x2: this.maxX + margin, y1: this.minY - margin, y2: this.maxY + margin };
		const startKey = `${from.x},${from.y},${startDir}`;
		const g = new Map<string, number>([[startKey, 0]]);
		const parent = new Map<string, string>();
		const open = new Heap();
		open.push(h(from.x, from.y), startKey);
		let found: string | null = null;
		let budget = 120000;
		while (open.size && budget-- > 0) {
			const key = open.pop()!;
			const [x, y, d] = key.split(',').map(Number);
			const here = cell(x, y);
			const score = g.get(key)!;
			if (key !== startKey && targets.has(here)) {
				const v = this.vertices.get(here);
				if (!v || v.net === net) { found = key; break; }
			}
			const v0 = this.vertices.get(here);
			const crossing = v0 && v0.net !== net;
			for (let nd = 0; nd < 4; nd++) {
				if (d !== 4 && nd === (d + 2) % 4) continue; // no U-turn
				if (crossing && nd !== d) continue;          // a crossing goes straight on
				const nx = x + STEP[nd].dx;
				const ny = y + STEP[nd].dy;
				if (nx < lim.x1 || nx > lim.x2 || ny < lim.y1 || ny > lim.y2) continue;
				const nc = cell(nx, ny);
				const isTarget = targets.has(nc);
				if (this.blocked.has(nc) && !isTarget) continue;
				const owner = this.edges.get(edgeKey(x, y, nd));
				if (owner && owner !== net) continue;
				const v = this.vertices.get(nc);
				let cost = 1;
				if (v && v.net !== net) {
					if (v.pin || v.through === null) continue;
					if (v.through === (nd % 2 === 0 ? 'h' : 'v')) continue;
					cost += 6; // crossings are fine, but not free
				}
				if (d !== 4 && nd !== d) cost += 4;
				if (d === 4 || (key === startKey && nd !== d)) cost += nd === d ? 0 : 2;
				if (this.soft.has(nc)) cost += 3;
				if (owner === net) cost -= 0.6; // following our own wire keeps a net tidy
				const nkey = `${nx},${ny},${nd}`;
				const ng = score + cost;
				if (ng < (g.get(nkey) ?? Infinity)) {
					g.set(nkey, ng);
					parent.set(nkey, key);
					open.push(ng + h(nx, ny), nkey);
				}
			}
		}
		if (!found) return null;
		const path: { x: number; y: number }[] = [];
		for (let k: string | undefined = found; k; k = parent.get(k)) {
			const [x, y] = k.split(',').map(Number);
			path.push({ x, y });
		}
		return path.reverse();
	}
}

/** A small binary heap: f-score, then key */
class Heap {
	private items: { f: number; key: string }[] = [];
	get size() { return this.items.length; }
	push(f: number, key: string) {
		const a = this.items;
		a.push({ f, key });
		let i = a.length - 1;
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (a[p].f <= a[i].f) break;
			[a[p], a[i]] = [a[i], a[p]];
			i = p;
		}
	}
	pop(): string | undefined {
		const a = this.items;
		if (!a.length) return undefined;
		const top = a[0].key;
		const last = a.pop()!;
		if (a.length) {
			a[0] = last;
			let i = 0;
			for (;;) {
				const l = i * 2 + 1;
				const r = l + 1;
				let m = i;
				if (l < a.length && a[l].f < a[m].f) m = l;
				if (r < a.length && a[r].f < a[m].f) m = r;
				if (m === i) break;
				[a[m], a[i]] = [a[i], a[m]];
				i = m;
			}
		}
		return top;
	}
}

// -- the whole sheet -------------------------------------------------------------------------------

function spiceValue(spec: ElementSpec) {
	return spec.value;
}

function toComponent(s: Shape, index: number): Component {
	const { spec } = s;
	const pins: Pin[] = s.type === 'generic'
		// a box lists its pins in node order: that is how the document is written back
		? [...s.pins].sort((a, b) => a.spiceIndex - b.spiceIndex).map((p) => ({ id: String(p.spiceIndex), x: p.x, y: p.y, name: p.name, side: p.side }))
		: COMPONENT_DEFS[s.type].pins.map((p, i) => ({ ...p, id: String(i) }));
	const nodes = spec.pins.map((p) => p.net);
	if (spec.bulkTied) nodes.push(spec.pins[2].net);
	return {
		id: `el:${index}:${spec.ref}`,
		type: s.type,
		x: s.center!.x,
		y: s.center!.y,
		rotation: s.rotation,
		mirror: s.mirror,
		attributes: { InstName: spec.ref, Value: spiceValue(spec) },
		pins,
		box: s.box,
		source: { ref: spec.ref, nodes, value: spec.value, imported: true, bulkTied: spec.bulkTied, external: spec.external }
	};
}

export interface LayoutResult {
	schematic: Schematic;
	/** nets that are drawn as labels because the router could not place their wires */
	labelledNets: string[];
}

/** Where a net's name stands: above its longest straight wire, off the part labels */
export function nodeLabelsFor(schematic: Schematic): NodeLabel[] {
	const conn = analyzeConnectivity(schematic);
	const flagged = new Set(schematic.components.filter((c) => c.type === 'netflag').map((c) => (c.attributes['Value'] || '').toUpperCase()));
	const labels: NodeLabel[] = [];
	const busy: { x1: number; y1: number; x2: number; y2: number }[] = [];
	for (const c of schematic.components) {
		const w = c.box?.w ?? (c.rotation % 180 ? COMPONENT_DEFS[c.type]?.height : COMPONENT_DEFS[c.type]?.width) ?? 40;
		const h = c.box?.h ?? (c.rotation % 180 ? COMPONENT_DEFS[c.type]?.width : COMPONENT_DEFS[c.type]?.height) ?? 40;
		const text = c.type === 'generic' ? 0 : 70;
		busy.push({ x1: c.x - w / 2 - 4, y1: c.y - h / 2 - 22, x2: c.x + w / 2 + text, y2: c.y + h / 2 + 22 });
	}
	for (const net of conn.nets) {
		if (net.isGround || flagged.has(net.name.toUpperCase())) continue;
		const keys = new Set(net.points.map((p) => `${p.x},${p.y}`));
		const mine = schematic.wires.filter((w) => keys.has(`${w.x1},${w.y1}`) || keys.has(`${w.x2},${w.y2}`));
		if (!mine.length) continue;
		const candidates: { x: number; y: number; score: number }[] = [];
		const tw = net.name.length * CHAR + 8;
		for (const w of mine) {
			const horizontal = w.y1 === w.y2;
			const len = Math.abs(w.x2 - w.x1) + Math.abs(w.y2 - w.y1);
			const x = horizontal ? (w.x1 + w.x2) / 2 - tw / 2 - 3 : w.x1;
			const y = horizontal ? w.y1 : (w.y1 + w.y2) / 2 + 8;
			let score = len + (horizontal ? 30 : 0);
			const r = { x1: x + 3, y1: y - 20, x2: x + 3 + tw, y2: y - 2 };
			if (busy.some((b) => r.x1 < b.x2 && r.x2 > b.x1 && r.y1 < b.y2 && r.y2 > b.y1)) score -= 1000;
			candidates.push({ x, y, score });
		}
		candidates.sort((a, b) => b.score - a.score);
		const best = candidates[0];
		labels.push({ name: net.name, x: best.x, y: best.y, isGround: false });
		busy.push({ x1: best.x, y1: best.y - 22, x2: best.x + tw + 6, y2: best.y });
	}
	return labels;
}

/** Partition of pins into nets: drawn must equal written. Returns the nets that differ. */
export function checkConnectivity(schematic: Schematic, specs: ElementSpec[]): string[] {
	const conn = analyzeConnectivity(schematic);
	const wantNet = new Map<string, string>();
	specs.forEach((s, index) => {
		const comp = schematic.components.find((c) => c.id === `el:${index}:${s.ref}`);
		if (!comp) return;
		for (const p of s.pins) {
			const idx = comp.pins.findIndex((cp, i) => cp.name === p.name && !wantNet.has(`${comp.id}#${i}`));
			if (idx >= 0) wantNet.set(`${comp.id}#${idx}`, p.net.toUpperCase());
		}
	});
	const netOfPin = new Map<string, string>();
	for (const pc of conn.pinConnections) netOfPin.set(`${pc.componentId}#${pc.pinIndex}`, pc.netId ?? '?');
	const bad = new Set<string>();
	const seen = new Map<string, string>();
	const owner = new Map<string, string>();
	for (const [pin, want] of wantNet) {
		const got = netOfPin.get(pin) ?? '?';
		const first = seen.get(want);
		if (first && first !== got) bad.add(want);
		seen.set(want, got);
		const o = owner.get(got);
		if (o && o !== want) { bad.add(want); bad.add(o); }
		owner.set(got, want);
	}
	return [...bad];
}

type Role = 'spine' | 'shunt' | 'loose';

/**
 * The spine carries the signal and goes through ELK. A shunt (one wired pin, the other on ground or
 * a rail) hangs off its net afterwards, side by side, the way a person draws it: ELK would stack
 * them in one layer and make the sheet tall. Parts with no wire at all (supply sources) go to the side.
 */
function assignRoles(shapes: Shape[]): Map<Shape, Role> {
	const fanout = new Map<string, number>();
	for (const s of shapes) for (const p of s.pins) if (p.attach === 'wire') fanout.set(p.net.toUpperCase(), (fanout.get(p.net.toUpperCase()) ?? 0) + 1);
	const wired = (s: Shape) => s.pins.filter((p) => p.attach === 'wire' && (fanout.get(p.net.toUpperCase()) ?? 0) > 1);
	const roles = new Map<Shape, Role>();
	const onSpine = new Set<string>();
	for (const s of shapes) {
		const n = wired(s).length;
		const source = s.spec.letter === 'V' || s.spec.letter === 'I';
		const role: Role = n === 0 ? 'loose' : n === 1 && s.pins.length === 2 && !source ? 'shunt' : 'spine';
		roles.set(s, role);
		if (role === 'spine') for (const p of wired(s)) onSpine.add(p.net.toUpperCase());
	}
	// a net made of shunts only: one of them has to be the anchor
	for (const s of shapes) {
		if (roles.get(s) !== 'shunt') continue;
		const net = wired(s)[0].net.toUpperCase();
		if (!onSpine.has(net)) {
			roles.set(s, 'spine');
			onSpine.add(net);
		}
	}
	return roles;
}

interface Rect {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

const rectOf = (s: Shape, center = s.center!): Rect => ({
	x1: center.x - s.foot.left,
	y1: center.y - s.foot.top,
	x2: center.x + s.foot.right,
	y2: center.y + s.foot.bottom
});

function setCenter(s: Shape, x: number, y: number) {
	s.center = { x: snap(x), y: snap(y) };
	for (const p of s.pins) p.world = { x: s.center.x + p.x, y: s.center.y + p.y };
}

/** Grid offsets around an anchor, nearest first; the first free one that can win ends the search */
const offsetCache = new Map<string, { dx: number; dy: number; base: number }[]>();
function offsets(dyFrom: number, dyTo: number, skipNear: boolean) {
	const key = `${dyFrom},${dyTo},${skipNear}`;
	let list = offsetCache.get(key);
	if (!list) {
		list = [];
		for (let dx = -600; dx <= 600; dx += GRID) {
			for (let dy = dyFrom; dy <= dyTo; dy += GRID) {
				// off the net's own line, so its wire can reach the pin
				if (skipNear && Math.abs(dy) < 30) continue;
				list.push({ dx, dy, base: Math.abs(dx) + 1.2 * Math.abs(dy) });
			}
		}
		list.sort((a, b) => a.base - b.base);
		offsetCache.set(key, list);
	}
	return list;
}

/** Rectangles by coarse grid cell: placing a part only looks at its neighbours */
class RectIndex {
	private cells = new Map<string, Rect[]>();
	bounds = { x1: Infinity, y1: Infinity, x2: -Infinity, y2: -Infinity };
	private static SIZE = 200;
	private keys(r: Rect) {
		const out: string[] = [];
		for (let x = Math.floor(r.x1 / RectIndex.SIZE); x <= Math.floor(r.x2 / RectIndex.SIZE); x++) {
			for (let y = Math.floor(r.y1 / RectIndex.SIZE); y <= Math.floor(r.y2 / RectIndex.SIZE); y++) out.push(`${x},${y}`);
		}
		return out;
	}
	add(r: Rect) {
		for (const k of this.keys(r)) {
			if (!this.cells.has(k)) this.cells.set(k, []);
			this.cells.get(k)!.push(r);
		}
		this.bounds = { x1: Math.min(this.bounds.x1, r.x1), y1: Math.min(this.bounds.y1, r.y1), x2: Math.max(this.bounds.x2, r.x2), y2: Math.max(this.bounds.y2, r.y2) };
	}
	hits(r: Rect, margin: number) {
		const g = { x1: r.x1 - margin, y1: r.y1 - margin, x2: r.x2 + margin, y2: r.y2 + margin };
		for (const k of this.keys(g)) {
			for (const t of this.cells.get(k) ?? []) {
				if (g.x1 < t.x2 && g.x2 > t.x1 && g.y1 < t.y2 && g.y2 > t.y1) return true;
			}
		}
		return false;
	}
}

function placeShunts(shunts: Shape[], placed: Shape[]) {
	const taken = new RectIndex();
	for (const s of placed) taken.add(rectOf(s));
	const anchored = new Map<string, { x: number; y: number; side: Side }[]>();
	for (const s of placed) {
		for (const p of s.pins) {
			if (p.attach !== 'wire') continue;
			const key = p.net.toUpperCase();
			if (!anchored.has(key)) anchored.set(key, []);
			anchored.get(key)!.push({ ...p.world!, side: p.side });
		}
	}
	for (const s of shunts) {
		const pin = s.pins.find((p) => p.attach === 'wire')!;
		const pins = anchored.get(pin.net.toUpperCase()) ?? [];
		const sideways = pins.filter((p) => p.side === 'left' || p.side === 'right');
		const refY = (sideways[0] ?? pins[0]).y;
		let refX: number;
		if (pins.length === 1) refX = pins[0].x + (pins[0].side === 'right' ? 30 : pins[0].side === 'left' ? -30 : 0);
		else refX = (Math.min(...pins.map((p) => p.x)) + Math.max(...pins.map((p) => p.x))) / 2;
		const upright = pin.side === 'top' || pin.side === 'bottom';
		const b = taken.bounds;
		let best: { x: number; y: number; cost: number } | null = null;
		// a part hanging from the net has its pin below the line, a pull-up has it above
		const dyFrom = pin.side === 'top' ? 20 : -400;
		const dyTo = pin.side === 'bottom' ? -20 : 400;
		for (const o of offsets(dyFrom, dyTo, !upright)) {
			// sorted by distance: nothing further out can beat what we have
			if (best && o.base >= best.cost) break;
			const c = { x: snap(refX + o.dx) - pin.x, y: snap(refY + o.dy) - pin.y };
			const r = rectOf(s, c);
			if (taken.hits(r, 6)) continue;
			const grow = Math.max(0, b.y1 - r.y1) + Math.max(0, r.y2 - b.y2) + 0.25 * (Math.max(0, b.x1 - r.x1) + Math.max(0, r.x2 - b.x2));
			const cost = o.base + 2 * grow;
			if (!best || cost < best.cost) best = { ...c, cost };
		}
		// the search window can be full on a very dense sheet: outside everything always works
		const at = best ?? { x: refX - pin.x, y: pin.side === 'bottom' ? b.y1 - s.foot.bottom - 10 : b.y2 + s.foot.top + 10 };
		setCenter(s, at.x, at.y);
		taken.add(rectOf(s));
		pins.push({ ...pin.world!, side: pin.side });
		anchored.set(pin.net.toUpperCase(), pins);
	}
}

/** Supply sources and other unwired parts: a column to the left of the circuit */
function placeLoose(loose: Shape[], placed: Shape[]) {
	if (!loose.length) return;
	const rects = placed.map((s) => rectOf(s));
	const hasCircuit = rects.length > 0;
	const top = hasCircuit ? Math.min(...rects.map((r) => r.y1)) : 0;
	const bottom = hasCircuit ? Math.max(...rects.map((r) => r.y2)) : 300;
	// a pair of supplies stacks in one column: the sheet is wider than tall
	const limit = Math.max(bottom - top, 320);
	let right = hasCircuit ? Math.min(...rects.map((r) => r.x1)) - 20 : 0;
	let y = top;
	let columnWidth = 0;
	for (const s of loose) {
		const h = s.foot.top + s.foot.bottom;
		const w = s.foot.left + s.foot.right;
		if (y > top && y + h > top + limit) {
			right -= columnWidth + 10;
			y = top;
			columnWidth = 0;
		}
		columnWidth = Math.max(columnWidth, w);
		setCenter(s, right - s.foot.right, y + s.foot.top);
		y += h + 10;
	}
}

export const DEFAULT_ROUTE_BUDGET_MS = 6000;

/**
 * @param routeBudgetMs time for the wires; a net not finished by then is drawn with labels
 */
export async function layoutCircuit(specs: ElementSpec[], { extraRails = [] as string[], routeBudgetMs = DEFAULT_ROUTE_BUDGET_MS } = {}): Promise<LayoutResult> {
	const rails = findRails(specs);
	for (const r of extraRails) rails.add(r.toUpperCase());
	const labelledNets: string[] = [];
	const everyNet = () => {
		for (const s of specs) for (const p of s.pins) if (!isGroundNet(p.net)) rails.add(p.net.toUpperCase());
	};
	// The drawing must say what the netlist says. Nets that do not come out exact become labels;
	// on the last pass every net is a label, which is exact by construction.
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt === 2) everyNet();
		const shapes = specs.map((s) => shapeOf(s, rails));
		const roles = assignRoles(shapes);
		const spine = shapes.filter((s) => roles.get(s) === 'spine');
		await place(spine);
		placeShunts(shapes.filter((s) => roles.get(s) === 'shunt'), spine);
		placeLoose(shapes.filter((s) => roles.get(s) === 'loose'), shapes.filter((s) => roles.get(s) !== 'loose'));
		const { failed, sheet } = await route(shapes, attempt === 2 ? Infinity : routeBudgetMs);
		const wrong = [...failed, ...checkConnectivity(sheet, specs)];
		if (!wrong.length) {
			sheet.nodeLabels = nodeLabelsFor(sheet);
			return { schematic: sheet, labelledNets };
		}
		for (const n of wrong) {
			rails.add(n.toUpperCase());
			if (!labelledNets.includes(n)) labelledNets.push(n);
		}
	}
	// the caller shows the text without a drawing rather than a drawing that says something else
	throw new Error('the wiring could not be drawn exactly');
}

async function route(shapes: Shape[], budgetMs: number): Promise<{ failed: string[]; sheet: Schematic }> {
	const router = new Router();
	const components: Component[] = shapes.map((s, i) => toComponent(s, i));
	const pinsByNet = new Map<string, { x: number; y: number; side: Side }[]>();

	for (const s of shapes) {
		const c = s.center!;
		router.extend(c.x - s.foot.left, c.y - s.foot.top, c.x + s.foot.right, c.y + s.foot.bottom);
		router.blockRect(c.x - s.hw, c.y - s.hh, c.x + s.hw, c.y + s.hh);
		for (const l of s.labels) router.softRect(c.x + l.x, c.y + l.y, c.x + l.x + l.w, c.y + l.y + l.h);
	}
	for (const s of shapes) {
		for (const p of s.pins) {
			router.markPin(p.world!.x, p.world!.y, p.net.toUpperCase());
		}
	}

	// grounds and labels first: the wires go around them
	let extras = 0;
	for (const s of shapes) {
		for (const p of s.pins) {
			if (p.attach === 'wire') {
				const key = p.net.toUpperCase();
				if (!pinsByNet.has(key)) pinsByNet.set(key, []);
				pinsByNet.get(key)!.push({ ...p.world!, side: p.side });
				continue;
			}
			const d = DIRS[p.side];
			const net = p.net.toUpperCase();
			const end = { x: p.world!.x + d.x * p.stub, y: p.world!.y + d.y * p.stub };
			if (p.stub > 0) {
				const path = [];
				for (let i = 0; i <= p.stub; i += GRID) path.push({ x: p.world!.x + d.x * i, y: p.world!.y + d.y * i });
				router.lay(path, net);
			}
			if (p.attach === 'ground') {
				const up = p.side === 'top';
				const def = COMPONENT_DEFS.ground;
				components.push({
					id: `gnd:${extras++}`,
					type: 'ground',
					x: end.x,
					y: end.y + (up ? -10 : 10),
					rotation: up ? 180 : 0,
					mirror: false,
					attributes: { InstName: '', Value: '' },
					pins: def.pins.map((q, i) => ({ ...q, id: String(i) }))
				});
				const gy = end.y + (up ? -10 : 10);
				router.blockRect(end.x - 20, gy - 10, end.x + 20, gy + 10);
				router.markPin(end.x, end.y, net);
			} else {
				const dir = p.side === 'left' ? 'left' : p.side === 'right' ? 'right' : p.side === 'top' ? 'up' : 'down';
				components.push({
					id: `flag:${extras++}`,
					type: 'netflag',
					x: end.x,
					y: end.y,
					rotation: 0,
					mirror: false,
					attributes: { InstName: '', Value: p.net, Dir: dir },
					pins: [{ id: '0', x: 0, y: 0, name: 'N' }]
				});
				const size = flagSize(p.net);
				const x1 = dir === 'left' ? end.x - size.w : dir === 'right' ? end.x : end.x - size.w / 2;
				const x2 = dir === 'left' ? end.x : dir === 'right' ? end.x + size.w : end.x + size.w / 2;
				const y1 = dir === 'up' ? end.y - size.h : dir === 'down' ? end.y : end.y - size.h / 2;
				const y2 = dir === 'up' ? end.y : dir === 'down' ? end.y + size.h : end.y + size.h / 2;
				router.blockRect(x1, y1, x2, y2);
				router.markPin(end.x, end.y, net);
			}
		}
	}

	// short nets first: they get the straight lines
	const span = (pins: { x: number; y: number }[]) =>
		Math.max(...pins.map((p) => p.x)) - Math.min(...pins.map((p) => p.x)) + Math.max(...pins.map((p) => p.y)) - Math.min(...pins.map((p) => p.y));
	const order = [...pinsByNet.entries()].filter(([, pins]) => pins.length > 1).sort((a, b) => span(a[1]) - span(b[1]));
	const failed: string[] = [];
	const deadline = Date.now() + budgetMs;
	let breath = Date.now();
	for (const [net, pins] of order) {
		// a big sheet takes a while: the page keeps answering, and there is an end to it
		if (Date.now() > deadline) { failed.push(net); continue; }
		if (Date.now() - breath > 40) {
			await new Promise((r) => setTimeout(r));
			breath = Date.now();
		}
		const seed = [...pins].sort((a, b) => a.x - b.x || a.y - b.y)[0];
		const tree = new Set<string>([cell(seed.x, seed.y)]);
		const remaining = pins.filter((p) => p !== seed);
		while (remaining.length) {
			// nearest terminal next
			let best = 0;
			let bestD = Infinity;
			remaining.forEach((p, i) => {
				for (const t of tree) {
					const [x, y] = t.split(',').map(Number);
					const dist = Math.abs(p.x - x) + Math.abs(p.y - y);
					if (dist < bestD) { bestD = dist; best = i; }
				}
			});
			const term = remaining.splice(best, 1)[0];
			if (tree.has(cell(term.x, term.y))) continue;
			const path = router.connect(net, term, term.side, tree);
			if (!path) { failed.push(net); break; }
			router.lay(path, net);
			for (const p of path) tree.add(cell(p.x, p.y));
		}
	}

	return {
		failed,
		sheet: { components, wires: router.wires, junctions: router.junctions }
	};
}
