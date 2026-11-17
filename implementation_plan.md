# Implementation Plan: SSH Access per Box

## Goal
Let a user open an interactive SSH console to any Cloud box from the BoxLite tree view. The extension automates the documented flow (`boxlite ssh`) and connects over the Cloud-routed `ProxyCommand`. A public box IP is never needed.

## Background (from BoxLite docs)
- Cloud SSH needs the local `boxlite` CLI (with the `ssh` subcommand), OpenSSH (`ssh`, `ssh-keygen`), a signed-in CLI context, a **running** box, and **inbound networking enabled**.
- `boxlite --context <ctx> ssh <BOX>` does the following:
  - Generates and saves a keypair locally.
  - Configures guest sshd.
  - Prints the private-key path, the host-key fingerprint, and a full `ssh ... -o ProxyCommand=...` command.
- Other commands:
  - `ssh --status <BOX>` reports the current state and fingerprint.
  - `ssh --enable <BOX>` re-enables saved config.
  - `ssh --disable <BOX>` disables it.
  - `network tunnel --revoke <BOX> 22` closes the tunnel.
- **Re-running setup replaces the authorized key and disconnects existing clients.** The extension must therefore never re-run setup silently.
- Related facts from the BoxLite Cloud guide:
  - The API host is `https://api.boxlite.ai`.
  - `BOXLITE_API_KEY` only overrides the bearer token of a saved profile.
  - `network inbound <BOX> enabled` is required.
  - A stopped box must be started first.

## Existing code touched
| Area | File | Notes |
|---|---|---|
| Commands | [src/commands/index.ts](src/commands/index.ts) | `boxlite.execCommand` is the pattern to follow (uses `resolveBoxId`). |
| Tree | [src/tree/nodes.ts](src/tree/nodes.ts) | `BoxTreeItem.contextValue` contains `-isRunning` / `-isStopped`. |
| Manifest | [package.json](package.json) | Add commands and `view/item/context` menu entries. |
| Auth | [src/auth/credentials.ts](src/auth/credentials.ts), `secretsStore.ts` | Source of the active API key and URL. |
| Process helpers | [src/util/process.ts](src/util/process.ts) | `createCleanSubprocessEnv` is reused for all spawns. |
| Tests | `test/*.test.ts`, `test/mock-vscode.js` | Add `ssh.test.ts`. |

## Design

### New module `src/ssh/`
1. **`cli.ts`**: thin wrapper over `child_process.execFile` (no shell, args as an array, clean env).
   - `findBoxliteCli()`: checks the `boxlite.cliPath` setting, then PATH, via `boxlite ssh --help`.
   - `findOpenSsh()`: runs `ssh -V` and `ssh-keygen -?`.
   - `cliLogin(ctx, url, apiKey)`: runs `boxlite --context <ctx> auth login --url <url> --api-key-stdin`, with the key piped to stdin. The key never goes in argv or logs.
   - `ensureInbound(box)`: runs `network inbound <box> enabled`.
   - `sshSetup(box)`, `sshStatus(box)`, `sshEnable(box)`, `sshDisable(box)`, `revokeTunnel(box, 22)`.
2. **`parse.ts`**: pure functions, unit-testable.
   - `parseSetupOutput(stdout)` returns `{ keyPath, fingerprint, sshCommand }`.
     - It takes everything after the line "Copy and run the following command to enter the box" as the full command.
     - It tokenizes with quote awareness and keeps the `ProxyCommand` intact.
   - `parseStatusOutput` extracts the enabled state and fingerprint.
3. **`sshStore.ts`**: persists per-box SSH metadata in `context.globalState`, keyed by `orgContext:boxId`.
   - Fields: `keyPath`, `fingerprint`, `sshArgs[]`, `configuredAt`.
   - **No private key material is stored.** The key stays where the CLI wrote it; only the path is stored.
   - If the key file is missing, treat the box as "not set up".
4. **`sshService.ts`**: orchestration that exposes `connect(boxId)`, `setup(boxId, {force})`, `disable(boxId)`, `copyCommand(boxId)`.

### CLI context strategy
Use a dedicated context named `vscode-<keyId>`, derived from the active API key id. This avoids clobbering the user's own `app` context.
- Log in to it lazily with the key from `SecretStorage` before the first SSH operation.
- Re-login when the active key changes.
- Pass `--context <ctx>` on every call.
- The generated `ProxyCommand` references the CLI and context, so the context must persist.

