/**
 * In-test self-signed certificate generation (IMPLEMENTATION_PLAN.md Stage
 * 6 dependency note: "Prefer in-test generation; a committed private key
 * in a security-focused repo is a bad look even when harmless, and it
 * will trip secret scanning"). Uses `selfsigned` (devDependency only —
 * runtime dependency count stays at two, per DESIGN.md §2.7) rather than
 * shelling out to `openssl`, since the CI matrix includes `windows-latest`
 * and a bundled `openssl` binary is not guaranteed there.
 */
import selfsigned from 'selfsigned';

export interface TlsFixture {
  cert: string;
  key: string;
}

export async function generateTlsFixture(commonName: string, sanIp?: string): Promise<TlsFixture> {
  const attrs = [{ name: 'commonName', value: commonName }];
  const altNames = sanIp
    ? [{ type: 7 as const, ip: sanIp }]
    : [{ type: 2 as const, value: commonName }];
  const pems = await selfsigned.generate(attrs, {
    notAfterDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    keySize: 2048,
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  return { cert: pems.cert, key: pems.private };
}
