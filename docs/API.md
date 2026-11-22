# BoxLite Cloud API Reference & PowerShell Guide

This document is generated directly from the extension's `/src` implementation—primarily:

- `src/bridge/python/bridge.py` (`RestRuntimeFallback` and `BoxLiteBridge`)
- `src/bridge/client.ts` (`BoxLiteBridgeClient`)
- `src/bridge/protocol.ts` (request/response schemas)
- `src/ssh/restClient.ts` (`BoxliteRestSshClient` and `openTunnelWithRecovery`)
- `src/auth/credentials.ts` (API key & base URL resolution)
- `src/util/validation.ts` & `src/util/diagnosis.ts` (validation rules & error diagnostics)

---

## 1. Architecture & How the API Works

The extension interacts with **BoxLite Cloud** through two layers:

```text
VS Code Extension Host (TypeScript)
  ├── BoxLiteBridgeClient (src/bridge/client.ts)
  │     └── JSON-Lines over stdin/stdout ──► bridge.py (src/bridge/python/bridge.py)
  │           ├── Official Python SDK (boxlite==0.11.0) when installed
  │           └── Built-in REST fallback (RestRuntimeFallback) ──► BoxLite Cloud REST API (/v1)
  │
  └── BoxliteRestSshClient (src/ssh/restClient.ts)
        ├── Direct HTTPS JSON calls ──────────────────────────────► BoxLite Cloud REST API (/v1)
        └── HTTP/1.1 CONNECT over TLS ────────────────────────────► One-shot Tunnel Proxy URI
```

### Base URL & Transport Security

- **Default Base URL:** `https://api.boxlite.ai` (overridable via `BOXLITE_REST_URL` or VS Code setting `boxlite.restUrl`).
- **API Prefix:** All REST endpoints are prefixed with `/v1` (e.g., `https://api.boxlite.ai/v1/boxes`).
- **HTTPS Enforcement:** `src/ssh/restClient.ts` rejects plain `http://` for any non-loopback host. Only `https://` (or `http://` for `127.0.0.1`, `localhost`, `::1`) is permitted.

### Authentication Headers

| Context | Header | Format |
|---|---|---|
| Standard REST API (`/v1/...`) | `Authorization` | `Bearer <BOXLITE_API_KEY>` |
| HTTP/1.1 `CONNECT` Tunnel Stream | `X-BoxLite-Authorization` | `Bearer <BOXLITE_API_KEY>` |
| Accessing a Private Tunnel URL | `X-BoxLite-Access-Token` | `<tunnel.token>` |

API keys are checked for control characters (`\r`, `\n`, `\0`) and must be non-empty.

---

## 2. PowerShell Setup & Common Helper

Run this setup block once in your PowerShell session. All examples below build on `Invoke-BoxLiteApi`.

```powershell
# Configure credentials (avoid hardcoding keys in scripts)
$env:BOXLITE_API_KEY  = "bl_live_your_api_key_here"
$env:BOXLITE_REST_URL = "https://api.boxlite.ai"

function Invoke-BoxLiteApi {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [ValidateSet('GET', 'POST', 'PUT', 'PATCH', 'DELETE')]
        [string]$Method,

        [Parameter(Mandatory)]
        [string]$Path,

        [object]$Body = $null,

        [int]$TimeoutSec = 30
    )

    $apiKey = $env:BOXLITE_API_KEY
    if ([string]::IsNullOrWhiteSpace($apiKey)) {
        throw "BOXLITE_API_KEY environment variable is not set."
    }

    $baseUrl = ($env:BOXLITE_REST_URL ? $env:BOXLITE_REST_URL : "https://api.boxlite.ai").TrimEnd('/')
    $uri = "$baseUrl/v1$Path"

    $headers = @{
        Authorization = "Bearer $($apiKey.Trim())"
        Accept        = "application/json"
        "User-Agent"  = "boxlite-powershell-client/0.3.0"
    }

    $params = @{
        Method     = $Method
        Uri        = $uri
        Headers    = $headers
        TimeoutSec = $TimeoutSec
    }

    if ($null -ne $Body) {
        $params.ContentType = "application/json"
        $params.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    }

    Invoke-RestMethod @params
}
```

> **Note for Windows PowerShell 5.1:** Replace `$env:BOXLITE_REST_URL ? ... : ...` with `if ($env:BOXLITE_REST_URL) { $env:BOXLITE_REST_URL } else { "https://api.boxlite.ai" }`.

---

## 3. Boxes API

Boxes are isolated microVM instances.

### Endpoints

| Operation | Method & Path | Bridge Op | Notes |
|---|---|---|---|
| List boxes | `GET /v1/boxes` | `list_boxes` / `check_credentials` | Returns `{ boxes: [...] }` or an array of boxes. |
| Inspect box | `GET /v1/boxes/{box_id}` | `inspect_box` | Returns full metadata including status, network, volumes, and tunnels. |
| Create box | `POST /v1/boxes` | `create_box` | Creates a box in stopped/configured state; call `/start` afterward. |
| Start box | `POST /v1/boxes/{box_id}/start` | `start_box` | Starts the microVM. Poll `GET /v1/boxes/{box_id}` until `running`/`ready`/`active`. |
| Stop box | `POST /v1/boxes/{box_id}/stop` | `stop_box` | Stops the microVM. Poll until `stopped`/`terminated`/`exited`/`configured`. |
| Remove box | `DELETE /v1/boxes/{box_id}?force=true` | `remove_box` | Permanently deletes the box (`force=true` removes running boxes). |

