const MINIMUM_MAJOR_VERSION = 24;

/**
 * Parses process.version rather than trusting engines.node, because a package
 * manager can be configured to ignore engine mismatches.
 */
export function parseMajorVersion(nodeVersion: string): number {
  const match = /^v(\d+)\./.exec(nodeVersion);
  if (!match?.[1]) {
    throw new Error(`Unable to parse Node.js version string: "${nodeVersion}"`);
  }
  return Number.parseInt(match[1], 10);
}

export function assertSupportedNodeVersion(nodeVersion: string): void {
  const major = parseMajorVersion(nodeVersion);
  if (major < MINIMUM_MAJOR_VERSION) {
    throw new Error(
      `ftd-metrics-exporter requires Node.js >= ${MINIMUM_MAJOR_VERSION}, but this process is running ${nodeVersion}. Install a supported Node.js version and try again.`,
    );
  }
}
