"""Guard the ESP32 fleet transport against insecure TLS fallback."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FirmwareTlsPolicyTests(unittest.TestCase):
    def test_https_requires_a_ca_and_never_disables_certificate_verification(self):
        source = (ROOT / "firmware/esp32_rover/esp32_rover.ino").read_text(encoding="utf-8")
        start = source.index("#if DEFENX_USE_TLS", source.index("static int signedPost"))
        end = source.index("#else", start)
        tls_block = source[start:end]
        self.assertIn("!TLS_ROOT_CA || TLS_ROOT_CA[0] == '\\0'", tls_block)
        self.assertIn("return -4;", tls_block)
        self.assertIn("tls.setCACert(TLS_ROOT_CA);", tls_block)
        self.assertNotIn("setInsecure", tls_block)

    def test_example_configuration_warns_that_ca_is_required(self):
        config = (ROOT / "firmware/esp32_rover/config.example.h").read_text(encoding="utf-8")
        self.assertIn("#define DEFENX_USE_TLS   1", config)
        self.assertIn("#define TLS_ROOT_CA", config)
        self.assertIn("REQUIRED", config)
