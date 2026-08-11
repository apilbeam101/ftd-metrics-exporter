# Contributing

Thanks for considering a contribution to ftd-metrics-exporter.

## Dev setup

- Node.js 24+ (`node --version`).
- `npm ci` — installs exact locked dependency versions. Never `npm install` for a first setup; the lockfile is the source of truth.
- Copy `example.env` to `.env` and fill in your own SCC or FMC credentials if you want to run the exporter against real infrastructure locally. Never commit `.env` — it's gitignored, and CI never holds live credentials.

## Running the checks

```
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit against src/ and test/ (two tsconfigs — see below)
npm run lint         # biome lint .
npm test            # unit + integration
npm run test:unit
npm run test:integration
npx biome check .        # lint + format check
npx biome check --fix .  # apply safe autofixes
```

Two `tsconfig`s exist on purpose: [tsconfig.json](tsconfig.json) builds `src/` only; [tsconfig.test.json](tsconfig.test.json) additionally typechecks `test/` and `scripts/`. `npm run typecheck` runs both — don't collapse them back into one config, an early review caught `test/` going silently unchecked without the split.

CI (`.github/workflows/ci.yml`) runs the same checks across `ubuntu-latest`/`macos-latest`/`windows-latest` and Node 24/current. A PR is expected to pass the fast Linux-only leg (typecheck, lint, unit) before the full matrix runs.

## Generated files

Three files are generated and must not be hand-edited. Each has a test or CI job that fails if the committed copy drifts from its generator:

```
node --experimental-strip-types scripts/generate-metrics-doc.ts   # -> docs/METRICS.md
node --experimental-strip-types scripts/generate-dashboard.ts     # -> dashboards/ftd-health.json
node --experimental-strip-types scripts/sanitize-fixtures.ts      # -> test/fixtures/ (from .scratch/ captures)
```

Edit the generator, regenerate, and commit both. For the dashboard specifically, the procedure for round-tripping a change you prototyped in the Grafana UI is in [docs/DASHBOARDS_AND_ALERTS.md](docs/DASHBOARDS_AND_ALERTS.md#round-tripping-a-change-made-in-the-grafana-ui) — don't paste a Grafana export in directly, it carries instance-specific `id`/`version` fields and will fail the byte-identical check.

If you change an alert rule in [alerts/ftd-health.yaml](alerts/ftd-health.yaml), update [alerts/ftd-health.test.yaml](alerts/ftd-health.test.yaml) alongside it and verify locally:

```
promtool check rules alerts/ftd-health.yaml
promtool test rules alerts/ftd-health.test.yaml
```

Both run in CI (job `alerts`). Every rule is expected to be tested in **both** directions — fires against a violating series, stays silent otherwise. A one-directional test passes just as well against a rule that fires unconditionally, which is the specific bug class that file exists to catch.

## Coding standards

- Pure functions (response mappers, the metrics renderer) validate their input as `unknown`, never trust the wire-schema type as already checked.
- Conditional metric groups (chassis, HA, RA VPN, S2S) stay optional at the type level and are omitted entirely when absent upstream — never emitted as zero.
- No comments unless the *why* is non-obvious (a hidden constraint, a workaround, a subtle invariant). No docstrings.
- No native addons, no `node-gyp`, no platform-conditional dependencies — this is what keeps the standalone build identical across Windows/macOS/Linux, and CI's no-native-addons check enforces it.
- Metric names, metric labels, and environment variable names are the versioned public API (not the TypeScript types) — think carefully about SemVer implications before renaming anything metric- or config-related.
- Run `npx biome format --write .` before committing; CI's lint step checks formatting too.

## Contributing sanitized fixtures (FMC schema unknowns)

The standalone on-prem FMC backend's response body field names for the chassis, HA, RA VPN, and S2S VPN metric groups are not documented anywhere by Cisco and remain experimental as a result. The most valuable contribution most people can make to this project, without writing any code, is a real captured response from hardware the maintainers don't have access to.

1. Run the exporter against your own FMC or SCC tenant with `--dump-raw`:

   ```
   node dist/index.js --dump-raw
   ```

   This performs one real poll cycle and writes the raw upstream JSON response bodies to **stdout only** (never a file — this project keeps no persistent state or disk cache), sanitized by default. Log output goes to stderr, so `node dist/index.js --dump-raw > capture.json` produces clean, parseable JSON.
2. **The output may still contain device names and topology detail** even after sanitization — `--dump-raw`'s sanitization pass redacts credential-shaped values and UUID/IPv4-shaped substrings, but does not attempt to recognize every possible sensitive field. Review `capture.json` yourself before sharing it, and redact anything you're not comfortable publishing (interface names, hostnames, tunnel names are common candidates).
3. Open a GitHub issue or PR attaching the sanitized capture, and say which metric family/families it covers (`CPU`, `MEM`, `DISK_STATS`, `INTERFACE`, `CHASSIS_STATS`) and whether the device has HA/RA VPN/S2S configured.
4. If you're comfortable writing the mapper/test change yourself: fixtures live under `test/fixtures/`, following the existing SCC/FMC directory split. `scripts/sanitize-fixtures.ts` is the maintainers' own offline tool for turning a raw `.scratch/` capture into a committed fixture — it's not run in CI and not something a PR needs to invoke, but it's a useful reference for the sanitization rules a fixture needs to satisfy (every UUID/IPv4-shaped substring replaced, real names swapped for the existing `*.lab.example`-style placeholders). `test/unit/fixture-sanitization.test.ts` is the actual CI guard: it asserts, for every committed fixture, that no unrecognized UUID/IPv4-shaped substring exists — the inverse check, not a denylist of known-real values.

## Commit conventions

No enforced format (no commitlint), but write commit messages that explain *why*, not just *what changed* — the diff already shows what changed.

## Sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/) instead of a separate CLA. Sign off every commit to certify you wrote it or otherwise have the right to submit it under the project's license:

```
git commit -s -m "your message"
```

This adds a `Signed-off-by: Your Name <your.email@example.com>` trailer. PRs with unsigned commits will be asked to amend before merge.

## What NOT to do

- **Never propose a CI job that holds live SCC/FMC credentials.** CI secrets in a public repository are a standing exfiltration target, particularly via PRs from forks. Live verification is a manual, documented maintainer step (see [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md)), not something CI does.
- Don't add a runtime dependency without discussing it first in an issue — two runtime dependencies (`prom-client`, `undici`) is a deliberate security control, not an oversight.
