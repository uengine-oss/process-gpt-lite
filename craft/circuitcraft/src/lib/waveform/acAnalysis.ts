/**
 * AC results: complex vectors to magnitude (dB) and phase (degrees) for a Bode plot
 */

const FLOOR_DB = -400;

export function magnitudeDb(re: ArrayLike<number>, im: ArrayLike<number>): Float64Array {
	const out = new Float64Array(re.length);
	for (let i = 0; i < re.length; i++) {
		const m = Math.hypot(re[i], im[i]);
		out[i] = m < 1e-20 ? FLOOR_DB : 20 * Math.log10(m);
	}
	return out;
}

/** Phase in degrees, unwrapped so a filter's roll-off is a line, not a sawtooth */
export function phaseDeg(re: ArrayLike<number>, im: ArrayLike<number>): Float64Array {
	const out = new Float64Array(re.length);
	let offset = 0;
	let last = 0;
	for (let i = 0; i < re.length; i++) {
		const p = (Math.atan2(im[i], re[i]) * 180) / Math.PI;
		if (i > 0) {
			if (p - last > 180) offset -= 360;
			else if (p - last < -180) offset += 360;
		}
		last = p;
		out[i] = p + offset;
	}
	return out;
}
