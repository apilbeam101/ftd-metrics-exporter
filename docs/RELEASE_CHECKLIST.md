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

## Stage 16 — live validation (soak tests)

Per `docs/IMPLEMENTATION_PLAN.md`'s Stage 16 scope — **not** the same as
`docs/LIVE_SMOKE_TEST.md`'s ~10-15 minute per-surface smoke test (see that
file's "Not the same as Stage 16" note). Sustained runs, ≥7 days, watching
for rate-limit behavior, memory growth, and stable series count over time
rather than a handful of poll cycles.

- [ ] **7-day SCC soak** (maintainer tenant). Pass criteria (Implementation
      Plan §16 testing step 1): zero `poll_errors_total{reason="rate_limited"}`,
      `cache_age_seconds` never exceeding ~2× the poll interval, flat heap.
      **In progress, started 2026-08-25.** Built from a clean clone of
      `origin/main` @ `1878bed` on the Ubuntu test VM, running via systemd
      (matching `deploy/systemd/`, not a terminal session), scraped by the
      VM's real microk8s Prometheus Operator with `alerts/ftd-health.yaml`
      loaded as a `PrometheusRule` and `dashboards/ftd-health.json` imported
      into the same Grafana used for Stage 15. First ~2 hours: `ftd_exporter_up`
      steady at 1, `cache_age_seconds` never exceeding ~90s against a 60s poll
      interval (well inside the 2× bound — the one over-budget cycle was the
      cold-start cycle refreshing the license/certificate/inventory caches for
      the first time simultaneously, not a rate-limit or design problem),
      `ftd_exporter_series` stable at 266, zero `poll_errors_total` of any
      reason, zero `ftd_exporter_license_errors_total`/`ftd_exporter_certificate_errors_total`,
      heap stable in the ~17-21MB range. This is also the first sustained run
      for the license/certificate metrics (added 2026-08-14, never previously
      soak-tested) and confirms the SCC HA-shared-`device_uid` behavior
      (§14.14) live on a real HA pair distinct from the one used to originally
      find it.
      **Soak clock restarted 2026-08-25 12:38 UTC**, ~3h50m into the original
      run: redeployed the VM from the packaged `v0.3.0` release (built via
      `npm pack` against the tag, transferred, `npm ci --omit=dev` on the VM;
      the live `.env` was left untouched) rather than the `1878bed` working
      clone, so the soak now runs the exact artifact that shipped —
      including this same release's five-panel dashboard fix (§14.15) and
      the fresh `node:26`/`node:26-slim` base layers pulled in by the
      `release.yml` image build. Immediately post-restart: `ftd_exporter_build_info{version="0.3.0"}`,
      `/healthz`=200, one expected cold-start-elongated poll cycle
      (119s, same simultaneous-cache-refresh cause as the original run's),
      then back to the ~1.8s baseline on the next two cycles, zero errors in
      the journal. The pre-restart ~4 hours above remain valid evidence for
      the license/certificate/HA findings; only the *duration* counter toward
      the 7-day pass criterion restarts. Will update with the full 7-day
      result.
- [ ] **7-day FMC soak** (lab, 4 FTDv). Not started this session — see
      `docs/LIVE_SMOKE_TEST.md`'s note on the FMC-lab/Docker-K8s-host mutually
      exclusive network routes; this leg needs the FMC lab route specifically,
      which was not available during this soak-test session (the Ubuntu VM
      route was used instead, for the SCC leg).
- [x] **Two dashboard panels CLAUDE.md flagged as unconfirmed** ("Interface
      inventory", "Exporter build info") checked in a genuine non-headless
      browser session per the plan — both reproduced as real, live bugs, not
      headless-capture artifacts. Root-caused and fixed; see
      [DESIGN.md §14.15](DESIGN.md#1415-four-dashboard-table-panels-silently-broken-by-a-grafana-transform-that-doesnt-do-what-its-name-suggests)
      for the full writeup. Two more panels ("Per-device summary", "Current HA
      role") turned out to share the same root cause and got the same fix; a
      fifth ("S2S tunnels not up") was caught only by adversarial review, not
      live reproduction. All five re-verified live against the real
      Grafana/Prometheus this soak test is running against.

## First publish only (GHCR/npm registry setup)

- [x] Staged-file audit before the first `git` push: confirm `.env`,
      `.scratch/`, `data/`, `node_modules/`, `dist/` have zero entries in
      `git status --porcelain`, then run `gitleaks` locally against the
      staged tree — confirm it reports clean with `.gitleaks.toml`'s
      allowlist active (two committed test fixtures are deliberately
      credential-shaped and are allowlisted by exact string, not by file —
      see the comment in `.gitleaks.toml`). Enable GitHub secret-scanning
      push protection before pushing. This step only matters once — after
      the first push, a leaked credential must be rotated, not deleted.
      **Done 2026-08-07**: `gitleaks protect --staged` and `gitleaks detect`
      both reported clean before and after the initial push; secret-scanning
      + push protection enabled via the API before the first push.
- [x] Trigger `scan.yml` once via `workflow_dispatch` after the first image
      publish and confirm a tracking issue is actually created on a
      high/critical finding (or confirm none exist) — `gh issue create
      --label base-image-cve` requires that label to already exist in the
      repo; create it first (`gh label create base-image-cve --description
      "Base image CVE tracking" --color b60205`) or the scan job's
      reporting step fails silently on every run.
      **Done 2026-08-07**: label created, `scan.yml` triggered manually,
      found 180 high/critical findings in `node:26-slim` and correctly
      opened [#4](https://github.com/apilbeam101/ftd-metrics-exporter/issues/4)
      — a base-image finding per SECURITY.md, addressed by the next monthly
      `rebuild.yml` run, not a source-code defect.
- [ ] Confirm the `dco` CI job actually blocks a PR with an unsigned commit
      once the repo is on GitHub (push a throwaway branch/PR with one
      unsigned commit against a fork or a test repo first, if possible) —
      this check has only been verified against local git logic, never a
      real `pull_request` event's `base.sha`/`head.sha`.
      **Partially exercised 2026-08-07**: the job ran and passed
      (`base.sha`/`head.sha` resolved correctly) on all three Dependabot
      PRs merged this session — but Dependabot's own commits already carry
      a `Signed-off-by` trailer, so this only confirms the job's *positive*
      path. The negative case (blocking an actually-unsigned commit) is
      still unverified — still open.
- [x] After the first image publish, set the GHCR package visibility to
      **public** (it defaults to private) and confirm an anonymous
      `docker pull` from a logged-out client.
      **Done 2026-08-07**: package visibility confirmed public via the API;
      all four tags (`0.1.0`, `0.1`, `0`, `latest`) resolve via an anonymous
      GHCR token-exchange + manifest fetch (no `docker` CLI available on
      this dev machine, so verified via the raw registry API instead of
      `docker pull`).

## Every release

- [x] **Bump `package.json`'s `version`** to match the tag you're about to
      push, and commit it. `release.yml`'s `verify` job fails the whole
      release if the pushed tag (`vX.Y.Z`) doesn't match `package.json`'s
      version — this is deliberate (a mismatch would otherwise move
      `:latest`/GHCR tags to an image reporting a stale
      `ftd_exporter_build_info{version=}` before the npm publish step fails
      or publishes something unintended).
      **v0.1.0 (2026-08-07)**: `package.json` already at `0.1.0` from Stage
      0; no bump needed for this first release.
      **v0.3.0 (2026-08-25)**: bumped `0.2.0` → `0.3.0` (`npm version --no-git-tag-version`)
      for the license/certificate-status feature set, SCC device-inventory
      follow-through, and the five-panel dashboard fix — all additive to the
      metric surface, consistent with a minor bump per §13. Also picked up
      two open Dependabot PRs (GitHub Actions group bump, `biome` dev-dep
      bump) merged first so the tagged commit includes them; one PR's CI run
      hit the known-flaky `dist-smoke.test.ts` SIGINT-during-init signal test
      (unrelated to either PR's diff — confirmed by a clean re-run before
      merging) rather than a real regression.
- [x] **Promote `CHANGELOG.md`'s `## [Unreleased]` section to `## [X.Y.Z]`**
      (with today's date) before tagging. `release.yml`'s `release` job
      extracts the section matching the pushed tag's version and fails if
      none exists — this is what makes the promotion a hard gate rather
      than a habit to remember.
      **v0.1.0 (2026-08-07)**: promoted; verified the extraction script
      directly against the file before pushing the tag.
      **v0.3.0 (2026-08-25)**: promoted, and rewrote the dashboard-fix "Fixed"
      entry to reflect the final five-panel state (the `merge`→`joinByLabels`
      fix) rather than the superseded first-pass "switch to `merge`" wording
      that was already in `[Unreleased]`.
- [ ] Live verification against a real SCC tenant and/or on-prem FMC —
      follow [docs/LIVE_SMOKE_TEST.md](LIVE_SMOKE_TEST.md) and record
      results here (backend × surface × pass/fail × date).
      **v0.1.0**: not re-run for this release — see the existing results
      log below from the pre-release live smoke test session (same day).
- [x] `npm pack` output inspected by eye once before publishing (automated as
      a CI tripwire in `release.yml`, but the tripwire itself is worth a
      periodic manual sanity check) — no `.env`, no `data/`, no `.scratch/`,
      no fixtures with real data.
      **v0.1.0**: N/A this release — npm publishing is gated off
      (`vars.PUBLISH_NPM`) pending `NPM_TOKEN` setup, so the `npm` job
      (and its `check-pack-allowlist.ts` step) didn't run. Revisit once npm
      publishing is enabled.
      **v0.3.0 (2026-08-25)**: still gated off; inspected `npm pack` output
      by eye anyway since the same tarball was used to redeploy the Stage 16
      soak VM — 160 files, `dist/`, `example.env`, `README.md`, `LICENSE`,
      `package.json` only, no `.env`/`data/`/`.scratch/`/fixtures.
- [x] After the release workflow completes: pull the published image
      anonymously and run `gh attestation verify
      oci://ghcr.io/apilbeam101/ftd-metrics-exporter:<tag> -R
      apilbeam101/ftd-metrics-exporter` — confirms provenance actually
      resolves for a real consumer, not just that the workflow step reported
      success.
      **v0.1.0 (2026-08-07)**: verified — real Sigstore certificate, Rekor
      transparency-log inclusion, and a SLSA provenance statement resolving
      to the exact tag/commit/workflow run and image digest
      (`sha256:3ae4a1ab...`).
      **v0.3.0 (2026-08-25)**: verified — `gh attestation verify` resolved a
      real Sigstore bundle referencing `refs/tags/v0.3.0` and the
      `release.yml` workflow run.
- [x] Confirm the Docker Hub mirror published the same tag (best-effort;
      mirror failures are non-fatal to the release, so this is the check
      that catches a silently-failed mirror).
      **v0.1.0 (2026-08-07)**: mirror job failed as expected — no
      `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets exist. Non-fatal
      (`continue-on-error: true`); GHCR + npm remain the primary artifacts
      per the workflow's own design. Revisit if Docker Hub distribution is
      wanted later.
      **v0.3.0 (2026-08-25)**: same, still no secrets configured — confirmed
      unchanged from v0.1.0/v0.2.0, not a new failure.

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