### Connect flow (`boxlite.sshConnect`)
```
resolveBoxId → preflight (CLI + OpenSSH present?) → box running? (offer Start)
  → ensure CLI context logged in → ensureInbound
  → stored config + key file exist?
        yes → `ssh --status`; if disabled → `ssh --enable`; if fingerprint differs → warn, offer "Re-run setup"
        no  → `ssh <box>` setup → parse → persist
  → open integrated terminal running the saved ssh command
```
- The terminal uses `vscode.window.createTerminal({ name: 'SSH: <box>', shellPath: <ssh bin>, shellArgs: [...] })`. Passing args as an array avoids quoting problems with the `ProxyCommand`.
- Fall back to `terminal.sendText` with a shell-escaped string only if the parsed args are unusable.
- **First-connect host trust.** Show a modal with the setup fingerprint before opening the terminal, and let OpenSSH do its normal known-hosts prompt. Do not set `StrictHostKeyChecking=no`.
- Reuse an existing terminal for the same box if it is still alive.

### Commands (all category "BoxLite")
| Command | Title | Shown when |
|---|---|---|
| `boxlite.sshConnect` | Connect via SSH | box `isRunning` (inline `$(remote)` and context menu). Starting a stopped box is offered when invoked from the palette. |
| `boxlite.sshSetup` | Set Up / Reset SSH... | box `isRunning`. Modal warning: "Replaces the SSH key and disconnects existing clients." |
| `boxlite.sshCopyCommand` | Copy SSH Command | box `isRunning` and SSH configured. |
| `boxlite.sshDisable` | Disable SSH & Close Tunnel | box `isRunning`. Runs `network tunnel --revoke <box> 22`, then `ssh --disable`. |
| `boxlite.sshOpenRemote` | Open in Remote-SSH | box `isRunning`. Requires `ms-vscode-remote.remote-ssh`. |
| `boxlite.sshRemoveConfigEntries` | Remove Managed SSH Config Entries | Command palette only. |

Add a `-sshReady` suffix to `BoxTreeItem.contextValue` (from the store) so menus can distinguish Connect vs Set up. Refresh the tree after setup/disable.

### Settings
- `boxlite.ssh.cliPath` (default `boxlite`)
- `boxlite.ssh.sshPath` (default `ssh`)
- `boxlite.ssh.contextPrefix` (default `vscode`)
- `boxlite.ssh.manageConfig` (default `false`)

## Phases
1. **Foundations.** Add `cli.ts`, `parse.ts` and `sshStore.ts` with unit tests, using fixture CLI output.
2. **Core connect.** Add `sshService.connect`, the `boxlite.sshConnect` command, the manifest entries, and the context-value suffix.
3. **Lifecycle.** Add setup/reset, disable and copy-command, plus the stopped-box and disabled-SSH recovery paths.
4. **SSH config + Remote-SSH (in v1).** Add `sshConfig.ts` (opt-in managed blocks), the `boxlite.sshOpenRemote` command, the extension detection and install prompt, and the `boxlite.sshRemoveConfigEntries` command.
5. **Polish.** Add the settings, the output channel (`BoxLite SSH`, with secrets redacted), the README docs, and the capability probe for JSON output.

## Error handling (map to docs troubleshooting table)
| Symptom | Extension behaviour |
|---|---|
| `boxlite ssh` unknown subcommand | Prompt: "Update the BoxLite CLI", with a link to `curl -fsSL https://sh.boxlite.ai \| sh`. |
| CLI or OpenSSH missing | Show an install-guidance message and a button to open the docs. |
| Auth failure or box not found | Offer to re-link the API key (`boxlite.setApiKey`). |
| SSH disabled | Auto-run `ssh --enable`, then connect. |
| Private-key permissions rejected | On macOS/Linux run `chmod 600` on the key path. On Windows, offer to reset the ACL via `icacls <key> /inheritance:r /grant:r "%USERNAME%:R"`. |
| `Permission denied (publickey)` | Explain that another setup replaced the key, and offer "Reset SSH". |
| Host fingerprint changed | Compare with `ssh --status` and show both values before the user decides. |
| Box stopped | Offer Start, wait for `running`, then continue. |

## Security
- Run all CLI calls with `execFile` and arrays (no shell). Validate the box id against `validation.ts`.
- Pass the API key only on stdin. Redact `blk_live_*` and key paths in logs.
- Store only the key path, never the key.
- Never disable host-key checking.
- Document that disabling SSH does not close the tunnel by itself. The extension always runs the revoke together with disable.
- Follow the `vscode-extension-startup-crash` skill. Do not trigger any CLI or bridge work from `onView` activation. SSH work runs only on explicit commands, and preflight checks are lazy.

## Testing
- **Unit tests:**
  - `parse.ts` against sample setup and status output, including a quoted `ProxyCommand` and Windows paths.
  - `sshStore` keying.
  - Argument construction, with a mocked `execFile`.
  - Preflight error mapping.
- **Mock-based command tests** (`test/mock-vscode.js`):
  - A command appears only for running boxes.
  - The disable flow calls revoke before disable.
