import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from biometric_crypto import (
    PREFIX,
    BiometricCryptoError,
    decrypt_bytes,
    encrypt_bytes,
    key_is_valid,
)


class BiometricCryptoTests(unittest.TestCase):
    def setUp(self):
        self.key = "test-only-random-key-material-32-bytes-minimum"
        self.aad = "defenx-face-enrollment:person-1:descriptor:v1"
        self.plaintext = b'{"descriptor":[0.1,0.2,0.3]}'

    def test_key_requires_minimum_length(self):
        self.assertFalse(key_is_valid(""))
        self.assertFalse(key_is_valid("short"))
        self.assertTrue(key_is_valid(self.key))

    def test_round_trip_uses_versioned_aes_gcm_envelope(self):
        blob = encrypt_bytes(self.key, self.plaintext, self.aad)
        self.assertTrue(blob.startswith(PREFIX))
        self.assertNotIn(self.plaintext.decode(), blob)
        self.assertEqual(decrypt_bytes(self.key, blob, self.aad), self.plaintext)

    def test_random_nonce_produces_distinct_ciphertexts(self):
        first = encrypt_bytes(self.key, self.plaintext, self.aad)
        second = encrypt_bytes(self.key, self.plaintext, self.aad)
        self.assertNotEqual(first, second)
        self.assertEqual(decrypt_bytes(self.key, first, self.aad), self.plaintext)
        self.assertEqual(decrypt_bytes(self.key, second, self.aad), self.plaintext)

    def test_wrong_key_is_rejected(self):
        blob = encrypt_bytes(self.key, self.plaintext, self.aad)
        with self.assertRaises(BiometricCryptoError):
            decrypt_bytes("different-random-key-material-32-bytes", blob, self.aad)

    def test_associated_data_binds_record_and_field(self):
        blob = encrypt_bytes(self.key, self.plaintext, self.aad)
        with self.assertRaises(BiometricCryptoError):
            decrypt_bytes(self.key, blob, self.aad + ":other")

    def test_tampering_is_rejected(self):
        blob = encrypt_bytes(self.key, self.plaintext, self.aad)
        index = len(PREFIX) + 20
        replacement = "A" if blob[index] != "A" else "B"
        tampered = blob[:index] + replacement + blob[index + 1:]
        with self.assertRaises(BiometricCryptoError):
            decrypt_bytes(self.key, tampered, self.aad)

    def test_unversioned_or_malformed_ciphertext_is_rejected(self):
        for value in ("", "v1.legacy", PREFIX, PREFIX + "not-base64%%%"):
            with self.subTest(value=value):
                with self.assertRaises(BiometricCryptoError):
                    decrypt_bytes(self.key, value, self.aad)

    def test_empty_payload_round_trip(self):
        blob = encrypt_bytes(self.key, b"", self.aad)
        self.assertEqual(decrypt_bytes(self.key, blob, self.aad), b"")


if __name__ == "__main__":
    unittest.main()
