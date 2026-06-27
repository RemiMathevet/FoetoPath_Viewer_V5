# Mission Log — FoetoPath Slide Viewer

Append-only. Each entry: `## YYYY-MM-DD HH:MM — [type] — [summary]`

---

## 2026-05-05 16:49 — phase — Bootstrapped project-context convention

- Created CLAUDE.md, missions/, docs/, Makefile
- Project: Flask slide viewer for fetal pathology (OpenSlide + OpenSeadragon)

---

## 2026-05-05 16:49 — phase — Measurement tool + LDA annotations + FRANCINE removal

- Added distance measurement tool (µm/mm, delete buttons on each measurement)
- Added polygon area calculation (shoelace, µm²/mm²) in annotation list + GeoJSON export
- Removed FRANCINE queue system entirely (backend + frontend)
- Replaced free-text annotation labels with structured LDA class taxonomy (3 levels, 40+ classes)
- Added classes: vaisseau, vascularite, funiculite, chorio_1/2/3, artériopathie, trophoblaste_multinuclee, plasmocyte, siderophage, macrophage_meconial

---

## 2026-05-05 18:10 — phase — Cache LRU, réglages image et presets colorimétrie

- Cache LRU RAM (400 tuiles max) + 6 threads OSD parallèles + Cache-Control HTTP
- Réglages image : brightness, contrast, saturation, hue-rotate, gamma par canal (R/G/B)
- 7 presets IHC in-silico : PNN, fibrose, trichrome, fer/sidéro, inflammation, méconium, érythroblastes
- Annotations sauvegardées dans le dossier de la lame source

---
