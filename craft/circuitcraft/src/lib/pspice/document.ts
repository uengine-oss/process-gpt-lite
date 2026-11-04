/**
 * The open document. Its text is the single source of truth: the schematic writes back into it by
 * changing only the lines of the elements that changed, so an imported file that was not edited
 * saves byte for byte the way it came in.
 */
import type { Component, Schematic, SpiceDirective, SpiceModel } from '$lib/schematic/types';
import { analyzeConnectivity, nodeOrder } from '$lib/netlist/connectivity';
import { COMPONENT_PREFIX, DEFAULT_VALUES } from '$lib/netlist/types';
import { findModel } from '$lib/models';
import type { Files } from './translator';

// -- bytes -----------------------------------------------------------------------------------------

export type Encoding = 'utf-8' | 'utf-8-bom' | 'euc-kr' | 'latin1';

export function decodeBytes(bytes: Uint8Array): { text: string; encoding: Encoding } {
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	try {
		const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
		return bom ? { text: text.replace(/^﻿/, ''), encoding: 'utf-8-bom' } : { text, encoding: 'utf-8' };
	} catch { /* older tools write the local code page */ }
	try {
		return { text: new TextDecoder('euc-kr', { fatal: true }).decode(bytes), encoding: 'euc-kr' };
	} catch { /* not Korean either */ }
	// byte for byte (TextDecoder's "latin1" is windows-1252, which does not map back)
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return { text, encoding: 'latin1' };
}

let eucTable: Map<string, number[]> | null = null;
function eucKrTable() {
	if (eucTable) return eucTable;
	const table = new Map<string, number[]>();
	const dec = new TextDecoder('euc-kr');
	for (let hi = 0x81; hi <= 0xfe; hi++) {
		for (let lo = 0x41; lo <= 0xfe; lo++) {
			const ch = dec.decode(new Uint8Array([hi, lo]));
			if (ch.length === 1 && ch !== '�' && !table.has(ch)) table.set(ch, [hi, lo]);
		}
	}
	eucTable = table;
	return table;
}

export function encodeText(text: string, encoding: Encoding): Uint8Array {
	if (encoding === 'latin1') return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
	if (encoding === 'euc-kr') {
		const table = eucKrTable();
		const out: number[] = [];
		for (const ch of text) {
			const code = ch.charCodeAt(0);
			if (code < 0x80) out.push(code);
			else out.push(...(table.get(ch) ?? [0x3f]));
		}
		return Uint8Array.from(out);
	}
	const body = new TextEncoder().encode(text);
	if (encoding !== 'utf-8-bom') return body;
	const out = new Uint8Array(body.length + 3);
	out.set([0xef, 0xbb, 0xbf]);
	out.set(body, 3);
	return out;
}

