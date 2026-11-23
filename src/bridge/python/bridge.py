#!/usr/bin/env python3
"""
BoxLite VS Code Extension Python Sidecar Bridge
Interacts with the BoxLite Cloud via Python SDK `boxlite==0.11.0` or
fallback REST client when the native wheel is not installed (e.g. Windows).
Communicates with the VS Code extension host over standard I/O using JSON-lines.
"""

import asyncio
import json
import os
import re
import secrets as py_secrets
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional

# Ensure standard output and input are UTF-8 encoded and unbuffered
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(line_buffering=True, encoding="utf-8")
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")


_UNSET = object()


def log_debug(msg: str):
    sys.stderr.write(f"[boxlite-bridge] {msg}\n")
    sys.stderr.flush()


def send_response(req_id: str, success: bool, data: Any = None, error: Optional[Dict[str, Any]] = None):
    payload = {
        "id": req_id,
        "success": success,
        "data": data,
        "error": error
    }
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def extract_box_status(info: Any) -> str:
    if not info:
        return "unknown"
    if isinstance(info, dict):
        state_val = info.get("state")
        raw = info.get("status") or (state_val.get("status") if isinstance(state_val, dict) else state_val)
    else:
        state_attr = getattr(info, "state", None)
        raw = getattr(state_attr, "status", None) if state_attr is not None else getattr(info, "status", None)

    raw_str = str(getattr(raw, "value", getattr(raw, "name", raw))).lower() if raw else "unknown"
    if "." in raw_str:
        raw_str = raw_str.split(".")[-1]
    return raw_str.strip() or "unknown"


_BUILTIN_IMAGES = ("base", "python", "node", "sandbaseai-hermes")


def _canonical_catalog_image_name(image_ref: str) -> str:
    raw = (image_ref or "").strip()
    if not raw:
        return ""
    lower_raw = raw.lower()
    if "/" not in raw and ":" not in raw and "@" not in raw and lower_raw in _BUILTIN_IMAGES:
        return lower_raw

    name_and_tag = raw.split("@", 1)[0]
    last_slash = name_and_tag.rfind("/")
    colon_idx = name_and_tag.find(":", last_slash + 1)
    name_part = name_and_tag[:colon_idx] if colon_idx != -1 else name_and_tag

    segments = [s for s in name_part.split("/") if s]
    if not segments:
        return ""
    if len(segments) == 1:
        return f"docker.io/library/{segments[0].lower()}"

    first = segments[0]
    if "." in first or ":" in first or first.lower() == "localhost":
        norm_first = first.lower()
        registry = "docker.io" if norm_first in ("index.docker.io", "registry-1.docker.io") else norm_first
        rest = [s.lower() for s in segments[1:]]
        if registry == "docker.io" and len(rest) == 1:
            repository = f"library/{rest[0]}"
        else:
            repository = "/".join(rest)
    else:
        registry = "docker.io"
        repository = "/".join(s.lower() for s in segments)

    return f"{registry}/{repository}" if repository else ""


def _is_not_found_error(err: Exception) -> bool:
    lower = str(err).lower()
    return "404" in lower or "not found" in lower


def _is_image_pull_error(message: str) -> bool:
    lower = (message or "").lower()
    return (
        "failed to pull image" in lower
        or "refused the pull" in lower
        or "no registry login" in lower
        or "manifest unknown" in lower
        or "pull access denied" in lower
        or "repository does not exist" in lower
        or ("box state transition failed" in lower and ("pull" in lower or "image" in lower))
    )


def _is_image_catalog_limit_error(message: str) -> bool:
    lower = (message or "").lower()
    return ("image" in lower or "catalog" in lower) and (
        "limit" in lower or "quota" in lower or "20 images" in lower or "maximum" in lower
    )


class TunnelResultFallback:
    def __init__(self, data: Dict[str, Any]):
        self._uri = data.get("uri") or data.get("url")
        self._is_public = data.get("is_public", data.get("isPublic", True))
        self._token = data.get("token")

    def uri(self) -> Optional[str]:
        return self._uri

    def is_public(self) -> bool:
        return self._is_public

    def token(self) -> Optional[str]:
        return self._token


class ExecResultFallback:
    def __init__(self, exit_code: int = 0, stdout: str = "", stderr: str = ""):
        self.exit_code = exit_code
        self.stdout = stdout
        self.stderr = stderr


class RestNetworkHandleFallback:
    def __init__(self, runtime: "RestRuntimeFallback", box_id: str):
        self.rt = runtime
        self.box_id = box_id

    async def revoke_tunnel(self, port: int):
        return await self.rt.revoke_tunnel(self.box_id, port)

    async def update_inbound(self, spec: Any):
        mode = getattr(spec, "mode", spec if isinstance(spec, str) else "enabled")
        return await self.rt.update_inbound(self.box_id, mode)

    async def update_outbound(self, spec: Any):
        mode = getattr(spec, "mode", "enabled")
        allow_net = getattr(spec, "allow_net", [])
        return await self.rt.update_outbound(self.box_id, mode, allow_net)


class RestBoxFallback:
    def __init__(self, runtime: "RestRuntimeFallback", box_id: str, name: str):
        self.rt = runtime
        self.id = box_id
        self.name = name
        self.network = RestNetworkHandleFallback(runtime, box_id)

    async def start(self):
        return await self.rt.start(self.id)

    async def stop(self):
        return await self.rt.stop(self.id)

    async def inspect(self):
        return await self.rt.inspect(self.id)

    async def exec(self, *cmd):
        if len(cmd) == 2 and isinstance(cmd[1], (list, tuple)):
            cmd_list = [cmd[0]] + list(cmd[1])
        else:
            cmd_list = list(cmd)
        return await self.rt.exec(self.id, cmd_list)

    async def copy_in(self, source: str, destination: str):
        return await self.rt.copy_in(self.id, source, destination)

    async def tunnel(self, target: Any, options: Any = None):
        port = target[1] if isinstance(target, (tuple, list)) else int(target)
        is_public = getattr(options, "is_public", True) if options is not None else True
        res = await self.rt.tunnel(self.id, port, is_public)
        return TunnelResultFallback(res)


_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1", "[::1]"}
_SAFE_VERIFY_HOST_RE = re.compile(
    r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)


def _assert_secure_rest_url(raw_url: str) -> str:
    cleaned = (raw_url or "").strip().rstrip("/")
    parsed = urllib.parse.urlparse(cleaned)
    if parsed.scheme == "https":
        if not parsed.netloc:
            raise ValueError(f"Invalid REST URL: '{raw_url}'")
        return cleaned
    if parsed.scheme == "http":
        host = (parsed.hostname or "").lower()
        if host in _LOOPBACK_HOSTS:
            return cleaned
        raise ValueError(
            f"Insecure http:// REST URL is only allowed for loopback hosts (127.0.0.1, localhost, ::1); use https:// instead ('{host}')."
        )
    raise ValueError(f"Unsupported REST URL scheme: '{parsed.scheme}'")


