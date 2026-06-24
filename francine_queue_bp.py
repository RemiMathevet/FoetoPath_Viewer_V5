"""
francine_queue_bp.py
====================
Blueprint Flask — Queue d'embedding FRANCINE pour le viewer FoetoPath Hub.

Fournit les routes API pour ajouter, consulter, exporter et gérer les lames
à embarquer via le pipeline V1.2.

Intégration dans app.py principal :
    from francine_queue_bp import francine_bp, init_queue_db
    app.register_blueprint(francine_bp)
    init_queue_db(app)

Base SQLite : francine_queue.db (même dossier que app.py)
Table : queue_entries
  id            INTEGER PK AUTOINCREMENT
  slide_path    TEXT NOT NULL UNIQUE
  slide_name    TEXT
  tissue_type   TEXT DEFAULT ''
  magnifications TEXT DEFAULT '["x20"]'   -- JSON array
  status        TEXT DEFAULT 'pending'    -- pending | running | done | error
  error_msg     TEXT DEFAULT ''
  n_patches     INTEGER DEFAULT 0
  added_at      TEXT                      -- ISO datetime
  processed_at  TEXT                      -- ISO datetime (nullable)
"""

import json
import os
import sqlite3
import subprocess
import threading
from datetime import datetime
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

francine_bp = Blueprint('francine', __name__, url_prefix='/francine')

# ---------------------------------------------------------------------------
#  DB helpers
# ---------------------------------------------------------------------------

def _db_path(app=None):
    if app is None:
        app = current_app._get_current_object()
    return os.path.join(app.root_path, 'francine_queue.db')


def _get_conn(app=None):
    conn = sqlite3.connect(_db_path(app))
    conn.row_factory = sqlite3.Row
    return conn