export function toBytes(data: ArrayBuffer | ArrayBufferView | string | number[]): Uint8Array {
	if (typeof data === 'string') return new TextEncoder().encode(data);
	if (Array.isArray(data)) return Uint8Array.from(data);
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

// -- file kinds ------------------------------------------------------------------------------------

export const CIRCUIT_EXT = /\.(cir|net|ckt|sp)$/i;
export const LIBRARY_EXT = /\.(lib|mod|inc|sub|als)$/i;
export const ACCEPTED_EXTENSIONS = ['.cir', '.net', '.ckt', '.sp', '.lib', '.mod', '.inc', '.sub', '.als', '.json'];

export const baseFileName = (name: string) => name.split(/[\\/]/).pop() ?? name;

/** The name a save goes out under: a circuit is always a .cir, a library keeps its name */
export function saveName(name: string): string {
	if (LIBRARY_EXT.test(name)) return name;
	const base = baseFileName(name).replace(/\.[^.]*$/, '') || 'circuit';
	return `${base}.cir`;
}

export function companionMap(files: { name: string; text: string }[]): Files {
	const out: Files = {};
	for (const f of files) out[baseFileName(f.name).toLowerCase()] = f.text;
	return out;
}

export const EMPTY_DOCUMENT = `* Untitled circuit
.TRAN 1u 10m
.PROBE
.END
`;

// -- physical lines --------------------------------------------------------------------------------

interface Span {
	start: number;
	end: number;
}
interface DirectiveSpan extends Span {
	keyword: string;
	text: string;
}

interface ElementSpan extends Span {
	ref: string;
	comment: string;
}

interface Scan {
	lines: string[];
	/** by upper-case name; a name written twice has two spans */
	elements: Map<string, ElementSpan[]>;
	directives: DirectiveSpan[];
	endLine: number;
}

/** Which physical lines hold which element or directive, outside any .SUBCKT */
export function scan(text: string): Scan {
	const lines = text.split('\n');
	const elements: Scan['elements'] = new Map();
	const directives: DirectiveSpan[] = [];
	let depth = 0;
	let open: Span | null = null;
	let openText: DirectiveSpan | null = null;
	let endLine = -1;
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i].replace(/\r$/, '');
		const trimmed = line.trim();
		if (!trimmed || trimmed[0] === '*') continue;
		if (trimmed[0] === '+') {
			if (open) open.end = i;
			if (openText) openText.text += ' ' + trimmed.replace(/^\+\s*/, '').replace(/;.*$/, '').trim();
			continue;
		}
		open = null;
		openText = null;
		if (/^\.SUBCKT\b/i.test(trimmed)) { depth++; continue; }
		if (/^\.ENDS\b/i.test(trimmed)) { depth = Math.max(0, depth - 1); continue; }
		if (depth > 0) continue;
		if (trimmed[0] === '.') {
			const keyword = trimmed.split(/\s+/)[0].toUpperCase();
			if (keyword === '.END') { endLine = i; continue; }
			openText = { keyword, start: i, end: i, text: trimmed.replace(/;.*$/, '').trim() };
			directives.push(openText);
			open = openText;
			continue;
		}
		if (trimmed[0] === ';') continue;
		const ref = trimmed.split(/\s+/)[0];
		const comment = /;.*$/.exec(trimmed)?.[0] ?? '';
		const span = { ref, start: i, end: i, comment };
		const same = elements.get(ref.toUpperCase());
		if (same) same.push(span);
		else elements.set(ref.toUpperCase(), [span]);
		open = span;
	}
	return { lines, elements, directives, endLine };
}

interface Patch {
	start: number;
	end: number;
	replacement: string[];
}

function applyPatches(s: Scan, patches: Patch[], inserts: string[]): string {
	const lines = [...s.lines];
	const eol = lines.some((l) => l.endsWith('\r')) ? '\r' : '';
	for (const p of [...patches].sort((a, b) => b.start - a.start)) {
		lines.splice(p.start, p.end - p.start + 1, ...p.replacement.map((r) => r + eol));
	}
	if (inserts.length) {
		// after the last element if there is one, else before the first analysis, else before .END
		const rescanned = scan(lines.join('\n'));
		let at = -1;
		for (const spans of rescanned.elements.values()) for (const e of spans) at = Math.max(at, e.end + 1);
		if (at < 0) {
			const first = rescanned.directives.find((d) => /^\.(TRAN|AC|DC|OP|NOISE|TF|FOUR|PROBE|STEP)/.test(d.keyword));
			at = first ? first.start : rescanned.endLine >= 0 ? rescanned.endLine : lines.length;
		}
		lines.splice(at, 0, ...inserts.map((r) => r + eol));
	}
	return lines.join('\n');
}

// -- schematic -> element lines --------------------------------------------------------------------

export interface WrittenElement {
	comp: Component;
	ref: string;
	nodes: string[];
	value: string;
}

/** What each drawn element says in SPICE terms, with the current wiring */
export function writtenElements(schematic: Schematic): WrittenElement[] {
	const conn = analyzeConnectivity(schematic);
	const netName = new Map(conn.nets.map((n) => [n.id, n.name]));
	const pinNet = new Map<string, string>();
	for (const pc of conn.pinConnections) pinNet.set(`${pc.componentId}#${pc.pinIndex}`, netName.get(pc.netId ?? '') ?? '0');
	const out: WrittenElement[] = [];
	for (const comp of schematic.components) {
		if (comp.type === 'ground' || comp.type === 'netflag') continue;
		const prefix = COMPONENT_PREFIX[comp.type] ?? '';
		const ref = comp.attributes['InstName'] || `${prefix}?`;
		const value = comp.attributes['Value'] ?? comp.source?.value ?? DEFAULT_VALUES[comp.type] ?? '';
		const nodes = nodeOrder(comp).map((pinIndex) => pinNet.get(`${comp.id}#${pinIndex}`) ?? '0');
		// a drawn MOSFET has 3 pins; the netlist needs the bulk: it follows the source
		if ((comp.type === 'nmos' || comp.type === 'pmos') && nodes.length === 3) nodes.push(nodes[2]);
		out.push({ comp, ref, nodes, value });
	}
	return out;
}

