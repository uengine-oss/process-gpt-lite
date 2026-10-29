// Ducking for live interpretation (pure; server/test/interp.test.js): while the interpreter speaks for
// someone, that person's own voice is lowered — not cut — so the listener still hears who is talking and
// how; when the interpretation ends their voice comes back up. A listener on "hear original" (or with the
// meeting's 통역 off) hears everyone at full volume and no interpreter.
export const DUCK = 0.2      // the speaker's own voice while their interpretation plays
export const HOLD_MS = 450   // stays low this long after the last interpreted sound (no pumping between frames)
export const STEP = 0.12     // how far the volume moves per tick (≈ 30 ms): a short fade, not a click

// state: {mode: 'interp'|'original', on: bool, until: {speakerId: ms the scheduled interpretation ends}}
export function target(speakerId, state, now) {
  if (!state || state.mode === 'original' || !state.on) return 1
  const u = state.until?.[speakerId] || 0
  return now < u + HOLD_MS ? DUCK : 1
}
// the interpreter's own level: heard only in interpretation mode with the meeting's switch on
export const interpGain = (state) => (state && state.mode !== 'original' && state.on ? 1 : 0)
// one tick of the fade toward the target
export function ramp(current, goal, step = STEP) {
  if (Math.abs(goal - current) <= step) return goal
  return current + Math.sign(goal - current) * step
}
// is someone's interpretation playing right now (the tile's "AI 통역" badge)
export const speaking = (speakerId, state, now) => !!state && interpGain(state) > 0 && now < (state.until?.[speakerId] || 0)
