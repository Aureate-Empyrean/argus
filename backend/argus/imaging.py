"""Image inspection and rendering (Pillow).

Rules:
- The type is decided by the file's content (signature and decoder), never by its name.
- Size is checked from the header before any pixel is decoded; decoding is bounded and
  serialised (the module runs in 256 MiB), and JPEGs are decoded at a reduced scale whenever
  the output needs fewer pixels (`draft`).
- Every rendition starts from the original. Crop geometry is normalised to the *oriented*
  picture (after EXIF orientation), so it does not depend on the size of the image a client
  displayed, and re-cropping never degrades anything.
- Renditions carry no metadata: no EXIF (location, camera, dates), no XMP. Colour is converted
  to sRGB when the original embeds an ICC profile.
"""

import io
import math
import threading
from datetime import datetime

from PIL import Image, ImageCms, ImageOps, UnidentifiedImageError

FORMATS = {"JPEG": "image/jpeg", "PNG": "image/png", "WEBP": "image/webp", "GIF": "image/gif"}
HARD_MAX_PIXELS = 40_000_000  # what 256 MiB can decode safely (RGBA, one at a time)
MAX_SIDE = 20_000
Image.MAX_IMAGE_PIXELS = None  # limits are enforced explicitly below, before decoding
_LOCK = threading.Lock()
_SRGB = ImageCms.createProfile("sRGB")


class ImageRejected(ValueError):
    """The file is not an image Argus accepts; the message is shown to the user."""


def sniff(head: bytes):
    if head[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "WEBP"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    return None


def _oriented(w, h, orientation):
    return (h, w) if orientation in (5, 6, 7, 8) else (w, h)


def _exif_date(value):
    try:
        return datetime.strptime(str(value).strip("\x00 "), "%Y:%m:%d %H:%M:%S").strftime(
            "%Y-%m-%dT%H:%M:%S"
        )
    except (TypeError, ValueError):
        return None


def inspect(path, max_pixels: int):
    """Validate a file and describe it. Raises ImageRejected with a readable reason."""
    with open(path, "rb") as f:
        head = f.read(16)
    kind = sniff(head)
    if not kind:
        raise ImageRejected("This file is not a JPEG, PNG, WebP or GIF image.")
    try:
        with Image.open(path, formats=[kind]) as im:
            if im.format != kind:
                raise ImageRejected("The file's content does not match its image type.")
            w, h = im.size
            if w < 1 or h < 1 or w > MAX_SIDE or h > MAX_SIDE:
                raise ImageRejected(f"Images can be at most {MAX_SIDE:,} pixels on a side.")
            limit = min(max_pixels, HARD_MAX_PIXELS)
            if w * h > limit:
                raise ImageRejected(
                    f"This image has {w * h / 1e6:.0f} megapixels; the limit is {limit / 1e6:.0f}."
                )
            exif = im.getexif()
            orientation = exif.get(274, 1)
            if orientation not in range(1, 9):
                orientation = 1
            ifd = exif.get_ifd(0x8769) if exif else {}
            taken = _exif_date(ifd.get(36867) or ifd.get(36868) or exif.get(306))
            make = str(exif.get(271, "")).strip("\x00 ")[:60]
            model = str(exif.get(272, "")).strip("\x00 ")[:80]
            camera = model if make and model.lower().startswith(make.lower()) else " ".join(x for x in (make, model) if x)
            has_location = bool(exif.get_ifd(0x8825)) if exif else False
            frames = getattr(im, "n_frames", 1)
            meta = {
                "mode": im.mode, "frames": frames, "animated": frames > 1,
                "icc": bool(im.info.get("icc_profile")), "exif": bool(exif),
            }  # fmt: skip
        # A full decode (at reduced scale for JPEG) proves the file is intact and readable.
        with _LOCK, Image.open(path, formats=[kind]) as im:
            if kind == "JPEG":
                im.draft("RGB", (max(1, w // 8), max(1, h // 8)))
            im.load()
    except ImageRejected:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError) as exc:
        raise ImageRejected("This image is damaged or incomplete and cannot be read.") from exc
    ow, oh = _oriented(w, h, orientation)
    return {
        "format": kind, "mime": FORMATS[kind], "stored_width": w, "stored_height": h,
        "orientation": orientation, "width": ow, "height": oh, "taken_at": taken,
        "camera": camera[:120], "has_location": has_location, "metadata": meta,
    }  # fmt: skip


def valid_crop(crop, width, height):
    """A square crop, normalised to the oriented picture: x, y, w, h in [0, 1], w·W ≈ h·H."""
    try:
        x, y, w, h = (float(crop[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return None
    if not all(math.isfinite(v) for v in (x, y, w, h)):
        return None
    eps = 1e-6
    if x < -eps or y < -eps or w <= 0 or h <= 0 or x + w > 1 + eps or y + h > 1 + eps:
        return None
    side_w, side_h = w * width, h * height
    if side_w < 8 or abs(side_w - side_h) > max(2.0, 0.01 * side_w):
        return None
    return {"x": max(0.0, x), "y": max(0.0, y), "w": min(w, 1 - max(0.0, x)), "h": min(h, 1 - max(0.0, y))}


def render(path, photo, size: int, crop=None, quality=82):
    """A WebP rendition: the whole picture fitted in size×size, or a square crop at size×size.
    Returns (bytes, width, height)."""
    kind = photo["format"]
    sw, sh = photo["stored_width"], photo["stored_height"]
    with _LOCK, Image.open(path, formats=[kind]) as im:
        im.seek(0)
        if kind == "JPEG":
            # Decode only as many pixels as the output needs (scale is per stored axis).
            if crop:
                side = crop["w"] * photo["width"]
                scale = min(1.0, size / max(1.0, side))
            else:
                scale = min(1.0, size / max(photo["width"], photo["height"]))
            im.draft("RGB", (max(1, math.ceil(sw * scale)), max(1, math.ceil(sh * scale))))
        im.load()
        alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
        icc = im.info.get("icc_profile")
        out = ImageOps.exif_transpose(im) if photo["orientation"] != 1 else im.copy()
    out = out.convert("RGBA" if alpha else "RGB")
    if icc:
        try:
            profile = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            out = ImageCms.profileToProfile(out, profile, _SRGB, outputMode=out.mode)
        except (ImageCms.PyCMSError, OSError, ValueError):
            pass  # an unreadable profile: keep the pixels as they are
    W, H = out.size
    if crop:
        box = (
            round(crop["x"] * W), round(crop["y"] * H),
            round((crop["x"] + crop["w"]) * W), round((crop["y"] + crop["h"]) * H),
        )  # fmt: skip
        box = (max(0, box[0]), max(0, box[1]), min(W, max(box[0] + 1, box[2])), min(H, max(box[1] + 1, box[3])))
        out = out.crop(box).resize((size, size), Image.Resampling.LANCZOS, reducing_gap=3.0)
    else:
        out.thumbnail((size, size), Image.Resampling.LANCZOS, reducing_gap=3.0)
    buf = io.BytesIO()
    out.save(buf, "WEBP", quality=quality, method=4)  # no exif=, no icc_profile=: stripped
    return buf.getvalue(), out.size[0], out.size[1]
