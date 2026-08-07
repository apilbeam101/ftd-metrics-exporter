import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

interface PackageJson {
  version: string;
}

function readPackageVersion(): string {
  try {
    const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const contents = readFileSync(packageJsonPath, 'utf8');
    const parsed = JSON.parse(contents) as PackageJson;
    return parsed.version;
  } catch {
    // Informational only (surfaced via ftd_exporter_build_info); never fatal.
    return 'unknown';
  }
}

export const VERSION: string = readPackageVersion();
export const COMMIT: string = process.env.FTD_EXPORTER_COMMIT ?? 'unknown';
export const NODE_VERSION: string = process.version;
