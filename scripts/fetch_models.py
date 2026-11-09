"""Download Argus's face models from the OpenCV Model Zoo and verify their checksums.

The models are not stored in Git. Run this before building the image from a clean checkout:

    python scripts/fetch_models.py

Existing files with the correct checksum are left alone. A file that fails verification is never written.
"""

import argparse
import hashlib
import pathlib
import sys
import urllib.request

UPSTREAM = "https://github.com/opencv/opencv_zoo/raw/{commit}/models/{path}"
MODELS = {
    "face_detection_yunet_2023mar.onnx": (
        "f12e12798e8314f7c074a6656816c048dcc95b7a",
        "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    ),
    "face_recognition_sface_2021dec.onnx": (
        "ba91a3b91d00d76e86540d4013f944bd6b514e39",
        "face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    ),
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dest", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent / "models")
    dest = parser.parse_args().dest
    dest.mkdir(parents=True, exist_ok=True)
    for name, (commit, path, expected) in MODELS.items():
        target = dest / name
        if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == expected:
            print(f"ok      {name}")
            continue
        with urllib.request.urlopen(UPSTREAM.format(commit=commit, path=path), timeout=120) as response:
            data = response.read()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            print(f"FAILED  {name}: checksum {actual} does not match the pinned value", file=sys.stderr)
            return 1
        target.write_bytes(data)
        print(f"fetched {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