### Important `POST /v1/boxes` Rules

- **Do NOT send `auto_remove`:** It is deprecated/client-side and rejected by the Cloud OpenAPI schema (`400 Bad Request`).
- **`auto_stop`:** Must be `0` (disabled) or `>= 60` seconds. Values between `1` and `59` are clamped to `60` by `bridge.py`.
- **`auto_delete`:** Omit or `0` for persistent boxes; positive seconds for automatic deletion.
- **`disk_size_gb`:** Standard per-box rootfs disk limit is `10` GB (`1`–`10` GB). Use Managed Volumes (`/v1/volumes`) when workloads require extra persistent storage beyond the rootfs limit.
- **`network.outbound.mode = "disabled"`:** Provisions **no guest NIC** (air-gapped). This is permanent for the lifetime of the box—outbound, inbound, and tunnels cannot be enabled later.
- **Restoring from a checkpoint:** Send **only** `{ "checkpoint_id": "<id-or-name>" }` and optional `"name"`. Passing any other option (`image`, `cpus`, `network`, `volumes`, etc.) is rejected because restored boxes inherit all settings from the checkpoint.

### PowerShell Examples

#### Verify Credentials & List Boxes

```powershell
$resp = Invoke-BoxLiteApi -Method GET -Path "/boxes"
$boxes = if ($resp.boxes) { $resp.boxes } else { $resp }
$boxes | Select-Object id, name, status, image | Format-Table -AutoSize
```

#### Create & Start a Standard Box

```powershell
$createBody = @{
    name         = "my-python-api"
    image        = "python"            # Built-in image: base, python, node, sandbaseai-hermes, or OCI ref
    cpus         = 2
    memory_mib   = 4096
    disk_size_gb = 10
    auto_stop    = 900                 # 0 (disabled) or >= 60 seconds
    auto_resume  = $true
    env          = @{
        APP_ENV = "production"
        PORT    = "8080"
    }
    entrypoint   = @("sh", "-c", "while true; do sleep 3600; done")
    network      = @{
        inbound  = @{ mode = "enabled" }
        outbound = @{ mode = "enabled"; allow_net = @() }  # Empty array = unrestricted
    }
}

$created = Invoke-BoxLiteApi -Method POST -Path "/boxes" -Body $createBody -TimeoutSec 120
$boxId = if ($created.box_id) { $created.box_id } else { $created.id }
Write-Host "Created box: $boxId"

# Start the box and wait until running
Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/start" | Out-Null

for ($i = 0; $i -lt 16; $i++) {
    $info = Invoke-BoxLiteApi -Method GET -Path "/boxes/$boxId"
    $status = if ($info.status) { $info.status } else { $info.state.status }
    if ($status -in @("running", "ready", "active")) {
        Write-Host "Box $boxId is $status"
        break
    }
    Start-Sleep -Milliseconds 500
}
```

#### Inspect, Stop, and Remove a Box

```powershell
$boxId = "your-box-id"

# Inspect
$box = Invoke-BoxLiteApi -Method GET -Path "/boxes/$boxId"
$box | ConvertTo-Json -Depth 10

# Stop and wait until stopped
Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/stop" | Out-Null
for ($i = 0; $i -lt 16; $i++) {
    $info = Invoke-BoxLiteApi -Method GET -Path "/boxes/$boxId"
    $status = if ($info.status) { $info.status } else { $info.state.status }
    if ($status -in @("stopped", "terminated", "exited", "configured", "paused", "inactive", "shutdown")) {
        Write-Host "Box $boxId is $status"
        break
    }
    Start-Sleep -Milliseconds 500
}

# Force-remove
Invoke-BoxLiteApi -Method DELETE -Path "/boxes/$boxId?force=true" | Out-Null
Write-Host "Deleted box $boxId"
```

---

## 4. Command Execution, Log Tailing & File Upload API

### Endpoints

| Operation | Method & Path | Bridge Op | Request Body |
|---|---|---|---|
| Execute command | `POST /v1/boxes/{box_id}/exec` | `exec` | `{ "command": "python3", "args": ["-V"] }` |
| Tail logs (composite) | `GET /v1/boxes/{box_id}` + `POST /v1/boxes/{box_id}/exec` | `tail_log` | Checks box isn't stopped first (to avoid auto-waking), then runs `tail -n<lines> <logFile>`. |
| Copy files in | `POST /v1/boxes/{box_id}/copy-in` | `copy_in` | `{ "source": "...", "destination": "..." }` *(Note: local directory uploads use the native `boxlite` SDK wheel or an `exec` tar/base64 workflow.)* |

### PowerShell Examples

#### Execute a Command Inside a Box

