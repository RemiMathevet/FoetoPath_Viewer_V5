/**
 * francine_queue.js
 * =================
 * Panneau "Queue FRANCINE" pour le viewer de lames FoetoPath Hub.
 * Vanilla JS, zéro dépendance. À inclure dans le template du viewer.
 *
 * Prérequis : francine_queue_bp.py enregistré dans l'app Flask.
 *
 * Usage dans le template HTML :
 *   <script src="/static/francine_queue.js"></script>
 *   <script>
 *     const francineQueue = new FrancineQueue({
 *       getCurrentSlidePath: () => window.currentSlidePath,  // ta variable globale
 *       refreshInterval: 8000,   // poll toutes les 8s
 *     });
 *     francineQueue.mount(document.getElementById('francine-panel-root'));
 *   </script>
 *
 *   // Dans le viewer, quand une lame est chargée :
 *   window.currentSlidePath = slidePath;
 *   francineQueue.updateCurrentSlide(slidePath);
 */

class FrancineQueue {

  /**
   * @param {Object} opts
   * @param {() => string|null} opts.getCurrentSlidePath  Callback retournant le path absolu de la lame en cours
   * @param {number}  [opts.refreshInterval=10000]        Intervalle de polling en ms
   * @param {string}  [opts.apiBase='/francine']          Préfixe des routes Flask
   */
  constructor(opts = {}) {
    this._getPath    = opts.getCurrentSlidePath || (() => null);
    this._interval   = opts.refreshInterval ?? 10000;
    this._api        = opts.apiBase ?? '/francine';
    this._root       = null;
    this._pollTimer  = null;
    this._currentPath = null;
    this._queueData  = [];
    this._stats      = { pending: 0, running: 0, done: 0, error: 0, total: 0 };
  }

  // ── API calls ─────────────────────────────────────────────────────────────

  async _fetchStats() {
    const r = await fetch(`${this._api}/queue/stats`);
    if (r.ok) this._stats = await r.json();
  }

  async _fetchQueue() {
    const r = await fetch(`${this._api}/queue`);
    if (r.ok) this._queueData = await r.json();
  }