class RestRuntimeFallback:
    """Pure-Python REST client for BoxLite Cloud when native boxlite package is not installed."""

    def __init__(self, rest_url: str, api_key: str):
        self.rest_url = _assert_secure_rest_url(rest_url)
        self.api_key = api_key

    def _request(self, method: str, path: str, body: Any = None, timeout: int = 30) -> Any:
        url = f"{self.rest_url}/v1{path}"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "rc-boxlite-vscode/0.1.0"
        }
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                content = resp.read().decode("utf-8")
                if content:
                    return json.loads(content)
                return {}
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            err_code = None
            try:
                err_json = json.loads(err_body)
                if isinstance(err_json, dict):
                    raw_err = err_json.get("error")
                    err_code = err_json.get("code") or (raw_err.get("code") if isinstance(raw_err, dict) else None)
                    raw_msg = err_json.get("message")
                    if isinstance(raw_msg, list):
                        msg = "; ".join(str(m) for m in raw_msg)
                    elif raw_msg:
                        msg = str(raw_msg)
                    elif isinstance(raw_err, str):
                        msg = raw_err
                    elif isinstance(raw_err, dict) and raw_err.get("message"):
                        msg = str(raw_err["message"])
                    else:
                        msg = str(e)
                else:
                    msg = str(e)
            except Exception:
                msg = f"HTTP {e.code}: {err_body or e.reason}"
            code_tag = f" [{err_code}]" if err_code else ""
            raise RuntimeError(f"BoxLite Cloud API error ({e.code}){code_tag}: {msg}")
        except urllib.error.URLError as e:
            raise RuntimeError(f"NetworkError connecting to BoxLite Cloud ({self.rest_url}): {e.reason}")

    async def list(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/boxes")
        if isinstance(res, dict) and "boxes" in res:
            return res["boxes"]
        if isinstance(res, list):
            return res
        return []

    async def list_info(self) -> List[Dict[str, Any]]:
        return await self.list()

    async def inspect(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        return await loop.run_in_executor(None, self._request, "GET", f"/boxes/{encoded_id}")

    async def create(self, **kwargs) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, lambda: self._request("POST", "/boxes", kwargs, timeout=120))

    async def start(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        return await loop.run_in_executor(None, lambda: self._request("POST", f"/boxes/{encoded_id}/start", timeout=120))

    async def stop(self, box_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        return await loop.run_in_executor(None, self._request, "POST", f"/boxes/{encoded_id}/stop")

    async def remove(self, box_id: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        path = f"/boxes/{encoded_id}?force=true" if force else f"/boxes/{encoded_id}"
        await loop.run_in_executor(None, self._request, "DELETE", path)

    async def exec(self, box_id: str, cmd: List[str]) -> ExecResultFallback:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        command = cmd[0] if cmd else "sh"
        args = list(cmd[1:]) if len(cmd) > 1 else []
        body = {"command": command, "args": args}
        res = await loop.run_in_executor(None, self._request, "POST", f"/boxes/{encoded_id}/exec", body)
        if not isinstance(res, dict):
            return ExecResultFallback(exit_code=0, stdout=str(res) if res is not None else "", stderr="")
        stdout = res.get("stdout") or res.get("stdOut") or res.get("output") or ""
        stderr = res.get("stderr") or res.get("stdErr") or ""
        if isinstance(res.get("result"), dict):
            stdout = stdout or res["result"].get("stdout") or res["result"].get("output") or ""
            stderr = stderr or res["result"].get("stderr") or ""
        exit_code = res.get("exit_code", res.get("exitCode", res.get("result", {}).get("exit_code", 0) if isinstance(res.get("result"), dict) else 0))
        return ExecResultFallback(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr
        )

    async def copy_in(self, box_id: str, source: str, destination: str) -> bool:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        try:
            body = {"source": source, "destination": destination}
            await loop.run_in_executor(None, self._request, "POST", f"/boxes/{encoded_id}/copy-in", body)
            return True
        except Exception as e:
            raise RuntimeError(
                f"File copy_in failed in REST fallback: {e}. "
                "Local-to-cloud file uploads require the official 'boxlite' native SDK wheel (boxlite==0.11.0). "
                "Please configure a supported Python environment (Linux/macOS or WSL) to deploy local directories."
            )

    async def tunnel(self, box_id: str, port: int, is_public: bool) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        valid_port = int(port)
        if valid_port < 1 or valid_port > 65535:
            raise ValueError(f"Invalid tunnel port: {port}")
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        path = f"/boxes/{encoded_id}/network/tunnel?port={valid_port}"
        # OpenAPI schema requires camelCase 'isPublic' and additionalProperties: false
        body = {"isPublic": is_public} if not is_public else None
        res = await loop.run_in_executor(None, self._request, "POST", path, body)
        return res

    async def revoke_tunnel(self, box_id: str, port: int) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        valid_port = int(port)
        if valid_port < 1 or valid_port > 65535:
            raise ValueError(f"Invalid tunnel port: {port}")
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        path = f"/boxes/{encoded_id}/network/tunnel?port={valid_port}"
        await loop.run_in_executor(None, self._request, "DELETE", path)
        return {"revoked": True}

    async def update_inbound(self, box_id: str, mode: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        body = {"mode": mode, "allow_net": []}
        await loop.run_in_executor(None, self._request, "PUT", f"/boxes/{encoded_id}/network/inbound", body)
        return {"mode": mode}

    async def update_outbound(self, box_id: str, mode: str, allow_net: List[str]) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(box_id), safe="")
        body = {"mode": mode, "allow_net": allow_net}
        await loop.run_in_executor(None, self._request, "PUT", f"/boxes/{encoded_id}/network/outbound", body)
        return {"mode": mode, "allow_net": allow_net}

    async def list_volumes(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/volumes")
        if isinstance(res, dict) and "volumes" in res:
            return res["volumes"]
        if isinstance(res, list):
            return res
        return []

    async def get_volume(self, volume_id: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(volume_id), safe="")
        return await loop.run_in_executor(None, self._request, "GET", f"/volumes/{encoded_id}")

    async def create_volume(self, name: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {"name": name} if name else {}
        return await loop.run_in_executor(None, self._request, "POST", "/volumes", body)

    async def remove_volume(self, volume_id: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        encoded_id = urllib.parse.quote(str(volume_id), safe="")
        path = f"/volumes/{encoded_id}?force=true" if force else f"/volumes/{encoded_id}"
        await loop.run_in_executor(None, self._request, "DELETE", path)

    async def list_images(self) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/images")
        if isinstance(res, dict):
            raw_images = res.get("images")
            if not isinstance(raw_images, list):
                raw_images = (
                    res.get("items")
                    if isinstance(res.get("items"), list)
                    else (res.get("data") if isinstance(res.get("data"), list) else [])
                )
            images = raw_images
        elif isinstance(res, list):
            images = res
        else:
            images = []
        usage = None
        try:
            usage_res = await loop.run_in_executor(None, self._request, "GET", "/images/usage")
            if isinstance(usage_res, dict):
                usage = usage_res
        except Exception:
            pass
        return {"images": images, "usage": usage}

    async def get_image(self, name: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_name = urllib.parse.quote(name, safe="")
        return await loop.run_in_executor(None, self._request, "GET", f"/images/{encoded_name}")

    async def remove_image(self, name: str) -> None:
        loop = asyncio.get_running_loop()
        encoded_name = urllib.parse.quote(name, safe="")
        await loop.run_in_executor(None, self._request, "DELETE", f"/images/{encoded_name}")

    async def create_image_alias(self, name: str, alias: str, digest: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_name = urllib.parse.quote(name, safe="")
        body = {"alias": alias, "digest": digest}
        return await loop.run_in_executor(None, self._request, "POST", f"/images/{encoded_name}/aliases", body)

    async def delete_image_alias(self, name: str, alias: str) -> None:
        loop = asyncio.get_running_loop()
        encoded_name = urllib.parse.quote(name, safe="")
        encoded_alias = urllib.parse.quote(alias, safe="")
        await loop.run_in_executor(None, self._request, "DELETE", f"/images/{encoded_name}/aliases/{encoded_alias}")

    async def create_registry_login(self, registry_host: str, username: str, password: str, repository_prefix: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body = {
            "registry_host": registry_host,
            "username": username,
            "password": password
        }
        if repository_prefix:
            body["repository_prefix"] = repository_prefix
        return await loop.run_in_executor(None, self._request, "POST", "/images/registries", body)

    async def list_checkpoints(self) -> List[Dict[str, Any]]:
        loop = asyncio.get_running_loop()
        checkpoints: List[Dict[str, Any]] = []
        page_token: Optional[str] = None
        while True:
            path = "/checkpoints"
            if page_token:
                path = f"/checkpoints?pageToken={urllib.parse.quote(page_token, safe='')}"
            res = await loop.run_in_executor(None, self._request, "GET", path)
            if isinstance(res, dict):
                page_items = res.get("checkpoints")
                if isinstance(page_items, list):
                    checkpoints.extend(page_items)
                next_token = res.get("next_page_token") or res.get("nextPageToken")
                if not next_token:
                    break
                page_token = next_token
            elif isinstance(res, list):
                checkpoints.extend(res)
                break
            else:
                break
        return checkpoints

    async def get_checkpoint(self, key: str) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        encoded_key = urllib.parse.quote(key, safe="")
        return await loop.run_in_executor(None, self._request, "GET", f"/checkpoints/{encoded_key}")

    async def create_checkpoint(self, source_box_id: str, name: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        body: Dict[str, Any] = {"source_box_id": source_box_id}
        if name:
            body["name"] = name
        return await loop.run_in_executor(None, self._request, "POST", "/checkpoints", body)

    async def remove_checkpoint(self, key: str, force: bool = False) -> None:
        loop = asyncio.get_running_loop()
        encoded_key = urllib.parse.quote(key, safe="")
        path = f"/checkpoints/{encoded_key}?force=true" if force else f"/checkpoints/{encoded_key}"
        await loop.run_in_executor(None, self._request, "DELETE", path)

    def _normalize_domain_key(self, key: str) -> str:
        return (key or "").strip().rstrip(".").lower()

    async def list_domains_with_allowance(self) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, self._request, "GET", "/domains")
        allowance: Optional[Dict[str, Any]] = None
        if isinstance(res, dict):
            domains = res.get("domains")
            if not isinstance(domains, list):
                domains = res.get("items") if isinstance(res.get("items"), list) else []
            if any(k in res for k in ("limit", "used", "remaining")):
                allowance = {
                    "limit": int(res.get("limit", 0)),
                    "used": int(res.get("used", 0)),
                    "remaining": int(res.get("remaining", 0)),
                    "minLength": int(res.get("min_length", res.get("minLength", 1))),
                    "domainSuffix": res.get("domain_suffix", res.get("domainSuffix")),
                }
            return {"domains": domains, "allowance": allowance}
        if isinstance(res, list):
            return {"domains": res, "allowance": None}
        return {"domains": [], "allowance": None}

    async def list_domains(self) -> List[Dict[str, Any]]:
        res = await self.list_domains_with_allowance()
        return res["domains"]

    async def claim_domain(self, name: str, domain_suffix: Optional[str] = None) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        short_name = self._normalize_domain_key(name)
        suffixes: List[str] = []
        if domain_suffix:
            cleaned = domain_suffix.strip().lstrip(".").lower()
            if cleaned:
                suffixes.append(cleaned)
        if "boxliteapp.com" not in suffixes:
            suffixes.append("boxliteapp.com")
        for suffix in suffixes:
            marker = f".{suffix}"
            if short_name.endswith(marker):
                short_name = short_name[: -len(marker)]
                break
        if not short_name:
            raise ValueError("Domain short name cannot be empty.")
        return await loop.run_in_executor(None, self._request, "POST", "/domains", {"name": short_name})

    async def create_domain(self, domain: str, box_id: Optional[str] = None, port: Optional[int] = None) -> Dict[str, Any]:
        claimed = await self.claim_domain(domain)
        if box_id and port is not None:
            hostname = claimed.get("hostname") or claimed.get("domain") or domain
            return await self.bind_domain(str(hostname), str(box_id), int(port))
        return claimed

    async def bind_domain(self, domain: str, box_id: str, port: int) -> Dict[str, Any]:
        loop = asyncio.get_running_loop()
        hostname = self._normalize_domain_key(domain)
        if "." not in hostname:
            raise ValueError(f"Bind requires a full hostname (e.g. my-service.boxliteapp.com), got '{domain}'.")
        encoded_domain = urllib.parse.quote(hostname, safe="")
        body = {"type": "box", "box": str(box_id), "port": int(port)}
        return await loop.run_in_executor(None, self._request, "PUT", f"/domains/{encoded_domain}/target", body)

    async def unbind_domain(self, domain: str) -> None:
        loop = asyncio.get_running_loop()
        hostname = self._normalize_domain_key(domain)
        if "." not in hostname:
            raise ValueError(f"Unbind requires a full hostname (e.g. my-service.boxliteapp.com), got '{domain}'.")
        encoded_domain = urllib.parse.quote(hostname, safe="")
        await loop.run_in_executor(None, self._request, "DELETE", f"/domains/{encoded_domain}/target")

    async def get_domain(self, key: str) -> Dict[str, Any]:
        normalized_key = self._normalize_domain_key(key)
        res = await self.list_domains_with_allowance()
        for item in res["domains"]:
            if not isinstance(item, dict):
                continue
            item_host = self._normalize_domain_key(
                item.get("hostname") or item.get("domain") or item.get("name") or item.get("id") or ""
            )
            item_id = self._normalize_domain_key(item.get("id") or "")
            if normalized_key and (item_host == normalized_key or item_id == normalized_key):
                out = dict(item)
                if res.get("allowance") is not None:
                    out["allowance"] = res["allowance"]
                return out
        raise RuntimeError(
            f"BoxLite Cloud API error (404) [domain_not_owned]: This organization does not own {normalized_key}. "
            "Request a domain in Dashboard > Domains before binding."
        )

    def probe_domain_url(self, url: str, timeout: int = 10) -> Dict[str, Any]:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("https", "http"):
            raise ValueError(f"Unsupported domain URL scheme: {url}")
        headers = {
            "X-BoxLite-Skip-Preview-Warning": "true",
            "User-Agent": "rc-boxlite-vscode/0.1.0",
        }
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                resp.read(1024)
                return {"http_status": int(resp.status), "error": None}
        except urllib.error.HTTPError as e:
            return {"http_status": int(e.code), "error": None}
        except (urllib.error.URLError, OSError) as e:
            return {"http_status": None, "error": str(getattr(e, "reason", e))}

    async def verify_domain(self, key: str) -> Dict[str, Any]:
        return await self.get_domain(key)

    async def update_domain(self, key: str, box_id: Any = _UNSET, port: Any = _UNSET) -> Dict[str, Any]:
        hostname = self._normalize_domain_key(key)
        if box_id is None or box_id == "":
            await self.unbind_domain(hostname)
            return {"hostname": hostname, "url": f"https://{hostname}", "target": None}
        if box_id is _UNSET:
            raise ValueError("box_id is required to bind a domain.")
        if port is _UNSET or port is None:
            raise ValueError("port is required to bind a domain.")
        return await self.bind_domain(hostname, str(box_id), int(port))

    async def remove_domain(self, key: str) -> None:
        raise RuntimeError(
            "BoxLite Cloud /v1/domains does not support deleting reserved domains. "
            "Use 'Unbind Domain' (DELETE /v1/domains/{domain}/target) to stop routing while keeping the hostname reserved, "
            "or manage custom domains in BoxLite Console (https://app.boxlite.ai)."
        )


class BoxLiteBridge:
    def __init__(self):
        self.rt = None
        self.boxes: Dict[str, Any] = {}
        self.box_secrets: Dict[str, List[Dict[str, Any]]] = {}

    def _redact_secrets(self, raw_secrets: Any) -> List[Dict[str, Any]]:
        if not raw_secrets or not isinstance(raw_secrets, list):
            return []
        redacted: List[Dict[str, Any]] = []
        for s in raw_secrets:
            if isinstance(s, dict):
                s_name = s.get("name") or ""
                s_hosts = list(s.get("hosts") or [])
                s_headers = dict(s.get("headers") or {"Authorization": "Bearer {value}"})
            else:
                s_name = getattr(s, "name", "") or ""
                s_hosts = list(getattr(s, "hosts", []) or [])
                s_headers = dict(getattr(s, "headers", None) or {"Authorization": "Bearer {value}"})
            if s_name:
                redacted.append({
                    "name": s_name,
                    "hosts": s_hosts,
                    "headers": s_headers
                })
        return redacted

    def _format_secrets_payload(self, raw_secrets: Any) -> List[Dict[str, Any]]:
        if not raw_secrets or not isinstance(raw_secrets, list):
            return []
        formatted: List[Dict[str, Any]] = []
        for s in raw_secrets:
            if not isinstance(s, dict):
                continue
            name = (s.get("name") or "").strip()
            value = s.get("value") or ""
            hosts = [str(h).strip() for h in (s.get("hosts") or []) if str(h).strip()]
            headers = dict(s.get("headers") or {"Authorization": "Bearer {value}"})
            if name and value:
                formatted.append({
                    "name": name,
                    "value": value,
                    "hosts": hosts,
                    "headers": headers
                })
        return formatted

    def ensure_runtime(self):
        if self.rt is not None:
            return self.rt

        api_key = os.environ.get("BOXLITE_API_KEY")
        rest_url = os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai")
        if not api_key:
            raise ValueError("BOXLITE_API_KEY environment variable is not set. Use 'BoxLite: Sign In / Set API Key' to configure.")

        try:
            import boxlite
            # Use official Boxlite.rest with environment options
            self.rt = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions.from_env())
            log_debug("Initialized official boxlite SDK runtime.")
            return self.rt
        except (ImportError, Exception) as e:
            log_debug(f"Official boxlite SDK not available ({e}); using built-in REST client for {rest_url}.")
            self.rt = RestRuntimeFallback(rest_url, api_key)
            return self.rt

    def _rest_fallback(self, rt: Any) -> RestRuntimeFallback:
        if isinstance(rt, RestRuntimeFallback):
            return rt
        return RestRuntimeFallback(
            os.environ.get("BOXLITE_REST_URL", "https://api.boxlite.ai"),
            os.environ.get("BOXLITE_API_KEY", "")
        )

    def _build_rest_create_kwargs(
        self,
        *,
        image: Optional[str],
        name: Optional[str],
        auto_stop: Any,
        auto_delete: Any,
        auto_resume: Any,
        cpus: Any,
        memory_mib: Any,
        disk_size_gb: Any,
        env: Any,
        cmd: Any,
        entrypoint: Any,
        network_spec: Any,
        volumes: Any,
        secrets_payload: Any,
    ) -> Dict[str, Any]:
        # BoxLite Cloud REST API conforms to OpenAPI CreateBoxRequest.
        # 'auto_remove' is deprecated/client-side and MUST NOT be sent across the wire.
        kwargs: Dict[str, Any] = {
            "image": image or "python",
        }
        if name:
            kwargs["name"] = name
        if auto_stop is not None:
            # Boxlite Cloud requires auto_stop to be 0 (disabled) or >= 60 seconds
            kwargs["auto_stop"] = 60 if 0 < auto_stop < 60 else auto_stop
        if auto_delete is not None and auto_delete > 0:
            kwargs["auto_delete"] = auto_delete
        if auto_resume is not None:
            kwargs["auto_resume"] = auto_resume
        if cpus is not None:
            kwargs["cpus"] = cpus
        if memory_mib is not None:
            kwargs["memory_mib"] = memory_mib
        if disk_size_gb is not None:
            kwargs["disk_size_gb"] = disk_size_gb
        if env:
            kwargs["env"] = env
        if cmd:
            kwargs["cmd"] = cmd
        if entrypoint:
            kwargs["entrypoint"] = entrypoint
        if network_spec:
            kwargs["network"] = network_spec
        if volumes:
            kwargs["volumes"] = volumes
        if secrets_payload:
            kwargs["secrets"] = secrets_payload
        return kwargs

    def get_or_attach_box(self, box_id: str, name: Optional[str] = None):
        if box_id in self.boxes:
            return self.boxes[box_id]

        rt = self.ensure_runtime()
        box_name = name or f"box-{box_id[:8]}"

        try:
            import boxlite
            if not isinstance(rt, RestRuntimeFallback):
                box = boxlite.SimpleBox(runtime=rt, id=box_id, name=box_name)
                self.boxes[box_id] = box
                return box
        except ImportError:
            pass

        box = RestBoxFallback(rt, box_id, box_name)
        self.boxes[box_id] = box
        return box

    async def handle_list_boxes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        boxes = await (rt.list_info() if hasattr(rt, "list_info") else rt.list())
        result = []
        for b in boxes:
            if isinstance(b, dict):
                b_id = b.get("id") or b.get("box_id") or ""
                b_name = b.get("name") or ""
                b_image = b.get("image") or "python"
                b_tunnels = b.get("tunnels")
            else:
                b_id = getattr(b, "id", None) or getattr(b, "box_id", None) or str(b)
                b_name = getattr(b, "name", "") or ""
                b_image = getattr(b, "image", None) or "python"
                b_tunnels = getattr(b, "tunnels", None)

            b_volumes = b.get("volumes") if isinstance(b, dict) else getattr(b, "volumes", None)
            b_secrets_raw = b.get("secrets") if isinstance(b, dict) else getattr(b, "secrets", None)
            b_secrets = self._redact_secrets(b_secrets_raw) or self.box_secrets.get(b_id, [])

            b_status = extract_box_status(b)

            box_info = {
                "id": b_id,
                "name": b_name,
                "status": b_status,
                "image": b_image,
            }
            if b_tunnels is not None:
                box_info["tunnels"] = b_tunnels
            if b_volumes:
                box_info["volumes"] = b_volumes
            if b_secrets:
                box_info["secrets"] = b_secrets
            result.append(box_info)
        return {"boxes": result}

    async def handle_inspect_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        if hasattr(box, "inspect"):
            info = await box.inspect()
        else:
            info = await rt.inspect(box_id)

        if hasattr(info, "to_dict"):
            data = info.to_dict()
        elif hasattr(info, "__dict__"):
            data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
        elif isinstance(info, dict):
            data = dict(info)
        else:
            data = {"id": box_id, "raw": str(info)}

        if isinstance(data, dict):
            if "secrets" in data and data["secrets"]:
                data["secrets"] = self._redact_secrets(data["secrets"])
            elif box_id in self.box_secrets and self.box_secrets[box_id]:
                data["secrets"] = self.box_secrets[box_id]
        return {"box": data}

    async def handle_create_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args.get("name")
        checkpoint = args.get("checkpoint") or args.get("checkpointId") or args.get("checkpoint_id")
        if checkpoint:
            # Restored boxes inherit all saved execution/resource/lifecycle/network settings.
            # BoxLite Cloud rejects any creation option other than checkpoint_id and optional name.
            if isinstance(rt, RestRuntimeFallback):
                rest_kwargs: Dict[str, Any] = {"checkpoint_id": checkpoint}
                if name:
                    rest_kwargs["name"] = name
                res = await rt.create(**rest_kwargs)
                box_id = res.get("box_id") or res.get("id") or name or checkpoint
                await rt.start(box_id)
                box = RestBoxFallback(rt, box_id, name or box_id)
                self.boxes[box_id] = box
                return {"boxId": box_id, "name": name or box_id, "status": "running"}

            try:
                import boxlite
                create_kwargs: Dict[str, Any] = {}
                if name:
                    create_kwargs["name"] = name
                box = await rt.create(boxlite.BoxOptions(checkpoint=checkpoint), **create_kwargs)
                await box.start()
                box_id = box.id
                self.boxes[box_id] = box
                return {
                    "boxId": box_id,
                    "name": name or getattr(box, "name", None) or box_id,
                    "status": "running"
                }
            except TypeError as e:
                log_debug(f"BoxOptions(checkpoint=...) not supported in installed wheel ({e}); falling back to REST")
                fallback = self._rest_fallback(rt)
                rest_kwargs = {"checkpoint_id": checkpoint}
                if name:
                    rest_kwargs["name"] = name
                res = await fallback.create(**rest_kwargs)
                box_id = res.get("box_id") or res.get("id") or name or checkpoint
                await fallback.start(box_id)
                box = RestBoxFallback(fallback, box_id, name or box_id)
                self.boxes[box_id] = box
                return {"boxId": box_id, "name": name or box_id, "status": "running"}

        image = args.get("image", "python")
        auto_remove = args.get("autoRemove", False)
        auto_stop = args.get("autoStop", args.get("auto_stop", 0))
        if auto_stop is not None and 0 < auto_stop < 60:
            auto_stop = 60
        auto_delete = args.get("autoDelete", args.get("auto_delete", 0))
        auto_resume = args.get("autoResume", args.get("auto_resume", True))
        cpus = args.get("cpus", args.get("cpu"))
        memory_mib = args.get("memoryMib", args.get("memory_mib"))
        disk_size_gb = args.get("diskSizeGb", args.get("disk_size_gb"))
        entrypoint = args.get("entrypoint")
        cmd = args.get("cmd")
        env = args.get("env")
        network_spec = args.get("network")
        volumes = args.get("volumes")
        secrets_payload = self._format_secrets_payload(args.get("secrets"))
        redacted_secrets = self._redact_secrets(secrets_payload)

        if isinstance(rt, RestRuntimeFallback):
            kwargs = self._build_rest_create_kwargs(
                image=image,
                name=name,
                auto_stop=auto_stop,
                auto_delete=auto_delete,
                auto_resume=auto_resume,
                cpus=cpus,
                memory_mib=memory_mib,
                disk_size_gb=disk_size_gb,
                env=env,
                cmd=cmd,
                entrypoint=entrypoint,
                network_spec=network_spec,
                volumes=volumes,
                secrets_payload=secrets_payload,
            )

            res = await rt.create(**kwargs)
            box_id = res.get("box_id") or res.get("id") or name
            try:
                start_res = await rt.start(box_id)
            except Exception as start_err:
                if not name and _is_image_pull_error(str(start_err)) and box_id:
                    try:
                        await rt.remove(box_id, force=True)
                    except Exception:
                        pass
                raise
            resolved_image = (
                (start_res.get("image") if isinstance(start_res, dict) else None)
                or (res.get("image") if isinstance(res, dict) else None)
                or image
            )
            box = RestBoxFallback(rt, box_id, name or box_id)
            self.boxes[box_id] = box
            if redacted_secrets:
                self.box_secrets[box_id] = redacted_secrets
            return {"boxId": box_id, "name": name or box_id, "status": "running", "image": resolved_image}

        import boxlite
        outbound_spec = None
        inbound_spec = None

        if network_spec:
            outbound_cfg = network_spec.get("outbound", {})
            out_mode = outbound_cfg.get("mode", "enabled")
            allow_net = outbound_cfg.get("allow_net", [])
            outbound_spec = boxlite.OutboundNetworkSpec(mode=out_mode, allow_net=allow_net)

            inbound_cfg = network_spec.get("inbound", {})
            in_mode = inbound_cfg.get("mode", "enabled")
            inbound_spec = boxlite.InboundNetworkSpec(mode=in_mode)

        net = None
        if outbound_spec or inbound_spec:
            net = boxlite.NetworkSpec(
                outbound=outbound_spec or boxlite.OutboundNetworkSpec(mode="enabled", allow_net=[]),
                inbound=inbound_spec or boxlite.InboundNetworkSpec(mode="enabled")
            )

        sdk_secrets = None
        if secrets_payload:
            sdk_secrets = [
                boxlite.Secret(
                    name=s["name"],
                    value=s["value"],
                    hosts=s["hosts"],
                    headers=s["headers"]
                )
                for s in secrets_payload
            ]

        kwargs = {
            "runtime": rt,
            "image": image,
            "auto_remove": auto_remove,
        }
        if name:
            kwargs["name"] = name
        if auto_stop is not None:
            kwargs["auto_stop"] = auto_stop
        if auto_delete is not None and auto_delete > 0:
            kwargs["auto_delete"] = auto_delete
        if auto_resume is not None:
            kwargs["auto_resume"] = auto_resume
        if cpus is not None:
            kwargs["cpus"] = cpus
        if memory_mib is not None:
            kwargs["memory_mib"] = memory_mib
        if disk_size_gb is not None:
            kwargs["disk_size_gb"] = disk_size_gb
        if env:
            kwargs["env"] = list(env.items()) if isinstance(env, dict) else env
        if cmd:
            kwargs["cmd"] = cmd
        if entrypoint:
            kwargs["entrypoint"] = entrypoint
        if net:
            kwargs["network"] = net
        if volumes:
            kwargs["volumes"] = [
                {
                    "managed_volume": v.get("managed_volume") or v.get("managedVolume"),
                    "guest_path": v.get("guest_path") or v.get("guestPath"),
                    "read_only": v.get("read_only", v.get("readOnly", False))
                }
                for v in volumes
            ]
        if sdk_secrets:
            kwargs["secrets"] = sdk_secrets

        resolved_image = image
        try:
            box = boxlite.SimpleBox(**kwargs)
            try:
                await box.start()
            except Exception as start_err:
                if not name and _is_image_pull_error(str(start_err)) and getattr(box, "id", None):
                    try:
                        await rt.remove(box.id, force=True)
                    except Exception:
                        pass
                raise
            box_id = box.id
            resolved_image = getattr(box, "image", None) or image
            self.boxes[box_id] = box
        except TypeError as e:
            if sdk_secrets:
                # Never silently drop secrets; try rt.create(BoxOptions(...)) or REST fallback
                log_debug(f"SimpleBox with secrets failed ({e}); trying BoxOptions / REST fallback.")
                try:
                    box_opts_kwargs: Dict[str, Any] = {
                        "image": image,
                        "secrets": sdk_secrets,
                    }
                    if auto_stop is not None:
                        box_opts_kwargs["auto_stop"] = auto_stop
                    if auto_delete is not None and auto_delete > 0:
                        box_opts_kwargs["auto_delete"] = auto_delete
                    if auto_resume is not None:
                        box_opts_kwargs["auto_resume"] = auto_resume
                    if cpus is not None:
                        box_opts_kwargs["cpus"] = cpus
                    if memory_mib is not None:
                        box_opts_kwargs["memory_mib"] = memory_mib
                    if disk_size_gb is not None:
                        box_opts_kwargs["disk_size_gb"] = disk_size_gb
                    if env:
                        box_opts_kwargs["env"] = list(env.items()) if isinstance(env, dict) else env
                    if cmd:
                        box_opts_kwargs["cmd"] = cmd
                    if entrypoint:
                        box_opts_kwargs["entrypoint"] = entrypoint
                    if net:
                        box_opts_kwargs["network"] = net
                    if volumes:
                        box_opts_kwargs["volumes"] = kwargs["volumes"]
                    create_kwargs = {"name": name} if name else {}
                    box = await rt.create(boxlite.BoxOptions(**box_opts_kwargs), **create_kwargs)
                    try:
                        await box.start()
                    except Exception as start_err:
                        if not name and _is_image_pull_error(str(start_err)) and getattr(box, "id", None):
                            try:
                                await rt.remove(box.id, force=True)
                            except Exception:
                                pass
                        raise
                    box_id = box.id
                    resolved_image = getattr(box, "image", None) or image
                    self.boxes[box_id] = box
                except Exception as inner_e:
                    if not isinstance(inner_e, TypeError) and _is_image_pull_error(str(inner_e)):
                        raise
                    log_debug(f"BoxOptions with secrets failed ({inner_e}); falling back to REST")
                    fallback = self._rest_fallback(rt)
                    rest_kwargs = self._build_rest_create_kwargs(
                        image=image,
                        name=name,
                        auto_stop=auto_stop,
                        auto_delete=auto_delete,
                        auto_resume=auto_resume,
                        cpus=cpus,
                        memory_mib=memory_mib,
                        disk_size_gb=disk_size_gb,
                        env=env,
                        cmd=cmd,
                        entrypoint=entrypoint,
                        network_spec=network_spec,
                        volumes=volumes,
                        secrets_payload=secrets_payload,
                    )
                    res = await fallback.create(**rest_kwargs)
                    box_id = res.get("box_id") or res.get("id") or name
                    try:
                        start_res = await fallback.start(box_id)
                    except Exception as start_err:
                        if not name and _is_image_pull_error(str(start_err)) and box_id:
                            try:
                                await fallback.remove(box_id, force=True)
                            except Exception:
                                pass
                        raise
                    resolved_image = (
                        (start_res.get("image") if isinstance(start_res, dict) else None)
                        or (res.get("image") if isinstance(res, dict) else None)
                        or image
                    )
                    box = RestBoxFallback(fallback, box_id, name or box_id)
                    self.boxes[box_id] = box
            else:
                # Drop newer optional kwargs if the installed wheel rejects them
                log_debug(f"SimpleBox init with all options failed ({e}); falling back with core options.")
                for key in ["auto_resume", "auto_delete", "disk_size_gb", "memory_mib", "cpus", "env", "cmd", "volumes"]:
                    kwargs.pop(key, None)
                try:
                    box = boxlite.SimpleBox(**kwargs)
                except TypeError:
                    kwargs.pop("auto_stop", None)
                    box = boxlite.SimpleBox(**kwargs)
                try:
                    await box.start()
                except Exception as start_err:
                    if not name and _is_image_pull_error(str(start_err)) and getattr(box, "id", None):
                        try:
                            await rt.remove(box.id, force=True)
                        except Exception:
                            pass
                    raise
                box_id = box.id
                resolved_image = getattr(box, "image", None) or image
                self.boxes[box_id] = box

        if redacted_secrets:
            self.box_secrets[box_id] = redacted_secrets

        return {
            "boxId": box_id,
            "name": name or box_id,
            "status": "running",
            "image": resolved_image,
        }

    async def handle_start_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        await box.start()

        rt = self.ensure_runtime()
        for _ in range(16):
            try:
                info = await rt.inspect(box_id) if hasattr(rt, "inspect") else None
                st = extract_box_status(info)
                if st in ("running", "ready", "active"):
                    return {"boxId": box_id, "status": st}
            except Exception:
                pass
            await asyncio.sleep(0.5)

        return {"boxId": box_id, "status": "running"}

    async def handle_stop_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        box = self.get_or_attach_box(box_id)
        if hasattr(box, "stop"):
            await box.stop()
        else:
            rt = self.ensure_runtime()
            if hasattr(rt, "stop"):
                await rt.stop(box_id)

        rt = self.ensure_runtime()
        for _ in range(16):
            try:
                info = await rt.inspect(box_id) if hasattr(rt, "inspect") else None
                st = extract_box_status(info)
                if st in ("stopped", "terminated", "exited", "configured", "paused", "inactive", "shutdown"):
                    return {"boxId": box_id, "status": st}
            except Exception:
                pass
            await asyncio.sleep(0.5)

        return {"boxId": box_id, "status": "stopped"}

    async def handle_remove_box(self, args: Dict[str, Any]) -> Dict[str, Any]:
        target = args.get("boxId") or args.get("boxName")
        if not target:
            raise ValueError("boxId or boxName is required")
        ignore_not_found = bool(args.get("ignoreNotFound", False))
        rt = self.ensure_runtime()
        removed_id = target

        try:
            await rt.remove(target, force=True)
        except Exception as e:
            if not _is_not_found_error(e):
                raise
            matched_id = None
            try:
                boxes = await (rt.list_info() if hasattr(rt, "list_info") else rt.list())
                for b in (boxes or []):
                    if isinstance(b, dict):
                        b_id = b.get("id") or b.get("box_id")
                        b_name = b.get("name")
                    else:
                        b_id = getattr(b, "id", None) or getattr(b, "box_id", None)
                        b_name = getattr(b, "name", None)
                    if b_name == target or b_id == target:
                        matched_id = b_id
                        break
            except Exception:
                matched_id = None

            if matched_id and matched_id != target:
                try:
                    await rt.remove(matched_id, force=True)
                    removed_id = matched_id
                except Exception as remove_err:
                    if _is_not_found_error(remove_err) and ignore_not_found:
                        self.boxes.pop(target, None)
                        self.boxes.pop(matched_id, None)
                        self.box_secrets.pop(target, None)
                        self.box_secrets.pop(matched_id, None)
                        return {"boxId": target, "removed": False, "notFound": True}
                    raise
            else:
                if ignore_not_found:
                    self.boxes.pop(target, None)
                    self.box_secrets.pop(target, None)
                    return {"boxId": target, "removed": False, "notFound": True}
                raise

        self.boxes.pop(target, None)
        self.boxes.pop(removed_id, None)
        self.box_secrets.pop(target, None)
        self.box_secrets.pop(removed_id, None)
        return {"boxId": removed_id, "removed": True}

    async def handle_exec(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        cmd = args["command"]
        cmd_args = args.get("args", [])
        box = self.get_or_attach_box(box_id)

        full_cmd = [cmd] + cmd_args if cmd_args else [cmd]
        res = await box.exec(*full_cmd)
        if hasattr(res, "wait") and callable(res.wait):
            res = await res.wait()

        exit_code = getattr(res, "exit_code", getattr(res, "exitCode", 0))
        stdout = getattr(res, "stdout", "")
        stderr = getattr(res, "stderr", "")

        if callable(stdout):
            stdout = stdout()
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")

        if callable(stderr):
            stderr = stderr()
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")

        return {
            "exitCode": exit_code,
            "stdout": stdout,
            "stderr": stderr
        }

    async def handle_copy_in(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        source = args["source"]
        destination = args["destination"]
        box = self.get_or_attach_box(box_id)

        await box.copy_in(source, destination)
        return {
            "boxId": box_id,
            "source": source,
            "destination": destination,
            "success": True
        }

    async def handle_tunnel(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        port = int(args.get("port", 8080))
        is_public = args.get("isPublic", True)

        box = self.get_or_attach_box(box_id)
        target = ("127.0.0.1", port)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                if is_public:
                    tunnel = await box.tunnel(target)
                else:
                    tunnel = await box.tunnel(target, boxlite.TunnelOptions(is_public=False))
                url = tunnel.uri() if hasattr(tunnel, "uri") else str(tunnel)
                token = tunnel.token() if hasattr(tunnel, "token") else None
                return {
                    "boxId": box_id,
                    "port": port,
                    "isPublic": is_public,
                    "url": url,
                    "token": token
                }
        except ImportError:
            pass

        tunnel = await box.tunnel(target, TunnelResultFallback({"is_public": is_public}))
        url = tunnel.uri() if hasattr(tunnel, "uri") else str(tunnel)
        token = tunnel.token() if hasattr(tunnel, "token") else None

        return {
            "boxId": box_id,
            "port": port,
            "isPublic": is_public,
            "url": url,
            "token": token
        }

    async def handle_revoke_tunnel(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        port = int(args.get("port", 8080))
        box = self.get_or_attach_box(box_id)
        await box.network.revoke_tunnel(port)
        return {"boxId": box_id, "port": port, "revoked": True}

    async def handle_update_inbound(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        mode = args.get("mode", "enabled")
        box = self.get_or_attach_box(box_id)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                await box.network.update_inbound(boxlite.InboundNetworkSpec(mode=mode))
                return {"boxId": box_id, "inbound": mode}
        except ImportError:
            pass

        await box.network.update_inbound(mode)
        return {"boxId": box_id, "inbound": mode}

    async def handle_update_outbound(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        mode = args.get("mode", "enabled")
        allow_net = args.get("allowNet", [])
        box = self.get_or_attach_box(box_id)

        try:
            import boxlite
            if not isinstance(self.rt, RestRuntimeFallback):
                if allow_net:
                    spec = boxlite.OutboundNetworkSpec(mode=mode, allow_net=allow_net)
                else:
                    spec = boxlite.OutboundNetworkSpec(mode=mode)
                await box.network.update_outbound(spec)
                return {"boxId": box_id, "outbound": mode, "allowNet": allow_net}
        except ImportError:
            pass

        class OutboundSpecStub:
            def __init__(self, m, an):
                self.mode = m
                self.allow_net = an

        await box.network.update_outbound(OutboundSpecStub(mode, allow_net))
        return {"boxId": box_id, "outbound": mode, "allowNet": allow_net}

    async def handle_tail_log(self, args: Dict[str, Any]) -> Dict[str, Any]:
        box_id = args["boxId"]
        log_file = args.get("logFile", "/tmp/server.log")
        lines = max(1, min(int(args.get("lines", 100)), 10000))
        rt = self.ensure_runtime()
        box = self.get_or_attach_box(box_id)

        # Prevent waking up stopped boxes with tail execution
        stopped_states = ("stopped", "stopping", "terminated", "exited", "configured", "paused", "inactive", "shutdown")
        try:
            info = None
            if hasattr(box, "inspect") and callable(box.inspect):
                info = await box.inspect()
            elif hasattr(rt, "inspect") and callable(rt.inspect):
                info = await rt.inspect(box_id)
            status = extract_box_status(info)
            if status in stopped_states:
                return {
                    "boxId": box_id,
                    "content": "",
                    "exitCode": 0,
                    "status": status,
                    "stopped": True
                }
        except Exception as err:
            lower_err = str(err).lower()
            if "404" in lower_err or "not found" in lower_err:
                return {
                    "boxId": box_id,
                    "content": "",
                    "exitCode": 0,
                    "status": "stopped",
                    "stopped": True
                }
            raise

        res = await box.exec("tail", f"-n{lines}", log_file)
        if hasattr(res, "wait") and callable(res.wait):
            res = await res.wait()

        stdout = getattr(res, "stdout", "")
        if callable(stdout):
            stdout = stdout()
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")

        exit_code = getattr(res, "exit_code", getattr(res, "exitCode", 0))
        return {
            "boxId": box_id,
            "content": stdout,
            "exitCode": exit_code
        }

    async def handle_list_volumes(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volumes = []
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                volumes = await handle.list()
            except Exception as e:
                log_debug(f"rt.volumes().list() failed ({e}), falling back to REST")
                volumes = await self._rest_fallback(rt).list_volumes()
        elif hasattr(rt, "list_volumes"):
            volumes = await rt.list_volumes()

        result = []
        for v in volumes:
            if isinstance(v, dict):
                v_id = v.get("id") or v.get("volume_id") or ""
                v_name = v.get("name") or v_id
                v_state = v.get("state") or "ready"
                v_created = v.get("created_at") or v.get("createdAt")
                v_updated = v.get("updated_at") or v.get("updatedAt")
                v_size = v.get("size_bytes") or v.get("sizeBytes")
            else:
                v_id = getattr(v, "id", None) or getattr(v, "volume_id", "") or str(v)
                v_name = getattr(v, "name", "") or v_id
                v_state = getattr(v, "state", "ready")
                v_created = getattr(v, "created_at", None)
                if hasattr(v_created, "to_rfc3339"):
                    v_created = v_created.to_rfc3339()
                elif hasattr(v_created, "isoformat"):
                    v_created = v_created.isoformat()
                else:
                    v_created = str(v_created) if v_created else None
                v_updated = getattr(v, "updated_at", None)
                if hasattr(v_updated, "to_rfc3339"):
                    v_updated = v_updated.to_rfc3339()
                elif hasattr(v_updated, "isoformat"):
                    v_updated = v_updated.isoformat()
                else:
                    v_updated = str(v_updated) if v_updated else None
                v_size = getattr(v, "size_bytes", None)

            result.append({
                "id": v_id,
                "name": v_name,
                "state": str(v_state).lower() if v_state else "ready",
                "createdAt": v_created,
                "updatedAt": v_updated,
                "sizeBytes": v_size
            })
        return {"volumes": result}

    async def handle_create_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args.get("name")
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                info = await handle.create(name=name)
                v_id = getattr(info, "id", None) or getattr(info, "volume_id", "")
                v_name = getattr(info, "name", "") or v_id
                v_state = getattr(info, "state", "ready")
                v_created = getattr(info, "created_at", None)
                if hasattr(v_created, "to_rfc3339"):
                    v_created = v_created.to_rfc3339()
                elif hasattr(v_created, "isoformat"):
                    v_created = v_created.isoformat()
                else:
                    v_created = str(v_created) if v_created else None
                return {
                    "id": v_id,
                    "name": v_name,
                    "state": str(v_state).lower() if v_state else "ready",
                    "createdAt": v_created
                }
            except Exception as e:
                log_debug(f"rt.volumes().create() failed ({e}), falling back to REST")

        res = await self._rest_fallback(rt).create_volume(name=name)
        v_id = res.get("id") or res.get("volume_id") or ""
        v_name = res.get("name") or v_id
        v_state = res.get("state") or "ready"
        v_created = res.get("created_at") or res.get("createdAt")
        return {
            "id": v_id,
            "name": v_name,
            "state": str(v_state).lower() if v_state else "ready",
            "createdAt": v_created
        }

    async def handle_inspect_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volume_id = args["volumeId"]
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                info = await handle.get(volume_id)
                if hasattr(info, "to_dict"):
                    data = info.to_dict()
                elif hasattr(info, "__dict__"):
                    data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
                else:
                    data = {
                        "id": getattr(info, "id", volume_id),
                        "name": getattr(info, "name", volume_id),
                        "state": getattr(info, "state", "ready"),
                        "created_at": getattr(info, "created_at", None),
                        "size_bytes": getattr(info, "size_bytes", None)
                    }
                return {"volume": data}
            except Exception as e:
                log_debug(f"rt.volumes().get() failed ({e}), falling back to REST")

        res = await self._rest_fallback(rt).get_volume(volume_id)
        return {"volume": res}

    async def handle_remove_volume(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        volume_id = args["volumeId"]
        force = bool(args.get("force", False))
        if hasattr(rt, "volumes") and callable(rt.volumes):
            try:
                handle = rt.volumes()
                await handle.remove(volume_id, force=force)
                return {"volumeId": volume_id, "removed": True}
            except Exception as e:
                log_debug(f"rt.volumes().remove() failed ({e}), falling back to REST")

        await self._rest_fallback(rt).remove_volume(volume_id, force=force)
        return {"volumeId": volume_id, "removed": True}

    def _serialize_timestamp(self, val: Any) -> Optional[str]:
        if val is None:
            return None
        if isinstance(val, str):
            return val
        if hasattr(val, "to_rfc3339"):
            return val.to_rfc3339()
        if hasattr(val, "isoformat"):
            return val.isoformat()
        return str(val)

    def _format_image_item(self, img: Any) -> Optional[Dict[str, Any]]:
        if img is None:
            return None
        if isinstance(img, str):
            name = img.strip()
            return {"name": name} if name else None

        def get_field(key: str, default: Any = None) -> Any:
            if isinstance(img, dict):
                return img.get(key, default)
            return getattr(img, key, default)

        name = ""
        for field in ("name", "image_name", "imageName", "reference", "image"):
            val = get_field(field)
            if isinstance(val, str) and val.strip():
                name = val.strip()
                break

        raw_tag = get_field("tag")
        tag_str = raw_tag.strip() if isinstance(raw_tag, str) else ""

        if not name:
            raw_repo = get_field("repository")
            if isinstance(raw_repo, str) and raw_repo.strip():
                repo = raw_repo.strip()
                if tag_str and tag_str != "<none>" and ":" not in repo:
                    name = f"{repo}:{tag_str}"
                else:
                    name = repo

        if not name:
            raw_id = get_field("id")
            if isinstance(raw_id, str) and raw_id.strip():
                name = raw_id.strip()

        if not name:
            return None

        raw_tags = get_field("tags")
        if raw_tags is None:
            raw_tags = get_field("aliases")
        if isinstance(raw_tags, (list, tuple, set)):
            tags = [t if isinstance(t, str) else str(t) for t in raw_tags]
        elif tag_str and tag_str != "<none>":
            tags = [tag_str]
        else:
            tags = []

        box_count = get_field("boxCount")
        if box_count is None:
            box_count = get_field("box_count", 0)

        last_used_raw = (
            get_field("lastUsedAt")
            or get_field("last_used_at")
            or get_field("createdAt")
            or get_field("created_at")
        )
        last_used = self._serialize_timestamp(last_used_raw)

        size_bytes = get_field("sizeBytes")
        if size_bytes is None:
            size_bytes = get_field("size_bytes")

        digest = get_field("digest")

        formatted: Dict[str, Any] = dict(img) if isinstance(img, dict) else {}
        formatted.update({
            "name": name,
            "tags": tags,
            "boxCount": box_count if box_count is not None else 0,
            "lastUsedAt": last_used,
            "sizeBytes": size_bytes,
        })
        if isinstance(digest, str) and digest.strip():
            formatted["digest"] = digest.strip()
        return formatted

    def _get_images_handle(self, rt: Any) -> Any:
        if hasattr(rt, "images"):
            attr = getattr(rt, "images")
            return attr() if callable(attr) else attr
        return None

    async def handle_list_images(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        images = None
        usage = None

        img_mgr = self._get_images_handle(rt)
        if img_mgr is not None:
            if hasattr(img_mgr, "list") and callable(img_mgr.list):
                try:
                    images = await img_mgr.list()
                except Exception as e:
                    log_debug(f"rt.images.list() failed: {e}")
            if hasattr(img_mgr, "usage") and callable(img_mgr.usage):
                try:
                    u = await img_mgr.usage()
                    usage = {
                        "count": getattr(u, "count", 0),
                        "limit": getattr(u, "limit", 20),
                        "knownBytes": getattr(u, "known_bytes", getattr(u, "knownBytes", 0))
                    }
                except Exception as e:
                    log_debug(f"rt.images.usage() failed: {e}")

        if images is None:
            fallback_res = await self._rest_fallback(rt).list_images()
            images = fallback_res.get("images", [])
            if usage is None:
                usage = fallback_res.get("usage")

        formatted_images = []
        for img in (images or []):
            item = self._format_image_item(img)
            if item is not None:
                formatted_images.append(item)

        if isinstance(usage, dict):
            known_bytes = usage.get("knownBytes")
            if known_bytes is None:
                known_bytes = usage.get("known_bytes", 0)
            usage = {
                "count": usage.get("count", len(formatted_images)),
                "limit": usage.get("limit", 20),
                "knownBytes": known_bytes if known_bytes is not None else 0,
            }

        return {
            "images": formatted_images,
            "usage": usage or {"count": len(formatted_images), "limit": 20, "knownBytes": 0}
        }

    async def handle_inspect_image(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        canonical = _canonical_catalog_image_name(name)
        candidates = [name] if not canonical or canonical == name else [name, canonical]
        img_mgr = self._get_images_handle(rt)
        last_err: Optional[Exception] = None

        for candidate in candidates:
            data = None
            if img_mgr is not None and hasattr(img_mgr, "get"):
                try:
                    detail = await img_mgr.get(candidate)
                    if hasattr(detail, "to_dict"):
                        data = detail.to_dict()
                    elif hasattr(detail, "__dict__"):
                        data = {k: v for k, v in detail.__dict__.items() if not k.startswith("_")}
                    else:
                        data = {
                            "name": getattr(detail, "name", candidate),
                            "versions": [
                                {
                                    "digest": getattr(v, "digest", ""),
                                    "lastUsedAt": self._serialize_timestamp(
                                        getattr(v, "last_used_at", getattr(v, "lastUsedAt", None))
                                    ),
                                    "sizeBytes": getattr(v, "size_bytes", getattr(v, "sizeBytes", None))
                                }
                                for v in getattr(detail, "versions", [])
                            ],
                            "aliases": [
                                {
                                    "alias": getattr(a, "alias", ""),
                                    "digest": getattr(a, "digest", "")
                                }
                                for a in getattr(detail, "aliases", [])
                            ],
                            "history": [
                                {
                                    "alias": getattr(h, "alias", ""),
                                    "fromDigest": getattr(h, "from_digest", getattr(h, "fromDigest", None)),
                                    "toDigest": getattr(h, "to_digest", getattr(h, "toDigest", "")),
                                    "recordedAt": self._serialize_timestamp(
                                        getattr(h, "recorded_at", getattr(h, "recordedAt", None))
                                    )
                                }
                                for h in getattr(detail, "history", [])
                            ]
                        }
                except Exception as e:
                    last_err = e
                    log_debug(f"rt.images.get({candidate}) failed ({e}), falling back to REST")

            if data is None:
                try:
                    data = await self._rest_fallback(rt).get_image(candidate)
                except Exception as e:
                    last_err = e
                    if _is_not_found_error(e) and candidate != candidates[-1]:
                        continue
                    raise

            return {"image": data}

        if last_err is not None:
            raise last_err
        raise RuntimeError(f"Image '{name}' not found")

    async def handle_remove_image(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        canonical = _canonical_catalog_image_name(name)
        candidates = [name] if not canonical or canonical == name else [name, canonical]
        img_mgr = self._get_images_handle(rt)
        last_err: Optional[Exception] = None

        for candidate in candidates:
            if img_mgr is not None and hasattr(img_mgr, "remove") and callable(img_mgr.remove):
                try:
                    await img_mgr.remove(candidate)
                    return {"name": candidate, "removed": True}
                except Exception as e:
                    last_err = e
                    log_debug(f"rt.images.remove({candidate}) failed ({e}), falling back to REST")

            try:
                await self._rest_fallback(rt).remove_image(candidate)
                return {"name": candidate, "removed": True}
            except Exception as e:
                last_err = e
                if _is_not_found_error(e) and candidate != candidates[-1]:
                    continue
                raise

        if last_err is not None:
            raise last_err
        return {"name": name, "removed": True}

    async def handle_create_image_alias(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        alias = args["alias"]
        digest = args["digest"]
        canonical = _canonical_catalog_image_name(name)
        candidates = [name] if not canonical or canonical == name else [name, canonical]
        img_mgr = self._get_images_handle(rt)
        last_err: Optional[Exception] = None

        for candidate in candidates:
            if img_mgr is not None and hasattr(img_mgr, "create_alias") and callable(img_mgr.create_alias):
                try:
                    await img_mgr.create_alias(name=candidate, alias=alias, digest=digest)
                    return {"name": candidate, "alias": alias, "digest": digest}
                except Exception as e:
                    last_err = e
                    log_debug(f"rt.images.create_alias({candidate}) failed ({e}), falling back to REST")

            try:
                await self._rest_fallback(rt).create_image_alias(candidate, alias, digest)
                return {"name": candidate, "alias": alias, "digest": digest}
            except Exception as e:
                last_err = e
                if _is_not_found_error(e) and candidate != candidates[-1]:
                    continue
                raise

        if last_err is not None:
            raise last_err
        return {"name": name, "alias": alias, "digest": digest}

    async def handle_delete_image_alias(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        name = args["name"]
        alias = args["alias"]
        canonical = _canonical_catalog_image_name(name)
        candidates = [name] if not canonical or canonical == name else [name, canonical]
        img_mgr = self._get_images_handle(rt)
        last_err: Optional[Exception] = None

        for candidate in candidates:
            if img_mgr is not None and hasattr(img_mgr, "delete_alias") and callable(img_mgr.delete_alias):
                try:
                    await img_mgr.delete_alias(name=candidate, alias=alias)
                    return {"name": candidate, "alias": alias, "deleted": True}
                except Exception as e:
                    last_err = e
                    log_debug(f"rt.images.delete_alias({candidate}) failed ({e}), falling back to REST")

            try:
                await self._rest_fallback(rt).delete_image_alias(candidate, alias)
                return {"name": candidate, "alias": alias, "deleted": True}
            except Exception as e:
                last_err = e
                if _is_not_found_error(e) and candidate != candidates[-1]:
                    continue
                raise

        if last_err is not None:
            raise last_err
        return {"name": name, "alias": alias, "deleted": True}

    async def handle_create_registry_login(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        registry_host = args["registryHost"]
        username = args["username"]
        password = args["password"]
        prefix = args.get("repositoryPrefix")
        log_debug(f"Registering registry login for {registry_host} (user: {username})")

        if hasattr(rt, "images") and hasattr(getattr(rt, "images"), "registries"):
            reg_mgr = getattr(getattr(rt, "images"), "registries")
            if hasattr(reg_mgr, "create") and callable(reg_mgr.create):
                try:
                    kwargs = {
                        "registry_host": registry_host,
                        "username": username,
                        "password": password
                    }
                    if prefix:
                        kwargs["repository_prefix"] = prefix
                    await reg_mgr.create(**kwargs)
                    return {"success": True, "registryHost": registry_host}
                except Exception as e:
                    log_debug(f"rt.images.registries.create() failed ({e}), falling back to REST")

        await self._rest_fallback(rt).create_registry_login(registry_host, username, password, prefix)
        return {"success": True, "registryHost": registry_host}

    def _format_checkpoint(self, c: Any) -> Dict[str, Any]:
        if isinstance(c, dict):
            c_id = c.get("id") or c.get("checkpoint_id") or ""
            c_name = c.get("name") or c_id
            c_source = c.get("source_box_id") or c.get("sourceBoxId") or ""
            c_state = c.get("state") or "ready"
            c_created = c.get("created_at") or c.get("createdAt")
            c_size = c.get("size_bytes") if c.get("size_bytes") is not None else c.get("sizeBytes")
            c_error = c.get("error_reason") or c.get("errorReason")
        else:
            c_id = getattr(c, "id", None) or getattr(c, "checkpoint_id", "") or str(c)
            c_name = getattr(c, "name", "") or c_id
            c_source = getattr(c, "source_box_id", None) or getattr(c, "sourceBoxId", "") or ""
            c_state = getattr(c, "state", "ready")
            c_created = getattr(c, "created_at", None) or getattr(c, "createdAt", None)
            if hasattr(c_created, "to_rfc3339"):
                c_created = c_created.to_rfc3339()
            elif hasattr(c_created, "isoformat"):
                c_created = c_created.isoformat()
            elif c_created is not None:
                c_created = str(c_created)
            c_size = getattr(c, "size_bytes", None)
            if c_size is None:
                c_size = getattr(c, "sizeBytes", None)
            c_error = getattr(c, "error_reason", None) or getattr(c, "errorReason", None)

        item: Dict[str, Any] = {
            "id": c_id,
            "name": c_name,
            "sourceBoxId": c_source,
            "state": str(c_state).lower().strip() if c_state else "ready",
            "createdAt": c_created,
            "sizeBytes": c_size if c_size is not None else 0,
        }
        if c_error:
            item["errorReason"] = c_error
        return item

    def _get_checkpoint_handle(self, rt: Any) -> Any:
        if hasattr(rt, "checkpoints"):
            attr = getattr(rt, "checkpoints")
            return attr() if callable(attr) else attr
        return None

    async def handle_list_checkpoints(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        checkpoints = None
        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "list") and callable(handle.list):
            try:
                checkpoints = await handle.list()
            except Exception as e:
                log_debug(f"rt.checkpoints.list() failed ({e}), falling back to REST")

        if checkpoints is None:
            checkpoints = await self._rest_fallback(rt).list_checkpoints()

        return {"checkpoints": [self._format_checkpoint(c) for c in (checkpoints or [])]}

    async def handle_create_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        source_box_id = args["sourceBoxId"]
        name = args.get("name")

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "create") and callable(handle.create):
            try:
                if name:
                    info = await handle.create(source_box_id, name=name)
                else:
                    info = await handle.create(source_box_id)
                return self._format_checkpoint(info)
            except Exception as e:
                log_debug(f"rt.checkpoints.create() failed ({e}), falling back to REST")

        res = await self._rest_fallback(rt).create_checkpoint(source_box_id, name=name)
        return self._format_checkpoint(res)

    async def handle_inspect_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = args["checkpointKey"]

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "get") and callable(handle.get):
            try:
                info = await handle.get(key)
                if hasattr(info, "to_dict"):
                    data = info.to_dict()
                elif hasattr(info, "__dict__"):
                    data = {k: v for k, v in info.__dict__.items() if not k.startswith("_")}
                else:
                    data = self._format_checkpoint(info)
                return {"checkpoint": data}
            except Exception as e:
                log_debug(f"rt.checkpoints.get() failed ({e}), falling back to REST")

        res = await self._rest_fallback(rt).get_checkpoint(key)
        return {"checkpoint": res}

    async def handle_remove_checkpoint(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = args["checkpointKey"]
        force = bool(args.get("force", False))

        handle = self._get_checkpoint_handle(rt)
        if handle is not None and hasattr(handle, "remove") and callable(handle.remove):
            try:
                await handle.remove(key, force=force)
                return {"checkpointKey": key, "removed": True}
            except Exception as e:
                log_debug(f"rt.checkpoints.remove() failed ({e}), falling back to REST")

        await self._rest_fallback(rt).remove_checkpoint(key, force=force)
        return {"checkpointKey": key, "removed": True}

    async def handle_verify_secret_injection(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        image = args.get("image") or "python:alpine"
        host = (args.get("host") or "httpbingo.org").strip()
        if not _SAFE_VERIFY_HOST_RE.match(host):
            raise ValueError(f"Invalid verification hostname: '{host}'")
        token = "demo-not-a-real-key-" + py_secrets.token_hex(16)
        box_id = None

        try:
            created = await self.handle_create_box({
                "image": image,
                "diskSizeGb": 10,
                "autoStop": 0,
                "autoDelete": 0,
                "secrets": [{
                    "name": "demo",
                    "value": token,
                    "hosts": [host],
                    "headers": {"Authorization": "Bearer {value}"}
                }]
            })
            box_id = created["boxId"]

            env_res = await self.handle_exec({
                "boxId": box_id,
                "command": "env",
                "args": []
            })
            env_out = env_res.get("stdout", "")
            if env_res.get("exitCode", 0) != 0 or not env_out.strip() or token in env_out:
                raise RuntimeError("Guest environment check failed: test token appeared in guest environment or env failed.")

            target_url_literal = json.dumps(f"https://{host}/headers")
            request_code = (
                "import json, ssl, urllib.request\n"
                f'req = urllib.request.Request({target_url_literal}, headers={{"Authorization": "Bearer <BOXLITE_SECRET:demo>"}})\n'
                'ctx = ssl.create_default_context(cafile="/etc/ssl/certs/ca-certificates.crt")\n'
                "with urllib.request.urlopen(req, context=ctx, timeout=30) as response:\n"
                "    print(response.read().decode())\n"
            )
            echo_res = await self.handle_exec({
                "boxId": box_id,
                "command": "python",
                "args": ["-c", request_code]
            })
            if echo_res.get("exitCode", 0) != 0:
                raise RuntimeError(f"Header injection probe failed (exit {echo_res.get('exitCode')}): {echo_res.get('stderr', '')}")

            echoed = json.loads(echo_res.get("stdout", "{}"))
            echo_headers = {str(k).lower(): v for k, v in (echoed.get("headers") or {}).items()}
            authorization = echo_headers.get("authorization")
            if isinstance(authorization, list):
                authorization = authorization[0] if authorization else None
            if authorization != f"Bearer {token}":
                raise RuntimeError("Upstream did not receive the injected Authorization header")

            return {
                "boxId": box_id,
                "envCheckPassed": True,
                "headerInjectionPassed": True,
                "cleanedUp": True,
                "summary": "PASS: guest environment clean; PASS: upstream received injected Authorization header"
            }
        finally:
            if box_id is not None:
                try:
                    await rt.remove(box_id, force=True)
                    if box_id in self.boxes:
                        del self.boxes[box_id]
                    if box_id in self.box_secrets:
                        del self.box_secrets[box_id]
                except Exception as cleanup_err:
                    log_debug(f"Failed to remove verification box {box_id}: {cleanup_err}")

    def _get_domain_handle(self, rt: Any) -> Any:
        if hasattr(rt, "domains"):
            attr = getattr(rt, "domains")
            return attr() if callable(attr) else attr
        return None

    def _format_domain(self, d: Any) -> Dict[str, Any]:
        if isinstance(d, dict):
            domain_name = d.get("hostname") or d.get("domain") or d.get("name") or d.get("id") or ""
            raw_id = d.get("id") or d.get("domain_id") or d.get("domainId") or domain_name
            url_val = d.get("url") or (f"https://{domain_name}" if domain_name else "")
            kind_val = d.get("kind")
            target = d.get("target")
            status_val = d.get("status") or d.get("state")
            box_id = d.get("box_id") or d.get("boxId")
            box_name = d.get("box_name") or d.get("boxName")
            port = d.get("port")
            app_id = d.get("app_id") or d.get("appId")
            target_type = d.get("target_type") or d.get("targetType")
            verification_method = d.get("verification_method") or d.get("verificationMethod")
            verification_record_name = d.get("verification_record_name") or d.get("verificationRecordName")
            verification_record_value = d.get("verification_record_value") or d.get("verificationRecordValue")
            cname_target = d.get("cname_target") or d.get("cnameTarget")
            tls_status = d.get("tls_status") or d.get("tlsStatus")
            created_at = d.get("created_at") or d.get("createdAt")
            updated_at = d.get("updated_at") or d.get("updatedAt")
            error_reason = d.get("error_reason") or d.get("errorReason") or d.get("error")
        else:
            domain_name = (
                getattr(d, "hostname", None)
                or getattr(d, "domain", None)
                or getattr(d, "name", None)
                or getattr(d, "id", "")
                or ""
            )
            raw_id = getattr(d, "id", None) or domain_name
            url_val = getattr(d, "url", None) or (f"https://{domain_name}" if domain_name else "")
            kind_val = getattr(d, "kind", None)
            target = getattr(d, "target", None)
            status_val = getattr(d, "status", None) or getattr(d, "state", None)
            box_id = getattr(d, "box_id", None) or getattr(d, "boxId", None)
            box_name = getattr(d, "box_name", None) or getattr(d, "boxName", None)
            port = getattr(d, "port", None)
            app_id = getattr(d, "app_id", None) or getattr(d, "appId", None)
            target_type = getattr(d, "target_type", None) or getattr(d, "targetType", None)
            verification_method = getattr(d, "verification_method", None) or getattr(d, "verificationMethod", None)
            verification_record_name = getattr(d, "verification_record_name", None) or getattr(d, "verificationRecordName", None)
            verification_record_value = getattr(d, "verification_record_value", None) or getattr(d, "verificationRecordValue", None)
            cname_target = getattr(d, "cname_target", None) or getattr(d, "cnameTarget", None)
            tls_status = getattr(d, "tls_status", None) or getattr(d, "tlsStatus", None)
            created_at = getattr(d, "created_at", None) or getattr(d, "createdAt", None)
            updated_at = getattr(d, "updated_at", None) or getattr(d, "updatedAt", None)
            error_reason = getattr(d, "error_reason", None) or getattr(d, "errorReason", None)

        if target is not None:
            t_type = target.get("type") if isinstance(target, dict) else getattr(target, "type", None)
            if t_type == "box":
                target_type = "box"
                t_box = target.get("box") if isinstance(target, dict) else getattr(target, "box", None)
                t_port = target.get("port") if isinstance(target, dict) else getattr(target, "port", None)
                if t_box:
                    box_id = t_box
                if t_port is not None:
                    port = int(t_port)
            elif t_type == "app":
                target_type = "app"
                t_app = target.get("app") if isinstance(target, dict) else getattr(target, "app", None)
                if t_app:
                    app_id = t_app

        if not raw_id:
            raw_id = str(domain_name)

        if not kind_val and isinstance(domain_name, str) and domain_name.lower().endswith(".boxliteapp.com"):
            kind_val = "platform"

        if status_val:
            status_str = str(getattr(status_val, "value", getattr(status_val, "name", status_val))).lower()
            if "." in status_str:
                status_str = status_str.split(".")[-1]
        else:
            status_str = "active" if (box_id or app_id) else "unbound"

        out: Dict[str, Any] = {
            "id": str(raw_id),
            "domain": str(domain_name),
            "status": status_str,
        }
        if url_val:
            out["url"] = str(url_val)
        if kind_val:
            out["kind"] = str(kind_val)
        if target_type:
            out["targetType"] = str(target_type)
        if box_id:
            out["boxId"] = str(box_id)
        if box_name:
            out["boxName"] = str(box_name)
        if app_id:
            out["appId"] = str(app_id)
        if port is not None:
            out["port"] = int(port)
        if verification_method:
            out["verificationMethod"] = str(verification_method)
        if verification_record_name:
            out["verificationRecordName"] = str(verification_record_name)
        if verification_record_value:
            out["verificationRecordValue"] = str(verification_record_value)
        if cname_target:
            out["cnameTarget"] = str(cname_target)
        if tls_status:
            out["tlsStatus"] = str(tls_status)
        if created_at:
            out["createdAt"] = self._serialize_timestamp(created_at) or str(created_at)
        if updated_at:
            out["updatedAt"] = self._serialize_timestamp(updated_at) or str(updated_at)
        if error_reason:
            out["errorReason"] = str(error_reason)
        return out

    def _extract_domain_list(self, raw: Any) -> tuple[List[Any], Optional[Dict[str, Any]]]:
        if raw is None:
            return [], None
        if isinstance(raw, list):
            return raw, None
        if isinstance(raw, dict):
            items = raw.get("domains")
            if not isinstance(items, list):
                items = raw.get("items") if isinstance(raw.get("items"), list) else []
            allowance = raw.get("allowance")
            if allowance is None and any(k in raw for k in ("limit", "used", "remaining")):
                allowance = {
                    "limit": int(raw.get("limit", 0)),
                    "used": int(raw.get("used", 0)),
                    "remaining": int(raw.get("remaining", 0)),
                    "minLength": int(raw.get("min_length", raw.get("minLength", 1))),
                    "domainSuffix": raw.get("domain_suffix", raw.get("domainSuffix")),
                }
            return items, allowance
        items = list(getattr(raw, "domains", None) or [])
        allowance = None
        if hasattr(raw, "limit") or hasattr(raw, "used") or hasattr(raw, "remaining"):
            allowance = {
                "limit": int(getattr(raw, "limit", 0)),
                "used": int(getattr(raw, "used", 0)),
                "remaining": int(getattr(raw, "remaining", 0)),
                "minLength": int(getattr(raw, "min_length", getattr(raw, "minLength", 1))),
                "domainSuffix": getattr(raw, "domain_suffix", getattr(raw, "domainSuffix", None)),
            }
        return items, allowance

    async def handle_list_domains(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        domains = None
        allowance = None
        handle = self._get_domain_handle(rt)
        if handle is not None and hasattr(handle, "list") and callable(handle.list):
            try:
                raw = await handle.list()
                domains, allowance = self._extract_domain_list(raw)
            except Exception as e:
                log_debug(f"rt.domains.list() failed ({e}), falling back to REST")

        if domains is None:
            raw = await self._rest_fallback(rt).list_domains_with_allowance()
            domains, allowance = self._extract_domain_list(raw)

        out: Dict[str, Any] = {"domains": [self._format_domain(d) for d in (domains or [])]}
        if allowance is not None:
            out["allowance"] = allowance
        return out

    async def handle_create_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        raw_name = args.get("name") or args.get("domain") or ""
        box_id = args.get("boxId")
        port = args.get("port")

        res = await self._rest_fallback(rt).claim_domain(raw_name)
        formatted = self._format_domain(res)
        if box_id and port is not None:
            return await self.handle_bind_domain({
                "domainKey": formatted["domain"],
                "boxId": box_id,
                "port": int(port),
            })
        return formatted

    async def handle_bind_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        raw_key = args.get("domainKey") or args.get("domain") or ""
        hostname = raw_key.strip().rstrip(".").lower()
        box_id = str(args["boxId"])
        port = int(args["port"])

        handle = self._get_domain_handle(rt)
        if handle is not None and hasattr(handle, "bind") and callable(handle.bind):
            try:
                import boxlite
                target = boxlite.DomainTarget(type="box", box=box_id, port=port)
                info = await handle.bind(hostname, target)
                return self._format_domain(info)
            except Exception as e:
                log_debug(f"rt.domains.bind() failed ({e}), falling back to REST")

        res = await self._rest_fallback(rt).bind_domain(hostname, box_id, port)
        return self._format_domain(res)

    async def handle_unbind_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        raw_key = args.get("domainKey") or args.get("domain") or ""
        hostname = raw_key.strip().rstrip(".").lower()

        handle = self._get_domain_handle(rt)
        if handle is not None and hasattr(handle, "unbind") and callable(handle.unbind):
            try:
                await handle.unbind(hostname)
                return {"domainKey": hostname, "unbound": True}
            except Exception as e:
                log_debug(f"rt.domains.unbind() failed ({e}), falling back to REST")

        await self._rest_fallback(rt).unbind_domain(hostname)
        return {"domainKey": hostname, "unbound": True}

    async def handle_inspect_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        key = (args.get("domainKey") or "").strip().rstrip(".").lower()
        listed = await self.handle_list_domains({})
        matched = None
        for d in listed.get("domains", []):
            if (d.get("domain") or "").lower() == key or (d.get("id") or "").lower() == key:
                matched = dict(d)
                break
        if matched is None:
            raise RuntimeError(
                f"BoxLite Cloud API error (404) [domain_not_owned]: This organization does not own {key}. "
                "Request a domain in Dashboard > Domains before binding."
            )
        if "allowance" in listed:
            matched["allowance"] = listed["allowance"]
        return {"domain": matched}

    async def handle_verify_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = (args.get("domainKey") or "").strip().rstrip(".").lower()
        listed = await self.handle_list_domains({})
        matched = None
        for d in listed.get("domains", []):
            if (d.get("domain") or "").lower() == key or (d.get("id") or "").lower() == key:
                matched = dict(d)
                break
        if matched is None:
            raise RuntimeError(
                f"BoxLite Cloud API error (404) [domain_not_owned]: This organization does not own {key}. "
                "Request a domain in Dashboard > Domains before binding."
            )

        hostname = matched.get("domain") or key
        target_url = matched.get("url") or f"https://{hostname}"
        kind = matched.get("kind") or ("platform" if hostname.lower().endswith(".boxliteapp.com") else "custom")
        box_id = matched.get("boxId")
        port = matched.get("port")
        app_id = matched.get("appId")

        if not box_id and not app_id:
            if kind == "custom":
                matched["reachable"] = False
                matched["verificationChecks"] = {"owned": True, "bound": False, "dnsRequired": True}
                matched["verificationSummary"] = (
                    f'Custom domain "{hostname}" is registered but unbound. '
                    "Complete DNS/TLS setup in BoxLite Console -> Domains before binding."
                )
            else:
                matched["reachable"] = False
                matched["verificationChecks"] = {"owned": True, "bound": False, "dnsRequired": False}
                matched["verificationSummary"] = (
                    f'Domain "{hostname}" is owned by your organization and ready (no DNS or TLS setup required). '
                    "Bind it to a running Box and port with inbound access and a public tunnel to serve traffic."
                )
            return matched

        box_status = "unknown"
        if box_id:
            try:
                inspected = await self.handle_inspect_box({"boxId": box_id})
                box_status = extract_box_status(inspected.get("box"))
            except Exception as e:
                if _is_not_found_error(e):
                    box_status = "not_found"

        loop = asyncio.get_running_loop()
        fallback = self._rest_fallback(rt)
        probe = await loop.run_in_executor(None, fallback.probe_domain_url, target_url, 10)
        http_status = probe.get("http_status")
        probe_error = probe.get("error")

        port_label = port if port is not None else "?"
        if box_status == "not_found":
            reachable = False
            summary = (
                f'Domain "{hostname}" points to Box "{box_id}" (port {port_label}), which no longer exists. '
                "Bind the domain to another Box or unbind it."
            )
        elif http_status is not None and 200 <= http_status < 400:
            reachable = True
            summary = f'Domain "{hostname}" is verified and reachable (HTTP {http_status}) -> Box {box_id}:{port_label}.'
        elif http_status in (401, 403):
            reachable = True
            summary = (
                f'Domain "{hostname}" reached the service on Box {box_id}:{port_label} '
                f'(HTTP {http_status} application auth).'
            )
        elif http_status == 404:
            reachable = False
            summary = (
                f'Domain "{hostname}" returned HTTP 404. Ensure inbound access is enabled and a public tunnel is active '
                f'for Box {box_id} port {port_label} (private or revoked tunnels do not serve fixed domains).'
            )
        elif http_status == 502:
            reachable = False
            summary = (
                f'Domain "{hostname}" returned HTTP 502 (Box unreachable). '
                f'Ensure the service inside Box {box_id} is running and listening on 0.0.0.0:{port_label}.'
            )
        elif http_status == 503:
            reachable = False
            summary = (
                f'Domain "{hostname}" returned HTTP 503 (Box {box_id} status: {box_status}; may be waking on access). '
                "Retry in a few seconds."
            )
        elif http_status is not None:
            reachable = False
            summary = f'Domain "{hostname}" responded with HTTP {http_status} (Box {box_id} status: {box_status}).'
        else:
            reachable = False
            summary = f'Could not reach "{target_url}": {probe_error or "connection failed"}.'

        matched["reachable"] = reachable
        if http_status is not None:
            matched["httpStatus"] = http_status
        matched["verificationSummary"] = summary
        matched["verificationChecks"] = {
            "owned": True,
            "bound": True,
            "dnsRequired": kind == "custom",
            "boxStatus": box_status,
            "httpStatus": http_status,
            "reachable": reachable,
        }
        return matched

    async def handle_update_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        key = args["domainKey"]
        box_id = args.get("boxId") if "boxId" in args else _UNSET
        port = args.get("port") if "port" in args else _UNSET

        if box_id is None or box_id == "":
            await self.handle_unbind_domain({"domainKey": key})
            hostname = key.strip().rstrip(".").lower()
            return self._format_domain({"hostname": hostname, "url": f"https://{hostname}", "target": None})

        return await self.handle_bind_domain({"domainKey": key, "boxId": box_id, "port": port})

    async def handle_remove_domain(self, args: Dict[str, Any]) -> Dict[str, Any]:
        rt = self.ensure_runtime()
        key = args["domainKey"]
        await self._rest_fallback(rt).remove_domain(key)
        return {"domainKey": key, "removed": True}

    async def dispatch(self, req: Dict[str, Any]):
        req_id = req.get("id", "none")
        op = req.get("op", "")
        args = req.get("args", {})

        handler_name = f"handle_{op}"
        handler = getattr(self, handler_name, None)

        if not handler:
            send_response(
                req_id,
                False,
                error={
                    "code": "UnknownOperation",
                    "message": f"Operation '{op}' is not supported by BoxLite bridge"
                }
            )
            return

        try:
            result = await handler(args)
            send_response(req_id, True, data=result)
        except Exception as e:
            tb = traceback.format_exc()
            error_class = e.__class__.__name__
            message = str(e)

            # Formulate structured diagnostic guidance according to §5
            diagnosis = None
            lower_msg = message.lower()
            if _is_image_pull_error(message):
                diagnosis = (
                    "Image pull failed: (1) check the reference for typos (short names default to Docker Hub; "
                    "base, python, and node are BoxLite built-ins), (2) if the image is private, register a "
                    "registry login via 'BoxLite: Connect Private Registry...', (3) verify the tag exists. "
                    "Note: a create that fails on its image still leaves the box behind — remove it by the box name passed to create()."
                )
            elif _is_image_catalog_limit_error(message):
                diagnosis = (
                    "Image catalog limit reached: each organization catalog holds up to 20 recorded custom images. "
                    "Remove unused custom images before booting a new image (docs.boxlite.ai/cloud/image-catalog)."
                )
            elif "box networking is disabled" in lower_msg or "no guest nic" in lower_msg:
                diagnosis = (
                    "Box networking is permanently disabled: this box was created with Outbound Network disabled "
                    "(no guest NIC provisioned at creation, e.g. Quick Create or Air-Gapped mode). Network policies "
                    "and tunnels cannot be modified after creation — create a new box with Outbound Network enabled."
                )
            elif "domain_not_owned" in lower_msg or "does not own" in lower_msg:
                diagnosis = (
                    "Domain not owned: reserve the domain first via 'BoxLite: Request Domain...' or BoxLite Console -> Domains, "
                    "and pass the full hostname (e.g. my-service.boxliteapp.com) with the matching organization API key."
                )
            elif "domain_count_limit_reached" in lower_msg:
                diagnosis = (
                    "Organization domain allowance reached: unbinding keeps a domain reserved and does not free a slot. "
                    "Reuse an existing unbound domain or upgrade your plan in BoxLite Console."
                )
            elif "subdomain_too_short" in lower_msg:
                diagnosis = "Platform subdomain is too short: choose a longer subdomain name meeting your organization minimum length."
            elif "subdomain_taken" in lower_msg:
                diagnosis = "Platform subdomain is already taken by another organization: choose a different name."
            elif "region_not_supported" in lower_msg:
                diagnosis = "Box region is served by a regional proxy and cannot be bound to a platform subdomain."
            elif "platform_domain_not_configured" in lower_msg:
                diagnosis = "Platform domains are not configured on this BoxLite Cloud server."
            elif "domain_not_ready" in lower_msg or "subscription_required" in lower_msg or "subscription_not_ready" in lower_msg:
                diagnosis = "Custom domain setup or subscription is incomplete: complete setup in BoxLite Console -> Domains."
            elif "502" in message or "unreachable" in lower_msg:
                diagnosis = "502 Bad Gateway / Box unreachable: Check app listener on 0.0.0.0, /tmp/server.log, network inbound mode, and tunnel declaration (agent.md §5)."
            elif "401" in message or "unauthorized" in message.lower() or ("invalid credentials" in message.lower() and "403" not in message):
                diagnosis = "401 Unauthorized: Invalid credentials or missing token. Check credentials and BOXLITE_API_KEY via 'BoxLite: Sign In / Set API Key' (agent.md §5)."
            elif "403" in message or "forbidden" in message.lower():
                diagnosis = "403 Forbidden: Check authentication/token and requested URL; do not assume either app health or one particular policy cause (agent.md §5). Note: do not infer managed database or shared-volume support (agent.md §4). For private images or registries, ensure API key has Full access (docs.boxlite.ai/cloud/private-images)."
            elif "409" in message or "already ran" in message.lower() or "conflict" in message.lower():
                diagnosis = "409 Conflict: Process already ran or name conflict. Check supervisor entrypoint and box lifecycle (agent.md §5)."
            elif (
                "exceed per-box limit" in lower_msg
                or "exceeds the per-box limit" in lower_msg
                or "requested resources exceed" in lower_msg
            ):
                diagnosis = (
                    "Requested resources exceed per-box limits: BoxLite Cloud enforces per-box resource limits "
                    "(standard rootfs disk limit is 10 GB). Set disk size to 10 GB or less (or lower CPU/memory) "
                    "in Box options, boxlite.json, or boxlite.defaultDisk, or attach a Managed Volume for extra storage."
                )
            elif "400" in message or "bad request" in message.lower():
                diagnosis = "400 Bad Request: Check schema validation and parameters; ensure deprecated or unsupported fields (such as auto_remove) are omitted (agent.md §5)."
            elif "NetworkError" in error_class or "network" in message.lower():
                diagnosis = "BoxLite NetworkError: Connection failure talking to BoxLite Cloud. Check API key and BOXLITE_REST_URL (agent.md §5)."
            elif "BOXLITE_API_KEY" in message:
                diagnosis = "Missing API key: Configure your BoxLite Cloud API key with 'BoxLite: Sign In / Set API Key'."

            send_response(
                req_id,
                False,
                error={
                    "code": error_class,
                    "message": message,
                    "diagnosis": diagnosis,
                    "stack": tb
                }
            )


async def read_stdin_line() -> str:
    """Read a single line from sys.stdin in an executor thread, cross-platform."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, sys.stdin.readline)


async def main():
    bridge = BoxLiteBridge()
    log_debug("BoxLite Python bridge started. Listening on stdin...")

    while True:
        line = await read_stdin_line()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            asyncio.create_task(bridge.dispatch(req))
        except json.JSONDecodeError as err:
            log_debug(f"JSON decode error: {err}")
            send_response("error", False, error={"code": "InvalidJson", "message": str(err)})


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass
