# FoetoPath — Slide Viewer

## Project overview
Flask single-page app for browsing and annotating whole-slide images (WSI) in fetal pathology.
Backend: Python/Flask + OpenSlide (deep-zoom tiles). Frontend: vanilla JS + OpenSeadragon.

## Architecture
- `app.py` — Flask server: tile serving, slide metadata, annotation CRUD, tile export
- `templates/index.html` — Single-page frontend (HTML + CSS + JS, ~2400 lines)
- `static/cr_placenta.html` — Embedded placenta report form (iframe)
- `requirements.txt` — Flask, openslide-python, Pillow, numpy, blosc2

## Key subsystems
- **Deep-zoom viewer**: OpenSeadragon consuming DZI tiles from `/api/slide/tile/`
- **Annotation system (LDA-ready)**: freehand polygons with structured LDA classes per level (Macro / Cytoarchitecture / Cellulaire). Stored as GeoJSON in `{root}/annotations/`.
- **Measurement tool**: two-click distance measurement using slide MPP calibration (µm/mm)
- **Macro annotations**: separate annotation layer on label/macro images
- **Tile export**: ZIP export of annotation-bounded tiles at any pyramid level
- **CR Placenta**: embedded report form in right panel

## Annotation levels & LDA classes
Level 1 (Macro): placenta_normal, cordon, membranes, vaisseau, infarctus, hrp, fibrine, calcification, thrombus_iv, vascularite, funiculite, chorio_1/2/3, chorangiome
Level 2 (Cytoarchitecture): villosite_term, villosite_interm_m/i, villosite_souche, chambre_iv, plaque_choriale/basale, villite, intervillite, chorioamniotite, necrose_fibrinoide, arteriopathie, trophoblaste_multinuclee, chorangiose, hemorragie_intravillositaire, nidf
Level 3 (Cellulaire): syncytiotrophoblaste, cytotrophoblaste, hofbauer, endothelial, erythrocyte_nuclee, leucocyte, plasmocyte, siderophage, macrophage_meconial, fibroblaste, noeud_syncytial

## Conventions
- All coordinates are in level-0 pixels; MPP metadata converts to µm
- GeoJSON properties include `class_id` for ML training compatibility
- Frontend is a single HTML file (no build step, no bundler)
- Keyboard shortcuts: Q/D nav, A/E rotate, L label, N annotate, M measure, P CR

## Dev
```bash
# Run
source venv/bin/activate
python app.py --root /path/to/slides --debug

# No tests yet — TODO: confirm
# No CI — TODO: confirm
```