  async _addSlide(slidePath, tissueType, magnifications) {
    const r = await fetch(`${this._api}/queue/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slide_path: slidePath, tissue_type: tissueType, magnifications }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    return r.json();
  }

  async _removeEntry(id) {
    const r = await fetch(`${this._api}/queue/${id}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }

  async _clearDone() {
    const r = await fetch(`${this._api}/queue/clear_done`, { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  mount(rootEl) {
    this._root = rootEl;
    this._root.innerHTML = this._renderShell();
    this._bindAdd();
    this._bindClear();
    this.refresh();
    this._pollTimer = setInterval(() => this.refresh(), this._interval);
  }

  unmount() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  /** Appelé depuis le viewer quand une nouvelle lame est chargée. */
  updateCurrentSlide(slidePath) {
    this._currentPath = slidePath;
    const nameEl = this._root?.querySelector('.fq-current-name');
    if (nameEl) nameEl.textContent = slidePath ? this._basename(slidePath) : '—';
    // Mettre à jour le statut de la lame dans la liste si présente
    this._refreshList();
  }

  async refresh() {
    await Promise.all([this._fetchStats(), this._fetchQueue()]);
    this._renderStats();
    this._refreshList();
  }

  _renderShell() {
    return `
<div class="fq-panel">
  <div class="fq-header">
    <span class="fq-title">🧬 Queue FRANCINE</span>
    <span class="fq-stats-badge" data-fq="badge">…</span>
  </div>

  <!-- Formulaire ajout lame courante -->
  <div class="fq-add-form">
    <div class="fq-slide-row">
      <span class="fq-label">Lame :</span>
      <span class="fq-current-name">—</span>
    </div>

    <div class="fq-field-row">
      <label class="fq-label" for="fq-tissue">Tissu :</label>
      <select id="fq-tissue" class="fq-select">
        <option value="">— auto (dossier parent) —</option>
        <option value="cordon">Cordon ombilical</option>
        <option value="parenchyme">Parenchyme villositaire</option>
        <option value="membranes">Membranes</option>
        <option value="plaque_choriale">Plaque choriale</option>
        <option value="plaque_basale">Plaque basale / decidue</option>
        <option value="vaisseaux">Vaisseaux du cordon</option>
        <option value="foetus">Fœtus — autre</option>
      </select>
    </div>

    <div class="fq-field-row">
      <span class="fq-label">Mag. :</span>
      <div class="fq-mag-group">
        <label><input type="checkbox" class="fq-mag" value="x5">  ×5</label>
        <label><input type="checkbox" class="fq-mag" value="x10"> ×10</label>
        <label><input type="checkbox" class="fq-mag" value="x20" checked> ×20</label>
        <label><input type="checkbox" class="fq-mag" value="x40"> ×40</label>
      </div>
    </div>

    <div class="fq-btn-row">
      <button class="fq-btn fq-btn-add" data-fq="add-btn" disabled>
        ＋ Ajouter à la queue
      </button>
      <span class="fq-feedback" data-fq="feedback"></span>
    </div>
  </div>

  <!-- Barre d'actions queue -->
  <div class="fq-toolbar">
    <span class="fq-toolbar-label">Queue</span>
    <button class="fq-btn fq-btn-sm" data-fq="refresh-btn" title="Actualiser">↺</button>
    <button class="fq-btn fq-btn-sm fq-btn-clear" data-fq="clear-btn" title="Supprimer terminées/erreurs">🗑 Nettoyer</button>
    <a class="fq-btn fq-btn-sm fq-btn-export" href="/francine/queue/export_file" download title="Exporter JSON pour le pipeline">⬇ Export JSON</a>
  </div>

  <!-- Liste des entrées -->
  <div class="fq-list" data-fq="list">
    <div class="fq-empty">Aucune lame dans la queue.</div>
  </div>
</div>

<style>
.fq-panel {
  font-family: 'Segoe UI', system-ui, sans-serif;
  font-size: 13px;
  background: #1e1e2e;
  color: #cdd6f4;
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;
}
.fq-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px 8px;
  background: #181825;
  border-bottom: 1px solid #313244;
}
.fq-title { font-weight: 700; font-size: 14px; letter-spacing: .02em; }
.fq-stats-badge {
  background: #313244;
  border-radius: 12px;
  padding: 2px 10px;
  font-size: 11px;
  color: #a6adc8;
}
.fq-add-form {
  padding: 10px 14px;
  border-bottom: 1px solid #313244;
  background: #1e1e2e;
}
.fq-slide-row {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 6px;
}
.fq-current-name {
  font-weight: 600; color: #89dceb;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 220px;
}
.fq-field-row {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 6px;
}
.fq-label { color: #a6adc8; min-width: 46px; }
.fq-select {
  flex: 1;
  background: #313244; color: #cdd6f4;
  border: 1px solid #45475a; border-radius: 4px;
  padding: 3px 6px; font-size: 12px;
}
.fq-mag-group {
  display: flex; gap: 10px; flex-wrap: wrap;
}
.fq-mag-group label { display: flex; align-items: center; gap: 3px; cursor: pointer; }
.fq-btn-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
.fq-btn {
  background: #45475a; color: #cdd6f4;
  border: none; border-radius: 5px; padding: 5px 12px;
  cursor: pointer; font-size: 12px; font-weight: 600;
  transition: background .15s;
}
.fq-btn:hover:not(:disabled) { background: #585b70; }
.fq-btn:disabled { opacity: .4; cursor: not-allowed; }
.fq-btn-add { background: #313244; border: 1px solid #cba6f7; color: #cba6f7; }
.fq-btn-add:hover:not(:disabled) { background: #cba6f720; }
.fq-btn-sm { padding: 3px 8px; font-size: 11px; }
.fq-btn-clear { color: #f38ba8; border-color: #f38ba830; }
.fq-btn-export { text-decoration: none; color: #a6e3a1; border-color: #a6e3a130;
                  display: inline-block; }
.fq-feedback { font-size: 11px; color: #a6e3a1; }
.fq-toolbar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 14px;
  border-bottom: 1px solid #313244;
  background: #181825;
}
.fq-toolbar-label { color: #a6adc8; flex: 1; font-weight: 600; font-size: 12px; }
.fq-list {
  flex: 1; overflow-y: auto;
  padding: 6px 0;
}
.fq-empty { padding: 16px 14px; color: #6c7086; font-style: italic; text-align: center; }
.fq-entry {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 7px 14px;
  border-bottom: 1px solid #31324450;
  transition: background .1s;
}
.fq-entry:hover { background: #31324430; }
.fq-entry-dot {
  width: 8px; height: 8px; border-radius: 50%;
  margin-top: 4px; flex-shrink: 0;
}
.fq-entry-dot.pending  { background: #fab387; }
.fq-entry-dot.running  { background: #89dceb; animation: fq-pulse 1s infinite; }
.fq-entry-dot.done     { background: #a6e3a1; }
.fq-entry-dot.error    { background: #f38ba8; }
@keyframes fq-pulse {
  0%, 100% { opacity: 1; } 50% { opacity: .3; }
}
.fq-entry-info { flex: 1; min-width: 0; }
.fq-entry-name {
  font-weight: 600; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 200px;
}
.fq-entry-name.is-current { color: #89dceb; }
.fq-entry-meta {
  font-size: 11px; color: #6c7086; margin-top: 1px;
  display: flex; gap: 8px; flex-wrap: wrap;
}
.fq-entry-tissue { color: #cba6f7; }
.fq-entry-mags   { color: #89b4fa; }
.fq-entry-patches { color: #a6adc8; }
.fq-entry-error  { color: #f38ba8; font-size: 11px; margin-top: 2px; }
.fq-entry-del {
  background: none; border: none; color: #45475a;
  cursor: pointer; font-size: 14px; padding: 0 2px;
  line-height: 1; flex-shrink: 0;
  transition: color .15s;
}
.fq-entry-del:hover { color: #f38ba8; }
</style>
`;
  }

  _renderStats() {
    const el = this._root?.querySelector('[data-fq="badge"]');
    if (!el) return;
    const s = this._stats;
    const parts = [];
    if (s.pending  > 0) parts.push(`${s.pending} en attente`);
    if (s.running  > 0) parts.push(`⚡ ${s.running} en cours`);
    if (s.done     > 0) parts.push(`✓ ${s.done}`);
    if (s.error    > 0) parts.push(`✗ ${s.error}`);
    el.textContent = parts.length ? parts.join(' · ') : 'vide';
  }

  _refreshList() {
    const container = this._root?.querySelector('[data-fq="list"]');
    if (!container) return;

    if (!this._queueData.length) {
      container.innerHTML = '<div class="fq-empty">Aucune lame dans la queue.</div>';
      return;
    }

    container.innerHTML = this._queueData.map(e => {
      const isCurrent = e.slide_path === (this._currentPath ?? this._getPath());
      const mags = Array.isArray(e.magnifications) ? e.magnifications.join(' ') : e.magnifications;
      const tissueLabel = e.tissue_type || '—';
      const patchesLabel = e.n_patches > 0 ? `${e.n_patches.toLocaleString()} patches` : '';
      const errorEl = e.error_msg
        ? `<div class="fq-entry-error">⚠ ${this._esc(e.error_msg)}</div>`
        : '';
      return `
<div class="fq-entry" data-entry-id="${e.id}">
  <div class="fq-entry-dot ${e.status}"></div>
  <div class="fq-entry-info">
    <div class="fq-entry-name${isCurrent ? ' is-current' : ''}" title="${this._esc(e.slide_path)}">
      ${this._esc(e.slide_name || this._basename(e.slide_path))}${isCurrent ? ' ◀' : ''}
    </div>
    <div class="fq-entry-meta">
      <span class="fq-entry-tissue">🧬 ${this._esc(tissueLabel)}</span>
      <span class="fq-entry-mags">📐 ${this._esc(mags)}</span>
      ${patchesLabel ? `<span class="fq-entry-patches">${patchesLabel}</span>` : ''}
    </div>
    ${errorEl}
  </div>
  <button class="fq-entry-del" data-del-id="${e.id}" title="Retirer">×</button>
</div>`;
    }).join('');

    // Bind delete buttons
    container.querySelectorAll('[data-del-id]').forEach(btn => {
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const id = parseInt(btn.dataset.delId);
        try {
          await this._removeEntry(id);
          this.refresh();
        } catch (err) {
          console.error('FRANCINE: delete error', err);
        }
      });
    });
  }

  // ── Event binding ──────────────────────────────────────────────────────────

  _bindAdd() {
    const addBtn = this._root.querySelector('[data-fq="add-btn"]');
    const feedback = this._root.querySelector('[data-fq="feedback"]');

    // Activer le bouton seulement si une lame est chargée
    const _checkBtn = () => {
      const path = this._currentPath ?? this._getPath();
      addBtn.disabled = !path;
    };
    _checkBtn();
    setInterval(_checkBtn, 1000);  // re-check périodique (cas où la lame change sans updateCurrentSlide)

    addBtn.addEventListener('click', async () => {
      const path = this._currentPath ?? this._getPath();
      if (!path) return;

      const tissue = this._root.querySelector('#fq-tissue').value;
      const mags = [...this._root.querySelectorAll('.fq-mag:checked')].map(el => el.value);
      if (!mags.length) {
        this._showFeedback(feedback, '⚠ Choisir au moins une magnification', 'warn');
        return;
      }

      addBtn.disabled = true;
      addBtn.textContent = '…';

      try {
        const res = await this._addSlide(path, tissue, mags);
        const verb = res.action === 'updated' ? 'Mis à jour' : 'Ajouté';
        this._showFeedback(feedback, `✓ ${verb} : ${res.slide_name}`, 'ok');
        this.refresh();
      } catch (err) {
        this._showFeedback(feedback, `✗ ${err.message}`, 'err');
      } finally {
        addBtn.disabled = false;
        addBtn.textContent = '＋ Ajouter à la queue';
      }
    });

    // Bouton refresh manuel
    this._root.querySelector('[data-fq="refresh-btn"]').addEventListener('click', () => this.refresh());
  }

  _bindClear() {
    const btn = this._root.querySelector('[data-fq="clear-btn"]');
    btn.addEventListener('click', async () => {
      try {
        const { cleared } = await this._clearDone();
        this._showFeedback(
          this._root.querySelector('[data-fq="feedback"]'),
          `🗑 ${cleared} entrée(s) supprimée(s)`, 'ok'
        );
        this.refresh();
      } catch (err) {
        console.error('FRANCINE: clear error', err);
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _showFeedback(el, msg, type = 'ok') {
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'ok' ? '#a6e3a1' : type === 'warn' ? '#fab387' : '#f38ba8';
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.textContent = ''; }, 4000);
  }

  _basename(path) {
    if (!path) return '';
    return path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  }

  _esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
