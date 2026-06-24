#!/usr/bin/env python3
"""
Concat annotation report — aggregates slide annotations into a structured summary.
Can be used standalone (CLI) or imported by the hub for CR histo generation.

Usage:
    python concat_report.py /path/to/case/folder
    python concat_report.py /path/to/case/folder --format csv
    python concat_report.py /path/to/case/folder --format json
"""

import argparse
import csv
import io
import json
import sys
from pathlib import Path

SLIDE_EXTENSIONS = {".mrxs", ".svs", ".ndpi", ".tiff", ".tif", ".scn", ".bif"}


def collect_report(folder: str) -> list[dict]:
    folder_path = Path(folder)
    ann_dir = folder_path / "annotations"
    slides = sorted(f for f in folder_path.iterdir()
                    if f.suffix.lower() in SLIDE_EXTENSIONS and f.is_file())

    report = []
    for slide in slides:
        entry = {
            "slide": slide.stem,
            "filename": slide.name,
            "organs": [],
            "diagnosis": [],
            "retention": [],
            "annotations": [],
        }
        ann_path = ann_dir / f"{slide.stem}.geojson"
        if ann_path.is_file():
            with open(ann_path, "r", encoding="utf-8") as f:
                geojson = json.load(f)
            meta = geojson.get("metadata", {})
            tissue = meta.get("tissue_type", "")
            if tissue:
                entry["organs"] = [t.strip() for t in tissue.split(",") if t.strip()]
            for diag in meta.get("slide_diagnosis", []):
                if "_ret" in str(diag):
                    entry["retention"].append(diag)
                else:
                    entry["diagnosis"].append(diag)
            for feat in geojson.get("features", []):
                p = feat.get("properties", {})
                entry["annotations"].append({
                    "class_id": p.get("class_id", ""),
                    "label": p.get("label", ""),
                    "level": p.get("level", 0),
                    "tissue_type": p.get("tissue_type", ""),
                    "area_um2": p.get("area_um2"),
                })
        report.append(entry)
    return report


def format_text(report: list[dict]) -> str:
    lines = []
    for entry in report:
        lines.append(f"=== {entry['slide']} ===")
        if entry["organs"]:
            lines.append(f"  Organes : {', '.join(entry['organs'])}")
        if entry["diagnosis"]:
            lines.append(f"  Diagnostic L0 : {', '.join(entry['diagnosis'])}")
        if entry["retention"]:
            lines.append(f"  Rétention : {', '.join(entry['retention'])}")
        if entry["annotations"]:
            lines.append(f"  Annotations ({len(entry['annotations'])}) :")
            for ann in entry["annotations"]:
                area = f" ({ann['area_um2']} µm²)" if ann.get("area_um2") else ""
                lines.append(f"    - {ann['label']}{area}")
        elif not entry["diagnosis"] and not entry["organs"]:
            lines.append("  (non annotée)")
        lines.append("")
    return "\n".join(lines)


def format_csv(report: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["slide", "organs", "diagnosis", "retention", "ann_count", "ann_labels"])
    for entry in report:
        writer.writerow([
            entry["slide"],
            ";".join(entry["organs"]),
            ";".join(entry["diagnosis"]),
            ";".join(entry["retention"]),
            len(entry["annotations"]),
            ";".join(a["label"] for a in entry["annotations"]),
        ])
    return buf.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Concat annotation report")
    parser.add_argument("folder", help="Case folder containing slides")
    parser.add_argument("--format", choices=["text", "csv", "json"], default="text")
    args = parser.parse_args()

    report = collect_report(args.folder)
    if args.format == "json":
        print(json.dumps(report, indent=2, ensure_ascii=False))
    elif args.format == "csv":
        print(format_csv(report), end="")
    else:
        print(format_text(report))
