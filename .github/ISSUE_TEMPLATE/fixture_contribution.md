---
name: Fixture contribution (sanitized --dump-raw capture)
about: Contribute a real captured response to help close a schema unknown
title: "Fixture: "
labels: fixture
---

See [CONTRIBUTING.md § Contributing sanitized fixtures](../../CONTRIBUTING.md#contributing-sanitized-fixtures-fmc-schema-unknowns) for the full `--dump-raw` workflow before filing this.

## Backend and metric family/families

<!-- e.g. standalone FMC, CHASSIS_STATS -->

## Device capabilities

- [ ] Chassis-based hardware
- [ ] HA pair
- [ ] RA VPN configured
- [ ] S2S VPN tunnels configured

## Have you reviewed the capture for anything you're not comfortable sharing?

<!--
--dump-raw sanitizes credential-shaped values and UUID/IPv4-shaped
substrings by default, but does not attempt to recognize every possible
sensitive field (interface names, hostnames, tunnel names are common
things worth double-checking or redacting yourself before attaching).
-->

- [ ] Yes, reviewed and redacted anything sensitive

## Attach the capture

<!-- Attach capture.json (or paste it in a collapsed <details> block below). -->
