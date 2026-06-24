#!/usr/bin/env python3
"""
FoetoPath MRXS Slide Viewer
Flask server for browsing and viewing Mirax (.mrxs) whole-slide images.
Uses OpenSlide + OpenSeadragon for deep-zoom tile-based viewing.

Usage:
    python app.py                        # Start on port 5000, pick folder in GUI
    python app.py --port 8080            # Custom port
    python app.py --root /path/to/slides # Pre-set root folder
"""

import argparse
import csv
import io
import json
import os
import sqlite3
import sys
import threading
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import numpy as np
from flask import Flask, Response, abort, jsonify, render_template, request, send_file
from openslide import OpenSlide
from openslide.deepzoom import DeepZoomGenerator
from PIL import Image


import database as db

app = Flask(__name__)


# ── Configuration ──────────────────────────────────────────────────────────
TILE_SIZE = 254
TILE_OVERLAP = 1
TILE_FORMAT = "jpeg"
TILE_QUALITY = 80
THUMBNAIL_SIZE = (300, 300)
SLIDE_EXTENSIONS = {".mrxs", ".svs", ".ndpi", ".tiff", ".tif", ".scn", ".bif", ".vms", ".vmu"}
PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".gif", ".webp", ".tga"}


# ── Tile LRU Cache (in-RAM) ───────────────────────────────────────────────
class TileCache:
    """Thread-safe LRU cache for encoded JPEG tile bytes."""

    def __init__(self, maxsize: int = 400):
        self._cache: OrderedDict[tuple, bytes] = OrderedDict()
        self._maxsize = maxsize
        self._lock = threading.Lock()

    def get(self, key: tuple) -> bytes | None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            return None

    def put(self, key: tuple, data: bytes) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._cache[key] = data
            else:
                if len(self._cache) >= self._maxsize:
                    self._cache.popitem(last=False)
                self._cache[key] = data

    @property
    def size(self) -> int:
        return len(self._cache)


tile_cache = TileCache(maxsize=4000)

_prefetch_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="tile-prefetch")


# ── Slide Cache ────────────────────────────────────────────────────────────
@lru_cache(maxsize=10)
def get_slide(slide_path: str) -> OpenSlide:
    """Open and cache an OpenSlide object."""
    return OpenSlide(slide_path)


@lru_cache(maxsize=10)
def get_dz(slide_path: str) -> DeepZoomGenerator:
    """Create and cache a DeepZoomGenerator."""
    slide = get_slide(slide_path)
    return DeepZoomGenerator(slide, tile_size=TILE_SIZE, overlap=TILE_OVERLAP, limit_bounds=True)


def _prefetch_neighbors(path: str, level: int, col: int, row: int) -> None:
    """Pré-charge les 8 tuiles adjacentes en arrière-plan."""
    _prefetch_pool.submit(_do_prefetch, path, level, col, row)


def _do_prefetch(path: str, level: int, col: int, row: int) -> None:
    """Charge les voisines manquantes du cache (batch si Omnissiah)."""
    try:
        dz = get_dz(path)
        max_col, max_row = dz.level_tiles[level]
        needed = []
        for dc in (-1, 0, 1):
            for dr in (-1, 0, 1):
                if dc == 0 and dr == 0:
                    continue
                nc, nr = col + dc, row + dr
                if 0 <= nc < max_col and 0 <= nr < max_row:
                    if tile_cache.get((path, level, nc, nr)) is None:
                        needed.append((nc, nr))
        if not needed:
            return
        for nc, nr in needed:
            try:
                tile = dz.get_tile(level, (nc, nr))
                buf = io.BytesIO()
                tile.save(buf, format=TILE_FORMAT, quality=TILE_QUALITY)
                tile_cache.put((path, level, nc, nr), buf.getvalue())
            except Exception:
                pass
    except Exception:
        pass


def find_slides(folder: str) -> list[dict]:
    """Find all supported slide files in a folder."""
    slides = []
    folder_path = Path(folder)
    if not folder_path.is_dir():
        return slides
    for f in sorted(folder_path.iterdir()):
        if f.suffix.lower() in SLIDE_EXTENSIONS and f.is_file():
            slides.append({
                "name": f.stem,
                "filename": f.name,
                "path": str(f),
                "extension": f.suffix.lower(),
            })
    return slides


