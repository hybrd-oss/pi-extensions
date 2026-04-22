// Utility helpers for DCG testing
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function range(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}
