"""Decode a bounded local upload on CPU and emit a metadata-free canonical PNG."""
import json
import sys
import warnings
from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 12_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)
source, destination = sys.argv[1:3]
with Image.open(source) as image:
    original_format = image.format
    if original_format not in {"PNG", "JPEG", "WEBP"} or getattr(image, "n_frames", 1) != 1:
        raise ValueError("A single PNG, JPEG, or WebP image is required")
    image.load()
    image = ImageOps.exif_transpose(image)
    width, height = image.size
    if min(width, height) < 16 or max(width, height) > 4096 or width * height > 12_000_000:
        raise ValueError("Image dimensions exceed the upload limits")
    # Indexed PNG and colour-key transparency can have no explicit A band.
    # Keep their transparency before stripping metadata in the canonical PNG.
    image = image.convert("RGBA" if "A" in image.getbands() or "transparency" in image.info else "RGB")
    image.save(destination, format="PNG")
    print(json.dumps({"width": width, "height": height, "mime": "image/png", "originalMime": {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}[original_format]}))