const lineOf = (e: { ref: string; nodes: string[]; value: string }, comment = '') =>
	[e.ref, ...e.nodes, e.value].filter(Boolean).join(' ') + (comment ? ` ${comment}` : '');

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x.toUpperCase() === b[i].toUpperCase());

/**
 * Bring the document text in line with the schematic. Only elements that changed are touched.
 * @param known model names available from the document's libraries
 */
export function syncFromSchematic(text: string, schematic: Schematic, known: Set<string> = new Set()): string {
	const s = scan(text);
	const patches: Patch[] = [];
	const inserts: string[] = [];
	const unclaimed = new Map([...s.elements].map(([k, spans]) => [k, [...spans]]));
	const written = writtenElements(schematic);

	for (const w of written) {
		const src = w.comp.source;
		// drawn from an .INC file: that file is not this document
		if (src?.external) continue;
		const key = src?.ref.toUpperCase();
		const span = key ? unclaimed.get(key)?.shift() : undefined;
		if (span) {
			if (src && src.ref === w.ref && src.value === w.value && sameList(src.nodes, w.nodes)) continue;
			patches.push({ start: span.start, end: span.end, replacement: [lineOf(w, span.comment)] });
		} else {
			inserts.push(lineOf(w));
		}
		w.comp.source = { ...(src ?? { imported: false }), ref: w.ref, nodes: w.nodes, value: w.value };
	}
	// a deleted part: its line goes
	for (const spans of unclaimed.values()) {
		for (const span of spans) patches.push({ start: span.start, end: span.end, replacement: [] });
	}

	// a part drawn with a model name from the built-in list: its .MODEL comes along
	const models = new Set([...known, ...s.directives.filter((d) => d.keyword === '.MODEL').map((d) => d.text.split(/\s+/)[1]?.toUpperCase())]);
	for (const w of written) {
		if (!['diode', 'npn', 'pnp', 'nmos', 'pmos'].includes(w.comp.type)) continue;
		// an opened document says where its models are: a missing library is reported, not papered over
		if (w.comp.source?.imported) continue;
		const name = w.value.split(/\s+/)[0];
		if (!name || models.has(name.toUpperCase())) continue;
		const lib = findModel(name) ?? builtinFallback(w.comp.type, name);
		if (lib) {
			inserts.push(`.MODEL ${name} ${lib.type}(${lib.params})`);
			models.add(name.toUpperCase());
		}
	}
	if (!patches.length && !inserts.length) return text;
	return applyPatches(s, patches, inserts);
}

function builtinFallback(type: string, name: string): { type: string; params: string } | null {
	if (type === 'nmos' && /^NMOS$/i.test(name)) return { type: 'NMOS', params: 'LEVEL=1 VTO=1 KP=2e-3' };
	if (type === 'pmos' && /^PMOS$/i.test(name)) return { type: 'PMOS', params: 'LEVEL=1 VTO=-1 KP=1e-3' };
	return null;
}

// -- directives ------------------------------------------------------------------------------------

const ANALYSIS = /^\.(TRAN|AC|DC|OP|NOISE|TF)\b/i;

