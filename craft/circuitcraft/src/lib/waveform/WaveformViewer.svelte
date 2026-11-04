<script lang="ts">
	import { onMount, onDestroy, untrack } from 'svelte';
	import { WebglPlot, WebglLine, ColorRGBA } from 'webgl-plot';
	import type { TraceData, ViewBounds, Cursor } from './types';

	let {
		traces = [],
		timeData = [],
		xAxisType = 'time',
		xLabel = '',
		xUnit = '',
		yLabel = '',
		dataKey = '',
		ontracetoggle
	}: {
		traces: TraceData[];
		timeData: ArrayLike<number>;
		// 'frequency' is drawn on a log axis (a Bode plot); everything else is linear
		xAxisType?: 'time' | 'frequency' | 'sweep';
		xLabel?: string;
		xUnit?: string;
		yLabel?: string;
		// changes when the plot shows something else: the axes rescale then
		dataKey?: string;
		ontracetoggle?: (traceId: string) => void;
	} = $props();

	// plot margins in CSS pixels: the axes get their own strip, like a real instrument
	const MARGIN = { left: 62, right: 30, top: 8, bottom: 40 };
	const logX = $derived(xAxisType === 'frequency');
	const toPlotX = (v: number) => (logX ? Math.log10(Math.max(v, 1e-30)) : v);
	const fromPlotX = (v: number) => (logX ? Math.pow(10, v) : v);
	const xsOf = (t: TraceData): ArrayLike<number> => t.x ?? timeData;

	let gridCanvas: HTMLCanvasElement;
	let canvas: HTMLCanvasElement;
	let overlayCanvas: HTMLCanvasElement;
	let axisCanvas: HTMLCanvasElement;
	let container: HTMLDivElement;
	let wglp: WebglPlot | null = null;
	let initialized = false;

	let bounds: ViewBounds = { xMin: 0, xMax: 1, yMin: -1, yMax: 1 };
	let cursors: [Cursor, Cursor] = $state([
		{ id: 'A', x: 0.25, visible: false, color: '#ffff00' },
		{ id: 'B', x: 0.75, visible: false, color: '#00ffff' }
	]);

	let showGrid = $state(true);
	let zoomStart: { x: number; y: number } | null = null;
	let zoomEnd: { x: number; y: number } | null = null;
	let zoomType: 'x' | 'y' | 'rect' | null = $state(null);
	let mousePos = $state({ x: 0, y: 0, dataX: 0, dataY: 0 });
	let showTooltip = $state(false);
	let isDragging = false;
	let dragStart = { x: 0, y: 0 };
	let dragMode: 'pan' | 'zoom' | null = null;

	const getDpr = () => window.devicePixelRatio || 1;

	let resizeObserver: ResizeObserver | null = null;

	onMount(() => {
		initWebGL();
		// the panel around the plot is resizable, the window is only one reason for a new size
		resizeObserver = new ResizeObserver(handleResize);
		resizeObserver.observe(container);
	});

	onDestroy(() => resizeObserver?.disconnect());

	function initWebGL() {
		if (!canvas) return;
		const d = getDpr();
		const w = canvas.clientWidth * d, h = canvas.clientHeight * d;
		canvas.width = w; canvas.height = h;
		if (gridCanvas) { gridCanvas.width = w; gridCanvas.height = h; }
		if (overlayCanvas) { overlayCanvas.width = w; overlayCanvas.height = h; }
		sizeAxisCanvas();
		try {
			wglp = new WebglPlot(canvas, { antialias: true, transparent: true });
			initialized = true;
			updateTraces();
			render();
		} catch (err) {
			console.error('WebGL init failed:', err);
		}
	}

	function handleResize() {
		if (!canvas || !wglp) return;
		const d = getDpr();
		const w = canvas.clientWidth * d, h = canvas.clientHeight * d;
		canvas.width = w; canvas.height = h;
		if (gridCanvas) { gridCanvas.width = w; gridCanvas.height = h; }
		if (overlayCanvas) { overlayCanvas.width = w; overlayCanvas.height = h; }
		sizeAxisCanvas();
		wglp.viewport(0, 0, w, h);
		render();
	}

	function sizeAxisCanvas() {
		if (!axisCanvas || !container) return;
		const d = getDpr();
		axisCanvas.width = container.clientWidth * d;
		axisCanvas.height = container.clientHeight * d;
	}

	// Rescale when the plot shows something new, not when a trace is merely hidden
	let previousKey: string | null = null;

	$effect(() => {
		const key = dataKey;
		if (traces.length > 0 && (timeData.length > 0 || traces[0].x) && initialized && wglp) {
			const shouldAutoscale = key !== previousKey;
			previousKey = key;
			untrack(() => {
				updateTraces();
				if (shouldAutoscale) {
					autoscale();
				}
				render();
			});
		}
	});

	function updateTraces() {
		if (!wglp) return;
		wglp.removeDataLines();
		for (const trace of traces) {
			if (!trace.visible) continue;
			const xs = xsOf(trace);
			const n = Math.min(trace.values.length, xs.length);
			const line = new WebglLine(new ColorRGBA(trace.color.r, trace.color.g, trace.color.b, trace.color.a), n);
			for (let j = 0; j < n; j++) { line.setX(j, toPlotX(xs[j])); line.setY(j, trace.values[j]); }
			wglp.addDataLine(line);
		}
	}

	function autoscale() {
		if (!traces.length) return;
		let yMin = Infinity, yMax = -Infinity, xMin = Infinity, xMax = -Infinity;
		for (const t of traces) {
			if (!t.visible) continue;
			const xs = xsOf(t);
			if (xs.length) {
				xMin = Math.min(xMin, toPlotX(xs[0]));
				xMax = Math.max(xMax, toPlotX(xs[xs.length - 1]));
			}
			for (let i = 0; i < t.values.length; i++) {
				const v = t.values[i];
				// a node with no AC signal sits on the -400 dB floor: it must not flatten the rest
				if (t.type === 'magnitude' && v <= -300) continue;
				if (v < yMin) yMin = v;
				if (v > yMax) yMax = v;
			}
		}
		if (!Number.isFinite(yMin) || !Number.isFinite(xMin)) return;
		const pad = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.1 || 0.1;
		bounds = { xMin, xMax: xMax > xMin ? xMax : xMin + 1, yMin: yMin - pad, yMax: yMax + pad };
	}

	function render() {
		if (!wglp) return;

		// Calculate scale and offset for WebGL (-1 to 1 range)
		const xRange = bounds.xMax - bounds.xMin || 1;
		const yRange = bounds.yMax - bounds.yMin || 1;

		wglp.gScaleX = 2 / xRange;
		wglp.gScaleY = 2 / yRange;
		wglp.gOffsetX = -(bounds.xMin + bounds.xMax) / xRange;
		wglp.gOffsetY = -(bounds.yMin + bounds.yMax) / yRange;

		wglp.update();
		drawGridLayer();
		drawOverlay();
	}

	function drawGridLayer() {
		if (!gridCanvas) return;
		const ctx = gridCanvas.getContext('2d');
		if (!ctx) return;

		const w = gridCanvas.width;
		const h = gridCanvas.height;
		ctx.clearRect(0, 0, w, h);

		if (showGrid) {
			drawGrid(ctx, w, h);
		}
	}

	function drawOverlay() {
		if (!overlayCanvas) return;
		const ctx = overlayCanvas.getContext('2d');
		if (!ctx) return;

		const w = overlayCanvas.width;
		const h = overlayCanvas.height;
		ctx.clearRect(0, 0, w, h);

		if (showTooltip && !zoomType && traces.length > 0) drawHoverLine(ctx, h);
		for (const c of cursors) if (c.visible) drawCursor(ctx, c, w, h);
		if (zoomType && zoomStart && zoomEnd) drawZoomSelection(ctx, w, h);
		drawAxes();
	}

	const rgb = (c: {r:number,g:number,b:number}, a=1) => a < 1 ? `rgba(${c.r*255},${c.g*255},${c.b*255},${a})` : `rgb(${c.r*255},${c.g*255},${c.b*255})`;
	const toY = (v: number, h: number) => h - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * h;
	const toX = (v: number, w: number) => ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * w;

	function niceStep(range: number, divs: number): number {
		if (divs <= 0 || range <= 0) return range || 1;
		const raw = range / divs, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
		return mag * (n < 1.25 ? 1 : n < 1.75 ? 1.5 : n < 2.25 ? 2 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10);
	}

	/** x is in plot coordinates (log10 of the frequency on a Bode plot) */
	function getTraceValuesAtX(x: number): Map<string, number> {
		const values = new Map<string, number>();
		for (const t of traces) {
			if (!t.visible) continue;
			const xs = xsOf(t);
			if (!xs.length) continue;
			let lo = 0, hi = xs.length - 1;
			while (lo < hi) { const m = (lo + hi) >> 1; if (toPlotX(xs[m]) < x) lo = m + 1; else hi = m; }
			if (lo > 0) {
				const t0 = toPlotX(xs[lo - 1]), t1 = toPlotX(xs[lo]);
				const r = t1 !== t0 ? (x - t0) / (t1 - t0) : 0;
				values.set(t.name, t.values[lo - 1] + (t.values[lo] - t.values[lo - 1]) * Math.max(0, Math.min(1, r)));
			} else {
				values.set(t.name, t.values[0] || 0);
			}
		}
		return values;
	}

	/** 1500 -> 1.5k, 0.00002 -> 20u: engineering notation with no trailing zeros */
	function formatValue(v: number, u: string): string {
		const a = Math.abs(v);
		if (!Number.isFinite(v)) return '-';
		if (a === 0) return `0${u}`;
		const units: [number, string][] = [[1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']];
		for (const [m, p] of units) {
			if (a >= m * 0.9995) return `${+(v / m).toPrecision(3)}${p}${u}`;
		}
		return `${v.toExponential(1)}${u}`;
	}

	/** Format an X value given in plot coordinates */
	function formatXValue(v: number): string {
		return formatValue(fromPlotX(v), xUnit || (xAxisType === 'frequency' ? 'Hz' : xAxisType === 'time' ? 's' : ''));
	}

	function getTraceUnit(traceName: string): string {
		const trace = traces.find(t => t.name === traceName);
		if (!trace) return '';
		if (trace.type === 'current') return 'A';
		if (trace.type === 'voltage') return 'V';
		if (trace.type === 'frequency') return 'Hz';
		if (trace.type === 'magnitude') return 'dB';
		if (trace.type === 'phase') return '°';
		return '';
	}

	function drawHoverLine(ctx: CanvasRenderingContext2D, h: number) {
		const d = getDpr(), px = mousePos.x * d;
		ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
		ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); ctx.setLineDash([]);
		for (const [name, val] of getTraceValuesAtX(mousePos.dataX)) {
			const t = traces.find(tr => tr.name === name); if (!t?.visible) continue;
			const py = toY(val, h);
			ctx.fillStyle = rgb(t.color); ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI*2); ctx.fill();
		}
	}

	/** Tick positions in plot coordinates: decades on a log axis, round numbers on a linear one */
	function xTicks(w: number): { major: number[]; minor: number[] } {
		const d = getDpr();
		const major: number[] = [], minor: number[] = [];
		if (logX) {
			const span = bounds.xMax - bounds.xMin;
			const every = Math.max(1, Math.ceil(span / Math.max(2, w / (70 * d))));
			for (let k = Math.ceil(bounds.xMin); k <= bounds.xMax; k++) if (k % every === 0) major.push(k);
			if (span < 8) {
				for (let k = Math.floor(bounds.xMin); k <= bounds.xMax; k++) {
					for (let m = 2; m <= 9; m++) {
						const x = k + Math.log10(m);
						if (x >= bounds.xMin && x <= bounds.xMax) minor.push(x);
					}
				}
			}
			// less than a decade on screen: the 2,3,5 lines carry the numbers
			if (major.length < 2) for (const x of minor) if ([2, 3, 5].some((m) => Math.abs(((x % 1) + 1) % 1 - Math.log10(m)) < 1e-9)) major.push(x);
			return { major, minor };
		}
		const step = niceStep(bounds.xMax - bounds.xMin, Math.max(3, Math.round(w / (90 * d))));
		for (let x = Math.ceil(bounds.xMin / step) * step; x <= bounds.xMax + step * 1e-9; x += step) major.push(Math.abs(x) < step * 1e-9 ? 0 : x);
		return { major, minor };
	}

	function yTicks(h: number): number[] {
		const d = getDpr();
		const step = niceStep(bounds.yMax - bounds.yMin, Math.max(3, Math.round(h / (40 * d))));
		const out: number[] = [];
		for (let y = Math.ceil(bounds.yMin / step) * step; y <= bounds.yMax + step * 1e-9; y += step) out.push(Math.abs(y) < step * 1e-9 ? 0 : y);
		return out;
	}

	function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
		const d = getDpr();
		ctx.lineWidth = d;
		const line = (x1: number, y1: number, x2: number, y2: number) => {
			ctx.beginPath(); ctx.moveTo(Math.round(x1) + 0.5, Math.round(y1) + 0.5); ctx.lineTo(Math.round(x2) + 0.5, Math.round(y2) + 0.5); ctx.stroke();
		};
		const { major, minor } = xTicks(w);
		ctx.strokeStyle = '#242424';
		for (const x of minor) { const px = toX(x, w); line(px, 0, px, h); }
		ctx.strokeStyle = '#3a3a3a';
		for (const x of major) { const px = toX(x, w); line(px, 0, px, h); }
		for (const y of yTicks(h)) { const py = toY(y, h); line(0, py, w, py); }
	}

	/** Numbers and titles in the strips around the plot */
	function drawAxes() {
		if (!axisCanvas || !canvas) return;
		const ctx = axisCanvas.getContext('2d');
		if (!ctx) return;
		const d = getDpr();
		const W = axisCanvas.width, H = axisCanvas.height;
		const w = canvas.width, h = canvas.height;
		const left = MARGIN.left * d, top = MARGIN.top * d;
		ctx.clearRect(0, 0, W, H);
		const font = 'system-ui, -apple-system, "Segoe UI", sans-serif';
		ctx.strokeStyle = '#6a6a6a';
		ctx.lineWidth = d;
		ctx.strokeRect(left - 0.5, top - 0.5, w + 1, h + 1);

		ctx.fillStyle = '#c8c8c8';
		ctx.font = `${12 * d}px ${font}`;
		ctx.textBaseline = 'top';
		ctx.textAlign = 'center';
		const { major } = xTicks(w);
		for (const x of major) {
			const px = left + toX(x, w);
			ctx.beginPath(); ctx.moveTo(px, top + h); ctx.lineTo(px, top + h + 4 * d); ctx.stroke();
			ctx.fillText(formatXValue(x), px, top + h + 6 * d);
		}
		ctx.textAlign = 'right';
		ctx.textBaseline = 'middle';
		for (const y of yTicks(h)) {
			const py = top + toY(y, h);
			ctx.beginPath(); ctx.moveTo(left - 4 * d, py); ctx.lineTo(left, py); ctx.stroke();
			ctx.fillText(formatValue(y, ''), left - 6 * d, py);
		}
		ctx.fillStyle = '#9fb0c0';
		ctx.font = `${12 * d}px ${font}`;
		if (xLabel) {
			ctx.textAlign = 'center';
			ctx.textBaseline = 'bottom';
			ctx.fillText(xLabel, left + w / 2, H - 2 * d);
		}
		if (yLabel) {
			ctx.save();
			ctx.translate(13 * d, top + h / 2);
			ctx.rotate(-Math.PI / 2);
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(yLabel, 0, 0);
			ctx.restore();
		}
	}

	function drawCursor(ctx: CanvasRenderingContext2D, cur: Cursor, w: number, h: number) {
		const px = toX(cur.x, w), vals = getTraceValuesAtX(cur.x);
		ctx.strokeStyle = cur.color; ctx.lineWidth = 2; ctx.setLineDash([5,5]);
		ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke(); ctx.setLineDash([]);
		for (const [name, val] of vals) {
			const t = traces.find(tr => tr.name === name); if (!t?.visible) continue;
			const py = toY(val, h);
			ctx.fillStyle = rgb(t.color); ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI*2); ctx.fill();
			ctx.strokeStyle = rgb(t.color, 0.5); ctx.lineWidth = 1; ctx.setLineDash([3,3]);
			ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(0, py); ctx.stroke(); ctx.setLineDash([]);
		}
		const bx = (px + 128 > w) ? px - 128 : px + 8, by = 20, lh = 14;
		ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(bx, by, 120, 20 + vals.size * lh);
		ctx.strokeStyle = cur.color; ctx.lineWidth = 1; ctx.strokeRect(bx, by, 120, 20 + vals.size * lh);
		ctx.fillStyle = cur.color; ctx.font = 'bold 11px monospace';
		ctx.fillText(`${cur.id}: ${formatXValue(cur.x)}`, bx + 4, by + 14);
		ctx.font = '10px monospace'; let yo = by + 28;
		for (const [name, val] of vals) {
			const t = traces.find(tr => tr.name === name); if (!t?.visible) continue;
			const unit = getTraceUnit(name);
			ctx.fillStyle = rgb(t.color); ctx.fillText(formatValue(val, unit), bx + 4, yo); yo += lh;
		}
	}

	function drawZoomSelection(ctx: CanvasRenderingContext2D, canvasW: number, canvasH: number) {
		if (!zoomStart || !zoomEnd || !zoomType) return;
		ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.setLineDash([4,4]);
		ctx.fillStyle = 'rgba(255,255,255,0.1)';

		if (zoomType === 'x') {
			// Horizontal zoom - full height band
			const x = Math.min(zoomStart.x, zoomEnd.x);
			const w = Math.abs(zoomEnd.x - zoomStart.x);
			ctx.fillRect(x, 0, w, canvasH);
			ctx.strokeRect(x, 0, w, canvasH);
		} else if (zoomType === 'y') {
			// Vertical zoom - full width band
			const y = Math.min(zoomStart.y, zoomEnd.y);
			const h = Math.abs(zoomEnd.y - zoomStart.y);
			ctx.fillRect(0, y, canvasW, h);
			ctx.strokeRect(0, y, canvasW, h);
		} else {
			// Rectangle zoom
			const x = Math.min(zoomStart.x, zoomEnd.x), y = Math.min(zoomStart.y, zoomEnd.y);
			const w = Math.abs(zoomEnd.x - zoomStart.x), h = Math.abs(zoomEnd.y - zoomStart.y);
			ctx.strokeRect(x, y, w, h);
			ctx.fillRect(x, y, w, h);
		}
		ctx.setLineDash([]);
	}

	function handleMouseDown(e: MouseEvent) {
		const d = getDpr();
		dragStart = { x: e.offsetX * d, y: e.offsetY * d };

		if (e.button === 0) {
			// Left click: zoom mode (Plotly-style)
			isDragging = true;
			dragMode = 'zoom';
			zoomStart = zoomEnd = { x: e.offsetX * d, y: e.offsetY * d };
			zoomType = null;
		} else if (e.button === 1) {
			// Middle click: pan
			isDragging = true;
			dragMode = 'pan';
		}
	}

	function handleMouseMove(e: MouseEvent) {
		const d = getDpr(), w = canvas.clientWidth, h = canvas.clientHeight;
		const xRange = bounds.xMax - bounds.xMin, yRange = bounds.yMax - bounds.yMin;
		mousePos = { x: e.offsetX, y: e.offsetY, dataX: bounds.xMin + (e.offsetX / w) * xRange, dataY: bounds.yMax - (e.offsetY / h) * yRange };
		showTooltip = true;

		if (!isDragging || !dragMode) { render(); return; }

		if (dragMode === 'zoom') {
			zoomEnd = { x: e.offsetX * d, y: e.offsetY * d };

			// Determine zoom type based on drag direction (Plotly-style)
			if (zoomStart) {
				const dx = Math.abs(zoomEnd.x - zoomStart.x);
				const dy = Math.abs(zoomEnd.y - zoomStart.y);
				const minDrag = 10; // Minimum pixels to start zoom

				if (dx < minDrag && dy < minDrag) {
					zoomType = null; // Not enough movement yet
				} else {
					const ratio = dx / (dy + 0.001); // Avoid division by zero
					if (ratio > 3) {
						zoomType = 'x'; // Mostly horizontal
					} else if (ratio < 0.33) {
						zoomType = 'y'; // Mostly vertical
					} else {
						zoomType = 'rect'; // Diagonal
					}
				}
			}
		} else if (dragMode === 'pan') {
			const dx = e.offsetX * d - dragStart.x, dy = e.offsetY * d - dragStart.y;
			bounds = { xMin: bounds.xMin - (dx / (w * d)) * xRange, xMax: bounds.xMax - (dx / (w * d)) * xRange,
				yMin: bounds.yMin + (dy / (h * d)) * yRange, yMax: bounds.yMax + (dy / (h * d)) * yRange };
			dragStart = { x: e.offsetX * d, y: e.offsetY * d };
		}
		render();
	}

	function handleMouseUp() {
		if (dragMode === 'zoom' && zoomStart && zoomEnd && zoomType) {
			const w = canvas.width, h = canvas.height;
			const xRange = bounds.xMax - bounds.xMin, yRange = bounds.yMax - bounds.yMin;
			const x1 = Math.min(zoomStart.x, zoomEnd.x), x2 = Math.max(zoomStart.x, zoomEnd.x);
			const y1 = Math.min(zoomStart.y, zoomEnd.y), y2 = Math.max(zoomStart.y, zoomEnd.y);

			if (zoomType === 'x' && x2 - x1 > 10) {
				// X-only zoom
				bounds = { ...bounds,
					xMin: bounds.xMin + (x1/w)*xRange,
					xMax: bounds.xMin + (x2/w)*xRange };
			} else if (zoomType === 'y' && y2 - y1 > 10) {
				// Y-only zoom
				bounds = { ...bounds,
					yMin: bounds.yMax - (y2/h)*yRange,
					yMax: bounds.yMax - (y1/h)*yRange };
			} else if (zoomType === 'rect' && x2 - x1 > 10 && y2 - y1 > 10) {
				// Rectangle zoom
				bounds = { xMin: bounds.xMin + (x1/w)*xRange, xMax: bounds.xMin + (x2/w)*xRange,
					yMin: bounds.yMax - (y2/h)*yRange, yMax: bounds.yMax - (y1/h)*yRange };
			}
			render();
		}
		zoomStart = zoomEnd = null;
		zoomType = null;
		isDragging = false;
		dragMode = null;
	}

	function handleMouseLeave() { showTooltip = false; handleMouseUp(); }

	function handleWheel(e: WheelEvent) {
		e.preventDefault();

		// Normalize deltaY across browsers - positive = zoom out, negative = zoom in
		const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		const zoomIn = delta < 0;
		const zoomFactor = zoomIn ? 0.9 : 1.1; // < 1 = zoom in (smaller range), > 1 = zoom out

		const rect = canvas.getBoundingClientRect();
		const mouseX = (e.clientX - rect.left) / rect.width;
		const mouseY = 1 - (e.clientY - rect.top) / rect.height;

		const xRange = bounds.xMax - bounds.xMin;
		const yRange = bounds.yMax - bounds.yMin;
		const xPos = bounds.xMin + mouseX * xRange;
		const yPos = bounds.yMin + mouseY * yRange;

		if (e.shiftKey) {
			// Zoom Y only - apply zoom factor to Y range only
			const newYRange = yRange * zoomFactor;
			const newYMin = yPos - mouseY * newYRange;
			const newYMax = yPos + (1 - mouseY) * newYRange;
			bounds = {
				...bounds,
				yMin: newYMin,
				yMax: newYMax
			};
		} else if (e.ctrlKey || e.metaKey) {
			// Zoom X only
			const newXRange = xRange * zoomFactor;
			bounds = {
				...bounds,
				xMin: xPos - mouseX * newXRange,
				xMax: xPos + (1 - mouseX) * newXRange
			};
		} else {
			// Zoom both
			const newXRange = xRange * zoomFactor;
			const newYRange = yRange * zoomFactor;
			bounds = {
				xMin: xPos - mouseX * newXRange,
				xMax: xPos + (1 - mouseX) * newXRange,
				yMin: yPos - mouseY * newYRange,
				yMax: yPos + (1 - mouseY) * newYRange
			};
		}

		render();
	}

	function handleDoubleClick() {
		autoscale();
		render();
	}

	function handleKeyDown(e: KeyboardEvent) {
		const xRange = bounds.xMax - bounds.xMin, yRange = bounds.yMax - bounds.yMin;
		const xc = (bounds.xMin + bounds.xMax) / 2, yc = (bounds.yMin + bounds.yMax) / 2;
		const zf = 0.8, pan = 0.1;

		if (e.key === 'a' || e.key === 'A') { cursors[0].x = bounds.xMin + xRange * 0.25; cursors[0].visible = !cursors[0].visible; render(); }
		else if (e.key === 'b' || e.key === 'B') { cursors[1].x = bounds.xMin + xRange * 0.75; cursors[1].visible = !cursors[1].visible; render(); }
		else if (e.key === 'f' || e.key === 'F') { autoscale(); render(); }
		else if (e.key === 'g' || e.key === 'G') { showGrid = !showGrid; render(); }
		else if (e.key === 'z' || e.key === 'Z') { zoomStart = zoomEnd = null; zoomType = null; }
		else if (e.key === '+' || e.key === '=') {
			e.preventDefault();
			bounds = { xMin: xc - xRange*zf/2, xMax: xc + xRange*zf/2, yMin: yc - yRange*zf/2, yMax: yc + yRange*zf/2 };
			render();
		} else if (e.key === '-' || e.key === '_') {
			e.preventDefault();
			bounds = { xMin: xc - xRange/zf/2, xMax: xc + xRange/zf/2, yMin: yc - yRange/zf/2, yMax: yc + yRange/zf/2 };
			render();
		} else if (e.key === 'ArrowLeft') { e.preventDefault(); bounds = { ...bounds, xMin: bounds.xMin - xRange*pan, xMax: bounds.xMax - xRange*pan }; render(); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); bounds = { ...bounds, xMin: bounds.xMin + xRange*pan, xMax: bounds.xMax + xRange*pan }; render(); }
		else if (e.key === 'ArrowUp') { e.preventDefault(); bounds = { ...bounds, yMin: bounds.yMin + yRange*pan, yMax: bounds.yMax + yRange*pan }; render(); }
		else if (e.key === 'ArrowDown') { e.preventDefault(); bounds = { ...bounds, yMin: bounds.yMin - yRange*pan, yMax: bounds.yMax - yRange*pan }; render(); }
		else if (e.key === 'Escape') { zoomStart = zoomEnd = null; zoomType = null; isDragging = false; dragMode = null; render(); }
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="waveform-container" class:zooming={zoomType !== null} bind:this={container}>
	<canvas bind:this={axisCanvas} class="axis-canvas"></canvas>
	<div
		class="plot"
		style="left: {MARGIN.left}px; top: {MARGIN.top}px; right: {MARGIN.right}px; bottom: {MARGIN.bottom}px"
		onmousedown={handleMouseDown}
		onmousemove={handleMouseMove}
		onmouseup={handleMouseUp}
		onmouseleave={handleMouseLeave}
		onwheel={handleWheel}
		ondblclick={handleDoubleClick}
		onkeydown={handleKeyDown}
		tabindex="0"
		role="application"
		aria-label="Waveform viewer - use mouse to pan/zoom, A/B keys for cursors"
	>
		<canvas bind:this={gridCanvas} class="grid-canvas"></canvas>
		<canvas bind:this={canvas} class="waveform-canvas"></canvas>
		<canvas bind:this={overlayCanvas} class="overlay-canvas"></canvas>
	</div>
	<div class="legend" style="top: {MARGIN.top + 6}px; right: {MARGIN.right + 6}px">
		{#each traces as trace}
			<button
				class="legend-item"
				class:hidden={!trace.visible}
				style="color: rgb({trace.color.r * 255}, {trace.color.g * 255}, {trace.color.b * 255}); opacity: {trace.visible ? 1 : 0.4}"
				onclick={() => ontracetoggle?.(trace.id)}
				title="Click to {trace.visible ? 'hide' : 'show'} trace"
			>
				<span class="legend-color"></span>
				{trace.name}
			</button>
		{/each}
	</div>

	{#if showTooltip && !zoomType && traces.length > 0}
		<div class="tooltip" style="left: {mousePos.x + MARGIN.left + 15}px; top: {Math.max(4, mousePos.y + MARGIN.top - 20)}px;">
			<div class="tooltip-header">{formatXValue(mousePos.dataX)}</div>
			{#each traces as trace}
				{#if trace.visible}
					{@const values = getTraceValuesAtX(mousePos.dataX)}
					{@const val = values.get(trace.name)}
					{#if val !== undefined}
						{@const unit = getTraceUnit(trace.name)}
						<div class="tooltip-row" style="color: rgb({trace.color.r * 255}, {trace.color.g * 255}, {trace.color.b * 255})">
							{trace.name}: {formatValue(val, unit)}
						</div>
					{/if}
				{/if}
			{/each}
		</div>
	{/if}

	{#if zoomType}
		<div class="zoom-mode-indicator">
			{#if zoomType === 'x'}X ZOOM{:else if zoomType === 'y'}Y ZOOM{:else}BOX ZOOM{/if}
		</div>
	{/if}
</div>

<style>
	.waveform-container {
		position: relative;
		width: 100%;
		height: 100%;
		background: #111111;
		overflow: hidden;
	}

	.waveform-container.zooming {
		cursor: crosshair;
	}

	.axis-canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.plot {
		position: absolute;
		cursor: crosshair;
		outline: none;
	}

	/* pointer events land on .plot, so offsetX is measured from the plot's edge */
	.grid-canvas,
	.waveform-canvas,
	.overlay-canvas {
		position: absolute;
		top: 0;
		left: 0;
		width: 100%;
		height: 100%;
		pointer-events: none;
	}

	.legend {
		position: absolute;
		background: rgba(0, 0, 0, 0.72);
		padding: 3px 6px;
		font-size: 12px;
		font-family: monospace;
		max-height: 70%;
		overflow-y: auto;
		pointer-events: auto;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.legend-item {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		background: transparent;
		border: none;
		font-family: monospace;
		font-size: 12px;
		cursor: pointer;
		text-align: left;
		transition: background 0.1s;
	}

	.legend-item:hover {
		background: rgba(255, 255, 255, 0.1);
	}

	.legend-item.hidden {
		text-decoration: line-through;
	}

	.legend-color {
		width: 12px;
		height: 2px;
		background: currentColor;
	}

	.tooltip {
		position: absolute;
		background: rgba(0, 0, 0, 0.9);
		border: 1px solid #444;
		padding: 6px 10px;
		font-family: monospace;
		font-size: 11px;
		pointer-events: none;
		z-index: 100;
		max-width: 200px;
		white-space: nowrap;
	}

	.tooltip-header {
		color: #aaa;
		margin-bottom: 4px;
		padding-bottom: 4px;
		border-bottom: 1px solid #333;
	}

	.tooltip-row {
		padding: 1px 0;
	}

	.zoom-mode-indicator {
		position: absolute;
		top: 8px;
		left: 50%;
		transform: translateX(-50%);
		background: rgba(255, 200, 0, 0.9);
		color: #000;
		padding: 4px 12px;
		font-family: monospace;
		font-size: 11px;
		font-weight: bold;
		pointer-events: none;
	}
</style>

