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

    def read(self):
        return self._body

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
            disk_size_gb=20,
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
        self.assertEqual(kwargs["disk_size_gb"], 20)
        self.assertEqual(kwargs["auto_delete"], 3600)
        self.assertEqual(kwargs["auto_resume"], False)

    def test_rest_fallback_reuses_existing_rest_runtime(self):
        br = bridge.BoxLiteBridge()
        rt = bridge.RestRuntimeFallback("https://api.boxlite.ai", "bl_key")
        self.assertIs(br._rest_fallback(rt), rt)

        with patch.dict(os.environ, {"BOXLITE_REST_URL": "https://custom.boxlite.ai", "BOXLITE_API_KEY": "k1"}):
            fb = br._rest_fallback(object())
            self.assertIsInstance(fb, bridge.RestRuntimeFallback)
            self.assertEqual(fb.rest_url, "https://custom.boxlite.ai")
            self.assertEqual(fb.api_key, "k1")


if __name__ == "__main__":
    unittest.main()