/** The directives the Directives dialog edits, read from the document */
export function directivesOf(text: string): { directives: SpiceDirective[]; parameters: Record<string, string>; models: SpiceModel[] } {
	const s = scan(text);
	const directives: SpiceDirective[] = [];
	const parameters: Record<string, string> = {};
	const models: SpiceModel[] = [];
	for (const d of s.directives) {
		if (ANALYSIS.test(d.text)) {
			directives.push({ id: `d${d.start}`, type: (d.keyword.slice(1).toLowerCase() as SpiceDirective['type']), text: d.text });
		} else if (d.keyword === '.PARAM') {
			for (const m of d.text.slice(6).matchAll(/([A-Za-z_]\w*)\s*=\s*(\{[^}]*\}|[^\s,]+)/g)) parameters[m[1]] = m[2];
		} else if (d.keyword === '.MODEL') {
			const m = /^\.MODEL\s+(\S+)\s+([A-Za-z_]+)\s*\(?([\s\S]*?)\)?\s*$/i.exec(d.text);
			if (m) models.push({ name: m[1], type: m[2], params: m[3] });
		}
	}
	return { directives, parameters, models };
}

/** Write back what the dialog changed; everything else stays as it is */
export function applyDirectives(
	text: string,
	next: { directives?: SpiceDirective[]; parameters?: Record<string, string>; models?: SpiceModel[] }
): string {
	const s = scan(text);
	const before = directivesOf(text);
	const patches: Patch[] = [];
	const inserts: string[] = [];
	const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toUpperCase();

	if (next.directives) {
		const wanted = next.directives.filter((d) => ANALYSIS.test(d.text)).map((d) => d.text.trim());
		const wantedSet = new Set(wanted.map(norm));
		const haveSet = new Set(before.directives.map((d) => norm(d.text)));
		for (const d of s.directives) {
			if (ANALYSIS.test(d.text) && !wantedSet.has(norm(d.text))) patches.push({ start: d.start, end: d.end, replacement: [] });
		}
		for (const t of wanted) if (!haveSet.has(norm(t))) inserts.push(t);
		// other .xxx directives of a schematic file (.ic, .options, K lines drawn as text)
		for (const d of next.directives) {
			if (ANALYSIS.test(d.text) || d.type === 'param' || d.type === 'model') continue;
			const line = d.text.trim();
			if (!s.directives.some((x) => norm(x.text) === norm(line))) inserts.push(line);
		}
	}
	if (next.parameters) {
		const lastValue = before.parameters;
		const lines = s.directives.filter((d) => d.keyword === '.PARAM');
		for (const d of lines) {
			let out = d.text;
			for (const name of Object.keys(lastValue)) {
				const re = new RegExp(`(\\s|^)${name}\\s*=\\s*(\\{[^}]*\\}|[^\\s,]+)`, 'i');
				if (!re.test(out)) continue;
				if (next.parameters[name] === undefined) out = out.replace(re, '');
				else if (next.parameters[name] !== lastValue[name]) out = out.replace(re, `$1${name}=${next.parameters[name]}`);
			}
			out = out.replace(/\s+/g, ' ').trim();
			if (out === d.text.replace(/\s+/g, ' ').trim()) continue;
			patches.push({ start: d.start, end: d.end, replacement: /^\.PARAM$/i.test(out) ? [] : [out] });
		}
		for (const [name, value] of Object.entries(next.parameters)) {
			if (!(name in lastValue)) inserts.unshift(`.PARAM ${name}=${value}`);
		}
	}
	if (next.models) {
		const lines = s.directives.filter((d) => d.keyword === '.MODEL');
		const wanted = new Map(next.models.map((m) => [m.name.toUpperCase(), m]));
		for (const d of lines) {
			if (!wanted.has(d.text.split(/\s+/)[1]?.toUpperCase())) patches.push({ start: d.start, end: d.end, replacement: [] });
		}
		const have = new Set(before.models.map((m) => m.name.toUpperCase()));
		for (const m of next.models) if (!have.has(m.name.toUpperCase())) inserts.push(`.MODEL ${m.name} ${m.type}(${m.params})`);
	}
	if (!patches.length && !inserts.length) return text;
	// directives go in front of .END, not among the elements
	const body = applyPatches(s, patches, []);
	if (!inserts.length) return body;
	const again = scan(body);
	const lines = body.split('\n');
	const eol = lines.some((l) => l.endsWith('\r')) ? '\r' : '';
	const at = again.endLine >= 0 ? again.endLine : lines.length;
	lines.splice(at, 0, ...inserts.map((r) => r + eol));
	return lines.join('\n');
}

// -- CSV -------------------------------------------------------------------------------------------

export function csvCell(v: string | number): string {
	const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