```powershell
$boxId = "your-box-id"

$execResult = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/exec" -Body @{
    command = "python3"
    args    = @("-c", "import platform; print(platform.platform())")
} -TimeoutSec 60

$exitCode = if ($null -ne $execResult.exit_code) { $execResult.exit_code } else { $execResult.exitCode }
Write-Host "Exit Code: $exitCode"
Write-Host "STDOUT:`n$($execResult.stdout)"
if ($execResult.stderr) {
    Write-Warning "STDERR:`n$($execResult.stderr)"
}
```

#### Safely Tail Logs Without Waking a Stopped Box

```powershell
function Get-BoxLiteLogTail {
    param(
        [Parameter(Mandatory)][string]$BoxId,
        [string]$LogFile = "/tmp/server.log",
        [int]$Lines = 100
    )

    $stoppedStates = @("stopped", "stopping", "terminated", "exited", "configured", "paused", "inactive", "shutdown")
    $info = Invoke-BoxLiteApi -Method GET -Path "/boxes/$BoxId"
    $status = (if ($info.status) { $info.status } else { $info.state.status }).ToString().ToLower()

    if ($status -in $stoppedStates) {
        Write-Host "Box $BoxId is $status; skipping log tail to avoid waking it."
        return ""
    }

    $res = Invoke-BoxLiteApi -Method POST -Path "/boxes/$BoxId/exec" -Body @{
        command = "tail"
        args    = @("-n$Lines", $LogFile)
    }
    return $res.stdout
}

Get-BoxLiteLogTail -BoxId "your-box-id" -LogFile "/tmp/server.log" -Lines 50
```

#### Upload a Local File via `exec` (Base64 Workaround for REST)

Because `POST /v1/boxes/{box_id}/copy-in` for local directories requires the native `boxlite` SDK wheel, you can upload files purely over REST using `exec` + Base64:

```powershell
$boxId = "your-box-id"
$localFile = ".\server.py"
$remotePath = "/app/server.py"

$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes((Resolve-Path $localFile)))
$cmd = "mkdir -p `$(dirname '$remotePath') && printf '%s' '$b64' | base64 -d > '$remotePath'"

Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/exec" -Body @{
    command = "sh"
    args    = @("-c", $cmd)
}
```

---

## 5. Networking & Tunnels API

### Endpoints

| Operation | Method & Path | Bridge Op / Client Method | Request Body |
|---|---|---|---|
| Update inbound mode | `PUT /v1/boxes/{box_id}/network/inbound` | `update_inbound` / `enableInbound` | `{ "mode": "enabled" \| "disabled", "allow_net": [] }` |
| Update outbound policy | `PUT /v1/boxes/{box_id}/network/outbound` | `update_outbound` / `enableOutbound` | `{ "mode": "enabled" \| "disabled", "allow_net": [...] }` |
| Create / prepare tunnel | `POST /v1/boxes/{box_id}/network/tunnel?port={port}` | `tunnel` / `prepareTunnel` | Public: *(no body)*; Private: `{ "isPublic": false }` |
| Revoke tunnel | `DELETE /v1/boxes/{box_id}/network/tunnel?port={port}` | `revoke_tunnel` / `revokeTunnel` | *(no body)* |

### Allowlist Validation Rules (`src/util/validation.ts`)

- Valid rules: exact hostnames (`api.example.com`), wildcards (`*.example.com`), IPv4 (`1.2.3.4`), or IPv4 CIDR (`10.0.0.0/8`).
- URLs (`https://...`), `host:port`, and comma-separated values in a single entry are rejected.
- `mode = "enabled"` with `allow_net = []` means **unrestricted** outbound access (not deny-all).
- `mode = "disabled"` cannot specify non-empty `allow_net` and suspends the guest NIC (also disabling inbound access and DNS).
- Private tunnels require exact camelCase `{ "isPublic": false }` (`additionalProperties: false` in the OpenAPI schema).

### PowerShell Examples

#### Configure Inbound & Outbound Network Policies

```powershell
$boxId = "your-box-id"

# Enable inbound proxy access
Invoke-BoxLiteApi -Method PUT -Path "/boxes/$boxId/network/inbound" -Body @{
    mode      = "enabled"
    allow_net = @()
}

# Restrict outbound egress to specific hosts and CIDR ranges
Invoke-BoxLiteApi -Method PUT -Path "/boxes/$boxId/network/outbound" -Body @{
    mode      = "enabled"
    allow_net = @("api.openai.com", "*.github.com", "10.0.0.0/8")
}
```

#### Create a Public Tunnel, Create a Private Tunnel, and Call a Private Tunnel

```powershell
$boxId = "your-box-id"

# 1. Public tunnel on port 8080 (omit body for public)
$pubTunnel = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/network/tunnel?port=8080"
$pubUrl = if ($pubTunnel.uri) { $pubTunnel.uri } else { $pubTunnel.url }
Write-Host "Public URL: $pubUrl"

# 2. Private tunnel on port 8080 (requires camelCase isPublic = false)
$privTunnel = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/network/tunnel?port=8080" -Body @{
    isPublic = $false
}
$privUrl = if ($privTunnel.uri) { $privTunnel.uri } else { $privTunnel.url }
Write-Host "Private URL: $privUrl"
Write-Host "Access Token: $($privTunnel.token)"

# 3. Access the private tunnel using X-BoxLite-Access-Token
Invoke-RestMethod -Uri "$privUrl/healthz" -Headers @{
    "X-BoxLite-Access-Token" = $privTunnel.token
}

# 4. Revoke the tunnel
Invoke-BoxLiteApi -Method DELETE -Path "/boxes/$boxId/network/tunnel?port=8080" | Out-Null
```

