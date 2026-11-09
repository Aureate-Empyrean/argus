"""Pin the locally built image by immutable Docker content ID."""

import json
import subprocess
from pathlib import Path

manifest = json.loads(Path("manifest.json").read_text())
manifest["container"]["image"] = subprocess.check_output(
    ["docker", "image", "inspect", "argus:0.3.0", "--format", "{{.Id}}"], text=True
).strip()
Path("manifest.local.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("Wrote manifest.local.json with the exact locally built image identity.")
