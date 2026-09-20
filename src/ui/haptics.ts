export function vibrate(pattern: number | number[] = 15): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    /* iOS may throw / no-op */
  }
}