---

## 6. SSH & Raw HTTP/1.1 `CONNECT` Tunnel API

Implemented in `src/ssh/restClient.ts` (`BoxliteRestSshClient`).

### Endpoints

| Operation | Method & Path | Client Method | Request / Response |
|---|---|---|---|
| Get SSH status | `GET /v1/boxes/{box_id}/ssh` | `getSshStatus` | Returns `{ enabled, generation, listen_address, host_public_key, host_key_fingerprint }`. |
| Configure SSH | `POST /v1/boxes/{box_id}/ssh` | `configureSsh` | Body: `{ listen_address, host_private_key, accounts: [{ login, authorized_keys, ca }] }`. Restarts guest listener on every call. |
| Re-enable SSH | `POST /v1/boxes/{box_id}/ssh/enable` | `enableSsh` | Re-enables a previously configured SSH daemon (`generation > 0`). |
| Disable SSH | `DELETE /v1/boxes/{box_id}/ssh` | `disableSsh` | Stops and disables guest SSH. |
| Prepare one-shot tunnel | `POST /v1/boxes/{box_id}/network/tunnel?port=22` | `prepareTunnel` | Returns `{ uri }` for a single HTTP/1.1 `CONNECT` stream. |

### How the One-Shot `CONNECT` Tunnel Works

1. Ensure inbound & outbound networking are enabled on the box.
2. Call `POST /v1/boxes/{box_id}/network/tunnel?port=22` to receive a one-shot `uri` (e.g., `https://<tunnel-host>:443/...`).
3. Open a TLS connection to `<tunnel-host>:<port>` with ALPN `http/1.1`.
4. Send an HTTP/1.1 `CONNECT` handshake authenticated with `X-BoxLite-Authorization: Bearer <BOXLITE_API_KEY>`:
   ```http
   CONNECT <host>:<port> HTTP/1.1
   Host: <host>:<port>
   X-BoxLite-Authorization: Bearer <BOXLITE_API_KEY>

   ```
5. Once the proxy responds with `HTTP/1.1 200 ...` followed by `\r\n\r\n`, the TLS stream becomes a raw bidirectional byte stream directly to the guest's SSH port (e.g., you immediately receive the `SSH-2.0-...` banner).
6. Each prepared tunnel URI is **one-shot**; call `prepareTunnel` again for every new connection.

### PowerShell Examples

#### Configure, Check Status, Enable, and Disable Guest SSH

```powershell
$boxId = "your-box-id"

# Generate temporary Ed25519 host & client keys with OpenSSH ssh-keygen
ssh-keygen -t ed25519 -N '""' -f ".\box_host_key" | Out-Null
ssh-keygen -t ed25519 -N '""' -f ".\box_client_key" | Out-Null

$hostPrivateKey = Get-Content -Raw ".\box_host_key"
$clientPublicKey = (Get-Content -Raw ".\box_client_key.pub").Trim()

# Configure guest SSH (never auto-retry; each accepted call restarts the guest listener)
$sshStatus = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/ssh" -Body @{
    listen_address   = "127.0.0.1:22"
    host_private_key = $hostPrivateKey
    accounts         = @(
        @{
            login           = "root"
            authorized_keys = @($clientPublicKey)
            ca              = $null
        }
    )
} -TimeoutSec 60

$sshStatus | Format-List

# Check SSH status
Invoke-BoxLiteApi -Method GET -Path "/boxes/$boxId/ssh"

# Disable SSH
Invoke-BoxLiteApi -Method DELETE -Path "/boxes/$boxId/ssh"

# Re-enable previously configured SSH
Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/ssh/enable"
```

#### Open a Raw HTTP/1.1 `CONNECT` Tunnel Stream in PowerShell (.NET `SslStream`)

```powershell
$boxId = "your-box-id"
$port  = 22

# 1. Prepare a one-shot tunnel URI
$descriptor = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/network/tunnel?port=$port"
$tunnelUri  = [System.Uri]$descriptor.uri
$targetHost = $tunnelUri.Host
$targetPort = if ($tunnelUri.IsDefaultPort) { if ($tunnelUri.Scheme -eq 'https') { 443 } else { 80 } } else { $tunnelUri.Port }
$authority  = "${targetHost}:${targetPort}"

# 2. Connect TCP + TLS (forcing HTTP/1.1 via ALPN)
$tcp = [System.Net.Sockets.TcpClient]::new($targetHost, $targetPort)
$ssl = [System.Net.Security.SslStream]::new($tcp.GetStream(), $false)
$sslOpts = [System.Net.Security.SslClientAuthenticationOptions]::new()
$sslOpts.TargetHost = $targetHost
$sslOpts.ApplicationProtocols = [System.Collections.Generic.List[System.Net.Security.SslApplicationProtocol]]::new(
    @([System.Net.Security.SslApplicationProtocol]::Http11)
)
$ssl.AuthenticateAsClient($sslOpts)

# 3. Send HTTP/1.1 CONNECT request
$connectReq = "CONNECT $authority HTTP/1.1`r`nHost: $authority`r`nX-BoxLite-Authorization: Bearer $($env:BOXLITE_API_KEY.Trim())`r`n`r`n"
$reqBytes = [System.Text.Encoding]::ASCII.GetBytes($connectReq)
$ssl.Write($reqBytes, 0, $reqBytes.Length)
$ssl.Flush()

# 4. Read response headers until CRLFCRLF
$reader = [System.IO.StreamReader]::new($ssl, [System.Text.Encoding]::ASCII, $false, 1024, $true)
$statusLine = $reader.ReadLine()
Write-Host "Proxy response: $statusLine"
while (($hdr = $reader.ReadLine()) -ne "") { }

if ($statusLine -notmatch '^HTTP/\d(\.\d)?\s+2\d\d\b') {
    throw "CONNECT rejected: $statusLine"
}

# 5. Stream is now raw TCP to guest port 22 (read the SSH server banner)
$banner = $reader.ReadLine()
Write-Host "Guest SSH Banner: $banner"

$ssl.Dispose()
$tcp.Dispose()
```

