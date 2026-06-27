# FoetoPath Viewer V6

Whole-slide image viewer for fetal pathology. Single-page Flask app with deep-zoom tile serving via OpenSlide and an OpenSeadragon frontend. No build step.

## What's new in V6

- **Rapid labelling system** — right-click context menu with placenta labelling tree (Cordon / Membranes / Parenchyme) for one-click organ status + diagnosis assignment
- **Tabbed right panel** — "Labellisation" tab (organ status, signs, notes) and "Annoter" tab (polygon annotations)
- **Sign grouping by pathology type** — signs grouped by `type_patho` (MVM, VTF, etc.) in both panel and context menu
- **Similar slides gallery** — click the magnifier on a selected diagnosis to browse all slides sharing that sign, with thumbnails and cross-case navigation
- **Zoom indicator** — objective magnification (×0.5…×40) displayed in the topbar
- **Carousel badges** — green/gray dots on slide thumbnails indicating labelling status

## Features

**Slide viewing**
- Deep-zoom tile serving for MRXS, SVS, NDPI, TIFF/BigTIFF, SCN, BIF, VMS, VMU
- In-RAM LRU tile cache with background prefetching
- Macro/label image display and gross photo gallery
- Rotation (90° and 10° increments), fullscreen, pan/zoom

**Dual-mode labelling & annotation**
- **Placenta** — tissue selection (cordon, membranes, parenchyme), Amsterdam consensus staging, structured LDA classes across three levels (Macro, Cytoarchitecture, Cellulaire)
- **Foetus** — 15 base organs + 5 sub-organs, with pathology terms from the FOETO terminology database
- Normal / Pathologique status per organ with quick-pick signs
- Live autocomplete search across all pathology and retention terms
- Genest retention criteria per organ (post-mortem autolysis staging)
- Context menu: right-click → placenta labelling tree or quick sign toggle

**Measurements**
- Two-click distance tool calibrated from slide MPP metadata (µm/mm)

**Virtual IHC presets**
- CSS/SVG filter presets: PNN/nuclei, fibrose, trichrome, fer, inflammation, méconium, érythroblastes
- Manual brightness, contrast, gamma, saturation, hue controls

**Annotations storage**
- GeoJSON polygons with micrometer-calibrated coordinates
- SQLite-backed persistence (`lames.db`)
- Macro image annotations on a separate canvas layer
- CSV and GeoJSON export

## Requirements

- Python 3.10+
- OpenSlide system library ([openslide.org](https://openslide.org/download/))
- FOETO terminology database (`syndromes_foetaux.db`) for pathology labels

## Installation

```bash
sudo apt install openslide-tools libopenslide-dev   # Debian/Ubuntu
pip install -r requirements.txt
```

## Usage

```bash
python app.py --root /path/to/slides --port 5080
```

| Flag | Default | Description |
|------|---------|-------------|
| `--root` | (none) | Root folder containing slide subfolders |
| `--port` | 5000 | Server port |
| `--host` | 127.0.0.1 | Bind address (`0.0.0.0` for LAN) |
| `--debug` | off | Flask debug mode |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FOETO_DB_PATH` | `~/Bureau/foeto_base/syndromes_foetaux.db` | FOETO terminology database |
| `LAMES_DB_PATH` | `/media/SSDsamsung/db/lames.db` | Viewer SQLite database |

### Expected folder structure

```
slides_root/
  Case_001/
    slide_HE.mrxs
    slide_HE/           # Mirax data directory
    slide_CD34.svs
  Case_002/
    placenta.ndpi
```

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Q` / `D` | Previous / next slide |
| `A` / `E` | Rotate ±10° |
| Numpad `7` / `9` | Rotate ±90° |
| Arrow keys | Pan viewport |
| `R` | Reset zoom and rotation |
| `F` | Fullscreen |
| `L` | Toggle label/macro image |
| `N` | Toggle annotation mode |
| `M` | Toggle measurement mode |
| `W` | Mark all selected organs normal → save → next slide |
| `Ctrl+S` | Save annotations |
| Right-click | Context menu (labelling tree + quick signs) |

## Project structure

```
app.py              Flask server: routes, tile serving, annotation CRUD, label API
database.py         SQLite schema (slides, annotations, organ_status, slide_notes, diagnoses)
templates/
  index.html        Single-page HTML shell
static/
  viewer.js         Frontend (OpenSeadragon, labelling, annotations, measurements, IHC)
  viewer.css        Styles
  cr_placenta.html  Embedded placenta report form
```

## Part of FoetoPath

This viewer is one component of the FoetoPath ecosystem. The FOETO database (`foeto_terms` table in `syndromes_foetaux.db`) is the single source of truth for pathology labels, organ lists, retention criteria, and annotation class definitions.
