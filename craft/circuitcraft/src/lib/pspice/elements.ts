/**
 * From a parsed PSpice document to what the schematic draws: which symbol, which pins, which nets.
 * Anything the symbol set cannot draw becomes a labelled box with named pins; nothing is dropped.
 */
import type { ComponentType } from '$lib/schematic/types';
import type { Files, ParsedDoc, ParsedElement } from './translator';
import { read } from './translator';

export interface ElementPin {
	name: string;
	net: string;
}

export interface ElementSpec {
	ref: string;
	letter: string;
	symbol: ComponentType;
	/** in SPICE node order */
	pins: ElementPin[];
	/** everything after the nodes on the line */
	value: string;
	/** second line in a box */
	title: string;
	/** a MOSFET drawn with three pins: its bulk follows the source */
	bulkTied?: boolean;
	/** an X whose .SUBCKT is in no open file */
	missingPart?: string;
	/** the line comes from this .INC file */
	external?: string;
}

export interface LibraryInfo {
	subckts: Map<string, string[]>;
	modelKinds: Map<string, string>;
}

/** Pin names and model kinds from the document and every companion file */
export function libraryInfo(doc: ParsedDoc, files: Files = {}): LibraryInfo {
	const info: LibraryInfo = { subckts: new Map(), modelKinds: new Map() };
	const add = (d: ParsedDoc) => {
		for (const s of d.subckts) if (s.name && !info.subckts.has(s.name.toUpperCase())) info.subckts.set(s.name.toUpperCase(), s.pins);
		for (const m of d.models) if (m.name && !info.modelKinds.has(m.name.toUpperCase())) info.modelKinds.set(m.name.toUpperCase(), m.kind);
	};
	add(doc);
	for (const text of Object.values(files)) {
		try {
			add(readCompanion(text));
		} catch { /* a companion we cannot read is reported when the run needs it */ }
	}
	return info;
}

// companions do not change while a document is open, and vendor libraries are long
const parsedCompanions = new Map<string, ParsedDoc>();
function readCompanion(text: string): ParsedDoc {
	let doc = parsedCompanions.get(text);
	if (!doc) {
		// read() takes the first line as a title; a library may start with its first .SUBCKT
		doc = read(`* companion\n${text}`);
		if (parsedCompanions.size > 32) parsedCompanions.clear();
		parsedCompanions.set(text, doc);
	}
	return doc;
}

const NAMED_PINS: Record<string, string[]> = {
	E: ['N+', 'N-', 'NC+', 'NC-'],
	G: ['N+', 'N-', 'NC+', 'NC-'],
	F: ['N+', 'N-'],
	H: ['N+', 'N-'],
	B: ['N+', 'N-'],
	S: ['N+', 'N-', 'C+', 'C-'],
	W: ['N+', 'N-'],
	T: ['A+', 'A-', 'B+', 'B-'],
	J: ['D', 'G', 'S'],
	Z: ['D', 'G', 'S'],
	Q: ['C', 'B', 'E', 'S'],
	M: ['D', 'G', 'S', 'B']
};

// read() takes four "nodes" for F, H and W, but only the first two are nodes: the other tokens are
// the controlling source and the gain or model.
const TWO_NODES_THEN_CONTROL = new Set(['F', 'H', 'W']);

function nodesAndRest(el: ParsedElement, info: LibraryInfo): { nodes: string[]; rest: string[] } {
	const all = [...el.nodes, ...el.rest];
	if (TWO_NODES_THEN_CONTROL.has(el.letter)) return { nodes: all.slice(0, 2), rest: all.slice(2) };
	if (el.letter === 'X') {
		// a subcircuit call without PARAMS: (LTspice, ngspice) ends in name=value pairs after its name
		const n = all.findIndex((t) => t.includes('='));
		if (n > 0 && !/^PARAMS:?$/i.test(all[n - 1])) return { nodes: all.slice(0, n - 1), rest: all.slice(n - 1) };
	}
	if (el.letter === 'Q') {
		// C B E [substrate] model [area]: the model is the first token we know as one
		const known = (t?: string) => !!t && info.modelKinds.has(t.toUpperCase());
		if (known(all[3])) return { nodes: all.slice(0, 3), rest: all.slice(3) };
		if (known(all[4])) return { nodes: all.slice(0, 4), rest: all.slice(4) };
	}
	return { nodes: el.nodes, rest: el.rest };
}

