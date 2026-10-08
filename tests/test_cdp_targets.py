import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cdp_bridge import DEBUG_PORT, is_local_page_target


class CDPTargetTests(unittest.TestCase):
    def target(self, endpoint):
        return {"type": "page", "url": "app://-/index.html", "webSocketDebuggerUrl": endpoint}

    def test_same_loopback_endpoint_allowed(self):
        self.assertTrue(is_local_page_target(self.target(f"ws://127.0.0.1:{DEBUG_PORT}/devtools/page/abc")))

    def test_external_or_wrong_port_or_credentials_rejected(self):
        for endpoint in ["ws://example.com:9233/devtools/page/a", "ws://127.0.0.1:99/devtools/page/a",
                         f"ws://user@127.0.0.1:{DEBUG_PORT}/devtools/page/a", "ws://[broken", None,
                         f"ws://127.0.0.1:{DEBUG_PORT}/devtools/browser/abc"]:
            with self.subTest(endpoint=endpoint): self.assertFalse(is_local_page_target(self.target(endpoint)))

    def test_unrelated_page_rejected(self):
        target = self.target(f"ws://127.0.0.1:{DEBUG_PORT}/devtools/page/abc")
        target["url"] = "https://example.com"
        self.assertFalse(is_local_page_target(target))


if __name__ == "__main__": unittest.main()
