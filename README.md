# FoetoPath Viewer V5

Whole-slide image viewer for fetal pathology. Single-page Flask app with deep-zoom tile serving via OpenSlide and an OpenSeadragon frontend. No build step.

## Features

**Slide viewing**
- Deep-zoom tile serving for MRXS, SVS, NDPI, TIFF/BigTIFF, SCN, BIF, VMS, VMU
- In-RAM LRU tile cache with background prefetching
- Macro/label image display and gross photo gallery
- Rotation (90° and 10° increments), fullscreen, pan/zoom

**Dual annotation mode**
- **Placenta** — Amsterdam 2014 consensus staging with structured LDA classes across three levels (Macro, Cytoarchitecture, Cellulaire)
- **Foetus** — 15 base organs + 5 sub-organs (thymus, rate, surrénale, thyroïde, pancréas), with pathology terms pulled live from the FOETO terminology database
- Per-organ top-5 quick picks for common findings
- Live search across all pathology terms
- Genest retention criteria per organ (post-mortem autolysis staging)

**Measurements**
- Two-click distance tool calibrated from slide MPP metadata (µm/mm)

**Virtual IHC presets**
- CSS/SVG filter presets simulating stain-specific contrast: PNN/nuclei, fibrose, trichrome, fer, inflammation, méconium, érythroblastes
- Manual brightness, contrast, gamma, saturation, hue controls

**Annotations storage**
- GeoJSON polygons with micrometer-calibrated coordinates
- SQLite-backed persistence (`lames.db`)
- Macro image annotations on a separate canvas layer
- CSV and GeoJSON export

**Annotation report**
- `concat_report.py` — standalone CLI to aggregate slide annotations into structured summaries (text, CSV, JSON)
- `/api/annotations/report?folder=...` — REST endpoint for hub CR histo generation

## Requirements

- Python 3.10+
- OpenSlide system library ([openslide.org](https://openslide.org/download/))
- FOETO terminology database (`syndromes_foetaux.db`) for fetal organ labels

## Installation

```bash
sudo apt install openslide-tools libopenslide-dev   # Debian/Ubuntu
pip install -r requirements.txt
```

## Usage

```bash
python app.py --root /path/to/slides --port 5003
```

| Flag | Default | Description |
|------|---------|-------------|
| `--root` | (none) | Root folder containing slide subfolders |
| `--port` | 5000 | Server port |
| `--host` | 127.0.0.1 | Bind address (`0.0.0.0` for LAN) |
| `--debug` | off | Flask debug mode |

### Annotation report CLI

```bash
python concat_report.py /path/to/case/folder
python concat_report.py /path/to/case/folder --format csv
python concat_report.py /path/to/case/folder --format json
```

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
| `Ctrl+S` | Save annotations |

## Project structure

```
app.py              Flask server: routes, tile serving, annotation CRUD, foetus term API
concat_report.py    Standalone annotation report aggregator (CLI + importable)
database.py         SQLite schema and connection (lames.db)
templates/
  index.html        Single-page HTML shell
static/
  viewer.js         Frontend (OpenSeadragon, annotations, measurements, IHC presets)
  viewer.css        Styles
  cr_placenta.html  Embedded placenta report form
```

## Part of FoetoPath

This viewer is one component of the FoetoPath ecosystem. The FOETO database (`foeto_terms` table in `syndromes_foetaux.db`) is the single source of truth for pathology labels, organ lists, retention criteria, and annotation class definitions.

## License

See [LICENSE](LICENSE).
