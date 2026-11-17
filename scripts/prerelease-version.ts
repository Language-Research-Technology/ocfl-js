export function nextPrereleaseVersion(base: string, tags: readonly string[]): string {
  const prefix = `v${base}-beta.`;
  const highest = tags
    .filter((tag) => tag.startsWith(prefix))
    .map((tag) => tag.slice(prefix.length))
    .filter((n) => /^\d+$/.test(n))
    .reduce((max, n) => Math.max(max, Number(n)), 0);
  return `${base}-beta.${highest + 1}`;
}
