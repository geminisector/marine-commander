#!/usr/bin/env python3
"""Convert a Universal VTT map into Marine Commander's split runtime pair.

The converter writes an extracted image next to the source .dd2vtt and a
matching .scene.json whose ``image`` field points at that file. The app loads
this pair instead of the original .dd2vtt, which keeps the inline base64 artwork
out of live snapshots.

Examples:
    python3 tools/import_dd2vtt.py assets/maps/newmap/newmap.dd2vtt
    python3 tools/import_dd2vtt.py --force assets/maps/newmap/newmap.dd2vtt
    python3 tools/import_dd2vtt.py --geometry-only assets/maps/cortez/cortez.dd2vtt
    python3 tools/import_dd2vtt.py --keep-lights --force assets/maps/newmap/newmap.dd2vtt
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path
from typing import NoReturn

GEOMETRY_KEYS = (
    "format",
    "resolution",
    "line_of_sight",
    "objects_line_of_sight",
    "portals",
    "environment",
)


def fail(message: str) -> NoReturn:
    print("error: " + message, file=sys.stderr)
    raise SystemExit(1)


def load_json(path: Path, label: str) -> dict:
    try:
        data = json.loads(path.read_text())
    except OSError as exc:
        fail(f"could not read {label} {path}: {exc}")
    except json.JSONDecodeError as exc:
        fail(f"{label} {path} is not valid JSON: {exc}")
    if not isinstance(data, dict):
        fail(f"{label} {path} must contain a JSON object")
    return data


def decode_image(data: dict) -> bytes:
    image = data.get("image")
    if not isinstance(image, str) or not image.strip():
        fail("map has no embedded image")
    text = image.strip()
    if text.startswith("data:"):
        try:
            text = text.split(",", 1)[1]
        except IndexError:
            fail("map image is a malformed data URL")
    try:
        raw = base64.b64decode(text)
    except (binascii.Error, ValueError):
        fail("map image is not valid base64")
    if not raw:
        fail("map image is empty")
    return raw


def image_extension(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if raw.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if raw.startswith(b"RIFF") and raw[8:12] == b"WEBP":
        return "webp"
    if raw.startswith(b"GIF8"):
        return "gif"
    fail("map image is not PNG, JPEG, WebP or GIF")


def write_scene(path: Path, data: dict, existing: str | None) -> None:
    # Match the file's existing layout so geometry updates make small diffs.
    if existing is not None and "\n" in existing:
        text = json.dumps(data, indent=1)
    else:
        text = json.dumps(data, separators=(",", ":"))
    path.write_text(text)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert a .dd2vtt map into a .scene.json plus extracted image."
    )
    parser.add_argument("source", type=Path, help="path to the source .dd2vtt file")
    parser.add_argument(
        "--out-dir",
        type=Path,
        help="output directory (default: the source file's directory)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="overwrite an existing scene or image",
    )
    parser.add_argument(
        "--geometry-only",
        action="store_true",
        help="refresh geometry in an existing scene, preserving image and lights",
    )
    parser.add_argument(
        "--keep-lights",
        action="store_true",
        help="with a full import, keep the existing scene's lights",
    )
    args = parser.parse_args()

    source = args.source.expanduser()
    if not source.is_file():
        fail(f"source map not found: {source}")
    data = load_json(source, "map")

    if "resolution" not in data or "line_of_sight" not in data:
        fail(f"{source} does not look like a Universal VTT map")

    out_dir = (args.out_dir or source.parent).expanduser()
    if not out_dir.is_dir():
        fail(f"output directory not found: {out_dir}")
    scene_path = out_dir / (source.stem + ".scene.json")
    existing_raw = scene_path.read_text() if scene_path.is_file() else None

    if args.geometry_only:
        if existing_raw is None:
            fail(f"no existing scene to update: {scene_path}")
        scene = load_json(scene_path, "scene")
        for key in GEOMETRY_KEYS:
            if key in data:
                scene[key] = data[key]
        write_scene(scene_path, scene, existing_raw)
        print(f"updated geometry in {scene_path} (image and lights preserved)")
        return

    raw = decode_image(data)
    image_path = out_dir / (source.stem + "." + image_extension(raw))

    if not args.force and (existing_raw is not None or image_path.exists()):
        fail(
            f"{scene_path.name} or {image_path.name} already exists; "
            "pass --force to overwrite, or --geometry-only to keep the image"
        )

    if args.keep_lights:
        if existing_raw is None:
            fail("--keep-lights requires an existing scene file")
        scene = load_json(scene_path, "scene")
        data["lights"] = scene.get("lights", data.get("lights", []))

    if not image_path.is_file() or image_path.read_bytes() != raw:
        image_path.write_bytes(raw)
    data["image"] = image_path.name
    write_scene(scene_path, data, existing_raw)
    print(f"wrote {image_path} and {scene_path}")


if __name__ == "__main__":
    main()
