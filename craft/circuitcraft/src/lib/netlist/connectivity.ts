/**
 * Wire connectivity analysis
 * Finds connected wire segments and junctions to form nets
 */

import type { Component, Wire, Junction, Point, Schematic } from '../schematic/types';
import type { Net, PinConnection, ConnectivityResult } from './types';
import { COMPONENT_DEFS, defFor } from '../schematic/component-defs';
import { PIN_ORDER } from './types';

/** Tolerance for point matching (in schematic units) */
const TOLERANCE = 1;

/** Check if two points are the same (within tolerance) */
export function pointsEqual(p1: Point, p2: Point): boolean {
	return Math.abs(p1.x - p2.x) < TOLERANCE && Math.abs(p1.y - p2.y) < TOLERANCE;
}

/** Check if a point lies on a wire segment */
export function pointOnWire(p: Point, wire: Wire): boolean {
	// Check if point is on the line segment
	const minX = Math.min(wire.x1, wire.x2) - TOLERANCE;
	const maxX = Math.max(wire.x1, wire.x2) + TOLERANCE;
	const minY = Math.min(wire.y1, wire.y2) - TOLERANCE;
	const maxY = Math.max(wire.y1, wire.y2) + TOLERANCE;
	
	if (p.x < minX || p.x > maxX || p.y < minY || p.y > maxY) return false;
	
	// For horizontal wire
	if (Math.abs(wire.y1 - wire.y2) < TOLERANCE) {
		return Math.abs(p.y - wire.y1) < TOLERANCE;
	}
	// For vertical wire
	if (Math.abs(wire.x1 - wire.x2) < TOLERANCE) {
		return Math.abs(p.x - wire.x1) < TOLERANCE;
	}
	return false;
}

/** Get all connection points from a wire (endpoints) */
function getWireEndpoints(wire: Wire): Point[] {
	return [
		{ x: wire.x1, y: wire.y1 },
		{ x: wire.x2, y: wire.y2 }
	];
}

/** Get absolute pin positions for a component */
export function getComponentPinPositions(comp: Component): { pin: string; pos: Point }[] {
	// Use component's own pins if available (e.g., from LTSpice import), otherwise use COMPONENT_DEFS
	const pinDefs = (comp.pins && comp.pins.length > 0)
		? comp.pins.map(p => ({ name: p.name, x: p.x, y: p.y }))
		: defFor(comp)?.pins || COMPONENT_DEFS[comp.type]?.pins || [];

	if (pinDefs.length === 0) return [];

	return pinDefs.map(pin => {
		// Apply rotation and mirror to pin position
		let px = pin.x;
		let py = pin.y;

		// Mirror first (flip X)
		if (comp.mirror) {
			px = -px;
		}

		// Then rotate
		const rad = (comp.rotation * Math.PI) / 180;
		const cos = Math.cos(rad);
		const sin = Math.sin(rad);
		const rx = px * cos - py * sin;
		const ry = px * sin + py * cos;

		return {
			pin: pin.name,
			pos: { x: Math.round(comp.x + rx), y: Math.round(comp.y + ry) }
		};
	});
}

/**
 * Which pin stands at each position of the SPICE node list. Symbols have a fixed order
 * (a BJT is C B E while its pins are listed B C E); a box lists its pins in node order.
 */
export function nodeOrder(comp: Component): number[] {
	const order = PIN_ORDER[comp.type];
	if (!order) return comp.pins.map((_, i) => i);
	const names = comp.pins.length ? comp.pins.map((p) => p.name) : (COMPONENT_DEFS[comp.type]?.pins || []).map((p) => p.name);
	return order.map((name) => names.indexOf(name));
}

/** Union-Find data structure for grouping connected points */
class UnionFind {
	private parent: Map<string, string> = new Map();
	
	private key(p: Point): string {
		// Round to grid to handle floating point
		return `${Math.round(p.x)},${Math.round(p.y)}`;
	}
	
