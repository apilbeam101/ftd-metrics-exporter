---
name: Bug report
about: Something isn't working as documented
title: ""
labels: bug
---

**Before filing:** check [docs/TROUBLESHOOTING.md](../../docs/TROUBLESHOOTING.md) — it covers the highest-frequency issues (health-policy prerequisites, FMC UI/API session conflicts, TLS trust, sizing) and may already have your answer.

## What happened

<!-- What you expected, and what actually happened. -->

## Environment

- **Deployment method:** standalone / Docker / Kubernetes
- **Backend:** SCC (cdFMC) / standalone on-prem FMC
- **`ftd_exporter_build_info`** (from `/metrics`, or the image/npm tag): <!-- e.g. version="0.1.0", commit="...", node_version="...", backend="scc" -->
- **OS / Node version** (standalone only):

## Logs

<!--
Paste the relevant log lines. Secrets (tokens, passwords, Authorization headers)
are redacted automatically at the logging boundary — but please double check
before pasting, especially if you're sharing a --dump-raw capture instead of
normal log output. Never paste raw .env contents or a live Secret/ConfigMap.
-->

```
paste here
```

## What you've already checked

- [ ] `docs/TROUBLESHOOTING.md` for this symptom
- [ ] `/healthz` and `/readyz` respond as expected
- [ ] `ftd_exporter_up`, `ftd_exporter_poll_errors_total{reason}`, `ftd_exporter_cache_age_seconds`