def find_photos(folder: str) -> list[dict]:
    """Find all photo/image files in a folder."""
    photos = []
    folder_path = Path(folder)
    if not folder_path.is_dir():
        return photos
    for f in sorted(folder_path.iterdir()):
        if f.suffix.lower() in PHOTO_EXTENSIONS and f.is_file():
            # Skip very small files (thumbnails, icons)
            try:
                size = f.stat().st_size
                if size < 1024:  # < 1KB
                    continue
            except OSError:
                continue
            photos.append({
                "name": f.stem,
                "filename": f.name,
                "path": str(f),
                "extension": f.suffix.lower(),
                "size_kb": round(size / 1024, 1),
            })
    return photos


def find_cases(root: str) -> list[dict]:
    """Find all subfolders (cases) that contain slides or photos."""
    root_path = Path(root)
    if not root_path.is_dir():
        return []

    cases = []
    # Check root itself
    root_slides = find_slides(root)
    root_photos = find_photos(root)
    if root_slides or root_photos:
        cases.append({
            "name": root_path.name,
            "path": str(root_path),
            "slide_count": len(root_slides),
            "photo_count": len(root_photos),
            "is_root": True,
        })

    # Check subfolders
    for d in sorted(root_path.iterdir()):
        if d.is_dir() and not d.name.startswith("."):
            slides = find_slides(str(d))
            photos = find_photos(str(d))
            if slides or photos:
                cases.append({
                    "name": d.name,
                    "path": str(d),
                    "slide_count": len(slides),
                    "photo_count": len(photos),
                    "is_root": False,
                })
    return cases


# ── Routes ─────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    """Main page."""
    return render_template("index.html", default_root=app.config.get("DEFAULT_ROOT", ""))


def get_annotated_stems(root: str) -> set[str]:
    """Find slide stems that have annotation GeoJSON files."""
    ann_dir = Path(root) / "annotations"
    if not ann_dir.is_dir():
        return set()
    return {f.stem for f in ann_dir.iterdir() if f.suffix == ".geojson" and not f.stem.endswith("_macro")}


@app.route("/api/browse", methods=["POST"])
def browse():
    """List cases (subfolders with slides) in a root directory."""
    data = request.get_json()
    root = data.get("root", "")
    if not root or not os.path.isdir(root):
        return jsonify({"error": "Dossier invalide", "cases": []}), 400
    cases = find_cases(root)
    annotated = get_annotated_stems(root)
    for case in cases:
        case_slides = find_slides(case["path"])
        done = sum(1 for s in case_slides if s["name"] in annotated)
        case["annotated_count"] = done
    return jsonify({"cases": cases, "root": root})


@app.route("/api/slides", methods=["POST"])
def slides():
    """List slides and photos in a case folder."""
    data = request.get_json()
    folder = data.get("folder", "")
    root = data.get("root", "")
    if not folder or not os.path.isdir(folder):
        return jsonify({"error": "Dossier invalide", "slides": [], "photos": []}), 400
    slide_list = find_slides(folder)
    photo_list = find_photos(folder)
    if root:
        annotated = get_annotated_stems(root)
        for s in slide_list:
            s["annotated"] = s["name"] in annotated
    return jsonify({"slides": slide_list, "photos": photo_list, "folder": folder})


