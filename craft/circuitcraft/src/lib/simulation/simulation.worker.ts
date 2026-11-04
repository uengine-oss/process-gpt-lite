/**
 * Web Worker running one NGSpice WASM instance (eecircuit-engine).
 *
 * The engine's promise only settles when ngspice produced an output file, and a fatal ngspice error
 * calls exit(1) so it never settles at all. The page therefore watches stderr and a timeout, and
 * replaces this worker when the instance is gone (see index.ts). Two engine internals are used on
 * purpose, the version is pinned in package.json for it:
 * - __getSpiceModuleForTests().FS: out.raw is removed before each run, or a run that fails after a
 *   good one would return the previous run's numbers as its own.
 * - continuePromiseResolve: set when the engine went back to waiting without an output file.
 */

import { Simulation } from 'eecircuit-engine';
import type { FromWorker, SimResult, SimVector, ToWorker } from './types';

const post = (m: FromWorker, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let sim: Simulation | null = null;
let currentRun = 0;

// printErr of the engine goes to console.error: that is the only live view of ngspice's stderr
console.error = (...args: unknown[]) => post({ type: 'stderr', text: args.map(String).join(' ') });
console.warn = () => {};
console.info = () => {};

self.addEventListener('error', (e) => post({ type: 'crashed', id: currentRun, error: e.message || 'engine error' }));
self.addEventListener('unhandledrejection', (e) => {
	const r = (e as PromiseRejectionEvent).reason;
	post({ type: 'crashed', id: currentRun, error: String(r?.message || r?.name || r || 'engine error') });
});

function compact(result: Awaited<ReturnType<Simulation['runSim']>>): { result: SimResult; transfer: Transferable[] } {
	const transfer: Transferable[] = [];
	const vectors: SimVector[] = [];
	if (result.dataType === 'complex') {
		for (const d of result.data) {
			const re = Float64Array.from(d.values, (c) => c.real);
			const im = Float64Array.from(d.values, (c) => c.img);
			vectors.push({ name: d.name, type: d.type, re, im });
			transfer.push(re.buffer, im.buffer);
		}
	} else {
		for (const d of result.data) {
			const values = Float64Array.from(d.values);
			vectors.push({ name: d.name, type: d.type, values });
			transfer.push(values.buffer);
		}
	}
	return { result: { dataType: result.dataType, numPoints: result.numPoints, vectors }, transfer };
}

async function run(id: number, netlist: string) {
	currentRun = id;
	const engine = sim as Simulation;
	// (declared private in the engine's types)
	const inside = sim as unknown as {
		__getSpiceModuleForTests?: () => { FS?: { unlink: (p: string) => void } } | null;
		continuePromiseResolve?: unknown;
	};
	try { inside.__getSpiceModuleForTests?.()?.FS?.unlink('out.raw'); } catch { /* first run: no file yet */ }
	engine.setNetList(netlist);

	const finished = engine.runSim().then((r) => ({ r }));
	// the loop came back to waiting and runSim never resolved: ngspice wrote no output
	const waiting = new Promise<{ r: null }>((resolve) => {
		const timer = setInterval(() => {
			if (inside.continuePromiseResolve) { clearInterval(timer); resolve({ r: null }); }
		}, 20);
		finished.then(() => clearInterval(timer));
	});
	const { r } = await Promise.race([finished, waiting]);
	const errors = engine.getError().map((l) => l.trim()).filter(Boolean);
	if (!r) { post({ type: 'no-result', id, errors }); return; }
	const { result, transfer } = compact(r);
	post({ type: 'result', id, result, errors }, transfer);
}

self.onmessage = async (ev: MessageEvent<ToWorker>) => {
	const m = ev.data;
	if (m.type === 'init') {
		try {
			sim = new Simulation();
			await sim.start();
			post({ type: 'ready', info: sim.getInitInfo() });
		} catch (e) {
			post({ type: 'init-failed', error: e instanceof Error ? e.message : String(e) });
		}
	} else if (m.type === 'run') {
		try {
			await run(m.id, m.netlist);
		} catch (e) {
			post({ type: 'crashed', id: m.id, error: e instanceof Error ? e.message : String(e) });
		}
	}
};