---

## 7. Proxy Secrets Injection

BoxLite Cloud injects sensitive upstream credentials at the outbound TLS proxy so raw secrets **never enter the guest VM** (`src/bridge/python/bridge.py`, `src/util/validation.ts`).

### How It Works

1. Pass `secrets` in `POST /v1/boxes`:
   ```json
   {
     "name": "openai",
     "value": "sk-real-secret-value",
     "hosts": ["api.openai.com"],
     "headers": {
       "Authorization": "Bearer {value}"
     }
   }
   ```
2. Inside the box, pass the placeholder `<BOXLITE_SECRET:openai>` (for example, in `env` or request headers)—**never** the real credential.
3. When the guest makes an HTTPS request to a host in `hosts` with an existing header containing `<BOXLITE_SECRET:openai>` (e.g., `Authorization: Bearer <BOXLITE_SECRET:openai>`), the outbound proxy replaces the header using the `{value}` template.
4. **Requirements:**
   - `hosts` must be DNS hostnames only (e.g., `api.openai.com` or `*.example.com`)—no scheme, port, path, or IPv4.
   - `headers` must use `{value}` (not `<BOXLITE_SECRET:...>`).
   - Guest HTTP clients must trust the system CA bundle (`/etc/ssl/certs/ca-certificates.crt`).
   - The proxy only replaces **existing** headers; it does not add missing ones.

### PowerShell Example: Create a Box with a Proxy Secret & Verify Injection

```powershell
# Mirrors handle_verify_secret_injection in src/bridge/python/bridge.py
$testToken = "demo-not-a-real-key-" + [Guid]::NewGuid().ToString("N")

$created = Invoke-BoxLiteApi -Method POST -Path "/boxes" -Body @{
    image       = "python:alpine"
    auto_stop   = 0
    auto_resume = $true
    env         = @{
        DEMO_TOKEN = "<BOXLITE_SECRET:demo>"  # Placeholder only — never the real secret
    }
    secrets     = @(
        @{
            name    = "demo"
            value   = $testToken
            hosts   = @("httpbingo.org")
            headers = @{ Authorization = "Bearer {value}" }
        }
    )
} -TimeoutSec 120

$boxId = if ($created.box_id) { $created.box_id } else { $created.id }

try {
    Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/start" | Out-Null

    # 1. Confirm real token is NOT in guest environment
    $envCheck = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/exec" -Body @{
        command = "env"
        args    = @()
    }
    if ($envCheck.stdout -match [regex]::Escape($testToken)) {
        throw "FAIL: Secret leaked into guest environment!"
    }
    Write-Host "PASS: Guest environment does not contain raw secret."

    # 2. Send placeholder to httpbingo.org/headers and verify proxy injected the real token
    $pyCode = @'
import json, ssl, urllib.request
req = urllib.request.Request(
    "https://httpbingo.org/headers",
    headers={"Authorization": "Bearer <BOXLITE_SECRET:demo>"}
)
ctx = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")
with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
    print(r.read().decode())
'@
    $probe = Invoke-BoxLiteApi -Method POST -Path "/boxes/$boxId/exec" -Body @{
        command = "python"
        args    = @("-c", $pyCode)
    }

    $echoed = $probe.stdout | ConvertFrom-Json
    $authHeader = $echoed.headers.Authorization
    if ($authHeader -is [array]) { $authHeader = $authHeader[0] }

    if ($authHeader -eq "Bearer $testToken") {
        Write-Host "PASS: Upstream received injected Authorization header."
    } else {
        throw "FAIL: Unexpected Authorization header: $authHeader"
    }
}
finally {
    Invoke-BoxLiteApi -Method DELETE -Path "/boxes/$boxId?force=true" | Out-Null
}
```

---

## 8. Managed Volumes API

Persistent storage volumes that can be mounted into boxes at creation time.

### Endpoints

| Operation | Method & Path | Bridge Op | Notes |
|---|---|---|---|
| List volumes | `GET /v1/volumes` | `list_volumes` | Returns `{ volumes: [...] }` or array. |
| Create volume | `POST /v1/volumes` | `create_volume` | Body: `{ "name": "app-data" }` or `{}` for auto-generated name. |
| Inspect volume | `GET /v1/volumes/{volume_id}` | `inspect_volume` | Returns volume state, timestamps, and `size_bytes`. |
| Remove volume | `DELETE /v1/volumes/{volume_id}?force=true` | `remove_volume` | Optional `?force=true`. |