	find(p: Point): string {
		const k = this.key(p);
		if (!this.parent.has(k)) {
			this.parent.set(k, k);
			return k;
		}
		let root = k;
		while (this.parent.get(root) !== root) {
			root = this.parent.get(root)!;
		}
		// Path compression
		let curr = k;
		while (curr !== root) {
			const next = this.parent.get(curr)!;
			this.parent.set(curr, root);
			curr = next;
		}
		return root;
	}
	
	union(p1: Point, p2: Point): void {
		const r1 = this.find(p1);
		const r2 = this.find(p2);
		if (r1 !== r2) {
			this.parent.set(r1, r2);
		}
	}
	
	getGroups(): Map<string, Point[]> {
		const groups = new Map<string, Point[]>();
		for (const k of this.parent.keys()) {
			const root = this.find({ x: parseInt(k.split(',')[0]), y: parseInt(k.split(',')[1]) });
			if (!groups.has(root)) {
				groups.set(root, []);
			}
			const [x, y] = k.split(',').map(Number);
			groups.get(root)!.push({ x, y });
		}
		return groups;
	}
}

/** Analyze schematic connectivity and build nets */
export function analyzeConnectivity(schematic: Schematic): ConnectivityResult {
	const uf = new UnionFind();
	const errors: string[] = [];
	
	// Step 1: Add all wire endpoints and connect wire segments
	for (const wire of schematic.wires) {
		const p1 = { x: wire.x1, y: wire.y1 };
		const p2 = { x: wire.x2, y: wire.y2 };
		uf.find(p1);
		uf.find(p2);
		uf.union(p1, p2);
	}
	
	// Step 2: Connect via junctions
	for (const junc of schematic.junctions) {
		const jp = { x: junc.x, y: junc.y };
		uf.find(jp);
		// Connect junction to any wire it touches
		for (const wire of schematic.wires) {
			if (pointOnWire(jp, wire)) {
				uf.union(jp, { x: wire.x1, y: wire.y1 });
			}
		}
	}
	
	// Step 3: Connect wire endpoints that touch
	for (let i = 0; i < schematic.wires.length; i++) {
		const w1 = schematic.wires[i];
		const eps1 = getWireEndpoints(w1);
		for (let j = i + 1; j < schematic.wires.length; j++) {
			const w2 = schematic.wires[j];
			const eps2 = getWireEndpoints(w2);
			for (const p1 of eps1) {
				for (const p2 of eps2) {
					if (pointsEqual(p1, p2)) {
						uf.union(p1, p2);
					}
				}
			}
		}
	}
	
	// Step 4: Connect component pins to wires
	const pinConnections: PinConnection[] = [];

	for (const comp of schematic.components) {
		const pins = getComponentPinPositions(comp);
		const instName = comp.attributes['InstName'] || comp.id;

		for (const [pinIndex, { pin, pos }] of pins.entries()) {
			uf.find(pos);

			// Check if pin touches any wire endpoint
			let connected = false;
			for (const wire of schematic.wires) {
				const eps = getWireEndpoints(wire);
				for (const ep of eps) {
					if (pointsEqual(pos, ep)) {
						uf.union(pos, ep);
						connected = true;
					}
				}
				// Also check if pin is on wire segment
				if (pointOnWire(pos, wire)) {
					uf.union(pos, { x: wire.x1, y: wire.y1 });
					connected = true;
				}
			}

			pinConnections.push({
				componentId: comp.id,
				componentName: instName,
				pinName: pin,
				pinIndex,
				position: pos,
				netId: null  // Will be filled after net assignment
			});

			if (!connected && comp.type !== 'ground') {
				// Ground doesn't need wire connection, it defines node 0
			}
		}
	}

	// Step 4b: Net labels with the same name are one node, wherever they stand
	const firstFlag = new Map<string, Point>();
	for (const comp of schematic.components) {
		if (comp.type !== 'netflag') continue;
		const name = (comp.attributes['Value'] || '').toUpperCase();
		if (!name) continue;
		const pos = getComponentPinPositions(comp)[0]?.pos;
		if (!pos) continue;
		const first = firstFlag.get(name);
		if (first) uf.union(first, pos);
		else firstFlag.set(name, pos);
	}

	// Step 5: Build nets from union-find groups
	const groups = uf.getGroups();
	const nets: Net[] = [];

	// First pass: identify ground nets
	const groundPoints = new Set<string>();
	for (const comp of schematic.components) {
		if (comp.type === 'ground') {
			const pins = getComponentPinPositions(comp);
			for (const { pos } of pins) {
				const root = uf.find(pos);
				groundPoints.add(root);
			}
		}
	}

	// Net names: a net label wins; then the name the document used for most of the net's pins, so
	// an opened document keeps its node names; a new net gets the next free N<number>.
	const compsById = new Map(schematic.components.map((c) => [c.id, c]));
	const pinsByRoot = new Map<string, PinConnection[]>();
	for (const pc of pinConnections) {
		const root = uf.find(pc.position);
		if (!pinsByRoot.has(root)) pinsByRoot.set(root, []);
		pinsByRoot.get(root)!.push(pc);
	}
	const flagName = new Map<string, string>();
	const taken = new Set<string>(['0']);
	for (const [root, pcs] of pinsByRoot) {
		for (const pc of pcs) {
			const comp = compsById.get(pc.componentId);
			if (comp?.type !== 'netflag' || !comp.attributes['Value']) continue;
			if (!flagName.has(root)) flagName.set(root, comp.attributes['Value']);
			taken.add(comp.attributes['Value'].toUpperCase());
		}
	}
	const rootName = new Map<string, string>();
	for (const [root] of groups) {
		if (groundPoints.has(root)) { rootName.set(root, '0'); continue; }
		const flag = flagName.get(root);
		if (flag) rootName.set(root, flag);
	}
	const votes: { root: string; name: string; count: number }[] = [];
	for (const [root, pcs] of pinsByRoot) {
		if (rootName.has(root)) continue;
		const count = new Map<string, { name: string; count: number }>();
		for (const pc of pcs) {
			const comp = compsById.get(pc.componentId);
			if (!comp?.source) continue;
			const position = nodeOrder(comp).indexOf(pc.pinIndex);
			const name = comp.source.nodes[position];
			if (!name) continue;
			const key = name.toUpperCase();
			count.set(key, { name: count.get(key)?.name ?? name, count: (count.get(key)?.count ?? 0) + 1 });
		}
		for (const c of count.values()) votes.push({ root, ...c });
	}
	votes.sort((a, b) => b.count - a.count);
	for (const v of votes) {
		if (rootName.has(v.root) || taken.has(v.name.toUpperCase())) continue;
		rootName.set(v.root, v.name);
		taken.add(v.name.toUpperCase());
	}
	let netCounter = 1;
	const freshName = () => {
		while (taken.has(`N${netCounter}`)) netCounter++;
		taken.add(`N${netCounter}`);
		return `N${netCounter}`;
	};
	const netId = (name: string) => `net_${name}`;

	// Create nets
	const rootToNet = new Map<string, Net>();
	for (const [root, points] of groups) {
		const isGround = groundPoints.has(root);
		const name = rootName.get(root) ?? freshName();
		const net: Net = {
			id: netId(name),
			name,
			points,
			isGround
		};
		nets.push(net);
		rootToNet.set(root, net);
	}

	// Assign nets to pin connections
	for (const pc of pinConnections) {
		const root = uf.find(pc.position);
		const net = rootToNet.get(root);
		if (net) {
			pc.netId = net.id;
		} else {
			errors.push(`Pin ${pc.pinName} of ${pc.componentName} is not connected to any net`);
		}
	}

	return { nets, pinConnections, errors };
}

