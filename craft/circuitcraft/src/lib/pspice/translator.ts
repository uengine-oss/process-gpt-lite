/**
 * The PSpice translator shared with the MCP CLI (craft/pspice/pspice.mjs).
 * Every simulation goes through toNgspice: raw PSpice files fail or give wrong values in ngspice.
 */
// (plain JavaScript, typed by the declarations below)
import * as pspice from '../../../../pspice/pspice.mjs';

export interface ParsedElement {
	ref: string;
	letter: string;
	nodes: string[];
	rest: string[];
	raw: string;
	model?: string;
	value?: string;
}

export interface ParsedDoc {
	title: string;
	isLibrary: boolean;
	elements: ParsedElement[];
	models: { name: string; kind: string; raw: string }[];
	subckts: { name: string; pins: string[]; params: string[]; lines: string[] }[];
	params: string[];
	analyses: string[];
	options: string[];
	includes: string[];
	probes: string[];
	others: string[];
	warnings: string[];
}

export interface NgspiceRun {
	label: string;
	analysis: string;
	step: string | null;
	netlist: string;
}

export interface Translation {
	title: string;
	runs: NgspiceRun[];
	warnings: string[];
	unsupported: string[];
}

export type Files = Record<string, string>;

export const read: (text: string, opts?: { files?: Files }) => ParsedDoc = pspice.read;
export const toNgspice: (text: string, opts?: { files?: Files }) => Translation = pspice.toNgspice;
export const safeNode: (name: string) => string = pspice.safeNode;
export const number: (s: string) => number = pspice.number;
