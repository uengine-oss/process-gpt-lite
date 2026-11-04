/** Simulation result types */

export type VectorType = 'voltage' | 'current' | 'time' | 'frequency' | 'notype';

/** One vector of a run. Real runs fill `values`; AC runs fill `re` and `im`. */
export interface SimVector {
	name: string;
	type: VectorType;
	values?: Float64Array;
	re?: Float64Array;
	im?: Float64Array;
}

export interface SimResult {
	dataType: 'real' | 'complex';
	numPoints: number;
	vectors: SimVector[];
}

/** What the engine said about one netlist */
export interface RunOutcome {
	ok: boolean;
	/** why the run has no usable numbers (empty when ok) */
	error: string;
	/** data can come with an error: a transient that stopped early keeps the part it computed */
	result: SimResult | null;
	/** "Warning:" lines from ngspice */
	warnings: string[];
	/** the engine died (or hung) and its worker was replaced */
	recovered: boolean;
	ms: number;
}

/** Messages between page and worker */
export type ToWorker =
	| { type: 'init' }
	| { type: 'run'; id: number; netlist: string };

export type FromWorker =
	| { type: 'ready'; info: string }
	| { type: 'init-failed'; error: string }
	| { type: 'stderr'; text: string }
	| { type: 'result'; id: number; result: SimResult; errors: string[] }
	| { type: 'no-result'; id: number; errors: string[] }
	| { type: 'crashed'; id: number; error: string };