### Validation Rules (`src/util/validation.ts`)

- Volume names: 1–63 chars, must start with alphanumeric, only `[A-Za-z0-9_.-]`.
- Guest mount paths: absolute path starting with `/`, no `..`, cannot be `/`, `/proc`, `/sys`, or `/dev`.

### PowerShell Examples

```powershell
# Create a volume
$vol = Invoke-BoxLiteApi -Method POST -Path "/volumes" -Body @{
    name = "app-data"
}
$volId = if ($vol.id) { $vol.id } else { $vol.volume_id }
Write-Host "Created volume: $volId ($($vol.name))"

# List volumes
$volsResp = Invoke-BoxLiteApi -Method GET -Path "/volumes"
$volumes = if ($volsResp.volumes) { $volsResp.volumes } else { $volsResp }
$volumes | Select-Object id, name, state, size_bytes | Format-Table -AutoSize

# Inspect volume
Invoke-BoxLiteApi -Method GET -Path "/volumes/$volId"

# Mount volume into a new box
$boxWithVol = Invoke-BoxLiteApi -Method POST -Path "/boxes" -Body @{
    name    = "box-with-storage"
    image   = "python"
    volumes = @(
        @{
            managed_volume = $vol.name
            guest_path     = "/data"
            read_only      = $false
        }
    )
}

# Remove volume (use ?force=true if needed)
Invoke-BoxLiteApi -Method DELETE -Path "/volumes/$volId?force=true" | Out-Null
```

---

## 9. Images & Private Registries API

Manage custom OCI container images, quota usage, digest-pinned aliases, and private registry credentials.

> **Important:** Image names (e.g., `ghcr.io/acme/api:1.4.0`) and aliases **must be URL-encoded** (`[System.Uri]::EscapeDataString(...)`) when placed in path segments.

### Endpoints

| Operation | Method & Path | Bridge Op | Notes |
|---|---|---|---|
| List images | `GET /v1/images` | `list_images` | Returns `{ images: [...] }` (or `items`/`data`). |
| Get image usage | `GET /v1/images/usage` | `list_images` | Returns `{ count, limit, known_bytes }`. Built-in images (`base`, `python`, `node`, `sandbaseai-hermes`) do not count toward quota. |
| Inspect image | `GET /v1/images/{encoded_name}` | `inspect_image` | Returns `versions` (digests), `aliases`, and `history`. |
| Remove image | `DELETE /v1/images/{encoded_name}` | `remove_image` | Deletes image from org catalog. |
| Pin image alias | `POST /v1/images/{encoded_name}/aliases` | `create_image_alias` | Body: `{ "alias": "stable", "digest": "sha256:..." }`. |
| Delete image alias | `DELETE /v1/images/{encoded_name}/aliases/{encoded_alias}` | `delete_image_alias` | Removes an alias. |
| Add private registry | `POST /v1/images/registries` | `create_registry_login` | Body: `{ "registry_host", "username", "password", "repository_prefix"? }`. |

### Supported Registry Hosts & Prefix Rules (`src/util/validation.ts`)

- Allowed `registry_host`: `ghcr.io`, `docker.io`, `quay.io`, `gcr.io`, `us.gcr.io`, `eu.gcr.io`, `asia.gcr.io`.
- Optional `repository_prefix` **must** end with `/` and must not start with `/` (e.g., `"acme/"` or `"org/team/"`).
- `digest` must match `^sha256:[a-fA-F0-9]{64}$`.

### PowerShell Examples

```powershell
# List images and quota usage
$imagesResp = Invoke-BoxLiteApi -Method GET -Path "/images"
$usage      = Invoke-BoxLiteApi -Method GET -Path "/images/usage"
Write-Host "Quota: $($usage.count) / $($usage.limit) images ($($usage.known_bytes) bytes)"
$imagesResp.images | Format-Table -AutoSize

# Inspect an image (URL-encode the image reference)
$imageName = "ghcr.io/acme/api"
$encodedImage = [System.Uri]::EscapeDataString($imageName)
$detail = Invoke-BoxLiteApi -Method GET -Path "/images/$encodedImage"
$detail | ConvertTo-Json -Depth 10

# Pin an alias (e.g., "prod") to an exact sha256 digest
$digest = $detail.versions[0].digest
Invoke-BoxLiteApi -Method POST -Path "/images/$encodedImage/aliases" -Body @{
    alias  = "prod"
    digest = $digest
}

# Delete an image alias
$encodedAlias = [System.Uri]::EscapeDataString("prod")
Invoke-BoxLiteApi -Method DELETE -Path "/images/$encodedImage/aliases/$encodedAlias" | Out-Null

# Connect a private registry
Invoke-BoxLiteApi -Method POST -Path "/images/registries" -Body @{
    registry_host     = "ghcr.io"
    username          = "my-github-user"
    password          = $env:GHCR_PAT
    repository_prefix = "acme/"
}

# Remove an image from the catalog
Invoke-BoxLiteApi -Method DELETE -Path "/images/$encodedImage" | Out-Null
```

---

## 10. Checkpoints API

Capture point-in-time rootfs + configuration snapshots from stopped boxes, and restore single boxes or parallel worker fleets.

### Endpoints

