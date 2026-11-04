/**
 * Component renderer - draws components on canvas
 */

import type { Component, Rotation } from './types';
import { defFor } from './component-defs';

/** Colors for rendering */
const COLORS = {
	component: '#00ff00',      // Green for components (LTSpice style)
	componentSelected: '#ffff00',  // Yellow when selected
	pin: '#ff0000',            // Red for pins
	label: '#ffffff',          // White for labels
	value: '#00ffff',          // Cyan for values
	box: '#7fb4ff',            // Generic device boxes
	boxFill: 'rgba(60, 110, 190, 0.16)',
	pinName: '#b8cfee',
	flag: '#ffb347',           // Net labels
};

/** Font size in schematic units: follows the zoom, but stays readable when zoomed far out */
export function labelFontSize(scale: number, dpr: number = (typeof window !== 'undefined' && window.devicePixelRatio) || 1): number {
	return Math.min(24, Math.max(12, (9.5 * dpr) / scale));
}

/** So far out that values and net names would only cover the drawing: names only */
export function farOut(scale: number, dpr: number = (typeof window !== 'undefined' && window.devicePixelRatio) || 1): boolean {
	return scale / dpr < 0.33;
}

/** A long value (a source with three waveforms) must not run over its neighbours */
export function shortenValue(value: string, max: number = 22): string {
	return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function transformPoint(comp: Component, x: number, y: number): { x: number; y: number } {
	const px = comp.mirror ? -x : x;
	const rad = (comp.rotation * Math.PI) / 180;
	const c = Math.round(Math.cos(rad));
	const s = Math.round(Math.sin(rad));
	return { x: px * c - y * s, y: px * s + y * c };
}

function renderGeneric(ctx: CanvasRenderingContext2D, comp: Component, scale: number, isSelected: boolean, isGhost: boolean): void {
	const w = comp.box?.w ?? 80;
	const h = comp.box?.h ?? 40;
	const font = labelFontSize(scale);
	ctx.save();
	ctx.translate(comp.x, comp.y);
	const corner = transformPoint(comp, w / 2, h / 2);
	const rw = Math.abs(corner.x);
	const rh = Math.abs(corner.y);
	ctx.fillStyle = COLORS.boxFill;
	ctx.fillRect(-rw, -rh, 2 * rw, 2 * rh);
	ctx.strokeStyle = isSelected ? COLORS.componentSelected : COLORS.box;
	ctx.lineWidth = 2 / scale;
	ctx.strokeRect(-rw, -rh, 2 * rw, 2 * rh);

	for (const pin of comp.pins) {
		const p = transformPoint(comp, pin.x, pin.y);
		ctx.fillStyle = isGhost ? `${COLORS.pin}80` : COLORS.pin;
		ctx.beginPath();
		ctx.arc(p.x, p.y, 2.2 / Math.max(scale, 0.6), 0, Math.PI * 2);
		ctx.fill();
	}
	if (!isGhost) {
		// Zoomed far out the text stops fitting: the name stays, the small print goes
		const roomy = font <= 15;
		ctx.textBaseline = 'middle';
		if (roomy) {
			// Pin names just inside the edge the pin leaves from
			ctx.font = `${font * 0.86}px monospace`;
			ctx.fillStyle = COLORS.pinName;
			for (const pin of comp.pins) {
				const p = transformPoint(comp, pin.x, pin.y);
				const dx = Math.abs(Math.abs(p.x) - rw) < 0.5 ? Math.sign(p.x) : 0;
				const dy = dx === 0 ? Math.sign(p.y) : 0;
				ctx.textAlign = dx > 0 ? 'right' : dx < 0 ? 'left' : 'center';
				ctx.fillText(pin.name, p.x - dx * 5, p.y - dy * (font * 0.7));
			}
		}
		// Name in the middle, model under it
		const title = font <= 18 ? comp.box?.title ?? '' : '';
		ctx.textAlign = 'center';
		ctx.font = `bold ${font}px monospace`;
		ctx.fillStyle = COLORS.label;
		ctx.fillText(comp.attributes['InstName'] || '', 0, title ? -font * 0.58 : 0);
		if (title) {
			ctx.font = `${font * 0.92}px monospace`;
			ctx.fillStyle = COLORS.value;
			ctx.fillText(title, 0, font * 0.58);
		}
	}
	ctx.restore();
}

function renderNetFlag(ctx: CanvasRenderingContext2D, comp: Component, scale: number, isSelected: boolean, isGhost: boolean): void {
	if (farOut(scale) && !isGhost) {
		ctx.fillStyle = COLORS.flag;
		ctx.fillRect(comp.x - 6, comp.y - 6, 12, 12);
		return;
	}
	const name = comp.attributes['Value'] || 'NET';
	const dir = comp.attributes['Dir'] || 'right';
	const font = labelFontSize(scale);
	ctx.save();
	ctx.translate(comp.x, comp.y);
	ctx.font = `bold ${font}px monospace`;
	const tw = ctx.measureText(name).width;
	const bh = font + 4;
	const bw = tw + 8;
	const gap = 4;
	let bx: number, by: number;
	if (dir === 'left') { bx = -gap - bw; by = -bh / 2; }
	else if (dir === 'up') { bx = -bw / 2; by = -gap - bh; }
	else if (dir === 'down') { bx = -bw / 2; by = gap; }
	else { bx = gap; by = -bh / 2; }
	const color = isSelected ? COLORS.componentSelected : COLORS.flag;
	ctx.strokeStyle = isGhost ? `${color}80` : color;
	ctx.lineWidth = 1.5 / scale;
	ctx.fillStyle = 'rgba(40, 28, 8, 0.85)';
	ctx.fillRect(bx, by, bw, bh);
	ctx.strokeRect(bx, by, bw, bh);
	ctx.fillStyle = isGhost ? `${color}80` : color;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillText(name, bx + bw / 2, by + bh / 2 + 0.5);
	ctx.fillStyle = isGhost ? `${COLORS.pin}80` : COLORS.pin;
	ctx.beginPath();
	ctx.arc(0, 0, 3 / scale, 0, Math.PI * 2);
	ctx.fill();
	ctx.restore();
}

/**
 * Render a component on the canvas
 */
export function renderComponent(
	ctx: CanvasRenderingContext2D,
	comp: Component,
	scale: number,
	isSelected: boolean = false,
	isGhost: boolean = false  // For placement preview
): void {
	if (comp.type === 'generic') return renderGeneric(ctx, comp, scale, isSelected, isGhost);
	if (comp.type === 'netflag') return renderNetFlag(ctx, comp, scale, isSelected, isGhost);
	const def = defFor(comp);
	if (!def) return;

	ctx.save();
	
	// Move to component position
	ctx.translate(comp.x, comp.y);
	
	// Apply rotation
	ctx.rotate((comp.rotation * Math.PI) / 180);
	
	// Apply mirror
	if (comp.mirror) {
		ctx.scale(-1, 1);
	}

	// Set styles
	const color = isSelected ? COLORS.componentSelected : COLORS.component;
	ctx.strokeStyle = isGhost ? `${color}80` : color;
	ctx.fillStyle = isGhost ? `${color}80` : color;
	ctx.lineWidth = 2 / scale;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';

	// Draw all paths
	for (const path of def.paths) {
		ctx.beginPath();
		for (const cmd of path) {
			drawCommand(ctx, cmd);
		}
		ctx.stroke();
	}

	// Draw pins (small circles)
	ctx.fillStyle = isGhost ? `${COLORS.pin}80` : COLORS.pin;
	for (const pin of def.pins) {
		ctx.beginPath();
		ctx.arc(pin.x, pin.y, 2.2 / Math.max(scale, 0.6), 0, Math.PI * 2);
		ctx.fill();
	}

	// Draw labels (only if not ghost)
	if (!isGhost) {
		const fontSize = labelFontSize(scale);
		ctx.font = `${fontSize}px monospace`;
		ctx.textBaseline = 'middle';

		// Counter-rotate labels to keep them readable
		// First undo mirror, then undo rotation
		ctx.save();
		if (comp.mirror) {
			ctx.scale(-1, 1);
		}
		ctx.rotate((-comp.rotation * Math.PI) / 180);

		const instName = comp.attributes['InstName'] || '';
		const value = farOut(scale) ? '' : shortenValue(comp.attributes['Value'] || '');

		if (comp.rotation === 90 || comp.rotation === 270) {
			// A part lying on its side: name above it, value under it
			const off = def.width / 2 + fontSize * 0.75;
			ctx.textAlign = 'center';
			if (instName) {
				ctx.fillStyle = COLORS.label;
				ctx.fillText(instName, 0, -off);
			}
			if (value) {
				ctx.fillStyle = COLORS.value;
				ctx.fillText(value, 0, off);
			}
		} else {
			// upside down or not, the text stays beside the part
			const flip = comp.mirror ? -1 : 1;
			const at = (o: { x: number; y: number }) => ({ x: flip * o.x, y: o.y });
			const lp = at(def.labelOffset);
			const vp = at(def.valueOffset);
			ctx.textAlign = comp.mirror ? 'end' : 'start';
			if (instName) {
				ctx.fillStyle = COLORS.label;
				ctx.fillText(instName, lp.x, lp.y);
			}
			if (value) {
				ctx.fillStyle = COLORS.value;
				ctx.fillText(value, vp.x, vp.y);
			}
		}

		ctx.restore();
	}

	ctx.restore();
}

/**
 * Execute a single draw command
 */
function drawCommand(
	ctx: CanvasRenderingContext2D,
	cmd: Record<string, unknown>
): void {
	switch (cmd.type) {
		case 'M':
			ctx.moveTo(cmd.x as number, cmd.y as number);
			break;
		case 'L':
			ctx.lineTo(cmd.x as number, cmd.y as number);
			break;
		case 'A': {
			ctx.arc(
				cmd.cx as number,
				cmd.cy as number,
				cmd.r as number,
				((cmd.start as number) * Math.PI) / 180,
				((cmd.end as number) * Math.PI) / 180
			);
			break;
		}
		case 'C': {
			// Circle - draw as separate path
			const x = cmd.x as number;
			const y = cmd.y as number;
			const r = cmd.r as number;
			ctx.moveTo(x + r, y);
			ctx.arc(x, y, r, 0, Math.PI * 2);
			break;
		}
		case 'R': {
			ctx.rect(
				cmd.x as number,
				cmd.y as number,
				cmd.w as number,
				cmd.h as number
			);
			break;
		}
		case 'T': {
			// Text is handled separately
			break;
		}
	}
}

/**
 * Check if a point is inside a component's bounding box
 */
export function hitTestComponent(
	comp: Component,
	px: number,
	py: number,
	tolerance: number = 5
): boolean {
	const def = defFor(comp);
	if (!def) return false;

	// Transform point to component local coordinates
	let lx = px - comp.x;
	let ly = py - comp.y;

	// Reverse rotation
	const rad = (-comp.rotation * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const rx = lx * cos - ly * sin;
	const ry = lx * sin + ly * cos;

	// Reverse mirror
	const fx = comp.mirror ? -rx : rx;

	// Check bounding box
	const hw = def.width / 2 + tolerance;
	const hh = def.height / 2 + tolerance;
	return Math.abs(fx) <= hw && Math.abs(ry) <= hh;
}

/**
 * Get the next rotation value
 */
export function nextRotation(current: Rotation): Rotation {
	const rotations: Rotation[] = [0, 90, 180, 270];
	const idx = rotations.indexOf(current);
	return rotations[(idx + 1) % 4];
}

