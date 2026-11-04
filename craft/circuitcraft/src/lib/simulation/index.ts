/**
 * Simulation engine: one NGSpice WASM instance in a worker, replaced when it dies.
 *
 * ngspice fatal errors call exit(1): the worker stays alive but its WASM is gone and no answer ever
 * comes. So a run ends one of four ways: a result, the engine going idle with no output, stderr
 * saying the instance is finished, or the timeout. In the last two the worker is terminated and a
 * new one started right away, and the person sees what ngspice said.
 */

import type { FromWorker, RunOutcome, SimResult, ToWorker } from './types';

export type { SimResult, SimVector, RunOutcome, VectorType } from './types';

export const DEFAULT_RUN_TIMEOUT_MS = 60000;

// after these lines the instance exits or hangs (measured: exit(1) prints the first; an undefined
// .PARAM prints the second and then never answers)
const ENGINE_GONE = /fatal error in ngspice|exit\(1\)|Cannot compute substitute/i;
// a run that "worked" with these lines did not simulate the circuit in the document
const CIRCUIT_REJECTED = /is not a valid .* ignored|circuit not parsed|interrupted due to error|Error on line|aren't any circuits|run simulation not started|No job \(tran|unknown subckt|could not find a valid modelname/i;
const RUN_ABORTED = /Timestep too small|run simulation\(s\) aborted|simulation\(s\) aborted|doAnalyses: /i;
const NOISE = /^Note: |Command 'remcirc' is ignored|there is no circuit loaded|Using SPARSE|^-+$/i;

/** the useful part of what ngspice printed */
function explain(lines: string[]): string {
	const useful = lines.map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
	const text = useful.filter((l) => !/fatal error in ngspice|Simulation interrupted|^from file|^test\.cir$|^in$/i.test(l));
	return (text.length ? text : useful).slice(0, 6).join('\n');
}

interface Pending {
	id: number;
	lines: string[];
	timer: ReturnType<typeof setTimeout>;
	started: number;
	resolve: (o: RunOutcome) => void;
}

export class SimEngine {
	private worker: Worker | null = null;
	private ready: Promise<string> | null = null;
	private resolveReady: ((info: string) => void) | null = null;
	private rejectReady: ((e: Error) => void) | null = null;
	private pending: Pending | null = null;
	private nextId = 1;
	// stop() also has to catch a run still waiting for the engine to start
	private generation = 0;
	/** how many times the worker was replaced (shown nowhere, read by tests) */
	recoveries = 0;
	info = '';
	onstate?: (state: 'starting' | 'ready' | 'failed', detail?: string) => void;

	start(): Promise<string> {
		if (this.ready) return this.ready;
		this.onstate?.('starting');
		this.worker = new Worker(new URL('./simulation.worker.ts', import.meta.url), { type: 'module' });
		this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onMessage(ev.data);
		this.worker.onerror = (ev) => this.fail(ev.message || 'engine worker error');
		this.ready = new Promise<string>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		this.ready.catch(() => {});
		this.post({ type: 'init' });
		return this.ready;
	}

	private post(m: ToWorker) { this.worker?.postMessage(m); }

	private onMessage(m: FromWorker) {
		const p = this.pending;
		switch (m.type) {
			case 'ready':
				this.info = m.info;
				this.resolveReady?.(m.info);
				this.onstate?.('ready');
				break;
			case 'init-failed':
				this.rejectReady?.(new Error(m.error));
				this.onstate?.('failed', m.error);
				break;
			case 'stderr':
				if (!p) break;
				p.lines.push(m.text);
				if (ENGINE_GONE.test(m.text)) this.fail();
				break;
			case 'crashed':
				if (!p || p.id === m.id) this.fail(m.error);
				break;
			case 'result':
				if (p?.id === m.id) this.finish(m.result, m.errors);
				break;
			case 'no-result':
				if (p?.id === m.id) this.finish(null, m.errors);
				break;
		}
	}

	private settle(outcome: Omit<RunOutcome, 'ms'>) {
		const p = this.pending;
		if (!p) return;
		this.pending = null;
		clearTimeout(p.timer);
		p.resolve({ ...outcome, ms: Date.now() - p.started });
	}

	private finish(result: SimResult | null, errors: string[]) {
		const p = this.pending;
		if (!p) return;
		const lines = errors.length ? errors : p.lines;
		const warnings = lines.filter((l) => /^Warning:/i.test(l.trim()) && !NOISE.test(l.trim()));
		const hasData = !!result && result.vectors.length > 0;
		const rejected = lines.some((l) => CIRCUIT_REJECTED.test(l));
		const aborted = lines.some((l) => RUN_ABORTED.test(l));
		if (!hasData || rejected) {
			this.settle({ ok: false, error: explain(lines) || 'ngspice returned no data.', result: null, warnings, recovered: false });
		} else if (aborted) {
			// the points up to the failure are real: keep them, say it stopped
			this.settle({ ok: false, error: explain(lines), result, warnings, recovered: false });
		} else {
			this.settle({ ok: true, error: '', result, warnings, recovered: false });
		}
	}

	/** the instance is finished: answer the run and start over */
	private fail(detail?: string) {
		const p = this.pending;
		const text = p ? explain(p.lines) : '';
		const error = [text, detail].filter(Boolean).join('\n') || 'The simulator stopped without an answer.';
		this.replaceWorker();
		this.settle({ ok: false, error, result: null, warnings: [], recovered: true });
	}

	private replaceWorker() {
		this.worker?.terminate();
		this.worker = null;
		this.ready = null;
		this.recoveries++;
		this.start().catch(() => {});
	}

	async run(netlist: string, { timeoutMs = DEFAULT_RUN_TIMEOUT_MS } = {}): Promise<RunOutcome> {
		if (this.pending) throw new Error('A simulation is already running.');
		const started = Date.now();
		const generation = this.generation;
		try {
			await this.start();
		} catch (e) {
			return { ok: false, error: `The simulator did not start: ${e instanceof Error ? e.message : e}`, result: null, warnings: [], recovered: false, ms: Date.now() - started };
		}
		if (generation !== this.generation) {
			return { ok: false, error: 'Stopped.', result: null, warnings: [], recovered: false, ms: Date.now() - started };
		}
		return new Promise<RunOutcome>((resolve) => {
			const id = this.nextId++;
			const timer = setTimeout(() => {
				const s = Math.round(timeoutMs / 100) / 10;
				this.fail(`No answer after ${s} s: the run was stopped.`);
			}, timeoutMs);
			this.pending = { id, lines: [], timer, started, resolve };
			this.post({ type: 'run', id, netlist });
		});
	}

	/** Stop button: end the running simulation (the instance cannot be interrupted, so it is replaced) */
	stop() {
		this.generation++;
		if (this.pending) this.fail('Stopped.');
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
		this.ready = null;
	}
}
