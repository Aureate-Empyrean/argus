import os
import re
import time
import uuid
from datetime import UTC, datetime

REF = re.compile(
    r"^nexus:v1:([a-z][a-z0-9-]{0,47}):([a-z][a-z0-9-]{0,47}):([a-zA-Z0-9][a-zA-Z0-9._~-]{0,127})$"
)


def uuid7() -> str:
    """RFC 9562 UUIDv7: 48-bit Unix milliseconds, version, 74 random bits."""
    ms = time.time_ns() // 1_000_000
    rand = int.from_bytes(os.urandom(10), "big")
    value = (ms & ((1 << 48) - 1)) << 80
    value |= 0x7 << 76
    value |= ((rand >> 62) & 0xFFF) << 64
    value |= 0b10 << 62
    value |= rand & ((1 << 62) - 1)
    return str(uuid.UUID(int=value))


def iso_now() -> str:
    return datetime.now(UTC).replace(microsecond=0).strftime("%Y-%m-%dT%H:%M:%SZ")
