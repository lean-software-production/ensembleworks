/** A short "how long ago" label: `12s ago`, `4m ago`, `3h ago`, `2d ago`. */
export function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
