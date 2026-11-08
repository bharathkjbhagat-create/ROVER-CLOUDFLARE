"""Runs the Node unit tests for the browser vision decision logic."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class VisionCoreNodeTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node is required")
    def test_node_suite(self):
        result = subprocess.run(["node", "--test", str(ROOT / "tests" / "vision_core.test.js")],
                                capture_output=True, text=True, cwd=ROOT)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()