import asyncio
import io
import json
import os
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

BRIDGE_DIR = Path(__file__).resolve().parent.parent / "src" / "bridge" / "python"
sys.path.insert(0, str(BRIDGE_DIR))

import bridge  # noqa: E402


class FakeHttpResponse:
    def __init__(self, payload, status=200):
        self._body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.status = status

    def read(self, amt=None):
        return self._body[:amt] if amt is not None else self._body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False


class TestRestRuntimeFallback(unittest.IsolatedAsyncioTestCase):
    async def test_image_methods_url_encode_name_and_alias(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")
        captured = []

        def fake_urlopen(req, timeout=30):
            captured.append((req.get_method(), req.full_url, req.data))
            return FakeHttpResponse({"name": "ghcr.io/acme/api:1.4.0"})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            await rt.get_image("ghcr.io/acme/api:1.4.0")
            await rt.remove_image("ghcr.io/acme/api:1.4.0")
            await rt.create_image_alias("ghcr.io/acme/api:1.4.0", "release/v1:prod", "sha256:abc")
            await rt.delete_image_alias("ghcr.io/acme/api:1.4.0", "release/v1:prod")

        encoded_img = "ghcr.io%2Facme%2Fapi%3A1.4.0"
        encoded_alias = "release%2Fv1%3Aprod"
        self.assertEqual(
            [(m, u) for m, u, _ in captured],
            [
                ("GET", f"https://api.boxlite.ai/v1/images/{encoded_img}"),
                ("DELETE", f"https://api.boxlite.ai/v1/images/{encoded_img}"),
                ("POST", f"https://api.boxlite.ai/v1/images/{encoded_img}/aliases"),
                ("DELETE", f"https://api.boxlite.ai/v1/images/{encoded_img}/aliases/{encoded_alias}"),
            ],
        )

    async def test_list_images_propagates_401_and_403_errors(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bad_key")

        def raise_403(req, timeout=30):
            raise urllib.error.HTTPError(
                req.full_url, 403, "Forbidden", hdrs=None, fp=io.BytesIO(b'{"message":"Forbidden"}')
            )

        with patch("urllib.request.urlopen", side_effect=raise_403):
            with self.assertRaises(RuntimeError) as ctx:
                await rt.list_images()
            self.assertIn("403", str(ctx.exception))

    async def test_list_images_tolerates_optional_usage_failure(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")

        def fake_urlopen(req, timeout=30):
            if req.full_url.endswith("/images/usage"):
                raise urllib.error.HTTPError(
                    req.full_url, 404, "Not Found", hdrs=None, fp=io.BytesIO(b"not found")
                )
            return FakeHttpResponse({"images": [{"name": "python:alpine"}]})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            res = await rt.list_images()
            self.assertEqual(res["images"], [{"name": "python:alpine"}])
            self.assertIsNone(res["usage"])

    async def test_create_start_use_longer_timeout_and_remove_url_encodes_box_target(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")
        calls = []

        def fake_urlopen(req, timeout=30):
            calls.append((req.get_method(), req.full_url, timeout))
            return FakeHttpResponse({"id": "box_123"})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            await rt.create(image="docker.io/library/alpine:3.20", name="demo box")
            await rt.start("box_123")
            await rt.remove("demo box", force=True)

        self.assertEqual(
            calls,
            [
                ("POST", "https://api.boxlite.ai/v1/boxes", 120),
                ("POST", "https://api.boxlite.ai/v1/boxes/box_123/start", 120),
                ("DELETE", "https://api.boxlite.ai/v1/boxes/demo%20box?force=true", 30),
            ],
        )

    async def test_domain_endpoints_match_boxlite_cloud_openapi(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")
        captured = []

        def fake_urlopen(req, timeout=30):
            body = json.loads(req.data.decode("utf-8")) if req.data else None
            captured.append((req.get_method(), req.full_url, body))
            if req.get_method() == "GET" and req.full_url.endswith("/v1/domains"):
                return FakeHttpResponse({
                    "domains": [
                        {
                            "hostname": "fd-system-holdings.boxliteapp.com",
                            "kind": "platform",
                            "url": "https://fd-system-holdings.boxliteapp.com",
                            "target": None,
                        },
                        {
                            "hostname": "api-demo.boxliteapp.com",
                            "kind": "platform",
                            "url": "https://api-demo.boxliteapp.com",
                            "target": {"type": "box", "box": "box_1", "port": 8080},
                        },
                    ],
                    "limit": 5,
                    "used": 2,
                    "remaining": 3,
                    "min_length": 5,
                    "domain_suffix": "boxliteapp.com",
                })
            if req.get_method() == "POST":
                return FakeHttpResponse({
                    "hostname": "my-service.boxliteapp.com",
                    "url": "https://my-service.boxliteapp.com",
                    "target": None,
                })
            if req.get_method() == "PUT":
                return FakeHttpResponse({
                    "hostname": "fd-system-holdings.boxliteapp.com",
                    "url": "https://fd-system-holdings.boxliteapp.com",
                    "target": {"type": "box", "box": "box_1", "port": 8080},
                })
            return FakeHttpResponse(None, status=204)

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            listed = await rt.list_domains_with_allowance()
            claimed = await rt.claim_domain("my-service.boxliteapp.com", domain_suffix="boxliteapp.com")
            bound = await rt.bind_domain("fd-system-holdings.boxliteapp.com.", "box_1", 8080)
            await rt.unbind_domain("fd-system-holdings.boxliteapp.com")

        self.assertEqual(len(listed["domains"]), 2)
        self.assertEqual(listed["allowance"]["remaining"], 3)
        self.assertEqual(listed["allowance"]["domainSuffix"], "boxliteapp.com")
        self.assertEqual(claimed["hostname"], "my-service.boxliteapp.com")
        self.assertEqual(bound["target"], {"type": "box", "box": "box_1", "port": 8080})
        self.assertEqual(
            captured,
            [
                ("GET", "https://api.boxlite.ai/v1/domains", None),
                ("POST", "https://api.boxlite.ai/v1/domains", {"name": "my-service"}),
                (
                    "PUT",
                    "https://api.boxlite.ai/v1/domains/fd-system-holdings.boxliteapp.com/target",
                    {"type": "box", "box": "box_1", "port": 8080},
                ),
                (
                    "DELETE",
                    "https://api.boxlite.ai/v1/domains/fd-system-holdings.boxliteapp.com/target",
                    None,
                ),
            ],
        )

    async def test_http_error_surfaces_code_and_list_messages(self):
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")

        def raise_404(req, timeout=30):
            raise urllib.error.HTTPError(
                req.full_url,
                404,
                "Not Found",
                hdrs=None,
                fp=io.BytesIO(
                    json.dumps({
                        "code": "domain_not_owned",
                        "message": ["This organization does not own demo.boxliteapp.com."],
                    }).encode("utf-8")
                ),
            )

        with patch("urllib.request.urlopen", side_effect=raise_404):
            with self.assertRaises(RuntimeError) as ctx:
                await rt.bind_domain("demo.boxliteapp.com", "box_1", 8080)
            self.assertIn("[domain_not_owned]", str(ctx.exception))
            self.assertIn("does not own demo.boxliteapp.com", str(ctx.exception))


class TestBoxLiteBridge(unittest.IsolatedAsyncioTestCase):
    async def test_handle_tail_log_uses_box_inspect_when_rt_lacks_inspect(self):
        br = bridge.BoxLiteBridge()

        class FakeExecResult:
            stdout = "hello from server\n"
            exit_code = 0

        class FakeBox:
            def __init__(self, status):
                self._status = status
                self.exec_called = False

            async def inspect(self):
                return {"status": self._status}

            async def exec(self, *args):
                self.exec_called = True
                return FakeExecResult()

        class FakeNativeRuntimeWithoutInspect:
            pass

        br.rt = FakeNativeRuntimeWithoutInspect()

        running_box = FakeBox("running")
        br.boxes["box-run"] = running_box
        res_run = await br.handle_tail_log({"boxId": "box-run", "lines": 20})
        self.assertEqual(res_run["content"], "hello from server\n")
        self.assertTrue(running_box.exec_called)

        stopped_box = FakeBox("stopped")
        br.boxes["box-stop"] = stopped_box
        res_stop = await br.handle_tail_log({"boxId": "box-stop", "lines": 20})
        self.assertTrue(res_stop["stopped"])
        self.assertEqual(res_stop["content"], "")
        self.assertFalse(stopped_box.exec_called)

    async def test_handle_inspect_image_propagates_rest_errors(self):
        br = bridge.BoxLiteBridge()
        br.rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bad_key")

        def raise_401(req, timeout=30):
            raise urllib.error.HTTPError(
                req.full_url, 401, "Unauthorized", hdrs=None, fp=io.BytesIO(b'{"message":"Unauthorized"}')
            )

        with patch("urllib.request.urlopen", side_effect=raise_401):
            with self.assertRaises(RuntimeError) as ctx:
                await br.handle_inspect_image({"name": "ghcr.io/acme/api:1.0"})
            self.assertIn("401", str(ctx.exception))

    def test_build_rest_create_kwargs_clamps_auto_stop_and_omits_auto_remove(self):
        br = bridge.BoxLiteBridge()
        kwargs = br._build_rest_create_kwargs(
            image="node:20-alpine",
            name="my-app",
            auto_stop=30,
            auto_delete=3600,
            auto_resume=False,
            cpus=2,
            memory_mib=2048,
            disk_size_gb=10,
            env={"PORT": "3000"},
            cmd=["node", "server.js"],
            entrypoint=None,
            network_spec={"outbound": {"mode": "enabled"}},
            volumes=[{"managed_volume": "v1", "guest_path": "/data"}],
            secrets_payload=[{"name": "api", "value": "x", "hosts": ["api.example.com"], "headers": {}}],
        )
        self.assertEqual(kwargs["auto_stop"], 60)
        self.assertNotIn("auto_remove", kwargs)
        self.assertEqual(kwargs["cpus"], 2)
        self.assertEqual(kwargs["memory_mib"], 2048)
        self.assertEqual(kwargs["disk_size_gb"], 10)
        self.assertEqual(kwargs["auto_delete"], 3600)
        self.assertEqual(kwargs["auto_resume"], False)

        custom_kwargs = br._build_rest_create_kwargs(
            image="node:20-alpine",
            name="my-custom-app",
            auto_stop=0,
            auto_delete=0,
            auto_resume=True,
            cpus=4,
            memory_mib=4096,
            disk_size_gb=25,
            env=None,
            cmd=None,
            entrypoint=None,
            network_spec=None,
            volumes=None,
            secrets_payload=None,
        )
        self.assertEqual(custom_kwargs["disk_size_gb"], 25)

    def test_rest_fallback_reuses_existing_rest_runtime(self):
        br = bridge.BoxLiteBridge()
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_key")
        self.assertIs(br._rest_fallback(rt), rt)

        with patch.dict(os.environ, {"BOXLITE_REST_URL": "https://custom.boxlite.ai", "BOXLITE_API_KEY": "k1"}):
            fb = br._rest_fallback(object())
            self.assertIsInstance(fb, bridge.RestRuntimeFallback)
            self.assertEqual(fb.rest_url, "https://custom.boxlite.ai")
            self.assertEqual(fb.api_key, "k1")

    async def test_handle_remove_box_falls_back_to_lookup_by_name_and_ignore_not_found(self):
        br = bridge.BoxLiteBridge()

        class FakeRuntime:
            def __init__(self):
                self.removed = []

            async def remove(self, target, force=False):
                if target == "demo-failed":
                    raise RuntimeError("BoxLite Cloud API error (404): box not found")
                self.removed.append((target, force))

            async def list_info(self):
                return [{"id": "box_orphan_99", "name": "demo-failed", "status": "stopped"}]

        rt = FakeRuntime()
        br.rt = rt
        res = await br.handle_remove_box({"boxId": "demo-failed", "ignoreNotFound": True})
        self.assertEqual(res, {"boxId": "box_orphan_99", "removed": True})
        self.assertEqual(rt.removed, [("box_orphan_99", True)])

        class MissingRuntime:
            async def remove(self, target, force=False):
                raise RuntimeError("BoxLite Cloud API error (404): not found")

            async def list_info(self):
                return []

        br.rt = MissingRuntime()
        res_missing = await br.handle_remove_box({"boxId": "no-such-box", "ignoreNotFound": True})
        self.assertEqual(res_missing, {"boxId": "no-such-box", "removed": False, "notFound": True})

    async def test_handle_list_images_falls_back_to_rest_when_sdk_list_fails_even_if_usage_succeeds(self):
        br = bridge.BoxLiteBridge()

        class FakeUsage:
            count = 1
            limit = 20
            known_bytes = 3630321

        class FakeImagesMgr:
            async def list(self):
                raise RuntimeError("SDK list failed")

            async def usage(self):
                return FakeUsage()

        class FakeNativeRuntime:
            images = FakeImagesMgr()

        br.rt = FakeNativeRuntime()

        def fake_urlopen(req, timeout=30):
            if req.full_url.endswith("/images/usage"):
                return FakeHttpResponse({"count": 1, "limit": 20, "known_bytes": 3630321})
            return FakeHttpResponse({"images": [{"name": "docker.io/library/alpine", "size_bytes": 3630321}]})

        with patch.dict(os.environ, {"BOXLITE_REST_URL": "https://api.boxlite.ai", "BOXLITE_API_KEY": "k1"}):
            with patch("urllib.request.urlopen", side_effect=fake_urlopen):
                res = await br.handle_list_images({})
                self.assertEqual(len(res["images"]), 1)
                self.assertEqual(res["images"][0]["name"], "docker.io/library/alpine")
                self.assertEqual(res["usage"]["count"], 1)

    async def test_handle_inspect_image_retries_with_canonical_name_on_404(self):
        br = bridge.BoxLiteBridge()
        br.rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_key")
        requested_urls = []

        def fake_urlopen(req, timeout=30):
            requested_urls.append(req.full_url)
            if req.full_url.endswith("%3A3.20"):
                raise urllib.error.HTTPError(
                    req.full_url, 404, "Not Found", hdrs=None, fp=io.BytesIO(b'{"message":"not found"}')
                )
            return FakeHttpResponse({"name": "docker.io/library/alpine", "versions": [{"digest": "sha256:" + "a" * 64}]})

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            res = await br.handle_inspect_image({"name": "docker.io/library/alpine:3.20"})

        self.assertEqual(res["image"]["name"], "docker.io/library/alpine")
        self.assertEqual(
            requested_urls,
            [
                "https://api.boxlite.ai/v1/images/docker.io%2Flibrary%2Falpine%3A3.20",
                "https://api.boxlite.ai/v1/images/docker.io%2Flibrary%2Falpine",
            ],
        )

    async def test_dispatch_diagnoses_image_pull_unauthorized_without_api_key_misattribution(self):
        br = bridge.BoxLiteBridge()

        async def fail_create(_args):
            raise RuntimeError(
                "Box state transition failed: Failed to pull image 'acme/api:1.4.0': docker.io refused the pull (UNAUTHORIZED)."
            )

        br.handle_create_box = fail_create
        captured = []
        with patch.object(bridge, "send_response", side_effect=lambda req_id, ok, data=None, error=None: captured.append((req_id, ok, error))):
            await br.dispatch({"id": "req_1", "op": "create_box", "args": {}})

        self.assertEqual(len(captured), 1)
        self.assertFalse(captured[0][1])
        diag = captured[0][2]["diagnosis"]
        self.assertIn("Image pull failed", diag)
        self.assertNotIn("401 Unauthorized", diag)

    async def test_dispatch_diagnoses_per_box_resource_limit_without_auto_remove_misattribution(self):
        br = bridge.BoxLiteBridge()

        async def fail_create(_args):
            raise RuntimeError(
                "BoxLite Cloud API error (400): Requested resources exceed per-box limits: disk 20GB exceeds the per-box limit of 10GB"
            )

        br.handle_create_box = fail_create
        captured = []
        with patch.object(bridge, "send_response", side_effect=lambda req_id, ok, data=None, error=None: captured.append((req_id, ok, error))):
            await br.dispatch({"id": "req_2", "op": "create_box", "args": {}})

        self.assertEqual(len(captured), 1)
        self.assertFalse(captured[0][1])
        diag = captured[0][2]["diagnosis"]
        self.assertIn("Requested resources exceed per-box limits", diag)
        self.assertNotIn("auto_remove", diag)

    async def test_handle_list_domains_handles_native_sdk_domain_list_and_derives_status(self):
        br = bridge.BoxLiteBridge()

        class FakeTarget:
            type = "box"
            box = "box_99"
            port = 3000

        class FakeDomainObj:
            def __init__(self, hostname, target):
                self.hostname = hostname
                self.url = f"https://{hostname}"
                self.target = target

        class FakeDomainList:
            domains = [
                FakeDomainObj("fd-system-holdings.boxliteapp.com", None),
                FakeDomainObj("app-live.boxliteapp.com", FakeTarget()),
            ]
            limit = 5
            used = 2
            remaining = 3
            min_length = 5

        class FakeDomainsHandle:
            async def list(self):
                return FakeDomainList()

        class FakeNativeRuntime:
            domains = FakeDomainsHandle()

        br.rt = FakeNativeRuntime()
        res = await br.handle_list_domains({})
        self.assertEqual(len(res["domains"]), 2)
        self.assertEqual(res["domains"][0]["domain"], "fd-system-holdings.boxliteapp.com")
        self.assertEqual(res["domains"][0]["status"], "unbound")
        self.assertEqual(res["domains"][0]["kind"], "platform")
        self.assertEqual(res["domains"][1]["status"], "active")
        self.assertEqual(res["domains"][1]["boxId"], "box_99")
        self.assertEqual(res["domains"][1]["port"], 3000)
        self.assertEqual(res["allowance"], {"limit": 5, "used": 2, "remaining": 3, "minLength": 5, "domainSuffix": None})

    async def test_handle_inspect_and_verify_domain_never_post_verify_and_check_reachability(self):
        br = bridge.BoxLiteBridge()
        br.rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_test_key")

        domains_payload = {
            "domains": [
                {
                    "hostname": "fd-system-holdings.boxliteapp.com",
                    "kind": "platform",
                    "url": "https://fd-system-holdings.boxliteapp.com",
                    "target": None,
                },
                {
                    "hostname": "live-app.boxliteapp.com",
                    "kind": "platform",
                    "url": "https://live-app.boxliteapp.com",
                    "target": {"type": "box", "box": "box_1", "port": 8080},
                },
            ],
            "limit": 5,
            "used": 2,
            "remaining": 3,
            "min_length": 5,
            "domain_suffix": "boxliteapp.com",
        }
        probe_status = 200
        requests = []

        def fake_urlopen(req, timeout=30):
            requests.append((req.get_method(), req.full_url, dict(req.header_items())))
            if "/verify" in req.full_url:
                raise AssertionError(f"Must never call /verify endpoint: {req.full_url}")
            if req.full_url == "https://api.boxlite.ai/v1/domains":
                return FakeHttpResponse(domains_payload)
            if req.full_url == "https://api.boxlite.ai/v1/boxes/box_1":
                return FakeHttpResponse({"id": "box_1", "status": "running"})
            if req.full_url == "https://live-app.boxliteapp.com":
                if probe_status >= 400:
                    raise urllib.error.HTTPError(
                        req.full_url, probe_status, "Err", hdrs=None, fp=io.BytesIO(b"")
                    )
                return FakeHttpResponse(None, status=probe_status)
            raise AssertionError(f"Unexpected URL: {req.full_url}")

        with patch("urllib.request.urlopen", side_effect=fake_urlopen):
            inspected = await br.handle_inspect_domain({"domainKey": "fd-system-holdings.boxliteapp.com"})
            self.assertEqual(inspected["domain"]["status"], "unbound")
            self.assertEqual(inspected["domain"]["allowance"]["limit"], 5)

            unbound_ver = await br.handle_verify_domain({"domainKey": "fd-system-holdings.boxliteapp.com"})
            self.assertEqual(unbound_ver["status"], "unbound")
            self.assertFalse(unbound_ver["reachable"])
            self.assertEqual(unbound_ver["verificationChecks"]["owned"], True)
            self.assertEqual(unbound_ver["verificationChecks"]["bound"], False)
            self.assertEqual(unbound_ver["verificationChecks"]["dnsRequired"], False)

            ok_ver = await br.handle_verify_domain({"domainKey": "live-app.boxliteapp.com"})
            self.assertTrue(ok_ver["reachable"])
            self.assertEqual(ok_ver["httpStatus"], 200)
            self.assertIn("verified and reachable", ok_ver["verificationSummary"])

            probe_headers = [h for m, u, h in requests if u == "https://live-app.boxliteapp.com"][0]
            self.assertEqual(probe_headers.get("X-boxlite-skip-preview-warning"), "true")

            probe_status = 404
            missing_tunnel_ver = await br.handle_verify_domain({"domainKey": "live-app.boxliteapp.com"})
            self.assertFalse(missing_tunnel_ver["reachable"])
            self.assertEqual(missing_tunnel_ver["httpStatus"], 404)
            self.assertIn("public tunnel", missing_tunnel_ver["verificationSummary"])

            probe_status = 502
            bad_gw_ver = await br.handle_verify_domain({"domainKey": "live-app.boxliteapp.com"})
            self.assertFalse(bad_gw_ver["reachable"])
            self.assertIn("0.0.0.0:8080", bad_gw_ver["verificationSummary"])

            probe_status = 503
            waking_ver = await br.handle_verify_domain({"domainKey": "live-app.boxliteapp.com"})
            self.assertFalse(waking_ver["reachable"])
            self.assertIn("503", waking_ver["verificationSummary"])

            with self.assertRaises(RuntimeError) as not_owned_ctx:
                await br.handle_verify_domain({"domainKey": "unknown.boxliteapp.com"})
            self.assertIn("domain_not_owned", str(not_owned_ctx.exception))

    async def test_dispatch_diagnoses_domain_error_codes(self):
        br = bridge.BoxLiteBridge()

        for msg, expected in [
            ("BoxLite Cloud API error (404) [domain_not_owned]: does not own x.boxliteapp.com", "Domain not owned"),
            ("BoxLite Cloud API error (400) [domain_count_limit_reached]: full", "domain allowance reached"),
            ("BoxLite Cloud API error (400) [subdomain_too_short]: short", "too short"),
            ("BoxLite Cloud API error (409) [subdomain_taken]: taken", "already taken"),
        ]:
            async def fail(_args, m=msg):
                raise RuntimeError(m)

            br.handle_verify_domain = fail
            captured = []
            with patch.object(bridge, "send_response", side_effect=lambda req_id, ok, data=None, error=None: captured.append((req_id, ok, error))):
                await br.dispatch({"id": "req_d", "op": "verify_domain", "args": {}})
            self.assertEqual(len(captured), 1)
            self.assertFalse(captured[0][1])
            self.assertIn(expected.lower(), captured[0][2]["diagnosis"].lower())

    async def test_security_hardening_rest_url_volume_encoding_and_verify_host(self):
        # 1. Non-loopback http:// must be rejected to protect API keys
        with self.assertRaises(ValueError):
            bridge.RestRuntimeFallback("http://api.boxlite.ai", "bl_test_key")
        # Loopback http:// and https:// are allowed
        rt_local = bridge.RestRuntimeFallback("http://127.0.0.1:8080", "bl_test_key")
        self.assertEqual(rt_local.rest_url, "http://127.0.0.1:8080")
        rt_https = bridge.RestRuntimeFallback("https://api.boxlite.ai/", "bl_test_key")
        self.assertEqual(rt_https.rest_url, "https://api.boxlite.ai")

        # 2. volume_id must be URL-encoded in get_volume and remove_volume
        called_paths = []

        def fake_request(method, req_path, body=None, timeout=30):
            called_paths.append((method, req_path))
            return {}

        rt_https._request = fake_request
        await rt_https.get_volume("../boxes/abc")
        await rt_https.remove_volume("vol/1?force=false#x", force=True)
        self.assertEqual(called_paths[0], ("GET", "/volumes/..%2Fboxes%2Fabc"))
        self.assertEqual(called_paths[1], ("DELETE", "/volumes/vol%2F1%3Fforce%3Dfalse%23x?force=true"))

        # 3. verify_secret_injection rejects malicious host injection
        br = bridge.BoxLiteBridge()
        br.rt = rt_https
        with self.assertRaises(ValueError):
            await br.handle_verify_secret_injection({"host": 'httpbingo.org"); import os; #'})


if __name__ == "__main__":
    unittest.main()
