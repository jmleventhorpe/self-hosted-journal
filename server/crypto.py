"""
Encryption for Journal.

Uses scrypt to derive a key from the user's password, and Fernet
(AES-128-CBC + HMAC-SHA256, from the `cryptography` library) to
encrypt entry text and images. No custom crypto - both primitives
are well-established, audited implementations.
"""

import os
import base64
from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

SALT_SIZE = 16
# A fixed plaintext we encrypt with the derived key and store alongside
# the salt. On unlock, we try to decrypt it - if it succeeds, the
# password was correct. This never stores the password itself.
VERIFIER_PLAINTEXT = b"simplejournal-verifier-v1"


def generate_salt() -> bytes:
    return os.urandom(SALT_SIZE)


# scrypt cost settings. The password is what the key is derived from, so
# these decide how fast someone holding a copy of journal.db can guess it
# offline. n=2**17, r=8 means 128 MiB and roughly 0.3s (desktop) to 1-2s
# (small ARM board) per guess - fine for a login that happens at most every
# couple of hours. Each journal records the settings it was created with
# (see db.py), so raising these later upgrades existing journals on their
# next login.
KDF_PARAMS = {"n": 2**17, "r": 8, "p": 1}
# What journals created before settings were recorded used.
LEGACY_KDF_PARAMS = {"n": 2**14, "r": 8, "p": 1}


def derive_key(password: str, salt: bytes, params: dict) -> bytes:
    """Derive a Fernet-compatible key (32 url-safe base64 bytes) from a password."""
    kdf = Scrypt(salt=salt, length=32, n=params["n"], r=params["r"], p=params["p"])
    key_bytes = kdf.derive(password.encode("utf-8"))
    return base64.urlsafe_b64encode(key_bytes)


def make_verifier(key: bytes) -> bytes:
    f = Fernet(key)
    return f.encrypt(VERIFIER_PLAINTEXT)


def check_verifier(key: bytes, verifier: bytes) -> bool:
    f = Fernet(key)
    try:
        return f.decrypt(verifier) == VERIFIER_PLAINTEXT
    except InvalidToken:
        return False


def encrypt_bytes(key: bytes, data: bytes) -> bytes:
    return Fernet(key).encrypt(data)


def decrypt_bytes(key: bytes, token: bytes) -> bytes:
    return Fernet(key).decrypt(token)


def encrypt_text(key: bytes, text: str) -> bytes:
    return encrypt_bytes(key, text.encode("utf-8"))


def decrypt_text(key: bytes, token: bytes) -> str:
    return decrypt_bytes(key, token).decode("utf-8")
