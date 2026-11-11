// 예약 규칙 (FR3.2): 최소 15분, 최대 4시간
export const MIN_MINUTES = 15
export const MAX_MINUTES = 240
export function validSlot(start: Date, end: Date): boolean {
  const m = (end.getTime() - start.getTime()) / 60000
  return m >= MIN_MINUTES && m <= MAX_MINUTES
}