| Operation | Method & Path | Bridge Op | Notes |
|---|---|---|---|
| List checkpoints | `GET /v1/checkpoints` | `list_checkpoints` | Paginated via `?pageToken=...` using `next_page_token` / `nextPageToken`. |
| Create checkpoint | `POST /v1/checkpoints` | `create_checkpoint` | Body: `{ "source_box_id": "...", "name": "..." }`. |
| Inspect checkpoint | `GET /v1/checkpoints/{encoded_key}` | `inspect_checkpoint` | Key can be checkpoint ID or name. |
| Remove checkpoint | `DELETE /v1/checkpoints/{encoded_key}?force=true` | `remove_checkpoint` | Optional `?force=true`. |

### Checkpoint Constraints (`src/util/diagnosis.ts`, `src/util/validation.ts`)

- The source box **must be stopped** before creating a checkpoint and kept intact until the checkpoint reaches `ready`.
- The source box **cannot** have attached managed volumes or proxy secrets.
- When restoring a box from a checkpoint (`POST /v1/boxes`), pass **only** `checkpoint_id` and optional `name`.

### PowerShell Examples

```powershell
# 1. Create a checkpoint from a stopped box
$cp = Invoke-BoxLiteApi -Method POST -Path "/checkpoints" -Body @{
    source_box_id = "your-stopped-box-id"
    name          = "golden-worker-v1"
} -TimeoutSec 60
$cpKey = if ($cp.id) { $cp.id } else { $cp.checkpoint_id }
Write-Host "Checkpoint $cpKey state: $($cp.state)"

# 2. List all checkpoints (handling pagination)
$allCheckpoints = @()
$pageToken = $null
do {
    $path = if ($pageToken) {
        "/checkpoints?pageToken=$([System.Uri]::EscapeDataString($pageToken))"
    } else {
        "/checkpoints"
    }
    $page = Invoke-BoxLiteApi -Method GET -Path $path
    if ($page.checkpoints) { $allCheckpoints += $page.checkpoints }
    $pageToken = if ($page.next_page_token) { $page.next_page_token } else { $page.nextPageToken }
} while ($pageToken)
$allCheckpoints | Select-Object id, name, source_box_id, state, size_bytes | Format-Table -AutoSize

# 3. Inspect a checkpoint
$encodedKey = [System.Uri]::EscapeDataString($cpKey)
Invoke-BoxLiteApi -Method GET -Path "/checkpoints/$encodedKey"

# 4. Fork a 3-worker fleet from the checkpoint (ONLY checkpoint_id + optional name)
1..3 | ForEach-Object {
    $worker = Invoke-BoxLiteApi -Method POST -Path "/boxes" -Body @{
        checkpoint_id = $cpKey
        name          = "worker-$_"
    }
    $workerId = if ($worker.box_id) { $worker.box_id } else { $worker.id }
    Invoke-BoxLiteApi -Method POST -Path "/boxes/$workerId/start" | Out-Null
    Write-Host "Started worker-$_ ($workerId)"
}

# 5. Delete a checkpoint
Invoke-BoxLiteApi -Method DELETE -Path "/checkpoints/$encodedKey?force=true" | Out-Null
```

---

## 11. Custom Domains API

Register custom FQDNs, verify DNS ownership, and bind/unbind domains to a box and port.

### Endpoints

| Operation | Method & Path | Bridge Op | Notes |
|---|---|---|---|
| List domains | `GET /v1/domains` | `list_domains` | Paginated via `?pageToken=...` using `next_page_token` / `nextPageToken`. |
| Create domain | `POST /v1/domains` | `create_domain` | Body: `{ "domain": "app.example.com", "box_id"?: "...", "port"?: 8080 }`. |
| Inspect domain | `GET /v1/domains/{encoded_key}` | `inspect_domain` | Returns status, DNS verification record, `cname_target`, `tls_status`. |
| Verify DNS | `POST /v1/domains/{encoded_key}/verify` | `verify_domain` | Body: `{}`. Triggers DNS verification check. |
| Update binding | `PATCH /v1/domains/{encoded_key}` | `update_domain` | Body: `{ "box_id": "..." \| null, "port": 8080 }`. |
| Remove domain | `DELETE /v1/domains/{encoded_key}` | `remove_domain` | Deletes the custom domain. |

### Validation Rules (`src/util/validation.ts`)

- Must be a valid FQDN (e.g., `app.example.com`). Wildcards (`*.example.com`), schemes, ports, paths, and IP addresses are rejected.

### PowerShell Examples

