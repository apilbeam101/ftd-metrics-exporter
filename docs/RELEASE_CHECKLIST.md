# Release checklist

Manual maintainer steps that are deliberately not CI jobs — live verification
holds real credentials and must never run in CI. Stage 14 (release-process
tooling) expands this file; this is a stub created in Stage 13A to track its
first item.

## Before 1.0

- [ ] **Register port 10049** on the Prometheus project's
      [default port allocations](https://github.com/prometheus/prometheus/wiki/Default-port-allocations)
      wiki page. Rationale: the originally planned `9812` was already taken
      by the FreeRADIUS exporter, and the `9100`-`9999` range is exhausted,
      so `10049` was the first free slot at audit time (2026-08-04).
      Registering it prevents the same collision for the next exporter
      author.
- [ ] **Third-party SCC validation** — recruit at least one external SCC
      deployment; capture the outcome here.

## First publish only (GHCR/npm registry setup)

- [ ] Staged-file audit before the first `git` push: confirm `.env`,
      `.scratch/`, `data/`, `node_modules/`, `dist/` have zero entries in
      `git status --porcelain`, then run `gitleaks` locally against the
      staged tree — confirm it reports clean with `.gitleaks.toml`'s
      allowlist active (two committed test fixtures are deliberately
      credential-shaped and are allowlisted by exact string, not by file —
      see the comment in `.gitleaks.toml`). Enable GitHub secret-scanning
      push protection before pushing. This step only matters once — after
      the first push, a leaked credential must be rotated, not deleted.
- [ ] Trigger `scan.yml` once via `workflow_dispatch` after the first image
      publish and confirm a tracking issue is actually created on a
      high/critical finding (or confirm none exist) — `gh issue create
      --label base-image-cve` requires that label to already exist in the
      repo; create it first (`gh label create base-image-cve --description
      "Base image CVE tracking" --color b60205`) or the scan job's
      reporting step fails silently on every run.
- [ ] Confirm the `dco` CI job actually blocks a PR with an unsigned commit
      once the repo is on GitHub (push a throwaway branch/PR with one
      unsigned commit against a fork or a test repo first, if possible) —
      this check has only been verified against local git logic, never a
      real `pull_request` event's `base.sha`/`head.sha`.
- [ ] After the first image publish, set the GHCR package visibility to
      **public** (it defaults to private) and confirm an anonymous
      `docker pull` from a logged-out client.

## Every release

- [ ] **Bump `package.json`'s `version`** to match the tag you're about to
      push, and commit it. `release.yml`'s `verify` job fails the whole
      release if the pushed tag (`vX.Y.Z`) doesn't match `package.json`'s
      version — this is deliberate (a mismatch would otherwise move
      `:latest`/GHCR tags to an image reporting a stale
      `ftd_exporter_build_info{version=}` before the npm publish step fails
      or publishes something unintended).
- [ ] **Promote `CHANGELOG.md`'s `## [Unreleased]` section to `## [X.Y.Z]`**
      (with today's date) before tagging. `release.yml`'s `release` job
      extracts the section matching the pushed tag's version and fails if
      none exists — this is what makes the promotion a hard gate rather
      than a habit to remember.
- [ ] Live verification against a real SCC tenant and/or on-prem FMC —
      follow [docs/LIVE_SMOKE_TEST.md](LIVE_SMOKE_TEST.md) and record
      results here (backend × surface × pass/fail × date).
- [ ] `npm pack` output inspected by eye once before publishing (automated as
      a CI tripwire in `release.yml`, but the tripwire itself is worth a
      periodic manual sanity check) — no `.env`, no `data/`, no `.scratch/`,
      no fixtures with real data.
- [ ] After the release workflow completes: pull the published image
      anonymously and run `gh attestation verify
      oci://ghcr.io/apilbeam101/ftd-metrics-exporter:<tag> -R
      apilbeam101/ftd-metrics-exporter` — confirms provenance actually
      resolves for a real consumer, not just that the workflow step reported
      success.
- [ ] Confirm the Docker Hub mirror published the same tag (best-effort;
      mirror failures are non-fatal to the release, so this is the check
      that catches a silently-failed mirror).

## Quarterly

- [ ] Confirm `rebuild.yml` and `scan.yml` have not been auto-disabled by
      GitHub's 60-day scheduled-workflow inactivity rule — check the Actions
      tab for each workflow's last run. At a monthly cadence, two
      consecutively missed runs is enough to hit that window.

## Post-1.0

- [ ] Evaluate the SemVer → CalVer (`YYYY.MM`) versioning transition
      described in the container-registry implementation plan. Three
      prerequisites must be settled first: (1) the exact CalVer form
      (`YYYY.M.PATCH`, no leading zero — `2026.09.0` is not valid SemVer);
      (2) a documented deprecation policy plus a CHANGELOG `Breaking`
      section to replace the breaking-change signal SemVer's major version
      currently carries; (3) re-specifying the moving image
      tags (`YYYY.M` / `YYYY` / `latest`) with guidance against pinning the
      bare year. Not a 1.0 blocker — do this only once 1.0 has shipped and
      been verified.

### Results log

| Date | Backend | Surface | Result | Notes |
|---|---|---|---|---|
| 2026-08-07 | SCC | Standalone | Pass | ~10 min, 11 poll cycles, real device (identifier withheld). One `429` mid-run, correctly retried and classified as `ftd_exporter_rate_limit_deferrals_total` (not a poll error) — expected behavior at the 60s interval against SCC's 2/min budget, not a bug. `ftd_exporter_up` stayed 1 throughout; `/healthz`/`/readyz` 200. |
| 2026-08-07 | SCC | Docker | Pass | ~9 min, 9 clean poll cycles, no rate-limit hits. Verified running as non-root UID 10001 with `--read-only --cap-drop=ALL`. `/healthz`/`/readyz` 200. |
| 2026-08-07 | SCC | Kubernetes | Pass | microk8s, ~7 min, 7 clean poll cycles via a real (session-only, never committed) Secret/ConfigMap. `/healthz`/`/readyz` 200 via port-forward. |
| 2026-08-07 | FMC | Standalone | Pass | ~12 min, 12 poll cycles against a real lab FMC (4 devices discovered, 1 fully connected/reporting). One `outcome:"failure",reason:"parse"` cycle recovered automatically via the poll-level backoff on the next cycle — `ftd_exporter_up` dipped to 0 for ~2 min then returned to 1; not a bug, this is the escalating-backoff design working as intended. `/healthz`/`/readyz` 200 throughout. Real device metrics present (`ftd_cpu_usage_ratio`, `ftd_interface_*`, etc.). Also captured a sanitized `--dump-raw` snapshot (gitignored) showing the other 3 discovered devices return `400 Device not connected.` / `500 There is no session with id [...]` on most families; this is expected lab topology (only 1 of 4 devices is actually connected), not an exporter defect, but the *type* of upstream error is new evidence worth folding into design review. |

FMC Docker/Kubernetes surfaces were **not run this session** — the on-prem
FMC lab and the Docker/Kubernetes host used for those legs sit behind
mutually exclusive network routes, so both cannot be reached in the same
session. Options for a future session: run Docker/K8s from a host with a
route to both networks, or seed a local mock FMC server with a real
`--dump-raw` capture (same approach already used for Stages 13B/13C, which
had no live FMC credential available at all) — see
[docs/LIVE_SMOKE_TEST.md](LIVE_SMOKE_TEST.md).