@app.route("/api/slide/info", methods=["POST"])
def slide_info():
    """Get slide metadata."""
    data = request.get_json()
    path = data.get("path", "")
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        slide = get_slide(path)
        dz = get_dz(path)
        props = dict(slide.properties)
        mpp_x = float(props.get("openslide.mpp-x", 0))
        mpp_y = float(props.get("openslide.mpp-y", 0))
        return jsonify({
            "dimensions": slide.dimensions,
            "level_count": slide.level_count,
            "level_dimensions": list(slide.level_dimensions),
            "dz_level_count": dz.level_count,
            "tile_size": TILE_SIZE,
            "overlap": TILE_OVERLAP,
            "mpp_x": mpp_x,
            "mpp_y": mpp_y,
            "properties": {k: v for k, v in props.items() if len(v) < 500},
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/slide/dzi", methods=["POST"])
def slide_dzi():
    """Generate DZI XML descriptor for OpenSeadragon."""
    data = request.get_json()
    path = data.get("path", "")
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        dz = get_dz(path)
        resp = dz.get_dzi(TILE_FORMAT)
        return Response(resp, mimetype="application/xml")
    except Exception as e:
        return Response(f"<error>{e}</error>", status=500, mimetype="application/xml")


@app.route("/api/slide/tile/<int:level>/<int:col>_<int:row>.<fmt>")
def slide_tile(level: int, col: int, row: int, fmt: str):
    """Serve a single tile with LRU RAM cache + neighbor prefetch."""
    path = request.args.get("path", "")
    if not path or not os.path.isfile(path):
        abort(404)

    cache_key = (path, level, col, row)
    cached = tile_cache.get(cache_key)
    if cached is not None:
        return Response(cached, mimetype=f"image/{TILE_FORMAT}",
                        headers={"Cache-Control": "public, max-age=86400"})

    try:
        dz = get_dz(path)
        tile = dz.get_tile(level, (col, row))
        buf = io.BytesIO()
        tile.save(buf, format=TILE_FORMAT, quality=TILE_QUALITY)
        data = buf.getvalue()
        tile_cache.put(cache_key, data)
        _prefetch_neighbors(path, level, col, row)
        return Response(data, mimetype=f"image/{TILE_FORMAT}",
                        headers={"Cache-Control": "public, max-age=86400"})
    except (ValueError, KeyError):
        abort(404)
    except Exception:
        abort(500)


@app.route("/api/slide/thumbnail")
def slide_thumbnail():
    """Generate a thumbnail for the carousel."""
    path = request.args.get("path", "")
    width = int(request.args.get("w", THUMBNAIL_SIZE[0]))
    height = int(request.args.get("h", THUMBNAIL_SIZE[1]))
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        slide = get_slide(path)
        thumb = slide.get_thumbnail((width, height))
        buf = io.BytesIO()
        thumb.save(buf, format="JPEG", quality=85)
        buf.seek(0)
        return Response(buf.read(), mimetype="image/jpeg")
    except Exception as e:
        # Return a placeholder
        img = Image.new("RGB", (width, height), (40, 40, 50))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        return Response(buf.read(), mimetype="image/jpeg")


@app.route("/api/slide/label")
def slide_label():
    """Get the label/macro image if available."""
    path = request.args.get("path", "")
    img_type = request.args.get("type", "label")  # label or macro
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        slide = get_slide(path)
        images = slide.associated_images
        if img_type in images:
            img = images[img_type]
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=90)
            buf.seek(0)
            return Response(buf.read(), mimetype="image/jpeg")
        abort(404)
    except Exception:
        abort(404)


@app.route("/api/slide/macro/info")
def slide_macro_info():
    """Get macro image dimensions for annotation coordinate mapping."""
    path = request.args.get("path", "")
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        slide = get_slide(path)
        images = slide.associated_images
        # Try macro first, then label
        for img_type in ("macro", "label"):
            if img_type in images:
                img = images[img_type]
                w, h = img.size
                return jsonify({
                    "type": img_type,
                    "width": w,
                    "height": h,
                    "available_types": list(images.keys()),
                })
        return jsonify({"error": "Pas d'image macro disponible"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Photo Routes ───────────────────────────────────────────────────────────
MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".bmp": "image/bmp", ".webp": "image/webp",
    ".tga": "image/x-tga",
}


@app.route("/api/photo/serve")
def photo_serve():
    """Serve a full-resolution photo."""
    path = request.args.get("path", "")
    if not path or not os.path.isfile(path):
        abort(404)
    ext = Path(path).suffix.lower()
    if ext not in PHOTO_EXTENSIONS:
        abort(403)
    mime = MIME_MAP.get(ext, "image/jpeg")
    try:
        with open(path, "rb") as f:
            data = f.read()
        return Response(data, mimetype=mime)
    except Exception:
        abort(500)


@app.route("/api/photo/thumbnail")
def photo_thumbnail():
    """Generate a thumbnail for a photo."""
    path = request.args.get("path", "")
    width = int(request.args.get("w", 192))
    height = int(request.args.get("h", 192))
    if not path or not os.path.isfile(path):
        abort(404)
    try:
        img = Image.open(path)
        img.thumbnail((width, height), Image.LANCZOS)
        # Convert to RGB if needed (for RGBA/palette images)
        if img.mode not in ("RGB", "L"):
            img = img.convert("RGB")
        buf = io.BytesIO()
        buf_format = "JPEG"
        img.save(buf, format=buf_format, quality=85)
        buf.seek(0)
        return Response(buf.read(), mimetype="image/jpeg")
    except Exception:
        # Placeholder
        img = Image.new("RGB", (width, height), (40, 40, 50))
        buf = io.BytesIO()
        img.save(buf, format="JPEG")
        buf.seek(0)
        return Response(buf.read(), mimetype="image/jpeg")


# ── Annotation Routes ──────────────────────────────────────────────────────

def get_annotation_path(root: str, slide_path: str) -> Path:
    """Get the GeoJSON annotation file path for a given slide.
    Stored next to the slide: {slide_dir}/annotations/{slide_stem}.geojson
    """
    slide = Path(slide_path)
    ann_dir = slide.parent / "annotations"
    ann_dir.mkdir(parents=True, exist_ok=True)
    return ann_dir / f"{slide.stem}.geojson"


def get_macro_annotation_path(root: str, slide_path: str) -> Path:
    """Get the GeoJSON annotation file path for a slide's macro image.
    Stored next to the slide: {slide_dir}/annotations/{slide_stem}_macro.geojson
    """
    slide = Path(slide_path)
    ann_dir = slide.parent / "annotations"
    ann_dir.mkdir(parents=True, exist_ok=True)
    return ann_dir / f"{slide.stem}_macro.geojson"


def get_slide_calibration(slide_path: str) -> dict:
    """Extract calibration metadata from a slide."""
    try:
        slide = get_slide(slide_path)
        props = slide.properties
        w, h = slide.dimensions

        # MPP (microns per pixel)
        mpp_x = float(props.get("openslide.mpp-x", 0))
        mpp_y = float(props.get("openslide.mpp-y", 0))

        # Bounds
        bounds_x = int(props.get("openslide.bounds-x", 0))
        bounds_y = int(props.get("openslide.bounds-y", 0))
        bounds_w = int(props.get("openslide.bounds-width", w))
        bounds_h = int(props.get("openslide.bounds-height", h))

        # Objective power
        objective = props.get("openslide.objective-power", "")

        return {
            "dimensions_px": [w, h],
            "mpp_x": mpp_x,
            "mpp_y": mpp_y,
            "bounds": {
                "x": bounds_x,
                "y": bounds_y,
                "width": bounds_w,
                "height": bounds_h,
            },
            "objective_power": objective,
            "vendor": props.get("openslide.vendor", ""),
        }
    except Exception:
        return {}


def update_diagnostics_csv(slide_path: str, tissue_type: str, slide_diagnosis: list):
    """Write/update diagnostics.csv next to the slide."""
    csv_path = Path(slide_path).parent / "diagnostics.csv"
    slide_id = Path(slide_path).stem
    rows = []
    if csv_path.is_file():
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            rows = [r for r in reader if r.get("slide_id") != slide_id]
    rows.append({
        "slide_id": slide_id,
        "tissue_type": tissue_type,
        "diagnosis": ";".join(slide_diagnosis) if slide_diagnosis else "",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    rows.sort(key=lambda r: r["slide_id"])
    with open(csv_path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["slide_id", "tissue_type", "diagnosis", "updated_at"])
        writer.writeheader()
        writer.writerows(rows)


@app.route("/api/annotations/save", methods=["POST"])
def annotations_save():
    """Save annotations as GeoJSON + SQLite + CSV."""
    data = request.get_json()
    root = data.get("root", "")
    slide_path = data.get("slide_path", "")
    features = data.get("features", [])
    tissue_type = data.get("tissue_type", "")
    slide_diagnosis = data.get("slide_diagnosis", [])

    if not root or not slide_path:
        return jsonify({"error": "Paramètres manquants"}), 400

    calibration = get_slide_calibration(slide_path)
    mpp_x = calibration.get("mpp_x", 0)
    mpp_y = calibration.get("mpp_y", 0)

    geojson_features = []
    for feat in features:
        coords_px = feat.get("coordinates", [])
        props = feat.get("properties", {})

        coords_um = []
        if mpp_x > 0 and mpp_y > 0:
            for ring in coords_px:
                coords_um.append([[pt[0] * mpp_x, pt[1] * mpp_y] for pt in ring])

        geojson_feat = {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": coords_px,
            },
            "properties": {
                **props,
                "tissue_type": tissue_type,
                "coordinates_um": coords_um if coords_um else None,
                "unit_px": "pixels (absolute, level 0)",
                "unit_um": f"micrometers (mpp_x={mpp_x}, mpp_y={mpp_y})" if mpp_x > 0 else None,
            },
        }
        geojson_features.append(geojson_feat)

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "slide_name": Path(slide_path).name,
            "slide_path": slide_path,
            "tissue_type": tissue_type,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "generator": "FoetoPath Slide Viewer",
            "slide_diagnosis": slide_diagnosis,
            "annotation_levels": {
                "1": "Macro",
                "2": "Cytoarchitecture",
                "3": "Cellulaire",
            },
            **calibration,
        },
        "features": geojson_features,
    }

    try:
        # 1. GeoJSON file
        ann_path = get_annotation_path(root, slide_path)
        with open(ann_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2, ensure_ascii=False)

        # 2. CSV diagnostics
        if tissue_type or slide_diagnosis:
            update_diagnostics_csv(slide_path, tissue_type, slide_diagnosis)

        # 3. SQLite database
        conn = db.get_db()
        slide_id = Path(slide_path).stem
        db.upsert_slide(conn, slide_id, Path(slide_path).name,
                        str(Path(slide_path).parent), tissue_type, calibration)
        if slide_diagnosis:
            db.set_diagnoses(conn, slide_id, slide_diagnosis)
        db.save_annotations(conn, slide_id, tissue_type, features, mpp_x, mpp_y)

        return jsonify({
            "ok": True,
            "path": str(ann_path),
            "feature_count": len(geojson_features),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/annotations/load")
def annotations_load():
    """Load annotations GeoJSON for a slide."""
    root = request.args.get("root", "")
    slide_path = request.args.get("slide_path", "")

    if not root or not slide_path:
        return jsonify({"error": "Paramètres manquants"}), 400

    ann_path = get_annotation_path(root, slide_path)
    if not ann_path.is_file():
        return jsonify({"features": [], "exists": False})

    try:
        with open(ann_path, "r", encoding="utf-8") as f:
            geojson = json.load(f)
        return jsonify({
            "exists": True,
            "path": str(ann_path),
            **geojson,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/annotations/macro/save", methods=["POST"])
def annotations_macro_save():
    """Save macro image annotations as GeoJSON (coordinates in pixels)."""
    data = request.get_json()
    root = data.get("root", "")
    slide_path = data.get("slide_path", "")
    features = data.get("features", [])
    macro_dimensions = data.get("macro_dimensions", [0, 0])

    if not root or not slide_path:
        return jsonify({"error": "Paramètres manquants"}), 400

    # Build GeoJSON features (coordinates in macro image pixels)
    geojson_features = []
    for feat in features:
        coords_px = feat.get("coordinates", [])
        props = feat.get("properties", {})
        geojson_feat = {
            "type": "Feature",
            "geometry": {
                "type": "Polygon",
                "coordinates": coords_px,
            },
            "properties": {
                **props,
                "unit": "pixels (macro image)",
            },
        }
        geojson_features.append(geojson_feat)

    geojson = {
        "type": "FeatureCollection",
        "metadata": {
            "slide_name": Path(slide_path).name,
            "slide_path": slide_path,
            "image_type": "macro",
            "macro_dimensions_px": macro_dimensions,
            "saved_at": datetime.now(timezone.utc).isoformat(),
            "generator": "FoetoPath Slide Viewer",
        },
        "features": geojson_features,
    }

    try:
        ann_path = get_macro_annotation_path(root, slide_path)
        with open(ann_path, "w", encoding="utf-8") as f:
            json.dump(geojson, f, indent=2, ensure_ascii=False)
        return jsonify({
            "ok": True,
            "path": str(ann_path),
            "feature_count": len(geojson_features),
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/annotations/macro/load")
def annotations_macro_load():
    """Load macro image annotations GeoJSON."""
    root = request.args.get("root", "")
    slide_path = request.args.get("slide_path", "")

    if not root or not slide_path:
        return jsonify({"error": "Paramètres manquants"}), 400

    ann_path = get_macro_annotation_path(root, slide_path)
    if not ann_path.is_file():
        return jsonify({"features": [], "exists": False})

    try:
        with open(ann_path, "r", encoding="utf-8") as f:
            geojson = json.load(f)
        return jsonify({
            "exists": True,
            "path": str(ann_path),
            **geojson,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/db/stats")
def db_stats():
    """Database statistics (slides, annotations, diagnoses, embeddings)."""
    root = request.args.get("root", "")
    if not root or not os.path.isdir(root):
        return jsonify({"error": "Root invalide"}), 400
    try:
        conn = db.get_db()
        return jsonify(db.stats(conn))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Config API (labels from foeto_terms, slide_tags from viewer_config) ──

FOETO_DB = os.environ.get("FOETO_DB_PATH", "/home/mathevet/Bureau/foeto_base/syndromes_foetaux.db")


def _load_lda_from_foeto():
    """Read viewer-enabled terms from foeto_terms → LDA_CLASSES dict keyed by level."""
    if not os.path.exists(FOETO_DB):
        return {}
    conn = sqlite3.connect(FOETO_DB)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT viewer_level, viewer_id, label_fr, viewer_color "
        "FROM foeto_terms WHERE viewer_level IS NOT NULL AND viewer_id IS NOT NULL "
        "ORDER BY viewer_level, viewer_id"
    ).fetchall()
    conn.close()
    lda = {}
    for r in rows:
        lvl = str(r["viewer_level"])
        lda.setdefault(lvl, []).append({
            "id": r["viewer_id"], "label": r["label_fr"], "color": r["viewer_color"] or "#999999",
        })
    return lda


@app.route("/api/config/labels")
def api_config_labels():
    lda = _load_lda_from_foeto()
    conn = db.get_db()
    tags = db.get_config(conn, "slide_tags")
    return jsonify({"lda_classes": lda, "slide_tags": tags or {}})


@app.route("/api/config/labels", methods=["PUT"])
def api_config_labels_update():
    data = request.get_json()
    conn = db.get_db()
    if "slide_tags" in data:
        db.set_config(conn, "slide_tags", data["slide_tags"])
    return jsonify({"ok": True})


# ── Main ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FoetoPath MRXS Slide Viewer")
    parser.add_argument("--port", type=int, default=5000, help="Port (default: 5000)")
    parser.add_argument("--host", default="127.0.0.1", help="Host (default: 127.0.0.1)")
    parser.add_argument("--root", default="", help="Default root folder for slides")
    parser.add_argument("--debug", action="store_true", help="Debug mode")
    args = parser.parse_args()

    app.config["DEFAULT_ROOT"] = args.root

    conn = db.get_db()
    db.seed_default_config(conn)

    lda = _load_lda_from_foeto()
    n = sum(len(v) for v in lda.values())
    # Version check
    local_v = None
    if os.path.exists(FOETO_DB):
        try:
            fc = sqlite3.connect(FOETO_DB)
            fc.row_factory = sqlite3.Row
            row = fc.execute("SELECT value FROM foeto_meta WHERE key='version'").fetchone()
            if row: local_v = row["value"]
            fc.close()
        except Exception: pass
    print(f"  FOETO DB v{local_v or '?'} — {n} classes from foeto_terms")

    print(f"\n{'='*60}")
    print(f"  FoetoPath MRXS Slide Viewer")
    print(f"  http://{args.host}:{args.port}")
    if args.root:
        print(f"  Root: {args.root}")
    print(f"{'='*60}\n")

    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)
