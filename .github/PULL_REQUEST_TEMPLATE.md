## What and why

<!-- What changed, and why -- link an issue if there is one. -->

## Checks

- [ ] `npm run typecheck && npm run lint && npm test` all green locally
- [ ] If a metric name, metric label, or environment variable was renamed/removed/added: called out explicitly below, since these are the project's versioned public API
- [ ] If this touches a response mapper or the metrics renderer: new/updated fixture-backed tests, not just an assertion against synthetic input
- [ ] Commits are signed off (`git commit -s`) per CONTRIBUTING.md's DCO requirement

## Metric/config surface changes (if any)

<!-- None, or: list the exact metric/label/env var name(s) added, renamed, or removed. -->

## Testing performed

<!-- What you actually ran, not just "tests pass" -- e.g. "ran against a mock FMC server with a 40-device paginated fixture". -->