const short = (s: string, max: number) => (s.length > max ? s.slice(0, max - 1) + '…' : s);

export function describeElement(el: ParsedElement, info: LibraryInfo): ElementSpec {
	const { nodes, rest } = nodesAndRest(el, info);
	const value = rest.join(' ');
	const spec: ElementSpec = { ref: el.ref, letter: el.letter, symbol: 'generic', pins: [], value, title: '' };
	const box = (names: string[]) => {
		spec.symbol = 'generic';
		spec.pins = nodes.map((net, i) => ({ name: names[i] ?? `P${i + 1}`, net }));
	};
	const symbol = (type: ComponentType, names: string[]) => {
		// a line with the wrong number of nodes is still shown; the simulator will say what is wrong
		if (nodes.length !== names.length) {
			box(names);
			spec.title = short(value, 14);
			return;
		}
		spec.symbol = type;
		spec.pins = nodes.map((net, i) => ({ name: names[i], net }));
	};
	switch (el.letter) {
		case 'R': symbol('resistor', ['1', '2']); break;
		case 'C': symbol('capacitor', ['1', '2']); break;
		case 'L': symbol('inductor', ['1', '2']); break;
		case 'V': symbol('voltage', ['+', '-']); break;
		case 'I': symbol('current', ['+', '-']); break;
		case 'D': symbol('diode', ['A', 'K']); break;
		case 'Q': {
			if (nodes.length === 3) {
				const kind = info.modelKinds.get((rest[0] || '').toUpperCase());
				symbol(kind === 'PNP' ? 'pnp' : 'npn', ['C', 'B', 'E']);
			} else {
				box(NAMED_PINS.Q);
				spec.title = short(rest[0] || '', 14);
			}
			break;
		}
		case 'M': {
			const kind = info.modelKinds.get((rest[0] || '').toUpperCase());
			if (nodes.length === 4 && nodes[3].toUpperCase() === nodes[2].toUpperCase()) {
				spec.symbol = kind === 'PMOS' ? 'pmos' : 'nmos';
				spec.pins = [{ name: 'D', net: nodes[0] }, { name: 'G', net: nodes[1] }, { name: 'S', net: nodes[2] }];
				spec.bulkTied = true;
			} else {
				box(NAMED_PINS.M);
				spec.title = short(rest[0] || '', 14);
			}
			break;
		}
		case 'X': {
			const declared = info.subckts.get((rest[0] || '').toUpperCase());
			box(declared && declared.length === nodes.length ? declared : nodes.map((_, i) => `P${i + 1}`));
			if (!declared) spec.missingPart = rest[0] || '?';
			spec.title = short(rest[0] || 'subckt', 14);
			break;
		}
		default: {
			box(NAMED_PINS[el.letter] ?? []);
			const head = /^(VALUE|TABLE|LAPLACE|FREQ|CHEBYSHEV|POLY)/i.exec(value)?.[1]?.toUpperCase();
			spec.title = head ?? short(rest.at(-1) ?? rest[0] ?? '', 14);
			break;
		}
	}
	return spec;
}

/** The elements of the document and of the .INC files it pulls in (a sub-sheet is part of the circuit) */
export function describeElements(doc: ParsedDoc, files: Files = {}): ElementSpec[] {
	const info = libraryInfo(doc, files);
	const specs = doc.elements.map((el) => describeElement(el, info));
	const seen = new Set<string>();
	const addIncludes = (includes: string[]) => {
		for (const line of includes) {
			const m = /^\.(INC|INCLUDE)\s+"?([^"\s]+)"?/i.exec(line);
			if (!m) continue;
			const name = m[2].split(/[\\/]/).pop()!.toLowerCase();
			const text = files[name];
			if (text === undefined || seen.has(name)) continue;
			seen.add(name);
			const inner = read(`* ${name}\n${text}`);
			for (const el of inner.elements) specs.push({ ...describeElement(el, info), external: name });
			addIncludes(inner.includes);
		}
	};
	addIncludes(doc.includes);
	return specs;
}
