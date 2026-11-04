<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import { base } from '$app/paths';
	import { SimEngine, DEFAULT_RUN_TIMEOUT_MS, type RunOutcome, type SimResult, type SimVector } from '$lib/simulation';
	import { WaveformViewer, type TraceData, getTraceColor, magnitudeDb, phaseDeg } from '$lib/waveform';
	import { NetlistEditor } from '$lib/editor';
	import { SchematicCanvas, type Schematic, type Component } from '$lib/schematic';
	import { ResizablePanel, HelpModal, LandingPage, DirectiveModal, ComponentEditModal } from '$lib/components';
	import { calculateComponentCurrent } from '$lib/netlist/current-calculator';
	import { analyzeConnectivity } from '$lib/netlist/connectivity';
	import { read, toNgspice, safeNode, type Files, type ParsedDoc, type Translation } from '$lib/pspice/translator';
	import { describeElements, describeElement, libraryInfo, type ElementSpec } from '$lib/pspice/elements';
	import { layoutCircuit, nodeLabelsFor } from '$lib/pspice/layout';
	import {
		ACCEPTED_EXTENSIONS, CIRCUIT_EXT, EMPTY_DOCUMENT, LIBRARY_EXT, applyDirectives, baseFileName, companionMap, csvCell,
		decodeBytes, directivesOf, encodeText, saveName, syncFromSchematic, toBytes, writtenElements, type Encoding
	} from '$lib/pspice/document';

	// -- how this page was opened -------------------------------------------------------------------
	const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
	const hostMode = params.get('host') === 'parent';
	let runTimeoutMs = Number(params.get('timeout')) || DEFAULT_RUN_TIMEOUT_MS;
	let routeBudgetMs: number | undefined;

	// -- the document --------------------------------------------------------------------------------
	let docName = $state('untitled.cir');
	let docText = $state(EMPTY_DOCUMENT);
	let docEncoding: Encoding = 'utf-8';
	let companions = $state.raw<{ name: string; text: string }[]>([]);
	let savedText = $state(EMPTY_DOCUMENT);
	// what the schematic and the runs were last derived from: an edit to the text differs from it
	let syncedText = EMPTY_DOCUMENT;
	let isLibrary = $state(false);
	let libraryParts = $state.raw<string[]>([]);
	let libraryPart = $state('');
	let libraryModels = $state.raw<string[]>([]);
	let specs = $state.raw<ElementSpec[]>([]);
	let labelledNets = $state.raw<string[]>([]);
	let drawError = $state('');

	let translation = $state.raw<Translation>({ title: '', runs: [], warnings: [], unsupported: [] });
	const dirty = $derived(docText !== savedText);
	const files = $derived(companionMap(companions));

	// -- runs ----------------------------------------------------------------------------------------
	type RunStatus = 'idle' | 'queued' | 'running' | 'ok' | 'failed' | 'skipped';
	interface RunView {
		label: string;
		analysis: string;
		step: string | null;
		netlist: string;
		status: RunStatus;
		error: string;
		warnings: string[];
		ms: number;
		result: SimResult | null;
	}
	let runs = $state.raw<RunView[]>([]);
	let selectedRun = $state(0);
	let overlaySteps = $state(false);
	let acView = $state<'mag' | 'phase'>('mag');
	let selectedVectors = $state.raw<string[]>([]);
	let hiddenTraces = $state.raw<Set<string>>(new Set());
	let extraTraces = $state.raw<Map<string, { name: string; values: ArrayLike<number> }>>(new Map());
	let busy = $state(false);
	let lastError = $state<string | null>(null);
	let engineState = $state<'starting' | 'ready' | 'failed'>('starting');
	let runPromise: Promise<unknown> | null = null;
	let runToken = 0;
	const engine = new SimEngine();

	// -- the drawing and the page --------------------------------------------------------------------
	let schematic = $state<Schematic>({ components: [], wires: [], junctions: [], directives: [], parameters: {}, models: [] });
	let canvasRef = $state<SchematicCanvas | null>(null);
	let status = $state('Starting the simulator...');
	let showHelp = $state(false);
	let showLanding = $state(!hostMode);
	let showDirectives = $state(false);
	let showComponentEdit = $state(false);
	let editingComponent = $state<Component | null>(null);
	let showAllNotices = $state(false);
	let dragOver = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let vectorMenu = $state<HTMLDetailsElement | null>(null);
	let netlistCollapsed = $state(false);
	let schematicCollapsed = $state(false);

	const toolbarHeight = 40;
	const statusbarHeight = 24;
	const runbarHeight = 34;
	const panelHeaders = 48;
	function initialSchematicHeight() {
		if (typeof window === 'undefined') return 340;
		const free = window.innerHeight - toolbarHeight - statusbarHeight - runbarHeight - panelHeaders;
		return Math.max(180, Math.round(free * 0.56));
	}
	const schematicHeight = initialSchematicHeight();
	const netlistWidth = typeof window !== 'undefined' && window.innerWidth < 1400 ? 250 : 320;

	// -- opening -------------------------------------------------------------------------------------

	/** Nets that keep their case and characters on the display */
	function netDisplayNames(): Map<string, string> {
		const map = new Map<string, string>();
		for (const s of specs) for (const p of s.pins) map.set(safeNode(p.net).toLowerCase(), p.net);
		return map;
	}

	function refreshTranslation() {
		try {
			translation = toNgspice(docText, { files });
		} catch (e) {
			translation = { title: '', runs: [], warnings: [], unsupported: [`This document could not be read: ${e instanceof Error ? e.message : e}`] };
		}
		runs = translation.runs.map((r) => ({ ...r, status: 'idle', error: '', warnings: [], ms: 0, result: null }));
		if (selectedRun >= runs.length) selectedRun = 0;
		extraTraces = new Map();
	}

	async function showLibraryPart(name: string, doc: ParsedDoc) {
		libraryPart = name;
		const part = doc.subckts.find((s) => s.name === name);
		if (!part) {
			schematic = { components: [], wires: [], junctions: [] };
			specs = [];
			return;
		}
		const inner = read(`* ${name}\n${part.lines.join('\n')}\n.END\n`);
		const info = libraryInfo(doc, files);
		// the part's own models count too
		for (const m of inner.models) info.modelKinds.set(m.name.toUpperCase(), m.kind);
		specs = inner.elements.map((el) => describeElement(el, info));
		const laid = await layoutCircuit(specs, { extraRails: part.pins });
		schematic = laid.schematic;
	}

	/** An open in progress: a run or a save waits for it (the drawing and the runs are being replaced) */
	let opening: Promise<unknown> = Promise.resolve();
	let loading = $state(false);

	function loadText(name: string, text: string, encoding: Encoding) {
		const job = opening.catch(() => {}).then(async () => {
			loading = true;
			try {
				await loadTextNow(name, text, encoding);
			} finally {
				loading = false;
			}
		});
		opening = job;
		return job;
	}

	async function loadTextNow(name: string, text: string, encoding: Encoding) {
		if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
		if (textTimer) { clearTimeout(textTimer); textTimer = null; }
		drawError = '';
		docName = baseFileName(name);
		docEncoding = encoding;
		docText = text;
		syncedText = text;
		savedText = text;
		lastError = null;
		showLanding = false;
		runToken++;
		busy = false;
		selectedVectors = [];
		hiddenTraces = new Set();
		selectedRun = 0;
		overlaySteps = false;
		acView = 'mag';
		engine.stop();

		// a library may open with its first .SUBCKT on line 1; read() takes that into account
		let doc = read(text, { files });
		const looksLikeLibrary = doc.isLibrary || (LIBRARY_EXT.test(name) && !doc.elements.length && !doc.analyses.length);
		isLibrary = looksLikeLibrary;
		if (looksLikeLibrary) {
			if (!doc.isLibrary) doc = read(`* ${name}\n${text}`, { files });
			libraryParts = doc.subckts.map((s) => s.name);
			libraryModels = doc.models.map((m) => m.name);
			translation = { title: doc.title, runs: [], warnings: [], unsupported: [] };
			runs = [];
			await tick();
			await showLibraryPart(libraryParts[0] ?? '', doc);
			status = `Library ${docName}: ${libraryParts.length} subcircuit(s), ${libraryModels.length} model(s)`;
		} else {
			libraryParts = [];
			libraryModels = [];
			const nextSpecs = describeElements(doc, files);
			drawError = '';
			let sheet: Schematic = { components: [], wires: [], junctions: [] };
			labelledNets = [];
			try {
				const laid = await layoutCircuit(nextSpecs, routeBudgetMs === undefined ? {} : { routeBudgetMs });
				sheet = laid.schematic;
				labelledNets = laid.labelledNets;
			} catch (e) {
				// no drawing is no reason to refuse the document: the text and the runs still work
				drawError = `The schematic could not be drawn: ${e instanceof Error ? e.message : e}`;
			}
			specs = nextSpecs;
			const dirs = directivesOf(text);
			schematic = { ...sheet, directives: dirs.directives, parameters: dirs.parameters, models: dirs.models };
			syncedText = text;
			refreshTranslation();
			status = `Opened ${docName}: ${specs.length} elements, ${runs.length} run(s)`;
		}
		await tick();
		canvasRef?.fitView();
	}

	/** Bytes in, schematic out. The companions make .LIB "x.lib" resolve. */
	async function openBytes(name: string, bytes: ArrayBuffer | ArrayBufferView | string, extra: { name: string; bytes: ArrayBuffer | ArrayBufferView | string }[] = []) {
		const { text, encoding } = decodeBytes(toBytes(bytes));
		companions = extra.map((f) => ({ name: f.name, text: decodeBytes(toBytes(f.bytes)).text }));
		await loadText(name, text, encoding);
	}

	/** Add libraries to the open circuit without touching its text */
	async function addCompanions(extra: { name: string; text: string }[]) {
		const merged = new Map(companions.map((c) => [baseFileName(c.name).toLowerCase(), c]));
		for (const c of extra) merged.set(baseFileName(c.name).toLowerCase(), c);
		companions = [...merged.values()];
		await tick();
		refreshTranslation();
		// pin names can come with the library: draw the boxes again
		const doc = read(docText, { files: companionMap(companions) });
		specs = describeElements(doc, companionMap(companions));
		const laid = await layoutCircuit(specs);
		schematic = { ...laid.schematic, directives: schematic.directives, parameters: schematic.parameters, models: schematic.models };
		await tick();
		canvasRef?.fitView();
		status = `Added ${extra.map((c) => c.name).join(', ')}`;
	}

	async function openFiles(list: File[]) {
		if (!list.length) return;
		const json = list.find((f) => /\.json$/i.test(f.name));
		if (json) return loadSchematicFile(json);
		const read1 = async (f: File) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
		const all = await Promise.all(list.map(read1));
		// a Capture export is a .cir that includes its .net: the .cir is the document
		const circuit = all.find((f) => /\.cir$/i.test(f.name)) ?? all.find((f) => CIRCUIT_EXT.test(f.name));
		if (circuit) return openBytes(circuit.name, circuit.bytes, all.filter((f) => f !== circuit));
		// only libraries: they belong to the open circuit, or are themselves what is being opened
		if (!showLanding && !isLibrary && specs.length) {
			return addCompanions(all.map((f) => ({ name: f.name, text: decodeBytes(f.bytes).text })));
		}
		return openBytes(all[0].name, all[0].bytes, all.slice(1));
	}

	function openDialog() {
		fileInput?.click();
	}

	function onFileChosen(e: Event) {
		const input = e.target as HTMLInputElement;
		const list = [...(input.files ?? [])];
		input.value = ''; // the same file can be chosen again
		openFiles(list).catch(reportOpenFailure);
	}

	function reportOpenFailure(e: unknown) {
		lastError = `Could not open the file: ${e instanceof Error ? e.message : e}`;
		status = lastError;
		post('failed', { error: lastError });
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		openFiles([...(e.dataTransfer?.files ?? [])]).catch(reportOpenFailure);
	}

	function onDragOver(e: DragEvent) {
		if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
		e.preventDefault();
		dragOver = true;
	}

	function newDocument() {
		docName = 'untitled.cir';
		docEncoding = 'utf-8';
		docText = EMPTY_DOCUMENT;
		syncedText = EMPTY_DOCUMENT;
		savedText = EMPTY_DOCUMENT;
		companions = [];
		isLibrary = false;
		libraryParts = [];
		specs = [];
		schematic = { components: [], wires: [], junctions: [], directives: [], parameters: {}, models: [] };
		refreshTranslation();
		lastError = null;
		selectedVectors = [];
		tick().then(() => canvasRef?.fitView());
	}

	// -- JSON schematics (the fork's own format and its examples) ------------------------------------

	async function loadSchematicData(data: { schematic: Schematic; netlist?: string }, name: string) {
		newDocument();
		showLanding = false;
		docName = saveName(name);
		const incoming = data.schematic;
		schematic = {
			components: incoming.components || [],
			wires: incoming.wires || [],
			junctions: incoming.junctions || [],
			directives: incoming.directives || [],
			parameters: incoming.parameters || {},
			models: incoming.models || []
		};
		const hasAnalysis = schematic.directives!.some((d) => ['tran', 'ac', 'dc', 'op'].includes(d.type));
		let text = applyDirectives(`* ${baseFileName(name).replace(/\.[^.]*$/, '')}\n.END\n`, {
			directives: hasAnalysis ? schematic.directives : undefined,
			parameters: schematic.parameters,
			models: schematic.models
		});
		if (!hasAnalysis) text = text.replace(/\.END/, '.TRAN 1u 10m\n.END');
		text = syncFromSchematic(text, schematic, new Set());
		docText = text;
		syncedText = text;
		savedText = text;
		specs = describeElements(read(text));
		refreshTranslation();
		schematic.nodeLabels = nodeLabelsFor(schematic);
		await tick();
		canvasRef?.fitView();
		status = `Loaded ${name}: ${specs.length} elements`;
	}

	async function loadSchematicFile(file: File) {
		const data = JSON.parse(await file.text());
		if (!data.schematic) {
			status = 'Invalid schematic file: missing schematic data';
			return;
		}
		await loadSchematicData(data, file.name);
	}

	async function handleLoadExample(example: { id: string; name: string; schematicFile: string }) {
		try {
			status = `Loading ${example.name}...`;
			const r = await fetch(`${base}${example.schematicFile}`);
			if (!r.ok) throw new Error(r.statusText);
			await loadSchematicData(await r.json(), `${example.id}.cir`);
		} catch (err) {
			status = `Failed to load example: ${err}`;
		}
	}

	function saveJson() {
		syncNow();
		const data = {
			version: 1,
			schematic: {
				components: schematic.components,
				wires: schematic.wires,
				junctions: schematic.junctions,
				directives: schematic.directives,
				parameters: schematic.parameters,
				models: schematic.models
			},
			netlist: docText,
			savedAt: new Date().toISOString()
		};
		download(docName.replace(/\.[^.]*$/, '') + '.json', new TextEncoder().encode(JSON.stringify(data, null, 2)), 'application/json');
		status = 'Saved the drawing as JSON';
	}

	// -- schematic and text stay one document --------------------------------------------------------

	let syncTimer: ReturnType<typeof setTimeout> | null = null;

	function knownModels(): Set<string> {
		const doc = read(docText, { files });
		return new Set(libraryInfo(doc, files).modelKinds.keys());
	}

	/** Write schematic changes into the text */
	function syncNow() {
		if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
		// no drawing (it failed) must not read as "every part was deleted"
		if (isLibrary || drawError) return;
		const next = syncFromSchematic(docText, schematic, knownModels());
		if (next !== docText) {
			docText = next;
			syncedText = next;
			specs = describeElements(read(next, { files }), files);
			refreshTranslation();
			status = 'Schematic change written to the document';
		}
		schematic.nodeLabels = nodeLabelsFor(schematic);
		canvasRef?.redraw();
	}

	function scheduleSync() {
		if (syncTimer) clearTimeout(syncTimer);
		syncTimer = setTimeout(syncNow, 150);
	}

	let textTimer: ReturnType<typeof setTimeout> | null = null;

	function onTextEdited(value: string) {
		if (value === syncedText) return;
		if (textTimer) clearTimeout(textTimer);
		textTimer = setTimeout(() => applyTextEdit(value).catch(reportOpenFailure), 400);
	}

	const topologyOf = (list: ElementSpec[]) => list.map((s) => `${s.ref}|${s.symbol}|${s.pins.map((p) => p.net.toUpperCase()).join(',')}`).join('\n');

	/** The person typed in the netlist: same circuit keeps its drawing, a new one is laid out again */
	async function applyTextEdit(value: string) {
		textTimer = null;
		syncedText = value;
		const doc = read(value, { files });
		const nextSpecs = doc.isLibrary ? [] : describeElements(doc, files);
		if (topologyOf(nextSpecs) === topologyOf(specs) && !isLibrary) {
			const byRef = new Map(nextSpecs.map((s) => [s.ref, s]));
			for (const c of schematic.components) {
				const s = c.source ? byRef.get(c.source.ref) : undefined;
				if (!s) continue;
				c.attributes['Value'] = s.value;
				if (c.box) c.box.title = s.title;
				c.source = { ...c.source!, value: s.value };
			}
			specs = nextSpecs;
			canvasRef?.redraw();
		} else if (!isLibrary) {
			specs = nextSpecs;
			const laid = await layoutCircuit(specs);
			schematic = { ...laid.schematic };
			await tick();
			canvasRef?.fitView();
		}
		if (isLibrary) {
			status = 'Library text updated';
			return;
		}
		const dirs = directivesOf(value);
		schematic.directives = dirs.directives;
		schematic.parameters = dirs.parameters;
		schematic.models = dirs.models;
		refreshTranslation();
		status = 'Document updated';
	}

	function flushTextEdit(): Promise<void> {
		if (textTimer) {
			clearTimeout(textTimer);
			return applyTextEdit(docText);
		}
		return Promise.resolve();
	}

	function handleSaveComponent(updated: Component) {
		schematic = {
			...schematic,
			components: schematic.components.map((c) => (c.id === updated.id ? updated : c))
		};
		syncNow();
		status = `Updated ${updated.attributes.InstName || updated.attributes.Value || updated.type}`;
	}

	function handleEditComponent(component: Component) {
		if (isLibrary) return;
		if (component.source?.external) {
			status = `${component.attributes.InstName} is defined in ${component.source.external}: edit it there`;
			return;
		}
		editingComponent = component;
		showComponentEdit = true;
	}

	function openDirectives() {
		syncNow();
		const dirs = directivesOf(docText);
		schematic.directives = dirs.directives;
		schematic.parameters = dirs.parameters;
		schematic.models = dirs.models;
		showDirectives = true;
	}

	function onDirectivesSaved() {
		// the document holds them from here on; no floating text boxes on the sheet
		schematic.directives = (schematic.directives || []).map((d) => ({ ...d, x: undefined, y: undefined }));
		const next = applyDirectives(docText, { directives: schematic.directives, parameters: schematic.parameters, models: schematic.models });
		if (next !== docText) {
			docText = next;
			syncedText = next;
			refreshTranslation();
		}
		canvasRef?.redraw();
	}

	// -- running -------------------------------------------------------------------------------------

	const blockedReason = $derived.by(() => {
		if (isLibrary) return `${docName} is a library: it has no circuit to simulate. Open a circuit together with this file, or use Open to add it to a circuit.`;
		if (translation.unsupported.length) return `Cannot run: ${translation.unsupported.join(' / ')}`;
		if (!showLanding && !specs.length && !schematic.components.some((c) => c.type !== 'ground' && c.type !== 'netflag')) return 'Nothing to simulate yet: draw a circuit or open a file.';
		return '';
	});

	function setRun(i: number, patch: Partial<RunView>) {
		runs = runs.map((r, j) => (j === i ? { ...r, ...patch } : r));
	}

	async function runAllInner() {
		const token = ++runToken;
		busy = true;
		lastError = null;
		extraTraces = new Map();
		const total = translation.runs.length;
		runs = translation.runs.map((r) => ({ ...r, status: 'queued', error: '', warnings: [], ms: 0, result: null }));
		let crashes = 0;
		let okCount = 0;
		for (let i = 0; i < total; i++) {
			if (token !== runToken) return;
			if (crashes >= 3) {
				setRun(i, { status: 'skipped', error: 'Skipped: the simulator stopped on the runs before this one.' });
				continue;
			}
			status = `Running ${runs[i].label} (${i + 1}/${total})...`;
			setRun(i, { status: 'running' });
			const o: RunOutcome = await engine.run(runs[i].netlist, { timeoutMs: runTimeoutMs });
			if (token !== runToken) return;
			if (o.recovered) crashes++;
			if (o.ok) okCount++;
			setRun(i, { status: o.ok ? 'ok' : 'failed', error: o.error, warnings: o.warnings, ms: o.ms, result: o.result });
			if (!o.ok && !lastError) lastError = `${runs[i].label}: ${o.error}`;
		}
		if (token !== runToken) return;
		busy = false;
		// show something that worked when the run on screen did not
		if (runs[selectedRun]?.status !== 'ok') {
			const firstOk = runs.findIndex((r) => r.status === 'ok');
			if (firstOk >= 0) selectedRun = firstOk;
		}
		ensureVectors();
		status = okCount === total ? `All ${total} run(s) finished` : `${okCount} of ${total} run(s) finished${lastError ? ': see the message above' : ''}`;
	}

	/** Run every run of the document; the promise settles when the last one is done */
	async function runAll() {
		await opening.catch(() => {});
		if (runPromise && busy) return runPromise;
		// an older run that was stopped ends first
		await runPromise?.catch(() => {});
		await flushTextEdit();
		syncNow();
		if (blockedReason) {
			lastError = blockedReason;
			status = blockedReason;
			showAllNotices = true;
			return;
		}
		runPromise = runAllInner().finally(() => { runPromise = null; busy = false; });
		return runPromise;
	}

	function stopRun() {
		runToken++;
		engine.stop();
		runs = runs.map((r) => (r.status === 'queued' || r.status === 'running' ? { ...r, status: 'skipped', error: 'Stopped.' } : r));
		busy = false;
		status = 'Stopped';
	}

	// -- what the plot shows -------------------------------------------------------------------------

	const currentRun = $derived(runs[selectedRun] ?? null);
	const analyses = $derived([...new Set(runs.map((r) => r.analysis))]);
	const stepsOfAnalysis = $derived(currentRun ? runs.filter((r) => r.analysis === currentRun.analysis && r.step).map((r) => r.step as string) : []);
	const shortAnalysis = (a: string) => a.split(/\s+/)[0].slice(1).toUpperCase();

	function selectAnalysis(a: string) {
		const step = currentRun?.step ?? null;
		const i = runs.findIndex((r) => r.analysis === a && r.step === step);
		selectedRun = i >= 0 ? i : runs.findIndex((r) => r.analysis === a);
		ensureVectors();
	}

	function selectStep(step: string) {
		overlaySteps = false;
		const a = currentRun?.analysis;
		const i = runs.findIndex((r) => r.analysis === a && r.step === step);
		if (i >= 0) selectedRun = i;
		ensureVectors();
	}

	const isScale = (v: SimVector, i: number) => i === 0 && (v.type === 'time' || v.type === 'frequency' || /sweep/i.test(v.name));
	function scaleOf(r: SimResult | null) {
		return r?.vectors.length && isScale(r.vectors[0], 0) ? r.vectors[0] : null;
	}
	const dataVectors = (r: SimResult | null) => (r ? r.vectors.filter((v, i) => !isScale(v, i)) : []);

	const nameMap = $derived(netDisplayNames());
	function displayName(raw: string): string {
		const m = /^([vi])\((.*)\)$/i.exec(raw);
		if (!m) return raw;
		const inner = m[2];
		const original = m[1].toLowerCase() === 'v' ? nameMap.get(inner.toLowerCase()) : undefined;
		return `${m[1].toUpperCase()}(${original ?? inner.toUpperCase()})`;
	}
	const isInternal = (raw: string) => raw.includes('.') || raw.includes('#');

	/** .PROBE V(OUT) ... picks the first plot; without it, the circuit's own nodes */
	function defaultVectors(r: SimResult): string[] {
		const names = dataVectors(r).map((v) => v.name);
		const lower = new Set(names.map((n) => n.toLowerCase()));
		const probed: string[] = [];
		const doc = read(docText);
		for (const line of doc.probes) {
			for (const m of line.matchAll(/\b([VI])\(\s*([^(),]+?)\s*\)/gi)) {
				const name = `${m[1].toLowerCase()}(${safeNode(m[2]).toLowerCase()})`;
				if (lower.has(name) && !probed.includes(name)) probed.push(name);
			}
		}
		if (probed.length) return probed;
		const rails = new Set(specs.filter((s) => s.letter === 'V' && !/\b(AC|PULSE|SIN|EXP|PWL|SFFM|AM)\b/i.test(s.value)).map((s) => safeNode(s.pins[0]?.net ?? '').toLowerCase()));
		const nodes = names.filter((n) => /^v\(/i.test(n) && !isInternal(n) && !rails.has(n.slice(2, -1).toLowerCase()));
		const fallback = nodes.length ? nodes : names.filter((n) => !isInternal(n));
		return (fallback.length ? fallback : names).slice(0, 6);
	}

	function ensureVectors() {
		const r = runs[selectedRun]?.result;
		if (!r) return;
		const have = new Set(dataVectors(r).map((v) => v.name.toLowerCase()));
		const kept = selectedVectors.filter((v) => have.has(v.toLowerCase()) || extraTraces.has(`${runs[selectedRun].label}|${v}`));
		if (!kept.length) selectedVectors = defaultVectors(r);
	}

	function toggleVector(name: string) {
		selectedVectors = selectedVectors.includes(name) ? selectedVectors.filter((v) => v !== name) : [...selectedVectors, name];
		hiddenTraces = new Set([...hiddenTraces].filter((t) => !t.startsWith(name)));
	}

	function toggleTrace(id: string) {
		const next = new Set(hiddenTraces);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		hiddenTraces = next;
	}

	const vectorGroups = $derived.by(() => {
		const list = dataVectors(currentRun?.result ?? null).map((v) => v.name);
		return [
			{ name: 'Nodes', items: list.filter((n) => /^v\(/i.test(n) && !isInternal(n)) },
			{ name: 'Source currents', items: list.filter((n) => /^i\(/i.test(n) && !isInternal(n)) },
			{ name: 'Inside subcircuits', items: list.filter((n) => isInternal(n)) },
			{ name: 'Other', items: list.filter((n) => !/^[vi]\(/i.test(n) && !isInternal(n)) }
		].filter((g) => g.items.length);
	});

	const shownRuns = $derived.by(() => {
		if (!currentRun) return [];
		if (overlaySteps && stepsOfAnalysis.length > 1) return runs.filter((r) => r.analysis === currentRun.analysis && r.status === 'ok');
		return [currentRun];
	});

	const plot = $derived.by(() => {
		const list = shownRuns.filter((r) => r.result);
		const first = list[0]?.result ?? null;
		const scale = scaleOf(first);
		if (!first || !scale || first.numPoints <= 1) return null;
		const complex = first.dataType === 'complex';
		const traces: TraceData[] = [];
		const axisX = (r: SimResult): ArrayLike<number> => {
			const s = scaleOf(r);
			return s?.re ?? s?.values ?? [];
		};
		let index = 0;
		for (const r of list) {
			for (const name of selectedVectors) {
				const v = r.result!.vectors.find((x) => x.name.toLowerCase() === name.toLowerCase());
				let values: ArrayLike<number> | null = null;
				let type: TraceData['type'] = v?.type === 'current' ? 'current' : v?.type === 'voltage' ? 'voltage' : 'notype';
				if (v) {
					if (complex) {
						values = acView === 'mag' ? magnitudeDb(v.re!, v.im!) : phaseDeg(v.re!, v.im!);
						type = acView === 'mag' ? 'magnitude' : 'phase';
					} else {
						values = v.values!;
					}
				} else if (extraTraces.has(`${r.label}|${name}`)) {
					values = extraTraces.get(`${r.label}|${name}`)!.values;
					type = name.startsWith('i(') ? 'current' : 'voltage';
				}
				if (!values) continue;
				const label = list.length > 1 ? `${displayName(name)} ${r.step ?? ''}`.trim() : displayName(name);
				const id = `${name}@${r.label}`;
				traces.push({ id, name: label, type, values, x: axisX(r.result!), color: getTraceColor(index++), visible: !hiddenTraces.has(id) });
			}
		}
		const xAxisType = scale.type === 'frequency' ? ('frequency' as const) : scale.type === 'time' ? ('time' as const) : ('sweep' as const);
		const sweep = /^v\((.*)-sweep\)$/i.exec(scale.name)?.[1];
		const xLabel = xAxisType === 'frequency' ? 'Frequency (Hz)' : xAxisType === 'time' ? 'Time (s)' : `${sweep ? sweep.toUpperCase() : scale.name} sweep`;
		const xUnit = xAxisType === 'frequency' ? 'Hz' : xAxisType === 'time' ? 's' : scale.type === 'voltage' ? 'V' : scale.type === 'current' ? 'A' : '';
		const kinds = new Set(traces.map((t) => t.type));
		const yLabel = complex ? (acView === 'mag' ? 'Magnitude (dB)' : 'Phase (deg)') : kinds.size === 1 && kinds.has('voltage') ? 'Voltage (V)' : kinds.size === 1 && kinds.has('current') ? 'Current (A)' : 'Value';
		return { traces, x: axisX(first), xAxisType, xLabel, xUnit, yLabel, key: `${list.map((r) => r.label).join('+')}|${selectedVectors.join(',')}|${acView}` };
	});

	/** .OP and .TF answer with single numbers: a table, not a curve */
	const table = $derived.by(() => {
		const r = currentRun?.result;
		if (!r || plot || r.numPoints > 1) return null;
		return r.vectors.map((v) => ({
			name: displayName(v.name),
			value: v.values ? String(v.values[0]) : `${v.re?.[0]} + j${v.im?.[0]}`
		}));
	});

	function handleProbe(event: { type: string; node1: string; node2?: string; componentId?: string; label: string }) {
		const r = currentRun?.result;
		if (!r) {
			status = `Probe ${event.label}: run the simulation first`;
			return;
		}
		if (event.type === 'voltage') {
			const name = `v(${safeNode(event.node1).toLowerCase()})`;
			if (event.node1 !== '0' && dataVectors(r).some((v) => v.name.toLowerCase() === name)) {
				if (!selectedVectors.includes(name)) selectedVectors = [...selectedVectors, name];
				status = `Added ${event.label}`;
			} else status = `${event.label} is not in this run`;
			return;
		}
		if (event.type === 'voltage-diff') {
			const of = (node: string) => node === '0' ? new Float64Array(r.numPoints) : r.vectors.find((v) => v.name.toLowerCase() === `v(${safeNode(node).toLowerCase()})`)?.values;
			const a = of(event.node1);
			const b = of(event.node2 ?? '0');
			if (!a || !b) {
				status = `${event.label} is only available in a transient run`;
				return;
			}
			const name = `v(${safeNode(event.node1).toLowerCase()},${safeNode(event.node2 ?? '0').toLowerCase()})`;
			extraTraces = new Map(extraTraces).set(`${runs[selectedRun].label}|${name}`, { name: event.label, values: a.map((x, i) => x - b[i]) });
			if (!selectedVectors.includes(name)) selectedVectors = [...selectedVectors, name];
			status = `Added ${event.label}`;
			return;
		}
		// a source's current comes from ngspice; a resistor's or capacitor's is worked out from its voltages
		const name = `i(${event.node1.toLowerCase()})`;
		if (dataVectors(r).some((v) => v.name.toLowerCase() === name)) {
			if (!selectedVectors.includes(name)) selectedVectors = [...selectedVectors, name];
			status = `Added ${event.label}`;
			return;
		}
		const comp = schematic.components.find((c) => c.id === event.componentId);
		const scale = scaleOf(r);
		if (!comp || !scale?.values || r.dataType !== 'real') {
			status = `${event.label} is only available in a transient run`;
			return;
		}
		const parameters = directivesOf(runs[selectedRun].netlist).parameters;
		const calc = calculateComponentCurrent(comp, schematic, r.vectors.map((v) => ({ name: v.name, type: v.type, values: v.values! })), Array.from(scale.values), parameters, (n) => `v(${safeNode(n).toLowerCase()})`);
		if (!calc) {
			status = `${event.label} cannot be worked out from this run`;
			return;
		}
		extraTraces = new Map(extraTraces).set(`${runs[selectedRun].label}|${name}`, { name: calc.name, values: calc.values });
		if (!selectedVectors.includes(name)) selectedVectors = [...selectedVectors, name];
		status = `Added ${event.label} (calculated)`;
	}

	// -- saving --------------------------------------------------------------------------------------

	function download(name: string, bytes: Uint8Array, type = 'application/octet-stream') {
		const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
	}

	function cirBytes() {
		return encodeText(docText, docEncoding);
	}

	/** Ctrl+S: the host takes the file, otherwise it downloads */
	async function save() {
		await opening.catch(() => {});
		await flushTextEdit();
		syncNow();
		const name = saveName(docName);
		const bytes = cirBytes();
		if (hostMode) {
			const copy = bytes.slice().buffer;
			post('save', { name, bytes: copy }, [copy]);
		} else {
			download(name, bytes, 'text/plain');
		}
		savedText = docText;
		status = `Saved ${name}`;
		return { name, text: docText };
	}

	/** The run(s) on screen as a table: one row per point, all the chosen vectors */
	function resultsCsv(): string {
		const list = shownRuns.filter((r) => r.result);
		if (!list.length) return '';
		const rows: string[] = [];
		const multiple = list.length > 1;
		const complex = list[0].result!.dataType === 'complex';
		const scale = scaleOf(list[0].result);
		const chosen = (selectedVectors.length ? selectedVectors : dataVectors(list[0].result).map((v) => v.name));
		const head: string[] = [];
		if (multiple) head.push('run');
		if (scale) head.push(scale.name);
		for (const n of chosen) {
			if (complex) head.push(`${displayName(n)} mag (dB)`, `${displayName(n)} phase (deg)`);
			else head.push(displayName(n));
		}
		rows.push(head.map(csvCell).join(','));
		for (const r of list) {
			const res = r.result!;
			const sc = scaleOf(res);
			const xs = sc?.re ?? sc?.values ?? [];
			const cols: ArrayLike<number>[] = [];
			for (const n of chosen) {
				const v = res.vectors.find((x) => x.name.toLowerCase() === n.toLowerCase());
				if (!v) {
					const extra = extraTraces.get(`${r.label}|${n}`);
					cols.push(extra?.values ?? new Float64Array(res.numPoints).fill(NaN));
					if (complex) cols.push(new Float64Array(res.numPoints).fill(NaN));
				} else if (complex) {
					cols.push(magnitudeDb(v.re!, v.im!), phaseDeg(v.re!, v.im!));
				} else cols.push(v.values!);
			}
			for (let i = 0; i < res.numPoints; i++) {
				const row: (string | number)[] = [];
				if (multiple) row.push(r.label);
				if (sc) row.push(xs[i]);
				for (const c of cols) row.push(c[i]);
				rows.push(row.map(csvCell).join(','));
			}
		}
		return rows.join('\n') + '\n';
	}

	function exportCsv() {
		const csv = resultsCsv();
		if (!csv) {
			status = 'No results to export yet';
			return;
		}
		const label = (overlaySteps ? shortAnalysis(currentRun!.analysis) : currentRun!.label).replace(/[^A-Za-z0-9=._-]+/g, '_');
		const name = `${docName.replace(/\.[^.]*$/, '')}_${label}.csv`;
		const bytes = new TextEncoder().encode(csv);
		if (hostMode) {
			const copy = bytes.slice().buffer;
			post('save', { name, bytes: copy }, [copy]);
		} else {
			download(name, bytes, 'text/csv');
		}
		status = `Exported ${name}`;
	}

	// -- host bridge and page API --------------------------------------------------------------------

	function post(kind: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = []) {
		if (!hostMode || window.parent === window) return;
		window.parent.postMessage({ type: `circuitcraft:${kind}`, ...payload }, location.origin, transfer);
	}

	function onMessage(e: MessageEvent) {
		if (!hostMode || e.source !== window.parent || e.origin !== location.origin) return;
		const m = e.data || {};
		if (m.type === 'circuitcraft:open') {
			openBytes(m.name || 'circuit.cir', m.bytes, m.files || []).catch(reportOpenFailure);
		}
	}

	let lastDirty = false;
	$effect(() => {
		const d = dirty;
		if (d !== lastDirty) {
			lastDirty = d;
			post('dirty', { dirty: d });
		}
	});

	function getState() {
		return {
			name: docName,
			isLibrary,
			libraryParts,
			libraryModels,
			elements: specs.map((s) => ({ ref: s.ref, letter: s.letter, symbol: s.symbol, nodes: s.pins.map((p) => p.net), pins: s.pins.map((p) => p.name), value: s.value, external: s.external ?? null })),
			labelledNets,
			runs: runs.map((r) => ({
				label: r.label,
				analysis: r.analysis,
				step: r.step,
				status: r.status,
				error: r.error,
				warnings: r.warnings,
				ms: r.ms,
				numPoints: r.result?.numPoints ?? 0,
				vectors: r.result?.vectors.map((v) => v.name) ?? []
			})),
			selectedRun,
			selectedVectors,
			warnings: translation.warnings,
			unsupported: translation.unsupported,
			lastError,
			blockedReason,
			busy,
			loading,
			engine: engineState,
			recoveries: engine.recoveries,
			dirty,
			text: docText
		};
	}

	function exposeApi() {
		(window as unknown as Record<string, unknown>).circuitcraft = {
			openFile: async (name: string, bytes: ArrayBuffer | ArrayBufferView | string, extra?: { name: string; bytes: ArrayBuffer | ArrayBufferView | string }[]) => {
				await openBytes(name, bytes, extra ?? []);
				return getState();
			},
			runAll: async () => {
				await runAll();
				return getState();
			},
			getState,
			// for the demo recording and the tests
			selectRun: (i: number) => { selectedRun = i; overlaySteps = false; ensureVectors(); return getState(); },
			setVectors: (names: string[]) => { selectedVectors = names; },
			setAcView: (v: 'mag' | 'phase') => { acView = v; },
			setOverlay: (on: boolean) => { overlaySteps = on; ensureVectors(); },
			setRunTimeout: (ms: number) => { runTimeoutMs = ms; },
			setRouteBudget: (ms: number | undefined) => { routeBudgetMs = ms; },
			getResult: (i: number) => {
				const r = runs[i]?.result;
				if (!r) return null;
				return {
					dataType: r.dataType,
					numPoints: r.numPoints,
					vectors: r.vectors.map((v) => ({
						name: v.name,
						type: v.type,
						values: v.values ? Array.from(v.values) : undefined,
						re: v.re ? Array.from(v.re) : undefined,
						im: v.im ? Array.from(v.im) : undefined
					}))
				};
			},
			getSchematic: () => JSON.parse(JSON.stringify({
				components: schematic.components,
				wires: schematic.wires,
				junctions: schematic.junctions,
				nodeLabels: schematic.nodeLabels
			})),
			getConnectivity: () => {
				const c = analyzeConnectivity(schematic);
				const name = new Map(c.nets.map((n) => [n.id, n.name]));
				return c.pinConnections.map((p) => ({ component: p.componentId, ref: p.componentName, pin: p.pinName, net: name.get(p.netId ?? '') ?? null }));
			},
			getPlot: () => plot && {
				xAxisType: plot.xAxisType,
				xLabel: plot.xLabel,
				yLabel: plot.yLabel,
				traces: plot.traces.map((t) => ({ name: t.name, type: t.type, visible: t.visible, points: t.values.length }))
			},
			getBytes: () => { syncNow(); return Array.from(cirBytes()); },
			getWritten: () => writtenElements(schematic).map((w) => ({ ref: w.ref, nodes: w.nodes, value: w.value })),
			toScreen: (x: number, y: number) => canvasRef?.toScreen(x, y) ?? null,
			fitView: () => canvasRef?.fitView(),
			editValue: (ref: string, value: string) => {
				const comp = schematic.components.find((c) => c.attributes['InstName'] === ref);
				if (!comp) return false;
				handleSaveComponent({ ...comp, attributes: { ...comp.attributes, Value: value } });
				return true;
			},
			newDocument: () => { showLanding = false; newDocument(); return getState(); },
			save,
			resultsCsv,
			docTranslation: () => translation
		};
	}

	// -- page lifecycle ------------------------------------------------------------------------------

	onMount(() => {
		// an http:// address that is not localhost has no crypto.randomUUID, and the editor needs ids
		if (!crypto.randomUUID) {
			(crypto as { randomUUID: () => string }).randomUUID = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		}
		exposeApi();
		window.addEventListener('message', onMessage);
		engine.onstate = (state, detail) => {
			engineState = state;
			if (state === 'ready' && /Starting|Restarting/.test(status)) status = 'Simulator ready';
			if (state === 'failed') {
				status = `The simulator did not start: ${detail}`;
				post('failed', { error: detail });
			}
		};
		engine.start().catch(() => {});
		if (hostMode) {
			newDocument();
			post('ready');
		} else {
			refreshTranslation();
		}
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('message', onMessage);
		engine.terminate();
	});

	function handleKeyDown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const isTextInput = target.tagName === 'TEXTAREA' ||
			(target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text') ||
			target.isContentEditable;
		const mod = e.ctrlKey || e.metaKey;

		if (!isTextInput && (e.key === 'h' || e.key === 'H') && !mod && !e.altKey) {
			e.preventDefault();
			showHelp = true;
			return;
		}
		if (mod && e.key === 's') e.preventDefault();
		if (mod && e.key === 'o') { e.preventDefault(); openDialog(); }
		if (showLanding) return;
		if (mod && e.key === 'b') { e.preventDefault(); runAll(); }
		if (mod && e.key === 's') save();
	}

	function handleNewProject() {
		showLanding = false;
		newDocument();
		showHelp = !hasSeenHelp();
	}

	function hasSeenHelp() {
		try {
			if (localStorage.getItem('circuitcraft-help-seen')) return true;
			localStorage.setItem('circuitcraft-help-seen', 'true');
		} catch { /* no storage in this frame */ }
		return false;
	}

	function returnToLanding() {
		if (hostMode) return;
		showLanding = true;
		runToken++;
		engine.stop();
		newDocument();
	}

	function runStatusMark(r: RunView) {
		return r.status === 'ok' ? '✓' : r.status === 'failed' ? '✕' : r.status === 'running' ? '…' : '';
	}

	const notices = $derived.by(() => {
		const items: { kind: 'error' | 'warn' | 'info'; text: string }[] = [];
		if (isLibrary) {
			items.push({ kind: 'info', text: `Library: ${libraryParts.length} subcircuit(s), ${libraryModels.length} model(s). ${blockedReason}` });
		}
		for (const u of translation.unsupported) items.push({ kind: 'error', text: `Cannot run: ${u}` });
		if (drawError) items.push({ kind: 'warn', text: drawError });
		for (const part of new Set(specs.filter((s) => s.missingPart).map((s) => s.missingPart))) {
			items.push({ kind: 'warn', text: `${part} is not in the open files: use Open to add its library.` });
		}
		if (lastError && !translation.unsupported.length && !isLibrary) items.push({ kind: 'error', text: lastError });
		for (const w of translation.warnings) items.push({ kind: 'warn', text: w });
		for (const r of runs) for (const w of r.warnings) {
			const t = `${r.label}: ${w}`;
			if (!items.some((i) => i.text === t)) items.push({ kind: 'warn', text: t });
		}
		return items;
	});
	const firstError = $derived(notices.find((n) => n.kind === 'error'));
	// a few lines stay in view; a long list folds behind its first line
	const noticesOpen = $derived(showAllNotices || notices.length <= 3);
</script>

<svelte:head>
	<title>CircuitCraft</title>
</svelte:head>

<svelte:window
	onkeydown={handleKeyDown}
	onmousedown={(e) => { if (vectorMenu?.open && !vectorMenu.contains(e.target as Node)) vectorMenu.open = false; }}
/>

<input
	bind:this={fileInput}
	id="cc-file-input"
	class="file-input"
	type="file"
	multiple
	accept={ACCEPTED_EXTENSIONS.join(',')}
	onchange={onFileChosen}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="app"
	ondragover={onDragOver}
	ondragleave={(e) => { if (!e.relatedTarget) dragOver = false; }}
	ondrop={onDrop}
>
	{#if dragOver}
		<div class="drop-hint">Drop a circuit (.cir .net .ckt .sp) together with its .lib files</div>
	{/if}
	{#if showLanding}
		<LandingPage
			onnewproject={handleNewProject}
			onopenfile={openDialog}
			onloadexample={handleLoadExample}
		/>
	{:else}
		<header class="toolbar">
			<span class="app-title" onclick={returnToLanding} title="CircuitCraft, based on WebSpice" role="button" tabindex="0" onkeydown={(e) => e.key === 'Enter' && returnToLanding()}>CircuitCraft</span>
			<span class="doc-name" title={docName}>{docName}{dirty ? ' *' : ''}</span>
			<button onclick={openDialog} title="Open a circuit and its libraries (Ctrl+O)">Open</button>
			<button onclick={save} title={isLibrary ? 'Save the library text (Ctrl+S)' : 'Save as PSpice .cir (Ctrl+S)'}>{isLibrary ? 'Save' : 'Save .cir'}</button>
			<button onclick={exportCsv} disabled={!currentRun?.result} title="Results on screen as CSV">Export CSV</button>
			{#if !hostMode}
				<button class="quiet" onclick={saveJson} disabled={isLibrary} title="Save the drawing with its placement">Save JSON</button>
			{/if}
			<span class="toolbar-separator"></span>
			{#if busy}
				<button class="stop" onclick={stopRun}>Stop</button>
			{:else}
				<button class="run" class:blocked={!!blockedReason} onclick={runAll} title={blockedReason || 'Run every analysis in the document (Ctrl+B)'}>Run (Ctrl+B)</button>
			{/if}
			{#if blockedReason && !busy}
				<span class="run-reason" title={blockedReason}>{blockedReason}</span>
			{/if}
			<div class="toolbar-spacer"></div>
			{#if engineState !== 'ready'}
				<span class="engine-note">{engineState === 'failed' ? 'Simulator failed' : 'Starting simulator…'}</span>
			{/if}
			<button class="help-btn" onclick={() => showHelp = true} title="Show keyboard shortcuts (H)">?</button>
		</header>

		{#if notices.length}
			<div class="notices" class:has-error={!!firstError}>
				{#if notices.length > 3}
					<button class="notices-toggle" onclick={() => showAllNotices = !showAllNotices} aria-expanded={showAllNotices}>
						{showAllNotices ? '▾' : '▸'} {notices.length}
					</button>
				{/if}
				<div class="notices-list" class:open={showAllNotices}>
					{#each noticesOpen ? notices : notices.slice(0, 1) as n}
						<div class="notice {n.kind}" title={n.text}>{n.text.split('\n').slice(0, showAllNotices ? 8 : 2).join(' · ')}</div>
					{/each}
				</div>
			</div>
		{/if}

		<main class="workspace">
			<ResizablePanel title="Netlist" direction="horizontal" initialSize={netlistWidth} minSize={160} bind:collapsed={netlistCollapsed}>
				<div class="panel-fill">
					<NetlistEditor bind:value={docText} onchange={onTextEdited} />
				</div>
			</ResizablePanel>
			<div class="right-panel">
				<ResizablePanel title="Schematic" direction="vertical" initialSize={schematicHeight} minSize={100} bind:collapsed={schematicCollapsed}>
					{#snippet headerActions()}
						{#if isLibrary && libraryParts.length}
							<select
								class="part-select"
								value={libraryPart}
								onchange={(e) => showLibraryPart((e.target as HTMLSelectElement).value, read(docText)).then(() => tick()).then(() => canvasRef?.fitView())}
							>
								{#each libraryParts as p}<option value={p}>{p}</option>{/each}
							</select>
						{/if}
						{#if !isLibrary}
							<button class="panel-action-btn" onclick={openDirectives} title="Edit parameters, models and analyses">Directives</button>
						{/if}
						<button class="panel-action-btn" onclick={() => canvasRef?.fitView()} title="Frame the whole drawing (F)">Fit</button>
					{/snippet}
					<div class="panel-fill dark">
						<SchematicCanvas
							bind:this={canvasRef}
							bind:schematic
							readonly={isLibrary}
							onprobe={handleProbe}
							oneditcomponent={handleEditComponent}
							oneditdirectives={openDirectives}
							onchange={scheduleSync}
						/>
					</div>
				</ResizablePanel>
				<div class="waveform-area">
					<div class="runbar">
						{#if analyses.length}
							<div class="pills" role="group" aria-label="Analysis">
								{#each analyses as a}
									<button class="pill" class:active={currentRun?.analysis === a} class:failed={runs.some((r) => r.analysis === a && r.status === 'failed')} title={a} onclick={() => selectAnalysis(a)}>{shortAnalysis(a)}</button>
								{/each}
							</div>
						{/if}
						{#if stepsOfAnalysis.length}
							<div class="pills" role="group" aria-label="Step">
								{#each stepsOfAnalysis as step}
									{@const r = runs.find((x) => x.analysis === currentRun?.analysis && x.step === step)}
									<button class="pill" class:active={!overlaySteps && currentRun?.step === step} class:failed={r?.status === 'failed'} onclick={() => selectStep(step)}>{step} {r ? runStatusMark(r) : ''}</button>
								{/each}
								<button class="pill" class:active={overlaySteps} onclick={() => { overlaySteps = !overlaySteps; ensureVectors(); }} title="Plot every step together">All</button>
							</div>
						{/if}
						{#if currentRun?.result?.dataType === 'complex'}
							<div class="pills" role="group" aria-label="AC view">
								<button class="pill" class:active={acView === 'mag'} onclick={() => acView = 'mag'}>Mag dB</button>
								<button class="pill" class:active={acView === 'phase'} onclick={() => acView = 'phase'}>Phase</button>
							</div>
						{/if}
						{#if vectorGroups.length}
							<details class="vectors" bind:this={vectorMenu}>
								<summary>Vectors ({selectedVectors.length})</summary>
								<div class="vector-menu">
									{#each vectorGroups as g}
										<div class="vector-group">{g.name}</div>
										{#each g.items as name}
											<label class="vector-item">
												<input type="checkbox" checked={selectedVectors.includes(name)} onchange={() => toggleVector(name)} />
												{displayName(name)}
											</label>
										{/each}
									{/each}
								</div>
							</details>
						{/if}
						<div class="toolbar-spacer"></div>
						{#if runs.length}
							<span class="run-count">{runs.filter((r) => r.status === 'ok').length}/{runs.length} runs</span>
						{/if}
					</div>
					<div class="plot-area">
						{#if plot && plot.traces.length}
							{#key plot.xAxisType}
								<WaveformViewer
									traces={plot.traces}
									timeData={plot.x}
									xAxisType={plot.xAxisType}
									xLabel={plot.xLabel}
									xUnit={plot.xUnit}
									yLabel={plot.yLabel}
									dataKey={plot.key}
									ontracetoggle={toggleTrace}
								/>
							{/key}
						{:else if table}
							<div class="op-table">
								<table>
									<thead><tr><th>Vector</th><th>Value</th></tr></thead>
									<tbody>
										{#each table as row}
											<tr><td>{row.name}</td><td>{row.value}</td></tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else if currentRun?.status === 'failed' || currentRun?.status === 'skipped'}
							<pre class="run-error">{currentRun.label}: {currentRun.error}</pre>
						{:else if busy}
							<div class="plot-empty">Simulating…</div>
						{:else if plot}
							<div class="plot-empty">Pick a vector to plot.</div>
						{:else}
							<div class="plot-empty">{blockedReason || 'Press Run to simulate.'}</div>
						{/if}
						{#if currentRun?.status === 'failed' && currentRun.result}
							<div class="partial-note">Stopped early: {currentRun.error}</div>
						{/if}
					</div>
				</div>
			</div>
		</main>
		<footer class="statusbar">
			<span class="status-text">{status}</span>
			<a href="https://github.com/jwt625/WebSpice" target="_blank" rel="noopener noreferrer" class="github-link" title="Based on WebSpice by jwt625 (MIT)">based on WebSpice</a>
		</footer>

		<HelpModal bind:visible={showHelp} />
		<DirectiveModal
			bind:visible={showDirectives}
			bind:parameters={schematic.parameters}
			bind:models={schematic.models}
			bind:directives={schematic.directives}
			onsave={onDirectivesSaved}
		/>
		<ComponentEditModal
			bind:visible={showComponentEdit}
			bind:component={editingComponent}
			models={schematic.models}
			onsave={handleSaveComponent}
		/>
	{/if}
</div>

<style>
	.file-input {
		position: fixed;
		left: -9999px;
		width: 1px;
		height: 1px;
		opacity: 0;
	}

	.app {
		position: relative;
		display: flex;
		flex-direction: column;
		height: 100vh;
		width: 100%;
	}

	.drop-hint {
		position: absolute;
		inset: 8px;
		z-index: 900;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px dashed #5aa0ff;
		border-radius: 6px;
		background: rgba(20, 40, 70, 0.85);
		color: #d8e8ff;
		font-size: 18px;
		pointer-events: none;
	}

	.toolbar {
		background: var(--toolbar-bg);
		border-bottom: 1px solid var(--border-primary);
		padding: var(--spacing-xs) var(--spacing-sm);
		display: flex;
		align-items: center;
		gap: 8px;
		height: 40px;
		flex-shrink: 0;
		min-width: 0;
	}

	.toolbar button {
		background: var(--btn-primary-bg);
		color: var(--text-primary);
		border: none;
		padding: 4px 10px;
		border-radius: 3px;
		cursor: pointer;
		font-size: 12px;
		white-space: nowrap;
		flex-shrink: 0;
	}

	.toolbar button:hover:not(:disabled) {
		background: var(--btn-primary-hover);
	}

	.toolbar button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toolbar button.quiet {
		background: transparent;
		border: 1px solid var(--border-primary);
	}

	.toolbar button.run {
		background: #2e8b57;
		color: #fff;
		font-weight: 600;
	}

	.toolbar button.run:hover {
		background: #37a367;
	}

	.toolbar button.run.blocked {
		background: #555;
		color: #bbb;
	}

	.toolbar button.stop {
		background: #b23b3b;
		color: #fff;
		font-weight: 600;
	}

	.run-reason {
		color: #ffb4a8;
		font-size: 12px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		min-width: 40px;
		flex: 1 1 0;
	}

	.engine-note {
		color: var(--text-secondary);
		font-size: 12px;
		white-space: nowrap;
	}

	.app-title {
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
		white-space: nowrap;
	}

	.doc-name {
		color: var(--text-secondary);
		font-size: 12px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		max-width: 180px;
	}

	.toolbar-separator {
		width: 1px;
		height: 20px;
		background: var(--border-primary);
		flex-shrink: 0;
	}

	.toolbar-spacer {
		flex: 1;
	}

	.toolbar .help-btn {
		background: var(--accent-blue, #0e639c);
		color: white;
		font-weight: bold;
		font-size: 14px;
		width: 24px;
		height: 24px;
		padding: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 50%;
	}

	.notices {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 3px 8px;
		background: #2c2a1c;
		border-bottom: 1px solid #5a5322;
		flex-shrink: 0;
		max-height: 40vh;
		overflow-y: auto;
	}

	.notices.has-error {
		background: #3a2020;
		border-bottom-color: #7a3a3a;
	}

	.notices-toggle {
		background: transparent;
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 3px;
		color: var(--text-primary);
		font-size: 11px;
		padding: 0 6px;
		cursor: pointer;
		flex-shrink: 0;
	}

	.notices-list {
		min-width: 0;
		flex: 1;
	}

	.notice {
		font-size: 12px;
		line-height: 18px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.notices-list.open .notice {
		white-space: pre-wrap;
	}

	.notice.warn { color: #ffd98a; }
	.notice.error { color: #ffb4a8; }
	.notice.info { color: #a9d0ff; }

	.panel-action-btn {
		background: var(--bg-secondary);
		border: 1px solid var(--border-primary);
		color: var(--text-secondary);
		cursor: pointer;
		padding: 2px 8px;
		font-size: 11px;
		border-radius: 3px;
	}

	.panel-action-btn:hover {
		background: var(--bg-tertiary);
		color: var(--text-primary);
	}

	.part-select {
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--border-primary);
		font-size: 11px;
		max-width: 180px;
	}

	.workspace {
		flex: 1;
		display: flex;
		flex-direction: row;
		overflow: hidden;
		min-height: 0;
	}

	.right-panel {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-width: 0;
	}

	.waveform-area {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		min-height: 0;
	}

	.runbar {
		display: flex;
		align-items: center;
		gap: 10px;
		height: 34px;
		padding: 0 8px;
		background: var(--bg-secondary);
		border-top: 1px solid var(--border-primary);
		border-bottom: 1px solid var(--border-primary);
		flex-shrink: 0;
		min-width: 0;
	}

	.pills {
		display: flex;
		gap: 1px;
		flex-shrink: 0;
	}

	.pill {
		background: var(--bg-tertiary);
		border: 1px solid var(--border-primary);
		color: var(--text-primary);
		font-size: 12px;
		padding: 2px 9px;
		cursor: pointer;
		white-space: nowrap;
	}

	.pill:first-child { border-radius: 3px 0 0 3px; }
	.pill:last-child { border-radius: 0 3px 3px 0; }
	.pill:hover { background: #3a3a3e; }
	.pill.active { background: var(--btn-primary-bg); border-color: #2a84c7; color: #fff; }
	.pill.failed { color: #ff9a8a; }

	.vectors {
		position: relative;
		flex-shrink: 0;
		font-size: 12px;
	}

	.vectors summary {
		cursor: pointer;
		padding: 2px 8px;
		border: 1px solid var(--border-primary);
		border-radius: 3px;
		background: var(--bg-tertiary);
		list-style: none;
		white-space: nowrap;
	}

	.vector-menu {
		position: fixed;
		z-index: 50;
		margin-top: 4px;
		background: var(--bg-primary);
		border: 1px solid var(--border-primary);
		box-shadow: 0 6px 18px rgba(0, 0, 0, 0.5);
		padding: 6px 10px;
		max-height: min(300px, 50vh);
		min-width: 200px;
		overflow-y: auto;
	}

	.vector-group {
		color: var(--text-secondary);
		font-size: 11px;
		margin: 6px 0 2px;
	}

	.vector-item {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 20px;
		cursor: pointer;
		white-space: nowrap;
	}

	.run-count {
		color: var(--text-secondary);
		font-size: 12px;
		white-space: nowrap;
	}

	.plot-area {
		position: relative;
		flex: 1;
		min-height: 0;
		background: #111;
		overflow: hidden;
	}

	.plot-empty {
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-secondary);
		font-size: 13px;
		padding: 12px;
		text-align: center;
	}

	.partial-note {
		position: absolute;
		left: 70px;
		top: 14px;
		color: #ffb4a8;
		background: rgba(40, 20, 20, 0.85);
		padding: 2px 8px;
		font-size: 12px;
		max-width: 60%;
	}

	.run-error {
		color: #ffb4a8;
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 12px;
		white-space: pre-wrap;
		overflow: auto;
		height: 100%;
	}

	.op-table {
		height: 100%;
		overflow: auto;
		padding: 8px 12px;
	}

	.op-table table {
		border-collapse: collapse;
		font-family: var(--font-mono);
		font-size: 13px;
	}

	.op-table th, .op-table td {
		padding: 2px 16px 2px 0;
		text-align: left;
		border-bottom: 1px solid var(--border-primary);
	}

	.panel-fill {
		width: 100%;
		height: 100%;
		overflow: hidden;
	}

	.panel-fill.dark {
		background: #1a1a1a;
		position: relative;
	}

	.statusbar {
		background: var(--statusbar-bg);
		color: var(--statusbar-text);
		padding: 2px 8px;
		font-size: 12px;
		height: 24px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--spacing-md);
		flex-shrink: 0;
		min-width: 0;
	}

	.status-text {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.statusbar .github-link {
		color: var(--statusbar-text);
		text-decoration: none;
		opacity: 0.8;
		font-size: 11px;
		white-space: nowrap;
	}

	.statusbar .github-link:hover {
		opacity: 1;
	}
</style>
