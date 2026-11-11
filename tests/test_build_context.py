"""The image build context leaves out Python bytecode (HYG-01).

Local test runs leave __pycache__ directories under backend/ and tests/. deploy/Dockerfile copies
backend/ as it is, so without this rule an image built from a working tree carries .pyc files that
a clean checkout does not have, and the image no longer matches its tagged source.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_build_context_excludes_bytecode():
    patterns = {line.strip() for line in (ROOT / ".dockerignore").read_text().splitlines()}
    # Root-anchored "__pycache__" would only match the top level; "**/" matches every directory.
    assert "**/__pycache__" in patterns


def test_dockerfile_copies_the_backend_directory():
    # The rule above matters because the backend is copied as a whole directory.
    dockerfile = (ROOT / "deploy" / "Dockerfile").read_text()
    assert "COPY backend ./backend" in dockerfile