def init_queue_db(app):
    """Crée la table si elle n'existe pas. Appeler au démarrage."""
    with app.app_context():
        conn = _get_conn(app)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS queue_entries (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                slide_path     TEXT    NOT NULL UNIQUE,
                slide_name     TEXT    NOT NULL DEFAULT '',
                tissue_type    TEXT    NOT NULL DEFAULT '',
                magnifications TEXT    NOT NULL DEFAULT '["x20"]',
                status         TEXT    NOT NULL DEFAULT 'pending',
                error_msg      TEXT    NOT NULL DEFAULT '',
                n_patches      INTEGER NOT NULL DEFAULT 0,
                added_at       TEXT    NOT NULL,
                processed_at   TEXT
            )
        """)
        conn.commit()
        conn.close()


def _row_to_dict(row):
    d = dict(row)
    try:
        d['magnifications'] = json.loads(d['magnifications'])
    except Exception:
        d['magnifications'] = ['x20']
    return d


# ---------------------------------------------------------------------------
#  Routes — liste & ajout
# ---------------------------------------------------------------------------

@francine_bp.route('/queue', methods=['GET'])
def get_queue():
    """
    GET /francine/queue
    Paramètres optionnels :
      ?status=pending|running|done|error|all  (défaut: all)
    Retourne la liste des entrées triées par added_at DESC.
    """
    status_filter = request.args.get('status', 'all')
    conn = _get_conn()
    if status_filter != 'all':
        rows = conn.execute(
            "SELECT * FROM queue_entries WHERE status=? ORDER BY added_at DESC",
            (status_filter,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM queue_entries ORDER BY added_at DESC"
        ).fetchall()
    conn.close()
    return jsonify([_row_to_dict(r) for r in rows])


@francine_bp.route('/queue/add', methods=['POST'])
def add_to_queue():
    """
    POST /francine/queue/add
    Body JSON :
    {
      "slide_path"    : "/data/lames/25P12345_1_1.mrxs",
      "tissue_type"   : "cordon",          // optionnel
      "magnifications": ["x5", "x20"]      // optionnel, défaut ["x20"]
    }
    Si la lame est déjà dans la queue (quel que soit le status), met à jour
    tissue_type et magnifications et repasse en pending.
    """
    data = request.get_json(force=True, silent=True) or {}
    slide_path = (data.get('slide_path') or '').strip()

    if not slide_path:
        return jsonify({'error': 'slide_path requis'}), 400
    if not os.path.isfile(slide_path):
        return jsonify({'error': f'Fichier introuvable : {slide_path}'}), 404

    slide_name = Path(slide_path).stem
    tissue_type = (data.get('tissue_type') or '').strip()
    mags = data.get('magnifications', ['x20'])
    if not isinstance(mags, list) or not mags:
        mags = ['x20']
    # Normaliser les magnifications
    valid_mags = {'x5', 'x10', 'x15', 'x20', 'x40'}
    mags = [m.lower().replace('×', 'x') for m in mags if m.lower().replace('×', 'x') in valid_mags]
    if not mags:
        mags = ['x20']

    mags_json = json.dumps(mags)
    now = datetime.now().isoformat()

    conn = _get_conn()
    existing = conn.execute(
        "SELECT id, status FROM queue_entries WHERE slide_path=?", (slide_path,)
    ).fetchone()

    if existing:
        conn.execute("""
            UPDATE queue_entries
            SET tissue_type=?, magnifications=?, status='pending',
                error_msg='', processed_at=NULL, added_at=?
            WHERE slide_path=?
        """, (tissue_type, mags_json, now, slide_path))
        action = 'updated'
        entry_id = existing['id']
    else:
        cur = conn.execute("""
            INSERT INTO queue_entries
              (slide_path, slide_name, tissue_type, magnifications, status, added_at)
            VALUES (?, ?, ?, ?, 'pending', ?)
        """, (slide_path, slide_name, tissue_type, mags_json, now))
        action = 'added'
        entry_id = cur.lastrowid

    conn.commit()
    conn.close()

    return jsonify({'id': entry_id, 'action': action, 'slide_name': slide_name,
                    'tissue_type': tissue_type, 'magnifications': mags}), 201


# ---------------------------------------------------------------------------
#  Routes — gestion
# ---------------------------------------------------------------------------

@francine_bp.route('/queue/<int:entry_id>', methods=['DELETE'])
def remove_entry(entry_id):
    """DELETE /francine/queue/<id> — Supprime une entrée."""
    conn = _get_conn()
    conn.execute("DELETE FROM queue_entries WHERE id=?", (entry_id,))
    conn.commit()
    conn.close()
    return jsonify({'deleted': entry_id})


@francine_bp.route('/queue/clear_done', methods=['POST'])
def clear_done():
    """POST /francine/queue/clear_done — Supprime les entrées done et error."""
    conn = _get_conn()
    n = conn.execute(
        "DELETE FROM queue_entries WHERE status IN ('done', 'error')"
    ).rowcount
    conn.commit()
    conn.close()
    return jsonify({'cleared': n})


@francine_bp.route('/queue/stats', methods=['GET'])
def queue_stats():
    """GET /francine/queue/stats — Compteurs par statut."""
    conn = _get_conn()
    rows = conn.execute("""
        SELECT status, COUNT(*) as n FROM queue_entries GROUP BY status
    """).fetchall()
    conn.close()
    stats = {r['status']: r['n'] for r in rows}
    stats.setdefault('pending', 0)
    stats.setdefault('running', 0)
    stats.setdefault('done', 0)
    stats.setdefault('error', 0)
    stats['total'] = sum(stats.values())
    return jsonify(stats)


# ---------------------------------------------------------------------------
#  Export JSON → pipeline V1.2
# ---------------------------------------------------------------------------

@francine_bp.route('/queue/export', methods=['GET'])
def export_queue():
    """
    GET /francine/queue/export
    Exporte les entrées 'pending' en JSON directement consommable par
    foetopath_pipeline_v2.py --queue.
    Paramètre optionnel : ?mark_running=1 pour passer les entrées en 'running'.
    """
    mark = request.args.get('mark_running', '0') == '1'
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM queue_entries WHERE status='pending' ORDER BY added_at"
    ).fetchall()

    result = []
    for row in rows:
        d = _row_to_dict(row)
        for mag in d['magnifications']:
            result.append({
                'slide_path'  : d['slide_path'],
                'tissue_type' : d['tissue_type'],
                'magnification': mag,
            })

    if mark and rows:
        ids = [r['id'] for r in rows]
        conn.execute(
            f"UPDATE queue_entries SET status='running' WHERE id IN ({','.join('?'*len(ids))})",
            ids
        )
        conn.commit()

    conn.close()
    return jsonify(result)


@francine_bp.route('/queue/export_file', methods=['GET'])
def export_queue_file():
    """
    GET /francine/queue/export_file
    Retourne le JSON dans un fichier téléchargeable
    (utile si le pipeline tourne sur une machine différente).
    """
    import io
    from flask import send_file

    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM queue_entries WHERE status='pending' ORDER BY added_at"
    ).fetchall()
    conn.close()

    result = []
    for row in rows:
        d = _row_to_dict(row)
        for mag in d['magnifications']:
            result.append({
                'slide_path'   : d['slide_path'],
                'tissue_type'  : d['tissue_type'],
                'magnification': mag,
            })

    buf = io.BytesIO(json.dumps(result, ensure_ascii=False, indent=2).encode('utf-8'))
    buf.seek(0)
    fname = f"francine_queue_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    return send_file(buf, mimetype='application/json',
                     as_attachment=True, download_name=fname)


# ---------------------------------------------------------------------------
#  Mise à jour status depuis le pipeline (webhook optionnel)
# ---------------------------------------------------------------------------

@francine_bp.route('/queue/update_status', methods=['POST'])
def update_status():
    """
    POST /francine/queue/update_status
    Body JSON : {"slide_path": "...", "status": "done", "n_patches": 42340}
    Appelable depuis le pipeline via requests.post() pour mettre à jour le statut.
    """
    data = request.get_json(force=True, silent=True) or {}
    slide_path = data.get('slide_path', '')
    status = data.get('status', '')
    n_patches = data.get('n_patches', 0)
    error_msg = data.get('error_msg', '')

    if not slide_path or status not in ('pending', 'running', 'done', 'error'):
        return jsonify({'error': 'Paramètres invalides'}), 400

    conn = _get_conn()
    conn.execute("""
        UPDATE queue_entries
        SET status=?, n_patches=?, error_msg=?, processed_at=?
        WHERE slide_path=?
    """, (status, n_patches, error_msg, datetime.now().isoformat(), slide_path))
    conn.commit()
    conn.close()
    return jsonify({'updated': slide_path, 'status': status})