```powershell
# 1. Register a custom domain (optionally bound to a box & port immediately)
$dom = Invoke-BoxLiteApi -Method POST -Path "/domains" -Body @{
    domain = "app.example.com"
    box_id = "your-box-id"
    port   = 8080
}
$domKey = if ($dom.id) { $dom.id } else { $dom.domain }
Write-Host "Add DNS record: $($dom.verification_record_name) -> $($dom.verification_record_value)"
Write-Host "CNAME target:   $($dom.cname_target)"

# 2. List all domains (handling pagination)
$allDomains = @()
$pageToken = $null
do {
    $path = if ($pageToken) {
        "/domains?pageToken=$([System.Uri]::EscapeDataString($pageToken))"
    } else {
        "/domains"
    }
    $page = Invoke-BoxLiteApi -Method GET -Path $path
    $items = if ($page.domains) { $page.domains } else { $page.items }
    if ($items) { $allDomains += $items }
    $pageToken = if ($page.next_page_token) { $page.next_page_token } else { $page.nextPageToken }
} while ($pageToken)
$allDomains | Select-Object id, domain, status, box_id, port, tls_status | Format-Table -AutoSize

# 3. Trigger DNS verification
$encodedDom = [System.Uri]::EscapeDataString($domKey)
Invoke-BoxLiteApi -Method POST -Path "/domains/$encodedDom/verify" -Body @{}

# 4. Rebind domain to a different box/port (or pass $null to unbind)
Invoke-BoxLiteApi -Method PATCH -Path "/domains/$encodedDom" -Body @{
    box_id = "other-box-id"
    port   = 3000
}

# 5. Inspect & Delete domain
Invoke-BoxLiteApi -Method GET -Path "/domains/$encodedDom"
Invoke-BoxLiteApi -Method DELETE -Path "/domains/$encodedDom" | Out-Null
```

---

## 12. Local Python Bridge Protocol (JSON-Lines)

If you want to call the extension's Python sidecar (`src/bridge/python/bridge.py`) directly from PowerShell—which automatically uses the official `boxlite==0.11.0` SDK if installed and falls back to REST otherwise—send newline-delimited `BridgeRequest` JSON objects on `stdin` and read `BridgeResponse` JSON objects from `stdout`.

### Wire Format (`src/bridge/protocol.ts`)

**Request:**
```json
{ "id": "req_1", "op": "list_boxes", "args": {} }
```

**Response:**
```json
{
  "id": "req_1",
  "success": true,
  "data": { "boxes": [] },
  "error": null
}
```

### Supported `op` Values

- **Health / Auth:** `ping`, `check_credentials`
- **Boxes:** `list_boxes`, `inspect_box`, `create_box`, `start_box`, `stop_box`, `remove_box`
- **Exec / Logs / Files:** `exec`, `tail_log`, `copy_in`
- **Networking / Tunnels:** `tunnel`, `revoke_tunnel`, `update_inbound`, `update_outbound`
- **Volumes:** `list_volumes`, `create_volume`, `inspect_volume`, `remove_volume`
- **Images:** `list_images`, `inspect_image`, `remove_image`, `create_image_alias`, `delete_image_alias`, `create_registry_login`
- **Checkpoints:** `list_checkpoints`, `create_checkpoint`, `inspect_checkpoint`, `remove_checkpoint`
- **Secrets:** `verify_secret_injection`
- **Domains:** `list_domains`, `create_domain`, `inspect_domain`, `verify_domain`, `update_domain`, `remove_domain`

### PowerShell Example: Calling `bridge.py` Directly

```powershell
$env:BOXLITE_API_KEY  = "bl_live_your_api_key_here"
$env:BOXLITE_REST_URL = "https://api.boxlite.ai"
$env:PYTHONUNBUFFERED = "1"
$env:PYTHONUTF8       = "1"

$requests = @(
    @{ id = "req_1"; op = "ping"; args = @{} }
    @{ id = "req_2"; op = "list_boxes"; args = @{} }
) | ForEach-Object { $_ | ConvertTo-Json -Depth 10 -Compress }

$responses = $requests | python ".\src\bridge\python\bridge.py"
$responses | ForEach-Object { $_ | ConvertFrom-Json } | ConvertTo-Json -Depth 10
```

---

## 13. Error Handling & Diagnostics

Common HTTP status codes and how `src/util/diagnosis.ts` and `src/bridge/python/bridge.py` classify them:

| Status / Error | Meaning | Remediation |
|---|---|---|
| `400 Bad Request` | Schema validation failure | Remove deprecated fields like `auto_remove`; ensure `auto_stop` is `0` or `>= 60`; check `isPublic` camelCase on private tunnels. |
| `401 Unauthorized` | Missing or invalid `BOXLITE_API_KEY` | Verify `Authorization: Bearer <key>` and target `BOXLITE_REST_URL`. |
| `403 Forbidden` | Insufficient permissions or missing private tunnel token | Ensure API key has Full access for private registries/images; pass `X-BoxLite-Access-Token` for private tunnels. |
| `404 Not Found` | Resource ID/key does not exist | Verify `box_id`, `volume_id`, URL-encoded image name, checkpoint key, or domain key. |
| `409 Conflict` | Name collision or lifecycle conflict | Box name already exists, source box not stopped for checkpoint, or PID 1 already exited. |
| `502 Bad Gateway` / Unreachable | Guest service not reachable through proxy | Ensure app listens on `0.0.0.0` (not `127.0.0.1`), check `/tmp/server.log`, and verify inbound/outbound networking is enabled. |
| `Box networking is disabled` | No guest NIC provisioned at creation | Box was created with `outbound.mode = "disabled"`; create a new box with outbound networking enabled. |

### PowerShell Error-Handling Pattern

```powershell
try {
    Invoke-BoxLiteApi -Method GET -Path "/boxes/nonexistent-id"
}
catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    $errDetails = $_.ErrorDetails.Message
    Write-Error "BoxLite API failed (HTTP $statusCode): $errDetails"
}
```
