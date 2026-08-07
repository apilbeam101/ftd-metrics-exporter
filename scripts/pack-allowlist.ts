/**
 * Pure logic for scripts/check-pack-allowlist.ts, split out so it can be
 * imported by a test with no side effects (the CLI script shells out to
 * `npm pack` at module-load time).
 */
export function isAllowed(filePath: string, filesAllowlist: string[]): boolean {
  // npm always includes package.json and a root LICENSE regardless of the
  // files array -- documented npm behavior, not a gap in this check.
  if (filePath === 'package.json' || /^LICENSE(\..+)?$/i.test(filePath)) {
    return true;
  }
  return filesAllowlist.some((entry) => {
    if (entry.endsWith('/')) {
      return filePath === entry.slice(0, -1) || filePath.startsWith(entry);
    }
    return filePath === entry;
  });
}

export function findDisallowed(files: string[], filesAllowlist: string[]): string[] {
  return files.filter((f) => !isAllowed(f, filesAllowlist));
}