- **Manual, against a real box:**
  1. Set up, connect, and run `whoami` (expect `boxlite`) and `uname -s` (expect `Linux`).
  2. Reconnect without re-running setup.
  3. Stop and start the box, then reconnect.
  4. Disable, then connect again (auto-enable).
  5. Reset, and confirm that existing sessions drop.
  6. Run on Windows, macOS and Linux.

## Decisions (confirmed)
1. **Own CLI context:** the extension creates and manages `vscode-<keyId>`. It never touches the user's `app` context.
2. **Remote-SSH hand-off is in v1.** See "Remote-SSH hand-off" below.
3. **`~/.ssh/config` management is opt-in only.** See "SSH config management" below.
4. **JSON output is unknown, so parsing is layered.** See "Output parsing strategy" below.

## Remote-SSH hand-off (v1)
Command `boxlite.sshOpenRemote` ("Open in VS Code Remote-SSH").
- **Requirement:** `ms-vscode-remote.remote-ssh` (or a compatible fork) installed. Detect it with `vscode.extensions.getExtension`. If it is missing, offer to install it via `workbench.extensions.installExtension`.
- **Why a Host alias is needed:** Remote-SSH only accepts a host alias or `user@host`. It cannot take the raw `ssh ... -o ProxyCommand=...` command. So the hand-off needs an SSH config entry, which is the same entry the opt-in config management writes.
- **Flow:**
  1. Run the normal connect preflight and setup.
  2. Write or update the managed Host block. Remote-SSH is an explicit user action, so a one-time confirmation modal ("Add `boxlite-<name>` to your SSH config?") covers consent for this host only.
  3. Run `vscode.commands.executeCommand('opensshremotes.openEmptyWindow', { host: 'boxlite-<name>' })`. As a fallback, use `vscode.openFolder` with the `vscode-remote://ssh-remote+boxlite-<name>/home/boxlite` URI.
- **Alternative if the user declines config writes:** write the Host block to an extension-owned file in `globalStorageUri` (`boxlite_ssh_config`) and set `remote.SSH.configFile` only after explicit confirmation. Otherwise show the manual `Include` instruction.
- **Caveats to verify:**
  - The remote needs `curl` or `wget`, plus a glibc or musl toolchain, for the VS Code server install. Check this on the BoxLite base image.
  - The proxy only works while the box is running.
  - `ProxyCommand` must work non-interactively, so the CLI context login must already be done.
  - The Windows host needs a path form for `ProxyCommand` that Remote-SSH can run (quote the CLI path).

## SSH config management (opt-in)
- **Setting:** `boxlite.ssh.manageConfig` (default `false`). The first use of Remote-SSH also prompts for it.
- **Managed block** in `~/.ssh/config`, one per box, delimited by markers:
  ```
  # >>> boxlite-cloud:<boxId> (managed by BoxLite extension) >>>
  Host boxlite-<name>
    HostName <boxId>
    User boxlite
    IdentityFile <keyPath>
    IdentitiesOnly yes
    ProxyCommand <parsed ProxyCommand value>
  # <<< boxlite-cloud:<boxId> <<<
  ```
- **Rules:**
  - Only edit between the markers, and never touch other content.
  - Back up the file to `config.boxlite.bak` before the first write.
  - Write atomically (temp file, then rename), and create `~/.ssh` with mode `700` if absent.
  - Sanitize the alias (`[a-z0-9-]`) and handle name collisions by appending a short box id.
  - Remove the block on `boxlite.sshDisable` (and on "Reset", then re-add).
  - Provide `boxlite.sshRemoveConfigEntries`, which removes all managed blocks.
  - Keep host-key checking on, so the known-hosts prompt still works.
- **Implementation:** `src/ssh/sshConfig.ts`, with pure `upsertBlock(text, block)` and `removeBlock(text, id)` functions so it is fully unit-testable.

## Output parsing strategy
There is no confirmed `--json` flag, so do not depend on one.
1. **Capability probe (once per CLI version, cached):** run `boxlite ssh --help` and look for `--json` / `--output`. If found, use it. This is a forward-compatible fast path.
2. **Text fallback:** the regex/line parser from `parse.ts`, anchored on the documented markers ("Copy and run the following command to enter the box", the private-key path, the fingerprint).
3. **Validation:** the parsed command must start with `ssh`, contain `-i <keyPath>` where the path exists, and contain a `ProxyCommand`. If validation fails, fall back to showing the raw output in the `BoxLite SSH` channel and give the user a "Copy raw output" action instead of guessing.
4. **Fixtures:** capture real output from a live setup (several CLI versions if possible) into `test/fixtures/ssh/` and test against them.
5. **Upstream:** note in the README that a stable JSON mode would remove the parser, and consider asking BoxLite for one.
6. **Version gate:** read `boxlite --version`. If `ssh --help` fails, show the "update CLI" prompt. Record the minimum tested version in a constant.
