"""Authenticated encryption for DEFENX biometric enrollment records.

Cloudflare Workers use the platform Web Crypto API (AES-256-GCM) through
Pyodide's JavaScript FFI. Local Flask/test runs use the same AES-GCM primitive
from the optional cryptography package. There is deliberately no custom cipher
or plaintext fallback.
"""
import base64
import hashlib
import secrets

PREFIX = "a256gcm.v1."
MIN_KEY_CHARS = 32


class BiometricCryptoError(Exception):
    pass


def key_is_valid(secret):
    return isinstance(secret, str) and len(secret.strip()) >= MIN_KEY_CHARS


def _key_bytes(secret):
    if not key_is_valid(secret):
        raise BiometricCryptoError("biometric_key_not_configured")
    return hashlib.sha256(secret.strip().encode("utf-8")).digest()


def _u8(js, data):
    arr = js.Uint8Array.new(len(data))
    for index, value in enumerate(data):
        arr[index] = value
    return arr


def _js_object(js, to_js, value):
    return to_js(value, dict_converter=js.Object.fromEntries)


async def _web_encrypt(key, nonce, plaintext, aad):
    import js
    from pyodide.ffi import to_js

    crypto_key = await js.crypto.subtle.importKey(
        "raw",
        _u8(js, key),
        _js_object(js, to_js, {"name": "AES-GCM"}),
        False,
        to_js(["encrypt"]),
    )
    algorithm = _js_object(js, to_js, {
        "name": "AES-GCM",
        "iv": _u8(js, nonce),
        "additionalData": _u8(js, aad),
        "tagLength": 128,
    })
    encrypted = await js.crypto.subtle.encrypt(
        algorithm, crypto_key, _u8(js, plaintext)
    )
    return bytes(js.Uint8Array.new(encrypted).to_py())


async def _web_decrypt(key, nonce, ciphertext, aad):
    import js
    from pyodide.ffi import to_js

    crypto_key = await js.crypto.subtle.importKey(
        "raw",
        _u8(js, key),
        _js_object(js, to_js, {"name": "AES-GCM"}),
        False,
        to_js(["decrypt"]),
    )
    algorithm = _js_object(js, to_js, {
        "name": "AES-GCM",
        "iv": _u8(js, nonce),
        "additionalData": _u8(js, aad),
        "tagLength": 128,
    })
    plaintext = await js.crypto.subtle.decrypt(
        algorithm, crypto_key, _u8(js, ciphertext)
    )
    return bytes(js.Uint8Array.new(plaintext).to_py())


def _local_encrypt(key, nonce, plaintext, aad):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as exc:
        raise BiometricCryptoError("aes_gcm_unavailable") from exc
    return AESGCM(key).encrypt(nonce, plaintext, aad)


def _local_decrypt(key, nonce, ciphertext, aad):
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except Exception as exc:
        raise BiometricCryptoError("aes_gcm_unavailable") from exc
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except Exception as exc:
        raise BiometricCryptoError("biometric_ciphertext_invalid") from exc


def encrypt_bytes(secret, plaintext, associated_data):
    key = _key_bytes(secret)
    nonce = secrets.token_bytes(12)
    aad = associated_data.encode("utf-8")
    try:
        from pyodide.ffi import run_sync
        import js  # noqa: F401
        ciphertext = run_sync(_web_encrypt(key, nonce, bytes(plaintext), aad))
    except ImportError:
        ciphertext = _local_encrypt(key, nonce, bytes(plaintext), aad)
    except Exception as exc:
        raise BiometricCryptoError("biometric_encryption_failed") from exc
    packed = nonce + ciphertext
    return PREFIX + base64.urlsafe_b64encode(packed).decode("ascii")


def decrypt_bytes(secret, envelope, associated_data):
    key = _key_bytes(secret)
    if not isinstance(envelope, str) or not envelope.startswith(PREFIX):
        raise BiometricCryptoError("biometric_ciphertext_invalid")
    try:
        packed = base64.urlsafe_b64decode(envelope[len(PREFIX):].encode("ascii"))
    except Exception as exc:
        raise BiometricCryptoError("biometric_ciphertext_invalid") from exc
    if len(packed) < 12 + 16:
        raise BiometricCryptoError("biometric_ciphertext_invalid")
    nonce, ciphertext = packed[:12], packed[12:]
    aad = associated_data.encode("utf-8")
    try:
        from pyodide.ffi import run_sync
        import js  # noqa: F401
        return run_sync(_web_decrypt(key, nonce, ciphertext, aad))
    except ImportError:
        return _local_decrypt(key, nonce, ciphertext, aad)
    except BiometricCryptoError:
        raise
    except Exception as exc:
        raise BiometricCryptoError("biometric_ciphertext_invalid") from exc
