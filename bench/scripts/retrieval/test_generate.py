"""Verify frozen identity and refuse drift without touching the committed checksum."""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

GENERATOR = Path(__file__).with_name("generate.py")
FROZEN_SHA256 = "6c750e41b0aa29ce6fb1c65c191686bad6d1ddc9fc273d07f491b0ea76e7fcd3"


class GeneratorTests(unittest.TestCase):
    def test_stdout_and_generated_file_share_frozen_identity(self):
        first = subprocess.check_output(
            [sys.executable, "-B", str(GENERATOR), "--stdout"]
        )
        self.assertEqual(hashlib.sha256(first).hexdigest(), FROZEN_SHA256)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "corpus.json"
            subprocess.run(
                [sys.executable, "-B", str(GENERATOR), "--output", str(output)],
                check=True,
                capture_output=True,
            )
            self.assertEqual(first, output.read_bytes())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
        corpus = json.loads(first)
        self.assertEqual(len(corpus["messages"]), 3000)
        self.assertEqual(len(corpus["labels"]), 80)

    def test_drift_fails_before_writing_or_blessing_checksum(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            generator = root / "bench/scripts/retrieval/generate.py"
            generator.parent.mkdir(parents=True)
            generator.write_bytes(GENERATOR.read_bytes())
            checksum = root / "bench/fixtures/retrieval/corpus.sha256"
            checksum.parent.mkdir(parents=True)
            checksum.write_text("0" * 64 + "\n")
            output = root / "corpus.json"
            result = subprocess.run(
                [sys.executable, "-B", str(generator), "--output", str(output)],
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(b"generated fixture hash mismatch", result.stderr)
            self.assertFalse(output.exists())
            self.assertEqual(checksum.read_text(), "0" * 64 + "\n")


if __name__ == "__main__":
    unittest.main()
