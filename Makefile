.PHONY: context-snapshot run

# ── Context snapshot for project-context convention ──────────
context-snapshot:
	@echo "=== Flask Routes ==="
	@cd /home/mathevet/Bureau/MRXS3 && python -c "from app import app; print('\n'.join(sorted(r.rule + '  [' + ','.join(r.methods - {'OPTIONS','HEAD'}) + ']' for r in app.url_map.iter_rules() if r.rule != '/static/<path:filename>')))" 2>/dev/null || echo "(could not load routes)"
	@echo ""
	@echo "=== LDA Classes ==="
	@grep -c "id:" templates/index.html | xargs -I{} echo "{} LDA class entries in index.html"
	@echo ""
	@echo "=== Annotation files ==="
	@find . -name '*.geojson' 2>/dev/null | wc -l | xargs -I{} echo "{} GeoJSON annotation file(s)"
	@echo ""
	@echo "=== File sizes ==="
	@wc -l app.py templates/index.html static/cr_placenta.html 2>/dev/null
	@echo ""
	@echo "=== Dependencies ==="
	@cat requirements.txt

# ── Dev helpers ──────────────────────────────────────────────
run:
	cd /home/mathevet/Bureau/MRXS3 && python app.py --debug
