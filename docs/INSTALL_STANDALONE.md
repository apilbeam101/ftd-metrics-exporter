# Standalone installation

Plain Node.js + npm is the supported standalone path — the flow is identical on Windows, macOS, and Linux.

## Prerequisites

- **Node.js 24 or later.** The process checks `process.version` at startup and exits with a clear message on an older runtime.
- Outbound HTTPS (TCP 443) to your SCC regional endpoint or your on-prem FMC host.
- An inbound listener port for `/metrics` (default **10049**, configurable via `METRICS_PORT`).

### Installing Node.js

If you don't already have Node.js 24+, pick your platform:

**macOS** — using [Homebrew](https://brew.sh):

```bash
brew install node
```

**Linux** — using [nvm](https://github.com/nvm-sh/nvm) (works on any distro):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh | bash
# restart your shell, then:
nvm install 24
nvm use 24
```

**Windows** — using [winget](https://learn.microsoft.com/en-us/windows/package-manager/winget/):

```powershell
winget install OpenJS.NodeJS.LTS
```

After any of the above, open a new terminal and confirm with `node --version`.

## Install and run

Pick one of the two install paths below, then continue from step 4 — they lead to the same running process, but the first has no build step and the second requires one.

**From npm** (quickest; ships a pre-built `dist/`, nothing to compile):

1. [Install Node.js 24+](#installing-nodejs).
2. `npm install -g ftd-metrics-exporter` — the command is then available as `ftd-metrics-exporter`. To try it without installing anything, use `npx ftd-metrics-exporter` instead.

**From source** (a `git clone` of a tagged release, or a release tarball):

1. [Install Node.js 24+](#installing-nodejs).
2. `npm ci` — installs exact locked dependency versions.
3. `npm run build` — compiles TypeScript to `dist/`.

**Then, either way:**

4. `cp example.env .env` and fill in the required variables (see [example.env](../example.env)).
5. Start it — `ftd-metrics-exporter` (npm install path) or `node dist/index.js` (from-source path). Both read `.env` from the current working directory by default. To point at a different file, pass `--env-file=/path/to/.env` — note that Node itself also recognizes this flag, so a missing or unreadable path fails with a Node-level error (`node: <path>: not found`) and exit code 9 before the exporter starts, rather than the exporter's own configuration error and exit code 1.
6. Verify: `curl http://localhost:10049/metrics` returns exposition-format text including `ftd_exporter_up 1`.

## Platform-specific notes

The only genuine platform differences are `.env` file permissions and how the process is supervised (kept running, restarted on crash/reboot). Find your platform below — you don't need to read the others.

### Linux

- Restrict the secret file: `chmod 600 .env`, owned by the service user.
- Run under a dedicated unprivileged service account (e.g. `ftd-exporter`), never root — port 10049 is >1024 so no privileged binding is needed.
- **Supervision: systemd.** An example unit is at [deploy/systemd/ftd-metrics-exporter.service](../deploy/systemd/ftd-metrics-exporter.service) — copy it to `/etc/systemd/system/`, adjust `WorkingDirectory`/`ExecStart` if you installed somewhere other than `/opt/ftd-metrics-exporter`, then:

  ```
  sudo useradd --system --no-create-home --shell /usr/sbin/nologin ftd-exporter
  sudo chown -R ftd-exporter:ftd-exporter /opt/ftd-metrics-exporter
  sudo chmod 600 /opt/ftd-metrics-exporter/.env
  sudo systemctl daemon-reload
  sudo systemctl enable --now ftd-metrics-exporter
  sudo systemctl status ftd-metrics-exporter
  journalctl -u ftd-metrics-exporter -f
  ```

  The unit sets `Restart=always` (crash and manual-kill recovery) plus standard hardening directives: `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `ProtectHome=yes`, and an empty `ReadWritePaths=` — the exporter never writes to disk, so it needs no writable path at all.

### macOS

> **Unverified.** This leg has not been executed on a real macOS device. Treat it as a starting point, not a tested procedure, and please report back if you try it.

- `chmod 600 .env`.
- Install Node via the official installer, Homebrew, or a version manager — all equivalent.
- **Supervision: launchd.** An example plist is at [deploy/launchd/com.example.ftd-metrics-exporter.plist](../deploy/launchd/com.example.ftd-metrics-exporter.plist) — rename the `Label` and file to your own reverse-DNS identifier, adjust the paths, then:

  ```
  cp com.example.ftd-metrics-exporter.plist ~/Library/LaunchAgents/
  launchctl load ~/Library/LaunchAgents/com.example.ftd-metrics-exporter.plist
  ```

  `KeepAlive` is configured to restart on a crash but not after a clean exit, so `launchctl stop` (a SIGTERM-driven graceful shutdown exits 0) is not immediately undone. To stop the job for good, use `launchctl unload ~/Library/LaunchAgents/com.example.ftd-metrics-exporter.plist`. Use `/Library/LaunchDaemons/` instead of `~/Library/LaunchAgents/` for a system-wide (not per-user) install. The plist sets no `StandardOutPath`/`StandardErrorPath` — the exporter writes no files, matching the systemd unit's empty `ReadWritePaths=`; view its logs with `log stream --predicate 'process == "node"' --info`.

### Windows

POSIX `chmod` does not apply — a `.env` on Windows commonly inherits broad `Users` read access by default, which silently exposes your API token/password to every local account on the machine. This is a real difference from Unix, not a formality.

- **Use a dedicated, non-administrator local account** for the exporter (e.g. `ftd-exporter`), the Windows equivalent of the Linux service account above — not your interactive admin account. Create one with `net user ftd-exporter /add` (then leave it out of the `Administrators` group), and grant it the *Log on as a batch job* right via `secpol.msc` → Local Policies → User Rights Assignment, which Task Scheduler requires for "Run whether user is logged on or not". The exporter needs no administrative privileges and no privileged port (10049 is >1024).

- **Restrict `.env` permissions with `icacls`**, from an elevated prompt, in the directory containing `.env`. The variable-expansion syntax differs by shell — use the block matching the shell you are in:

  PowerShell:

  ```powershell
  icacls .env /inheritance:r
  icacls .env /grant:r "$($env:USERNAME):R"
  icacls .env /grant:r "NT AUTHORITY\SYSTEM:F"
  ```

  cmd.exe:

  ```bat
  icacls .env /inheritance:r
  icacls .env /grant:r "%USERNAME%:R"
  icacls .env /grant:r "NT AUTHORITY\SYSTEM:F"
  ```

  `/inheritance:r` removes inherited permissions (including the broad default `Users` grant); the `/grant:r` calls then explicitly grant access. If the exporter will run as a different account than the one you're typing from — e.g. the dedicated `ftd-exporter` account above — substitute that account's name rather than relying on `$env:USERNAME`/`%USERNAME%` expansion.

  **Match the grant to whichever account your supervision method actually runs as** — this is the step most easily got wrong, because the options below run as different principals:

  | Supervision | Runs as | Grant needed on `.env` |
  |---|---|---|
  | Task Scheduler | the account configured on the General tab | that account, `:R` |
  | NSSM (as installed below) | `LocalSystem` by default | `NT AUTHORITY\SYSTEM:R` |
  | `sc.exe` service | whatever `obj=` specifies | that account, `:R` |

  If you're using Task Scheduler with a dedicated account, the `NT AUTHORITY\SYSTEM` grant above is not required — drop it. If you're using NSSM's default identity, the SYSTEM grant is the one doing the work, and `:R` is sufficient (`:F` is broader than needed).

  **Verify both directions** — an over-restrictive ACL is as broken as a permissive one, and only the first check below catches it:

  1. **The exporter's account can still read it.** From the account that will run the exporter, `type .env` must succeed. If it runs as a different account, use `runas /user:<serviceaccount> cmd` and check there. The quickest end-to-end confirmation is to start the exporter and check that its startup log shows your real `BACKEND_TYPE` rather than an "unset" error.
  2. **No other account can read it.** `icacls .env` should list only the accounts you explicitly granted, and from a second, non-administrator local account `type .env` must fail with access denied (log in as that account, or use `runas /user:<otheraccount> cmd`).

- **Supervision: Task Scheduler** (recommended — dependency-free, built into Windows):

  1. Open Task Scheduler → Create Task.
  2. General tab: name it; under "When running the task, use the following user account" select your dedicated `ftd-exporter` account; select "Run whether user is logged on or not" (you'll be prompted for that account's password); leave "Run with highest privileges" **unchecked** — the exporter needs no elevation.
  3. Triggers tab: "At startup" (or "At log on" for a per-user task).
  4. Actions tab: Action = "Start a program"; Program = `C:\Program Files\nodejs\node.exe`; Arguments = `dist\index.js`; Start in = the exporter's install directory (so the default `.env` lookup finds it).
  5. Settings tab: check "If the task fails, restart every" and set a short interval (e.g. 1 minute) to approximate `Restart=always`.

  For true Windows service semantics (start/stop via `services.msc`, dependency ordering) rather than a scheduled task, [NSSM](https://nssm.cc/) is a popular dependency-free wrapper — install it, then `nssm install ftd-metrics-exporter "C:\Program Files\nodejs\node.exe" "dist\index.js"` from the exporter's install directory. NSSM creates the service running as `LocalSystem` by default — either grant `NT AUTHORITY\SYSTEM:R` on `.env` (see the table above), or set the service to your dedicated account via `nssm set ftd-metrics-exporter ObjectName ftd-exporter <password>`. Also run `nssm set ftd-metrics-exporter AppDirectory <install dir>`, since NSSM's default working directory is the `node.exe` binary's own directory, not the install dir — without this the default `.env` lookup fails.

- Path handling in the exporter uses `node:path` throughout — Windows-style paths (`C:\certs\fmc-ca.pem`) work for `FMC_CA_BUNDLE_PATH` and the TLS cert/key path variables.
- No PowerShell-only or Windows-only tooling is required to *run* the exporter — the commands above are for OS-level service/permission setup only.

## Troubleshooting

Config errors, credential/TLS failures, and permission problems (including the Windows `.env`/`icacls` case above) are all covered in [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
