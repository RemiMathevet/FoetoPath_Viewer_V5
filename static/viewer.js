// ── State ────────────────────────────────────────────────
let state = {
    root: '',
    cases: [],
    currentCase: null,
    slides: [],
    photos: [],
    currentSlideIndex: -1,
    currentPhotoIndex: -1,
    osdViewer: null,
    rotation: 0,
    viewMode: 'slide', // 'slide' or 'photo'
    labelVisible: false,
    // Annotation state
    annMode: false,
    annColor: '#e74c3c',
    annLevel: 0,  // 0=label lame, 1=région faible G, 2=histo moyen G
    annLabel: '',
    tissueType: '',
    slideDiagnosis: [],
    annotations: [],     // [{points_px, color, label, level, id, created, tissue_type}, ...]
    annDrawing: false,
    annCurrentPath: [],
    annHighlighted: null, // id of highlighted annotation
    // Calibration
    mppX: 0,
    mppY: 0,
    // Measurement tool
    measureMode: false,
    measurements: [],       // [{id, start:[x,y], end:[x,y], distUm}]
    measurePending: null,   // [x,y] first click waiting for second
    measureCursor: null,    // [x,y] current mouse pos for preview
};

// ── Helpers ──────────────────────────────────────────────
function toast(msg, isError = false) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.toggle('error', isError);
    el.classList.add('visible');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => el.classList.remove('visible'), 3500);
}
function setLoading(on) {
    document.getElementById('loadingOverlay').classList.toggle('visible', on);
}
// Base path for API calls — detects reverse proxy (e.g. /viewer/)
const _BASE = window.location.pathname.replace(/\/+$/, '').replace(/\/?$/, '');
function _url(path) { return _BASE + path; }

async function api(url, body) {
    const res = await fetch(_url(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

// ── OSD Creation Helper ──────────────────────────────────
function createOSD(tileSources) {
    if (state.osdViewer) { state.osdViewer.destroy(); state.osdViewer = null; }
    state.rotation = 0;
    state.osdViewer = OpenSeadragon({
        id: 'viewer',
        prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.1/images/',
        tileSources: tileSources,
        animationTime: 0.3,
        blendTime: 0.1,
        constrainDuringPan: false,
        maxZoomPixelRatio: 4,
        minZoomImageRatio: 0.5,
        visibilityRatio: 0.3,
        zoomPerScroll: 1.3,
        zoomPerClick: 2.0,
        showNavigator: true,
        navigatorPosition: 'BOTTOM_RIGHT',
        navigatorSizeRatio: 0.15,
        navigatorAutoFade: true,
        showNavigationControl: true,
        navigationControlAnchor: OpenSeadragon.ControlAnchor.TOP_LEFT,
        gestureSettingsMouse: { clickToZoom: true, dblClickToZoom: true },
        gestureSettingsTouch: { pinchToZoom: true },
        crossOriginPolicy: false,
        imageLoaderLimit: 6,
        timeout: 60000,
        degrees: 0,
        tabIndex: -1,
    });
    state.osdViewer.innerTracker.keyHandler = null;
    state.osdViewer.innerTracker.keyDownHandler = null;
    state.osdViewer.addHandler('open', () => setLoading(false));
    state.osdViewer.addHandler('open-failed', () => {
        setLoading(false);
        toast('Erreur ouverture', true);
    });
    // Attach annotation re-render on viewport change
    annAttachViewportHandler();
    // Re-apply display filters (persist across slide switches)
    updateDisplayFilters();
}

// ── Load Cases ───────────────────────────────────────────
async function loadCases() {
    const root = document.getElementById('rootInput').value.trim();
    if (!root) { toast('Entrez un chemin de dossier', true); return; }
    state.root = root;
    const btn = document.getElementById('btnLoad');
    btn.textContent = '...'; btn.disabled = true;
    try {
        const data = await api('/api/browse', { root });
        if (data.error) { toast(data.error, true); return; }
        state.cases = data.cases;
        renderCaseList();
        document.getElementById('caseCount').textContent = data.cases.length;
        toast(data.cases.length === 0 ? 'Aucun cas trouvé' : `${data.cases.length} cas trouvé(s)`, data.cases.length === 0);
    } catch (e) {
        toast('Erreur réseau: ' + e.message, true);
    } finally {
        btn.textContent = 'Charger'; btn.disabled = false;
    }
}

// ── Render Case List ─────────────────────────────────────
function renderCaseList() {
    const el = document.getElementById('caseList');
    if (state.cases.length === 0) {
        el.innerHTML = '<div class="sidebar-empty">Aucun cas trouvé</div>';
        return;
    }
    el.innerHTML = state.cases.map((c, i) => {
        const parts = [];
        if (c.slide_count > 0) parts.push(`${c.slide_count} lame${c.slide_count > 1 ? 's' : ''}`);
        if (c.photo_count > 0) parts.push(`<span class="photo-count">${c.photo_count} photo${c.photo_count > 1 ? 's' : ''}</span>`);
        if (c.annotated_count > 0) parts.push(`${c.annotated_count} annotée${c.annotated_count > 1 ? 's' : ''}`);
        const doneIcon = c.annotated_count > 0 ? '<span style="color:var(--success);margin-right:4px;">&#10003;</span>' : '';
        return `
            <div class="case-item ${state.currentCase === i ? 'active' : ''}"
                 onclick="selectCase(${i})" title="${c.path}">
                <div class="case-item-name">${doneIcon}${c.is_root ? '&#128194; ' : ''}${c.name}</div>
                <div class="case-item-counts">${parts.join(' &middot; ')}</div>
            </div>`;
    }).join('');
}

// ── Select Case ──────────────────────────────────────────
async function selectCase(index) {
    state.currentCase = index;
    state.currentSlideIndex = -1;
    state.currentPhotoIndex = -1;
    state.viewMode = 'slide';
    closeLabel();
    renderCaseList();
    document.getElementById('welcomeScreen').classList.add('hidden');
    const caseData = state.cases[index];
    setLoading(true);
    try {
        const data = await api('/api/slides', { folder: caseData.path, root: state.root });
        state.slides = data.slides || [];
        state.photos = data.photos || [];
        renderCarousel();
        if (state._autoSlide && state.slides.length > 0) {
            const idx = state.slides.findIndex(s => s.path === state._autoSlide || s.path.endsWith(state._autoSlide.split('/').pop()));
            loadSlide(idx >= 0 ? idx : 0);
            delete state._autoSlide;
        } else if (state.slides.length > 0) {
            loadSlide(0);
        } else if (state.photos.length > 0) {
            loadPhoto(0);
        } else {
            if (state.osdViewer) { state.osdViewer.destroy(); state.osdViewer = null; }
            document.getElementById('slideMeta').textContent = '';
            setLoading(false);
        }
    } catch (e) {
        toast('Erreur chargement: ' + e.message, true);
        setLoading(false);
    }
}

// ── Render Carousel ──────────────────────────────────────
function renderCarousel() {
    const el = document.getElementById('carousel');
    const hasSlides = state.slides.length > 0;
    const hasPhotos = state.photos.length > 0;
    const showSlideRow = hasSlides && (state.slides.length > 1 || hasPhotos);

    if (!showSlideRow && !hasPhotos) { el.classList.remove('visible'); return; }
    el.classList.add('visible');
    let html = '';

    if (showSlideRow) {
        html += '<div class="carousel-section-label slide-label">&#128300; Lames (' + state.slides.length + ')</div><div class="carousel-scroll">';
        html += state.slides.map((s, i) => `
            <div class="carousel-item slide-item ${state.viewMode === 'slide' && i === state.currentSlideIndex ? 'active' : ''}"
                 onclick="loadSlide(${i})" title="${s.name}">
                <img src="${_BASE}/api/slide/thumbnail?path=${encodeURIComponent(s.path)}&w=160&h=160" alt="${s.name}" loading="lazy">
                <div class="carousel-item-label">${s.name}</div>
            </div>`).join('');
        html += '</div>';
    }
    if (hasPhotos) {
        html += '<div class="carousel-section-label photo-label">&#128247; Photos (' + state.photos.length + ')</div><div class="carousel-scroll">';
        html += state.photos.map((p, i) => `
            <div class="carousel-item photo-item ${state.viewMode === 'photo' && i === state.currentPhotoIndex ? 'active' : ''}"
                 onclick="loadPhoto(${i})" title="${p.filename} (${p.size_kb} KB)">
                <img src="${_BASE}/api/photo/thumbnail?path=${encodeURIComponent(p.path)}&w=160&h=160" alt="${p.name}" loading="lazy">
                <div class="carousel-item-label">${p.filename}</div>
            </div>`).join('');
        html += '</div>';
    }
    el.innerHTML = html;

    requestAnimationFrame(() => {
        const active = el.querySelector('.carousel-item.active');
        if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    });
}

// ── Load Slide (OpenSlide DZI) ───────────────────────────
async function loadSlide(index) {
    if (index < 0 || index >= state.slides.length) return;
    state.currentSlideIndex = index;
    state.viewMode = 'slide';
    state.currentPhotoIndex = -1;
    closeLabel();
    const slide = state.slides[index];

    setLoading(true);
    renderCarousel();
    document.getElementById('shortcutsHint').classList.add('visible');
    document.getElementById('viewBadge').classList.remove('visible');
    document.getElementById('btnLabel').classList.add('visible');

    // Reset annotation and measure mode on slide switch
    if (state.annMode) toggleAnnotationMode();
    if (state.measureMode) toggleMeasureMode();
    state.measurements = [];
    state.mppX = 0;
    state.mppY = 0;

    try {
        const info = await api('/api/slide/info', { path: slide.path });
        if (info.dimensions) {
            const [w, h] = info.dimensions;
            const mpx = ((w * h) / 1e6).toFixed(1);
            state.mppX = info.mpp_x || 0;
            state.mppY = info.mpp_y || 0;
            const mppStr = state.mppX > 0 ? `  \u00b7  ${state.mppX.toFixed(3)} \u00b5m/px` : '';
            document.getElementById('slideMeta').textContent =
                `${slide.name}  \u00b7  ${w.toLocaleString()} \u00d7 ${h.toLocaleString()} px  \u00b7  ${mpx} Mpx${mppStr}`;
            // Populate export level dropdown
            annPopulateLevels(info);
        }
    } catch (e) {}

    const tileSource = {
        getTileUrl: function(level, x, y) {
            return `${_BASE}/api/slide/tile/${level}/${x}_${y}.jpeg?path=${encodeURIComponent(slide.path)}`;
        },
        height: null, width: null, tileSize: 254, tileOverlap: 1, minLevel: 0, maxLevel: null,
    };
    try {
        const dziRes = await fetch(_url('/api/slide/dzi'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: slide.path }),
        });
        const xml = new DOMParser().parseFromString(await dziRes.text(), 'application/xml');
        const image = xml.querySelector('Image'), size = xml.querySelector('Size');
        if (image && size) {
            tileSource.width = parseInt(size.getAttribute('Width'));
            tileSource.height = parseInt(size.getAttribute('Height'));
            tileSource.tileSize = parseInt(image.getAttribute('TileSize'));
            tileSource.tileOverlap = parseInt(image.getAttribute('Overlap'));
            tileSource.maxLevel = Math.ceil(Math.log2(Math.max(tileSource.width, tileSource.height)));
        }
    } catch (e) { toast('Erreur DZI: ' + e.message, true); setLoading(false); return; }

    createOSD(tileSource);

    // Load existing annotations for this slide
    annLoad(slide.path);
}

// ── Load Photo (in OSD as simple image) ──────────────────
function loadPhoto(index) {
    if (index < 0 || index >= state.photos.length) return;
    state.currentPhotoIndex = index;
    state.viewMode = 'photo';
    state.currentSlideIndex = -1;
    closeLabel();
    const photo = state.photos[index];

    setLoading(true);
    renderCarousel();
    document.getElementById('shortcutsHint').classList.add('visible');
    document.getElementById('viewBadge').classList.add('visible');
    document.getElementById('btnLabel').classList.remove('visible');
    document.getElementById('slideMeta').textContent =
        `${photo.filename}  \u00b7  ${photo.size_kb} KB`;

    createOSD({
        type: 'image',
        url: `${_BASE}/api/photo/serve?path=${encodeURIComponent(photo.path)}`,
    });
}

// ── Navigate prev/next in current mode ───────────────────
function navPrev() {
    if (state.viewMode === 'slide') loadSlide(state.currentSlideIndex - 1);
    else loadPhoto(state.currentPhotoIndex - 1);
}
function navNext() {
    if (state.viewMode === 'slide') loadSlide(state.currentSlideIndex + 1);
    else loadPhoto(state.currentPhotoIndex + 1);
}

// ── Label ────────────────────────────────────────────────
function toggleLabel() {
    if (state.labelVisible) { closeLabel(); return; }
    if (state.viewMode !== 'slide' || state.currentSlideIndex < 0) return;
    const slide = state.slides[state.currentSlideIndex];
    const img = document.getElementById('labelPopupImg');
    const popup = document.getElementById('labelPopup');

    // Reset macro annotation state for new image
    macroAnnState.active = false;
    macroAnnState.drawing = false;
    macroAnnState.currentPath = [];
    macroAnnState.annotations = [];
    macroAnnState.imgNaturalW = 0;
    macroAnnState.imgNaturalH = 0;
    document.getElementById('btnMacroAnnotate').classList.remove('active');
    document.getElementById('macroAnnToolbar').classList.remove('visible');
    document.getElementById('macroAnnCanvas').classList.remove('drawing');
    macroAnnUpdateCount();

    // When image loads, capture natural dimensions, resize canvas, and load existing annotations
    img.onload = function() {
        macroAnnState.imgNaturalW = img.naturalWidth;
        macroAnnState.imgNaturalH = img.naturalHeight;
        macroAnnResizeCanvas();
        macroAnnRender();
        // Load existing macro annotations
        macroAnnLoad(slide.path);
        // Also fetch macro info from backend for accurate dimensions
        fetch(`${_BASE}/api/slide/macro/info?path=${encodeURIComponent(slide.path)}`)
            .then(r => r.json())
            .then(data => {
                if (data.width && data.height) {
                    macroAnnState.imgNaturalW = data.width;
                    macroAnnState.imgNaturalH = data.height;
                    macroAnnState.macroType = data.type || 'macro';
                }
            })
            .catch(() => {});
    };

    // Try label first, fallback to macro
    img.onerror = function() {
        img.onerror = function() {
            toast('Pas d\'étiquette disponible pour cette lame', true);
            popup.classList.remove('visible');
            state.labelVisible = false;
        };
        img.src = `${_BASE}/api/slide/label?path=${encodeURIComponent(slide.path)}&type=macro`;
        document.getElementById('labelPopupTitle').textContent = 'Macro — ' + slide.name;
    };
    img.src = `${_BASE}/api/slide/label?path=${encodeURIComponent(slide.path)}&type=label`;
    document.getElementById('labelPopupTitle').textContent = 'Étiquette — ' + slide.name;
    popup.classList.add('visible');
    state.labelVisible = true;
}
function closeLabel() {
    document.getElementById('labelPopup').classList.remove('visible');
    state.labelVisible = false;
    // Deactivate macro annotation mode
    if (macroAnnState.active) {
        macroAnnState.active = false;
        macroAnnState.drawing = false;
        macroAnnState.currentPath = [];
        document.getElementById('btnMacroAnnotate').classList.remove('active');
        document.getElementById('macroAnnToolbar').classList.remove('visible');
        document.getElementById('macroAnnCanvas').classList.remove('drawing');
    }
}

// ── Keyboard ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') { if (e.key === 'Enter' && e.target.id === 'rootInput') loadCases(); return; }

    // Close label on Escape
    if (e.key === 'Escape' && state.labelVisible) { closeLabel(); e.preventDefault(); return; }
    // Cancel pending measurement or clear all on Escape
    if (e.key === 'Escape' && state.measureMode) {
        if (state.measurePending) { state.measurePending = null; state.measureCursor = null; annRender(); }
        else { measureClearAll(); }
        e.preventDefault(); return;
    }

    const vp = state.osdViewer ? state.osdViewer.viewport : null;

    // Helper: rotation-aware pan
    function rotatedPan(rawDx, rawDy) {
        if (!vp) return;
        const angle = -state.rotation * Math.PI / 180;
        const dx = Math.cos(angle) * rawDx - Math.sin(angle) * rawDy;
        const dy = Math.sin(angle) * rawDx + Math.cos(angle) * rawDy;
        vp.panBy(new OpenSeadragon.Point(dx, dy));
    }

    switch (e.key) {
        // Arrow keys: pan 90% respecting rotation
        case 'ArrowLeft':
            e.preventDefault();
            if (vp) { const b = vp.getBounds(); rotatedPan(-b.width * 0.9, 0); }
            break;
        case 'ArrowRight':
            e.preventDefault();
            if (vp) { const b = vp.getBounds(); rotatedPan(b.width * 0.9, 0); }
            break;
        case 'ArrowUp':
            e.preventDefault();
            if (vp) { const b = vp.getBounds(); rotatedPan(0, -b.height * 0.9); }
            break;
        case 'ArrowDown':
            e.preventDefault();
            if (vp) { const b = vp.getBounds(); rotatedPan(0, b.height * 0.9); }
            break;

        // Numpad 4/6 or Q/D: prev/next
        case '4':
            if (e.location === 3 || e.code === 'Numpad4') { e.preventDefault(); navPrev(); }
            break;
        case '6':
            if (e.location === 3 || e.code === 'Numpad6') { e.preventDefault(); navNext(); }
            break;
        case 'q': case 'Q': e.preventDefault(); navPrev(); break;
        case 'd': case 'D': e.preventDefault(); navNext(); break;

        // Numpad 7/9: rotate 90° | A/E: rotate 10°
        case '7':
            if (e.location === 3 || e.code === 'Numpad7') {
                e.preventDefault();
                if (vp) { state.rotation = (state.rotation - 90 + 360) % 360; vp.setRotation(state.rotation); }
            }
            break;
        case '9':
            if (e.location === 3 || e.code === 'Numpad9') {
                e.preventDefault();
                if (vp) { state.rotation = (state.rotation + 90) % 360; vp.setRotation(state.rotation); }
            }
            break;
        case 'a': case 'A':
            e.preventDefault();
            if (vp) { state.rotation = (state.rotation - 10 + 360) % 360; vp.setRotation(state.rotation); }
            break;
        case 'e': case 'E':
            e.preventDefault();
            if (vp) { state.rotation = (state.rotation + 10) % 360; vp.setRotation(state.rotation); }
            break;

        // R: reset
        case 'r': case 'R':
            if (vp) { state.rotation = 0; vp.setRotation(0); vp.goHome(); }
            break;
        // F: fullscreen
        case 'f': case 'F':
            if (state.osdViewer) state.osdViewer.setFullScreen(!state.osdViewer.isFullPage());
            break;
        // L: label toggle
        case 'l': case 'L':
            toggleLabel();
            break;
        // P: CR panel toggle
        case 'p': case 'P':
            toggleCR();
            break;
        // N: annotation mode toggle
        case 'n': case 'N':
            toggleAnnotationMode();
            break;
        // M: measure mode toggle
        case 'm': case 'M':
            toggleMeasureMode();
            break;
        // I: display settings toggle
        case 'i': case 'I':
            toggleDisplaySettings();
            break;
    }

    // Ctrl+S: save annotations
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.annMode && state.annotations.length > 0) annSave();
    }
});

document.getElementById('rootInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadCases();
});

// ── Annotation System (LDA-ready) ─────────────────────────
const ANN_LEVELS = { 0: 'Label lame', 1: 'Région (faible G)', 2: 'Histo (moyen G)' };

// Source of truth: foeto_terms DB via /api/config/labels
let LDA_CLASSES = {};
let SLIDE_TAGS = {};

// Fœtus organ state
let FOETO_ORGANS = [];         // all available organs
let FOETO_TERMS_CACHE = {};    // {organ: {axis: [{id,label}]}}
let FOETO_QUICK_CACHE = {};    // {organ: [{id,label}]}
let FOETO_RETENTION_CACHE = {}; // {organ: [{id,label}]}
let _allFoetusOptions = [];    // flat list for search filter
let _allSignOptions = [];      // flat list for sign search

state.domain = 'placenta';     // 'placenta' or 'foetus'
state.selectedOrgans = [];     // checked fetal organs
state.organDiagnosis = [];     // checked quick picks (fœtus mode)
state.retentionPicks = [];     // checked Genest retention criteria
state.signPicks = [];          // checked signs from search

fetch(_url('/api/config/labels')).then(r => r.json()).then(cfg => {
    if (cfg.lda_classes) {
        LDA_CLASSES = {};
        for (const [k, v] of Object.entries(cfg.lda_classes)) LDA_CLASSES[parseInt(k)] = v;
    }
    if (cfg.slide_tags) SLIDE_TAGS = cfg.slide_tags;
    annPopulateClassDropdown();
    renderDiagTags();
}).catch(e => console.error('Labels fetch failed:', e));

// Load organ list once (base + sub-organs)
fetch(_url('/api/foeto/organs')).then(r => r.json()).then(data => {
    FOETO_ORGANS = (data.organs || []).concat(data.sub_organs || []);
    _renderOrganPills();
}).catch(() => {});

const _ORGAN_LABELS = {
    cerveau:'Cerveau', coeur:'Cœur', poumon:'Poumon', foie:'Foie', rein:'Rein',
    digestif:'Digestif', peau:'Peau', genital:'Génital', hematolymphoide:'Hémato',
    endocrine:'Endocrine', squelette:'Squelette', muscle:'Muscle',
    oeil_oreille:'Œil/Oreille', retention:'Rétention', multi_organe:'Multi-organe',
    thymus:'Thymus', rate:'Rate', surrenale:'Surrénale', thyroide:'Thyroïde', pancreas:'Pancréas',
};

function setDomain(domain, el) {
    state.domain = domain;
    document.querySelectorAll('.ann-domain-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    document.getElementById('placentaTools').style.display = domain === 'placenta' ? '' : 'none';
    document.getElementById('foetusTools').style.display = domain === 'foetus' ? '' : 'none';
    document.getElementById('levelRow').style.display = domain === 'placenta' ? '' : 'none';
    document.getElementById('annClassSearch').style.display = domain === 'foetus' ? '' : 'none';
    if (domain === 'placenta') {
        annPopulateClassDropdown();
    } else {
        _loadOrganTerms();
    }
}

function _renderOrganPills() {
    const el = document.getElementById('organPills');
    if (!el) return;
    el.innerHTML = FOETO_ORGANS.map(o => {
        const sel = state.selectedOrgans.includes(o) ? 'selected' : '';
        const label = _ORGAN_LABELS[o] || o;
        return `<span class="ann-diag-tag organ-pill ${sel}" onclick="toggleOrgan('${o}')">${label}</span>`;
    }).join('');
}

function toggleOrgan(organ) {
    const idx = state.selectedOrgans.indexOf(organ);
    if (idx >= 0) state.selectedOrgans.splice(idx, 1);
    else state.selectedOrgans.push(organ);
    _renderOrganPills();
    _loadOrganTerms();
}

function _loadOrganTerms() {
    if (state.selectedOrgans.length === 0) {
        FOETO_TERMS_CACHE = {};
        FOETO_QUICK_CACHE = {};
        _renderOrganQuickTags();
        _populateFoetusClassDropdown();
        return;
    }
    const needed = state.selectedOrgans.filter(o => !(o in FOETO_TERMS_CACHE));
    if (needed.length === 0) {
        _renderOrganQuickTags();
        _populateFoetusClassDropdown();
        return;
    }
    fetch(_url('/api/foeto/terms?organs=' + state.selectedOrgans.join(','))).then(r => r.json()).then(data => {
        Object.assign(FOETO_TERMS_CACHE, data.terms || {});
        Object.assign(FOETO_QUICK_CACHE, data.quick || {});
        Object.assign(FOETO_RETENTION_CACHE, data.retention || {});
        _renderOrganQuickTags();
        _renderRetentionTags();
        _buildSignOptions();
        _populateFoetusClassDropdown();
    }).catch(() => {});
}

function _renderOrganQuickTags() {
    const el = document.getElementById('organQuickTags');
    if (!el) return;
    if (state.selectedOrgans.length === 0) {
        el.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Cochez des organes</span>';
        return;
    }
    let html = '';
    for (const org of state.selectedOrgans) {
        const quick = FOETO_QUICK_CACHE[org] || [];
        if (quick.length === 0) continue;
        const label = _ORGAN_LABELS[org] || org;
        html += `<span style="font-size:9px;color:var(--text-muted);width:100%;margin-top:2px;">${label}</span>`;
        html += quick.map(t => {
            const sel = state.organDiagnosis.includes(t.id) ? 'selected' : '';
            const short = t.label.length > 40 ? t.label.slice(0, 38) + '…' : t.label;
            return `<span class="ann-diag-tag ${sel}" title="${t.label}" onclick="toggleOrganDiag('${t.id}')">${short}</span>`;
        }).join('');
    }
    el.innerHTML = html || '<span style="font-size:10px;color:var(--text-muted);">Aucun signe rapide</span>';
}

function toggleOrganDiag(id) {
    const idx = state.organDiagnosis.indexOf(id);
    if (idx >= 0) state.organDiagnosis.splice(idx, 1);
    else state.organDiagnosis.push(id);
    _renderOrganQuickTags();
    annSave();
}

function _buildSignOptions() {
    _allSignOptions = [];
    for (const org of state.selectedOrgans) {
        const byAxis = FOETO_TERMS_CACHE[org] || {};
        const label = _ORGAN_LABELS[org] || org;
        for (const terms of Object.values(byAxis)) {
            for (const t of terms) _allSignOptions.push({ ...t, org, orgLabel: label });
        }
    }
}

function organSignSearchUpdate() {
    const q = (document.getElementById('organSignSearch').value || '').toLowerCase().trim();
    const el = document.getElementById('organSignResults');
    if (!q || q.length < 2) { el.innerHTML = ''; return; }
    const hits = _allSignOptions.filter(t => t.label.toLowerCase().includes(q)).slice(0, 15);
    if (hits.length === 0) { el.innerHTML = '<span style="font-size:10px;color:var(--text-muted);padding:2px 4px;">Aucun résultat</span>'; return; }
    el.innerHTML = hits.map(t => {
        const sel = state.signPicks.includes(t.id) ? 'selected' : '';
        const short = t.label.length > 55 ? t.label.slice(0, 53) + '…' : t.label;
        return `<span class="ann-diag-tag ${sel}" title="${t.orgLabel}: ${t.label}" onclick="toggleSignPick('${t.id}')">${short}</span>`;
    }).join('');
}

function toggleSignPick(id) {
    const idx = state.signPicks.indexOf(id);
    if (idx >= 0) state.signPicks.splice(idx, 1);
    else state.signPicks.push(id);
    organSignSearchUpdate();
    annSave();
}

function _renderRetentionTags() {
    const el = document.getElementById('retentionTags');
    if (!el) return;
    if (state.selectedOrgans.length === 0) {
        el.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Cochez des organes</span>';
        return;
    }
    let html = '';
    for (const org of state.selectedOrgans) {
        const items = FOETO_RETENTION_CACHE[org] || [];
        if (items.length === 0) continue;
        const label = _ORGAN_LABELS[org] || org;
        html += `<span style="font-size:9px;color:var(--text-muted);width:100%;margin-top:2px;">${label}</span>`;
        html += items.map(t => {
            const sel = state.retentionPicks.includes(t.id) ? 'selected' : '';
            const short = t.label.length > 50 ? t.label.slice(0, 48) + '…' : t.label;
            return `<span class="ann-diag-tag retention-tag ${sel}" title="${t.label}" onclick="toggleRetentionPick('${t.id}')">${short}</span>`;
        }).join('');
    }
    el.innerHTML = html || '<span style="font-size:10px;color:var(--text-muted);">Pas de critères de rétention</span>';
}

function toggleRetentionPick(id) {
    const idx = state.retentionPicks.indexOf(id);
    if (idx >= 0) state.retentionPicks.splice(idx, 1);
    else state.retentionPicks.push(id);
    _renderRetentionTags();
    annSave();
}

function _populateFoetusClassDropdown() {
    const sel = document.getElementById('annClassSelect');
    if (!sel) return;
    _allFoetusOptions = [];
    let html = '';
    for (const org of state.selectedOrgans) {
        const byAxis = FOETO_TERMS_CACHE[org] || {};
        const label = _ORGAN_LABELS[org] || org;
        for (const [axis, terms] of Object.entries(byAxis)) {
            html += `<optgroup label="${label} — ${axis}">`;
            for (const t of terms) {
                html += `<option value="${t.id}">${t.label}</option>`;
                _allFoetusOptions.push({ id: t.id, label: t.label, org, axis });
            }
            html += '</optgroup>';
        }
    }
    sel.innerHTML = html || '<option value="">Sélectionnez des organes</option>';
    annOnClassChange();
}

function annFilterClasses() {
    const q = (document.getElementById('annClassSearch').value || '').toLowerCase().trim();
    const sel = document.getElementById('annClassSelect');
    if (!q) { _populateFoetusClassDropdown(); return; }
    const filtered = _allFoetusOptions.filter(t => t.label.toLowerCase().includes(q));
    sel.innerHTML = filtered.length === 0
        ? '<option value="">Aucun résultat</option>'
        : filtered.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
    annOnClassChange();
}

function setTissue(tissue, el) {
    const changed = state.tissueType !== tissue;
    state.tissueType = tissue;
    document.querySelectorAll('.tissue-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    if (changed) state.slideDiagnosis = [];
    renderDiagTags();
}

function renderDiagTags() {
    const container = document.getElementById('annDiagTags');
    if (!container) return;
    const tags = SLIDE_TAGS[state.tissueType] || [];
    if (tags.length === 0) { container.innerHTML = '<span style="font-size:10px;color:var(--text-muted);">Sélectionnez un tissu</span>'; return; }
    container.innerHTML = tags.map(t => {
        const sel = state.slideDiagnosis.includes(t) ? 'selected' : '';
        return `<span class="ann-diag-tag ${sel}" onclick="toggleDiagTag('${t.replace(/'/g, "\\'")}')">${t}</span>`;
    }).join('');
}

function toggleDiagTag(tag) {
    const idx = state.slideDiagnosis.indexOf(tag);
    if (idx >= 0) state.slideDiagnosis.splice(idx, 1);
    else state.slideDiagnosis.push(tag);
    renderDiagTags();
}

let annIdCounter = 0;

function ldaGetClass(level, classId) {
    const classes = LDA_CLASSES[level] || [];
    return classes.find(c => c.id === classId) || null;
}

function ldaGetSelectedClass() {
    const sel = document.getElementById('annClassSelect');
    const classId = sel ? sel.value : '';
    return ldaGetClass(state.annLevel, classId);
}

function annPopulateClassDropdown() {
    if (state.domain === 'foetus') { _populateFoetusClassDropdown(); return; }
    const sel = document.getElementById('annClassSelect');
    if (!sel) return;
    const classes = LDA_CLASSES[state.annLevel] || [];
    sel.innerHTML = classes.map(c =>
        `<option value="${c.id}">${c.label}</option>`
    ).join('');
    annOnClassChange();
}

function annOnClassChange() {
    const swatch = document.getElementById('annClassSwatch');
    if (state.domain === 'foetus') {
        state.annColor = '#3498db';
        swatch.style.background = '#3498db';
        return;
    }
    const cls = ldaGetSelectedClass();
    if (cls) {
        state.annColor = cls.color;
        swatch.style.background = cls.color;
    }
}

function annSetLevel(level, el) {
    state.annLevel = level;
    document.querySelectorAll('.ann-level-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
    annPopulateClassDropdown();
}

// populated by fetch callback above

function toggleAnnotationMode() {
    if (state.viewMode !== 'slide') { toast('Annotations disponibles uniquement sur les lames', true); return; }
    state.annMode = !state.annMode;
    const btn = document.getElementById('btnAnnotate');
    const canvas = document.getElementById('annotationCanvas');
    const panel = document.getElementById('annPanel');
    const badge = document.getElementById('annDrawingBadge');
    const handle = document.getElementById('resizeHandleRight');

    btn.classList.toggle('active', state.annMode);
    canvas.classList.toggle('drawing', state.annMode);
    panel.classList.toggle('visible', state.annMode);
    badge.classList.toggle('visible', state.annMode);

    if (state.annMode) {
        // Close CR panel if open
        const crPanel = document.getElementById('rightPanel');
        if (crPanel.classList.contains('visible')) {
            crPanel.classList.remove('visible');
            document.getElementById('btnCR').classList.remove('active');
        }
        handle.classList.add('visible');
        // Disable only drag/pan, keep scroll zoom active
        if (state.osdViewer) {
            state.osdViewer.gestureSettingsMouse.scrollToZoom = true;
            state.osdViewer.gestureSettingsMouse.clickToZoom = false;
            state.osdViewer.gestureSettingsMouse.dblClickToZoom = false;
            state.osdViewer.gestureSettingsMouse.pinchToZoom = true;
            state.osdViewer.panHorizontal = false;
            state.osdViewer.panVertical = false;
        }
        annResizeCanvas();
        annRender();
        annRenderList();
    } else {
        handle.classList.remove('visible');
        // Restore full mouse navigation
        if (state.osdViewer) {
            state.osdViewer.gestureSettingsMouse.clickToZoom = true;
            state.osdViewer.gestureSettingsMouse.dblClickToZoom = true;
            state.osdViewer.panHorizontal = true;
            state.osdViewer.panVertical = true;
        }
        state.annDrawing = false;
        state.annCurrentPath = [];
        state.annHighlighted = null;
    }
}

function annResizeCanvas() {
    const canvas = document.getElementById('annotationCanvas');
    const viewer = document.getElementById('viewer');
    canvas.width = viewer.clientWidth;
    canvas.height = viewer.clientHeight;
}

function annScreenToImage(screenX, screenY) {
    if (!state.osdViewer) return null;
    const rect = state.osdViewer.element.getBoundingClientRect();
    const vp = state.osdViewer.viewport;
    const pt = vp.viewportToImageCoordinates(vp.pointFromPixel(
        new OpenSeadragon.Point(screenX - rect.left, screenY - rect.top)));
    return [Math.round(pt.x), Math.round(pt.y)];
}

function annImageToCanvas(imgX, imgY) {
    if (!state.osdViewer) return null;
    const vp = state.osdViewer.viewport;
    const pt = vp.pixelFromPoint(vp.imageToViewportCoordinates(new OpenSeadragon.Point(imgX, imgY)));
    return [pt.x, pt.y];
}

// ── Annotation Rendering ─────────────────────────────────
function annRender() {
    const canvas = document.getElementById('annotationCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const ann of state.annotations) {
        annDrawPath(ctx, ann.points_px, ann.color, true, ann.id === state.annHighlighted);
    }
    if (state.annCurrentPath.length > 1) {
        annDrawPath(ctx, state.annCurrentPath, state.annColor, false, false);
    }
    if (state.measurements.length > 0 || state.measurePending) {
        measureRenderAll(ctx);
    }
    measureUpdateDeleteBtns();
}

function annDrawPath(ctx, points, color, closed, highlighted) {
    if (points.length < 2) return;
    ctx.beginPath();
    const first = annImageToCanvas(points[0][0], points[0][1]);
    if (!first) return;
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < points.length; i++) {
        const pt = annImageToCanvas(points[i][0], points[i][1]);
        if (pt) ctx.lineTo(pt[0], pt[1]);
    }
    if (closed) ctx.closePath();
    ctx.fillStyle = color + (highlighted ? '40' : '18');
    if (closed) ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = highlighted ? 3 : 2;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (highlighted) ctx.setLineDash([6, 4]); else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
}

// ── Drawing Events ───────────────────────────────────────
(function() {
    const canvas = document.getElementById('annotationCanvas');

    canvas.addEventListener('mousedown', (e) => {
        if (!state.annMode || e.button !== 0) return;
        e.preventDefault();
        state.annDrawing = true;
        state.annCurrentPath = [];
        const pt = annScreenToImage(e.clientX, e.clientY);
        if (pt) state.annCurrentPath.push(pt);
    });
    canvas.addEventListener('mousemove', (e) => {
        if (!state.annDrawing) return;
        const pt = annScreenToImage(e.clientX, e.clientY);
        if (pt) { state.annCurrentPath.push(pt); annRender(); }
    });
    canvas.addEventListener('mouseup', () => {
        if (!state.annDrawing) return;
        state.annDrawing = false;
        annFinishStroke();
    });
    canvas.addEventListener('mouseleave', () => {
        if (state.annDrawing) { state.annDrawing = false; state.annCurrentPath = []; annRender(); }
    });

    // Touch
    canvas.addEventListener('touchstart', (e) => {
        if (!state.annMode || e.touches.length !== 1) return;
        e.preventDefault();
        state.annDrawing = true;
        state.annCurrentPath = [];
        const pt = annScreenToImage(e.touches[0].clientX, e.touches[0].clientY);
        if (pt) state.annCurrentPath.push(pt);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        if (!state.annDrawing || e.touches.length !== 1) return;
        e.preventDefault();
        const pt = annScreenToImage(e.touches[0].clientX, e.touches[0].clientY);
        if (pt) { state.annCurrentPath.push(pt); annRender(); }
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
        if (!state.annDrawing) return;
        state.annDrawing = false;
        annFinishStroke();
    });
})();

function annFinishStroke() {
    if (state.annCurrentPath.length > 5) {
        const note = document.getElementById('annLabelInput').value.trim();
        let label, classId, color, tissueType, level;
        if (state.domain === 'foetus') {
            const sel = document.getElementById('annClassSelect');
            classId = sel ? sel.value : '';
            const opt = sel ? sel.options[sel.selectedIndex] : null;
            const classLabel = opt ? opt.textContent : '';
            label = note ? `${classLabel}: ${note}` : classLabel;
            color = '#3498db';
            tissueType = state.selectedOrgans.join(',');
            level = 0;
        } else {
            const cls = ldaGetSelectedClass();
            classId = cls ? cls.id : '';
            label = note ? `${cls ? cls.label : ANN_LEVELS[state.annLevel]}: ${note}` : (cls ? cls.label : ANN_LEVELS[state.annLevel]);
            color = cls ? cls.color : state.annColor;
            tissueType = state.tissueType;
            level = state.annLevel;
        }
        state.annotations.push({
            id: 'ann_' + (++annIdCounter),
            points_px: [...state.annCurrentPath],
            color, label, class_id: classId,
            tissue_type: tissueType,
            level, created: new Date().toISOString(),
        });
        annUpdateCount();
        annRenderList();
    }
    state.annCurrentPath = [];
    annRender();
}

// ── Measurement Tool ─────────────────────────────────────
let measureIdCounter = 0;

function formatDistance(um) {
    if (um > 500) return (um / 1000).toFixed(2) + ' mm';
    return um.toFixed(1) + ' µm';
}

function formatArea(um2) {
    if (um2 <= 0) return '';
    if (um2 >= 1e6) return (um2 / 1e6).toFixed(2) + ' mm²';
    return Math.round(um2).toLocaleString() + ' µm²';
}

function computePolygonArea(points) {
    if (points.length < 3) return 0;
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += points[j][0] * points[i][1];
        area -= points[i][0] * points[j][1];
    }
    return Math.abs(area) / 2;
}

function computeDistance(p1, p2) {
    const dx = (p2[0] - p1[0]) * (state.mppX || 1);
    const dy = (p2[1] - p1[1]) * (state.mppY || 1);
    return Math.sqrt(dx * dx + dy * dy);
}

function toggleMeasureMode() {
    if (state.viewMode !== 'slide') { toast('Mesures disponibles uniquement sur les lames', true); return; }
    if (state.mppX <= 0 || state.mppY <= 0) {
        toast('Pas de calibration (MPP) disponible — distances en pixels', false);
    }
    state.measureMode = !state.measureMode;
    const btn = document.getElementById('btnMeasure');
    const canvas = document.getElementById('annotationCanvas');
    const badge = document.getElementById('measureBadge');

    btn.classList.toggle('active', state.measureMode);
    badge.classList.toggle('visible', state.measureMode);

    if (state.measureMode) {
        if (state.annMode) toggleAnnotationMode();
        canvas.classList.add('measuring');
        if (state.osdViewer) {
            state.osdViewer.gestureSettingsMouse.clickToZoom = false;
            state.osdViewer.gestureSettingsMouse.dblClickToZoom = false;
            state.osdViewer.panHorizontal = false;
            state.osdViewer.panVertical = false;
        }
    } else {
        canvas.classList.remove('measuring');
        state.measurePending = null;
        state.measureCursor = null;
        if (state.osdViewer && !state.annMode) {
            state.osdViewer.gestureSettingsMouse.clickToZoom = true;
            state.osdViewer.gestureSettingsMouse.dblClickToZoom = true;
            state.osdViewer.panHorizontal = true;
            state.osdViewer.panVertical = true;
        }
    }
    annRender();
}

function measureUpdateCount() {
    document.getElementById('measureCount').textContent = state.measurements.length;
}

function measureClearAll() {
    state.measurements = [];
    state.measurePending = null;
    state.measureCursor = null;
    measureUpdateCount();
    annRender();
}

// Measure mode canvas events
(function() {
    const canvas = document.getElementById('annotationCanvas');

    canvas.addEventListener('click', (e) => {
        if (!state.measureMode || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const pt = annScreenToImage(e.clientX, e.clientY);
        if (!pt) return;

        if (!state.measurePending) {
            state.measurePending = pt;
        } else {
            const dist = computeDistance(state.measurePending, pt);
            state.measurements.push({
                id: 'meas_' + (++measureIdCounter),
                start: state.measurePending,
                end: pt,
                distUm: dist,
            });
            state.measurePending = null;
            state.measureCursor = null;
            measureUpdateCount();
        }
        annRender();
    });

    canvas.addEventListener('mousemove', (e) => {
        if (!state.measureMode || !state.measurePending) return;
        const pt = annScreenToImage(e.clientX, e.clientY);
        if (pt) { state.measureCursor = pt; annRender(); }
    });

    canvas.addEventListener('contextmenu', (e) => {
        if (!state.measureMode) return;
        e.preventDefault();
        if (state.measurePending) {
            state.measurePending = null;
            state.measureCursor = null;
            annRender();
        } else if (state.measurements.length > 0) {
            state.measurements.pop();
            measureUpdateCount();
            annRender();
        }
    });
})();

function measureRenderAll(ctx) {
    const hasCalib = state.mppX > 0 && state.mppY > 0;
    for (const m of state.measurements) {
        measureDrawLine(ctx, m.start, m.end, m.distUm, hasCalib, false);
    }
    if (state.measurePending) {
        const start = annImageToCanvas(state.measurePending[0], state.measurePending[1]);
        if (start) {
            ctx.beginPath();
            ctx.arc(start[0], start[1], 5, 0, Math.PI * 2);
            ctx.fillStyle = '#2ecc71';
            ctx.fill();
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        if (state.measureCursor) {
            const dist = computeDistance(state.measurePending, state.measureCursor);
            measureDrawLine(ctx, state.measurePending, state.measureCursor, dist, hasCalib, true);
        }
    }
}

function measureDrawLine(ctx, p1, p2, distUm, hasCalib, preview) {
    const a = annImageToCanvas(p1[0], p1[1]);
    const b = annImageToCanvas(p2[0], p2[1]);
    if (!a || !b) return;

    // Line
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.strokeStyle = preview ? '#2ecc7188' : '#2ecc71';
    ctx.lineWidth = preview ? 2 : 2.5;
    ctx.setLineDash(preview ? [6, 4] : []);
    ctx.stroke();
    ctx.setLineDash([]);

    // Endpoints
    for (const pt of [a, b]) {
        ctx.beginPath();
        ctx.arc(pt[0], pt[1], 4, 0, Math.PI * 2);
        ctx.fillStyle = '#2ecc71';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
    }

    // Distance label at midpoint
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    const label = hasCalib ? formatDistance(distUm) : Math.round(distUm) + ' px';
    ctx.font = 'bold 13px "DM Sans", sans-serif';
    const tw = ctx.measureText(label).width;
    const pad = 5;
    ctx.fillStyle = 'rgba(15, 17, 23, 0.85)';
    const rx = mx - tw / 2 - pad, ry = my - 10 - pad, rw = tw + pad * 2, rh = 20 + pad;
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(rx, ry, rw, rh, 4); }
    else { ctx.rect(rx, ry, rw, rh); }
    ctx.fill();
    ctx.strokeStyle = '#2ecc71';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#2ecc71';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, mx, my);
}

function measureUpdateDeleteBtns() {
    const overlay = document.getElementById('measureDeleteOverlay');
    if (!overlay) return;
    if (state.measurements.length === 0) { overlay.innerHTML = ''; return; }
    const viewer = document.getElementById('viewer');
    const vRect = viewer.getBoundingClientRect();
    overlay.innerHTML = state.measurements.map(m => {
        const a = annImageToCanvas(m.end[0], m.end[1]);
        if (!a) return '';
        const x = a[0] + 12;
        const y = a[1] - 12;
        if (x < -20 || y < -20 || x > vRect.width + 20 || y > vRect.height + 20) return '';
        return `<button class="measure-delete-btn" style="left:${x}px;top:${y}px"
                    onclick="measureDeleteById('${m.id}')" title="Supprimer">&times;</button>`;
    }).join('');
}

function measureDeleteById(id) {
    state.measurements = state.measurements.filter(m => m.id !== id);
    measureUpdateCount();
    annRender();
}

// ── Annotation List ──────────────────────────────────────
function annUpdateCount() {
    document.getElementById('annCount').textContent = state.annotations.length;
    annUpdateExportBtn();
}

function annRenderList() {
    const container = document.getElementById('annListScroll');
    if (state.annotations.length === 0) {
        container.innerHTML = '<div class="ann-list-empty">Dessinez sur la lame pour annoter</div>';
        return;
    }
    container.innerHTML = state.annotations.map((ann, i) => {
        const levelTag = ANN_LEVELS[ann.level] || '?';
        const nPts = ann.points_px.length;
        const areaPx2 = computePolygonArea(ann.points_px);
        let areaStr = '';
        if (areaPx2 > 0 && state.mppX > 0 && state.mppY > 0) {
            const areaUm2 = areaPx2 * state.mppX * state.mppY;
            areaStr = ' · ' + formatArea(areaUm2);
        } else if (areaPx2 > 0) {
            areaStr = ' · ' + Math.round(areaPx2).toLocaleString() + ' px²';
        }
        const classLabel = ann.class_id ? (ldaGetClass(ann.level, ann.class_id)?.label || ann.class_id) : '';
        const displayLabel = classLabel || ann.label;
        const noteStr = ann.label && classLabel && ann.label !== classLabel && !ann.label.startsWith(classLabel)
            ? ` — ${ann.label}` : '';
        return `
        <div class="ann-list-item ${ann.id === state.annHighlighted ? 'highlighted' : ''}"
             onmouseenter="annHighlight('${ann.id}')" onmouseleave="annHighlight(null)">
            <div class="ann-list-swatch" style="background:${ann.color}"></div>
            <div class="ann-list-info">
                <div class="ann-list-info-label" id="annLabel_${ann.id}" ondblclick="annStartEdit('${ann.id}')"
                     title="Double-clic pour renommer">${displayLabel}${noteStr}</div>
                <div class="ann-list-info-meta">${ann.tissue_type ? '<span class="tissue-badge ' + ann.tissue_type + '">' + ann.tissue_type + '</span> ' : ''}${levelTag} · ${nPts} pts${areaStr}${ann.class_id ? ' · <span style="color:var(--accent)">' + ann.class_id + '</span>' : ''}</div>
            </div>
            <div class="ann-list-actions">
                <button class="ann-list-action goto" onclick="annGoTo('${ann.id}')" title="Aller à">&#8982;</button>
                <button class="ann-list-action" onclick="annStartEdit('${ann.id}')" title="Renommer">&#9998;</button>
                <button class="ann-list-action delete" onclick="annDeleteOne('${ann.id}')" title="Supprimer">&#10005;</button>
            </div>
        </div>`;
    }).join('');
}

function annHighlight(id) {
    state.annHighlighted = id;
    annRender();
    // Update highlighted class in list
    document.querySelectorAll('.ann-list-item').forEach(el => el.classList.remove('highlighted'));
    if (id) {
        const items = document.querySelectorAll('.ann-list-item');
        const idx = state.annotations.findIndex(a => a.id === id);
        if (idx >= 0 && items[idx]) items[idx].classList.add('highlighted');
    }
}

function annGoTo(id) {
    const ann = state.annotations.find(a => a.id === id);
    if (!ann || !state.osdViewer) return;
    // Compute bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ann.points_px) {
        if (x < minX) minX = x; if (y < minY) minY = y;
        if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    // Add padding
    const padX = (maxX - minX) * 0.15;
    const padY = (maxY - minY) * 0.15;
    minX -= padX; minY -= padY; maxX += padX; maxY += padY;

    const vp = state.osdViewer.viewport;
    const topLeft = vp.imageToViewportCoordinates(new OpenSeadragon.Point(minX, minY));
    const bottomRight = vp.imageToViewportCoordinates(new OpenSeadragon.Point(maxX, maxY));
    const rect = new OpenSeadragon.Rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    vp.fitBounds(rect);

    state.annHighlighted = id;
    annRender();
    annRenderList();
}

function annStartEdit(id) {
    const ann = state.annotations.find(a => a.id === id);
    if (!ann) return;
    const labelEl = document.getElementById('annLabel_' + id);
    if (!labelEl) return;
    const currentLabel = ann.label;
    labelEl.innerHTML = `<input class="ann-edit-input" value="${currentLabel}"
        onkeydown="if(event.key==='Enter')annFinishEdit('${id}',this.value);if(event.key==='Escape')annRenderList();"
        onblur="annFinishEdit('${id}',this.value)">`;
    labelEl.querySelector('input').focus();
    labelEl.querySelector('input').select();
}

function annFinishEdit(id, newLabel) {
    const ann = state.annotations.find(a => a.id === id);
    if (ann) ann.label = newLabel.trim() || ANN_LEVELS[ann.level];
    annRenderList();
    annRender();
}

function annDeleteOne(id) {
    state.annotations = state.annotations.filter(a => a.id !== id);
    annUpdateCount();
    annRenderList();
    annRender();
}

function annUndo() {
    if (state.annotations.length === 0) return;
    state.annotations.pop();
    annUpdateCount(); annRenderList(); annRender();
}

function annClearAll() {
    if (state.annotations.length === 0) return;
    if (!confirm(`Effacer ${state.annotations.length} annotation(s) ?`)) return;
    state.annotations = [];
    annUpdateCount(); annRenderList(); annRender();
}

async function annSave() {
    if (state.viewMode !== 'slide' || state.currentSlideIndex < 0) return;
    const foetDiag = state.domain === 'foetus'
        ? [...state.organDiagnosis, ...state.signPicks, ...state.retentionPicks]
        : [];
    if (state.annotations.length === 0 && state.slideDiagnosis.length === 0 && foetDiag.length === 0) {
        toast('Aucune annotation ni diagnostic', true); return;
    }
    const slide = state.slides[state.currentSlideIndex];
    const features = state.annotations.map(ann => {
        const areaPx2 = computePolygonArea(ann.points_px);
        const areaUm2 = (state.mppX > 0 && state.mppY > 0) ? areaPx2 * state.mppX * state.mppY : null;
        return {
            coordinates: [ann.points_px],
            properties: {
                id: ann.id, label: ann.label, color: ann.color,
                class_id: ann.class_id || '',
                tissue_type: ann.tissue_type || state.tissueType,
                ann_class: ann.class_id || '',
                level: ann.level, level_name: ANN_LEVELS[ann.level],
                area_px2: Math.round(areaPx2),
                area_um2: areaUm2 ? Math.round(areaUm2) : null,
                created: ann.created,
            },
        };
    });
    try {
        const diagnosis = state.domain === 'foetus'
            ? [...state.organDiagnosis, ...state.signPicks, ...state.retentionPicks]
            : state.slideDiagnosis;
        const tissueType = state.domain === 'foetus' ? state.selectedOrgans.join(',') : state.tissueType;
        const res = await api('/api/annotations/save', {
            root: state.root, slide_path: slide.path, features: features,
            tissue_type: tissueType,
            slide_diagnosis: diagnosis,
        });
        if (res.ok) {
            const diagStr = state.slideDiagnosis.length > 0 ? ` | Diag: ${state.slideDiagnosis.join(', ')}` : '';
            toast(`${res.feature_count} annotation(s) sauvegardée(s)${diagStr}`);
        } else toast('Erreur: ' + (res.error || 'inconnue'), true);
    } catch (e) { toast('Erreur réseau: ' + e.message, true); }
}

async function annLoad(slidePath) {
    state.annotations = [];
    state.annHighlighted = null;
    state.slideDiagnosis = [];
    state.organDiagnosis = [];
    state.signPicks = [];
    state.retentionPicks = [];
    annUpdateCount();
    try {
        const res = await fetch(`${_BASE}/api/annotations/load?root=${encodeURIComponent(state.root)}&slide_path=${encodeURIComponent(slidePath)}`);
        const data = await res.json();
        if (data.exists) {
            const meta = data.metadata || {};
            const tissue = meta.tissue_type || '';
            const diagIds = meta.slide_diagnosis || [];

            if (state.domain === 'foetus' && tissue && !SLIDE_TAGS[tissue]) {
                // Foetus mode: restore organs + picks
                state.selectedOrgans = tissue.split(',').map(s => s.trim()).filter(Boolean);
                for (const id of diagIds) {
                    if (/_ret/.test(id)) state.retentionPicks.push(id);
                    else state.organDiagnosis.push(id);
                }
                _renderOrganPills();
                // Force-fetch all organ terms then re-render with saved picks
                FOETO_TERMS_CACHE = {}; FOETO_QUICK_CACHE = {}; FOETO_RETENTION_CACHE = {};
                _loadOrganTerms();
            } else {
                // Placenta mode
                if (tissue && SLIDE_TAGS[tissue]) {
                    setTissue(tissue, document.querySelector(`.tissue-btn[data-tissue="${tissue}"]`));
                }
                if (diagIds.length) {
                    state.slideDiagnosis = diagIds;
                    renderDiagTags();
                }
            }

            if (data.features && data.features.length > 0) {
                for (const feat of data.features) {
                    const coords = feat.geometry?.coordinates?.[0] || [];
                    const p = feat.properties || {};
                    state.annotations.push({
                        id: p.id || 'ann_' + (++annIdCounter),
                        points_px: coords,
                        color: p.color || '#e74c3c',
                        label: p.label || '',
                        class_id: p.class_id || '',
                        tissue_type: p.tissue_type || '',
                        level: p.level || 1,
                        created: p.created || '',
                    });
                }
                annUpdateCount();
            }
            const allDiag = [...state.slideDiagnosis, ...state.organDiagnosis, ...state.retentionPicks];
            const diagStr = allDiag.length > 0 ? ` | Diag: ${allDiag.length}` : '';
            toast(`${state.annotations.length} annotation(s) chargée(s)${diagStr}`);
        }
    } catch (e) {}
    if (state.annMode) annRenderList();
    annRender();
}

function annAttachViewportHandler() {
    if (!state.osdViewer) return;
    state.osdViewer.addHandler('update-viewport', () => {
        if (state.annotations.length > 0 || state.annCurrentPath.length > 0
            || state.measurements.length > 0 || state.measurePending) {
            annResizeCanvas(); annRender();
        }
    });
    state.osdViewer.addHandler('resize', () => { annResizeCanvas(); annRender(); });
}

// ── Macro Image Annotation System ─────────────────────────
let macroAnnState = {
    active: false,
    drawing: false,
    currentPath: [],       // [[x_px, y_px], ...] in macro image pixels
    annotations: [],       // [{id, points_px, color, label, created}, ...]
    color: '#e74c3c',
    imgNaturalW: 0,        // Actual macro image width in pixels
    imgNaturalH: 0,        // Actual macro image height in pixels
    macroType: 'macro',    // 'macro' or 'label'
};
let macroAnnIdCounter = 0;

const MACRO_ANN_COLORS = [
    { color: '#e74c3c', name: 'Rouge' }, { color: '#27ae60', name: 'Vert' },
    { color: '#2980b9', name: 'Bleu' }, { color: '#f39c12', name: 'Orange' },
    { color: '#8e44ad', name: 'Violet' }, { color: '#1abc9c', name: 'Turquoise' },
];

// Init macro annotation color buttons
(function() {
    const container = document.getElementById('macroAnnColors');
    container.innerHTML = MACRO_ANN_COLORS.map((c, i) => `
        <div class="macro-ann-color-btn ${i === 0 ? 'active' : ''}"
             style="background:${c.color}"
             onclick="macroAnnSetColor('${c.color}', this)"
             title="${c.name}"></div>
    `).join('');
})();

function macroAnnSetColor(color, el) {
    macroAnnState.color = color;
    document.querySelectorAll('.macro-ann-color-btn').forEach(b => b.classList.remove('active'));
    if (el) el.classList.add('active');
}

function macroAnnToggle() {
    macroAnnState.active = !macroAnnState.active;
    const btn = document.getElementById('btnMacroAnnotate');
    const toolbar = document.getElementById('macroAnnToolbar');
    const canvas = document.getElementById('macroAnnCanvas');

    btn.classList.toggle('active', macroAnnState.active);
    toolbar.classList.toggle('visible', macroAnnState.active);
    canvas.classList.toggle('drawing', macroAnnState.active);

    if (macroAnnState.active) {
        macroAnnResizeCanvas();
        macroAnnRender();
    } else {
        macroAnnState.drawing = false;
        macroAnnState.currentPath = [];
    }
}

function macroAnnResizeCanvas() {
    const img = document.getElementById('labelPopupImg');
    const canvas = document.getElementById('macroAnnCanvas');
    // Match canvas size to the displayed image size
    canvas.width = img.clientWidth;
    canvas.height = img.clientHeight;
    canvas.style.width = img.clientWidth + 'px';
    canvas.style.height = img.clientHeight + 'px';
}

// Convert screen coordinates to macro image pixel coordinates
function macroAnnScreenToImage(screenX, screenY) {
    const img = document.getElementById('labelPopupImg');
    const rect = img.getBoundingClientRect();
    // Position relative to displayed image
    const relX = screenX - rect.left;
    const relY = screenY - rect.top;
    // Scale to natural image dimensions
    const scaleX = macroAnnState.imgNaturalW / img.clientWidth;
    const scaleY = macroAnnState.imgNaturalH / img.clientHeight;
    return [Math.round(relX * scaleX), Math.round(relY * scaleY)];
}

// Convert macro image pixel coordinates to canvas coordinates
function macroAnnImageToCanvas(imgX, imgY) {
    const img = document.getElementById('labelPopupImg');
    const scaleX = img.clientWidth / macroAnnState.imgNaturalW;
    const scaleY = img.clientHeight / macroAnnState.imgNaturalH;
    return [imgX * scaleX, imgY * scaleY];
}

function macroAnnRender() {
    const canvas = document.getElementById('macroAnnCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const ann of macroAnnState.annotations) {
        macroAnnDrawPath(ctx, ann.points_px, ann.color, true);
    }
    if (macroAnnState.currentPath.length > 1) {
        macroAnnDrawPath(ctx, macroAnnState.currentPath, macroAnnState.color, false);
    }
}

function macroAnnDrawPath(ctx, points, color, closed) {
    if (points.length < 2) return;
    ctx.beginPath();
    const first = macroAnnImageToCanvas(points[0][0], points[0][1]);
    ctx.moveTo(first[0], first[1]);
    for (let i = 1; i < points.length; i++) {
        const pt = macroAnnImageToCanvas(points[i][0], points[i][1]);
        ctx.lineTo(pt[0], pt[1]);
    }
    if (closed) ctx.closePath();
    ctx.fillStyle = color + '25';
    if (closed) ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
}

// Drawing events on macro canvas
(function() {
    const canvas = document.getElementById('macroAnnCanvas');

    canvas.addEventListener('mousedown', (e) => {
        if (!macroAnnState.active || e.button !== 0) return;
        e.preventDefault();
        macroAnnState.drawing = true;
        macroAnnState.currentPath = [];
        const pt = macroAnnScreenToImage(e.clientX, e.clientY);
        macroAnnState.currentPath.push(pt);
    });
    canvas.addEventListener('mousemove', (e) => {
        if (!macroAnnState.drawing) return;
        const pt = macroAnnScreenToImage(e.clientX, e.clientY);
        macroAnnState.currentPath.push(pt);
        macroAnnRender();
    });
    canvas.addEventListener('mouseup', () => {
        if (!macroAnnState.drawing) return;
        macroAnnState.drawing = false;
        macroAnnFinishStroke();
    });
    canvas.addEventListener('mouseleave', () => {
        if (macroAnnState.drawing) {
            macroAnnState.drawing = false;
            macroAnnState.currentPath = [];
            macroAnnRender();
        }
    });

    // Touch support
    canvas.addEventListener('touchstart', (e) => {
        if (!macroAnnState.active || e.touches.length !== 1) return;
        e.preventDefault();
        macroAnnState.drawing = true;
        macroAnnState.currentPath = [];
        const pt = macroAnnScreenToImage(e.touches[0].clientX, e.touches[0].clientY);
        macroAnnState.currentPath.push(pt);
    }, { passive: false });
    canvas.addEventListener('touchmove', (e) => {
        if (!macroAnnState.drawing || e.touches.length !== 1) return;
        e.preventDefault();
        const pt = macroAnnScreenToImage(e.touches[0].clientX, e.touches[0].clientY);
        macroAnnState.currentPath.push(pt);
        macroAnnRender();
    }, { passive: false });
    canvas.addEventListener('touchend', () => {
        if (!macroAnnState.drawing) return;
        macroAnnState.drawing = false;
        macroAnnFinishStroke();
    });
})();

function macroAnnFinishStroke() {
    if (macroAnnState.currentPath.length > 5) {
        const label = document.getElementById('macroAnnLabelInput').value.trim() || 'Macro';
        macroAnnState.annotations.push({
            id: 'macro_ann_' + (++macroAnnIdCounter),
            points_px: [...macroAnnState.currentPath],
            color: macroAnnState.color,
            label: label,
            created: new Date().toISOString(),
        });
        macroAnnUpdateCount();
    }
    macroAnnState.currentPath = [];
    macroAnnRender();
}

function macroAnnUpdateCount() {
    document.getElementById('macroAnnCount').textContent =
        macroAnnState.annotations.length + ' annotation(s)';
}

function macroAnnUndo() {
    if (macroAnnState.annotations.length === 0) return;
    macroAnnState.annotations.pop();
    macroAnnUpdateCount();
    macroAnnRender();
}

function macroAnnClearAll() {
    if (macroAnnState.annotations.length === 0) return;
    if (!confirm(`Effacer ${macroAnnState.annotations.length} annotation(s) macro ?`)) return;
    macroAnnState.annotations = [];
    macroAnnUpdateCount();
    macroAnnRender();
}

async function macroAnnSave() {
    if (state.viewMode !== 'slide' || state.currentSlideIndex < 0) return;
    if (macroAnnState.annotations.length === 0) {
        toast('Aucune annotation macro à sauvegarder', true); return;
    }
    const slide = state.slides[state.currentSlideIndex];
    const features = macroAnnState.annotations.map(ann => ({
        coordinates: [ann.points_px],
        properties: {
            id: ann.id,
            label: ann.label,
            color: ann.color,
            created: ann.created,
        },
    }));
    try {
        const res = await api('/api/annotations/macro/save', {
            root: state.root,
            slide_path: slide.path,
            features: features,
            macro_dimensions: [macroAnnState.imgNaturalW, macroAnnState.imgNaturalH],
        });
        if (res.ok) toast(`${res.feature_count} annotation(s) macro sauvegardée(s)`);
        else toast('Erreur: ' + (res.error || 'inconnue'), true);
    } catch (e) { toast('Erreur réseau: ' + e.message, true); }
}

async function macroAnnLoad(slidePath) {
    macroAnnState.annotations = [];
    macroAnnUpdateCount();
    try {
        const res = await fetch(
            `${_BASE}/api/annotations/macro/load?root=${encodeURIComponent(state.root)}&slide_path=${encodeURIComponent(slidePath)}`
        );
        const data = await res.json();
        if (data.exists && data.features && data.features.length > 0) {
            for (const feat of data.features) {
                const coords = feat.geometry?.coordinates?.[0] || [];
                const p = feat.properties || {};
                macroAnnState.annotations.push({
                    id: p.id || 'macro_ann_' + (++macroAnnIdCounter),
                    points_px: coords,
                    color: p.color || '#e74c3c',
                    label: p.label || 'Macro',
                    created: p.created || '',
                });
            }
            macroAnnUpdateCount();
            toast(`${macroAnnState.annotations.length} annotation(s) macro chargée(s)`);
        }
    } catch (e) {}
    macroAnnRender();
}

// ponytail: tile export supprimé, stubs pour éviter les erreurs si appelé
function annPopulateLevels() {}
function annUpdateExportBtn() {}

// ── Display Settings (Brightness / Contrast / Gamma / Saturation / Presets) ──
const IHC_PRESETS = [
    {
        id: 'pnn', label: 'PNN / Noyaux',
        desc: 'Rehausse les noyaux polylobés (hématoxyline)',
        brightness: 1.05, contrast: 1.6, saturate: 1.3, hue: 0,
        gR: 1.8, gG: 1.2, gB: 0.6,
    },
    {
        id: 'fibrose', label: 'Fibrose',
        desc: 'Rehausse le collagène (éosine)',
        brightness: 1.05, contrast: 1.4, saturate: 1.5, hue: 0,
        gR: 0.6, gG: 1.3, gB: 1.8,
    },
    {
        id: 'trichrome', label: 'Trichrome',
        desc: 'Simule un Masson : collagène → bleu-vert',
        brightness: 1.0, contrast: 1.3, saturate: 2.0, hue: 180,
        gR: 0.8, gG: 0.7, gB: 0.9,
    },
    {
        id: 'fer', label: 'Fer / Sidéro.',
        desc: 'Rehausse l\'hémosidérine (pigment brun-doré)',
        brightness: 0.95, contrast: 1.5, saturate: 1.8, hue: 0,
        gR: 0.7, gG: 1.0, gB: 1.5,
    },
    {
        id: 'inflam', label: 'Inflammation',
        desc: 'Rehausse les cellules inflammatoires',
        brightness: 1.0, contrast: 1.8, saturate: 1.2, hue: 0,
        gR: 1.5, gG: 1.1, gB: 0.7,
    },
    {
        id: 'meconium', label: 'Méconium',
        desc: 'Rehausse le pigment méconial (vert-brun)',
        brightness: 1.0, contrast: 1.4, saturate: 2.2, hue: 0,
        gR: 1.3, gG: 0.6, gB: 1.1,
    },
    {
        id: 'erythro', label: 'Érythroblastes',
        desc: 'Rehausse les érythrocytes nucléés',
        brightness: 1.1, contrast: 1.5, saturate: 1.6, hue: 0,
        gR: 0.7, gG: 1.4, gB: 1.4,
    },
];

let activePresetId = null;

// Build preset buttons
(function() {
    const container = document.getElementById('displayPresets');
    container.innerHTML = IHC_PRESETS.map(p =>
        `<button class="display-preset-btn" data-preset="${p.id}" onclick="applyPreset('${p.id}')" title="${p.desc}">${p.label}</button>`
    ).join('');
})();

function toggleDisplaySettings() {
    const panel = document.getElementById('displaySettings');
    const btn = document.getElementById('btnDisplay');
    const isVisible = panel.classList.contains('visible');
    panel.classList.toggle('visible', !isVisible);
    btn.classList.toggle('active', !isVisible);
}

function toggleChannelGamma() {
    const group = document.getElementById('channelGroup');
    const arrow = document.getElementById('channelArrow');
    const vis = group.classList.toggle('visible');
    arrow.classList.toggle('open', vis);
}

function updateDisplayFilters(fromChannel) {
    const brightness = parseFloat(document.getElementById('brightnessSlider').value);
    const contrast = parseFloat(document.getElementById('contrastSlider').value);
    const saturate = parseFloat(document.getElementById('saturateSlider').value);
    const hue = parseFloat(document.getElementById('hueSlider').value);
    let gR = parseFloat(document.getElementById('gammaRSlider').value);
    let gG = parseFloat(document.getElementById('gammaGSlider').value);
    let gB = parseFloat(document.getElementById('gammaBSlider').value);

    // Update value labels
    document.getElementById('brightnessVal').textContent = brightness.toFixed(2);
    document.getElementById('contrastVal').textContent = contrast.toFixed(2);
    document.getElementById('saturateVal').textContent = saturate.toFixed(2);
    document.getElementById('hueVal').textContent = Math.round(hue) + '°';
    document.getElementById('gammaRVal').textContent = gR.toFixed(2);
    document.getElementById('gammaGVal').textContent = gG.toFixed(2);
    document.getElementById('gammaBVal').textContent = gB.toFixed(2);

    // Update SVG gamma filter per channel
    document.getElementById('gammaR').setAttribute('exponent', gR);
    document.getElementById('gammaG').setAttribute('exponent', gG);
    document.getElementById('gammaB').setAttribute('exponent', gB);

    // Apply combined CSS filter
    const viewer = document.getElementById('viewer');
    const gammaActive = gR !== 1 || gG !== 1 || gB !== 1;
    const isDefault = brightness === 1 && contrast === 1 && saturate === 1 && hue === 0 && !gammaActive;
    if (isDefault) {
        viewer.style.filter = '';
    } else {
        const parts = [];
        if (gammaActive) parts.push('url(#gammaFilter)');
        if (brightness !== 1) parts.push(`brightness(${brightness})`);
        if (contrast !== 1) parts.push(`contrast(${contrast})`);
        if (saturate !== 1) parts.push(`saturate(${saturate})`);
        if (hue !== 0) parts.push(`hue-rotate(${hue}deg)`);
        viewer.style.filter = parts.join(' ');
    }

    // Clear active preset highlight if user manually changed a slider
    if (!fromChannel || fromChannel === true) {
        activePresetId = null;
        document.querySelectorAll('.display-preset-btn').forEach(b => b.classList.remove('active'));
    }
}

function applyPreset(presetId) {
    const p = IHC_PRESETS.find(x => x.id === presetId);
    if (!p) return;
    document.getElementById('brightnessSlider').value = p.brightness;
    document.getElementById('contrastSlider').value = p.contrast;
    document.getElementById('saturateSlider').value = p.saturate;
    document.getElementById('hueSlider').value = p.hue;
    document.getElementById('gammaRSlider').value = p.gR;
    document.getElementById('gammaGSlider').value = p.gG;
    document.getElementById('gammaBSlider').value = p.gB;

    // Show per-channel gamma if channels differ
    if (p.gR !== p.gG || p.gG !== p.gB) {
        document.getElementById('channelGroup').classList.add('visible');
        document.getElementById('channelArrow').classList.add('open');
    }

    activePresetId = presetId;
    document.querySelectorAll('.display-preset-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.preset === presetId);
    });

    updateDisplayFilters('preset');
}

function resetDisplaySettings() {
    document.getElementById('brightnessSlider').value = 1;
    document.getElementById('contrastSlider').value = 1;
    document.getElementById('saturateSlider').value = 1;
    document.getElementById('hueSlider').value = 0;
    document.getElementById('gammaRSlider').value = 1;
    document.getElementById('gammaGSlider').value = 1;
    document.getElementById('gammaBSlider').value = 1;
    activePresetId = null;
    document.querySelectorAll('.display-preset-btn').forEach(b => b.classList.remove('active'));
    updateDisplayFilters('preset');
}

// ── CR Panel ─────────────────────────────────────────────
function toggleCR() {
    const panel = document.getElementById('rightPanel');
    const btn = document.getElementById('btnCR');
    const handle = document.getElementById('resizeHandleRight');
    const isVisible = panel.classList.contains('visible');

    if (isVisible) {
        panel.classList.remove('visible');
        btn.classList.remove('active');
        handle.classList.remove('visible');
    } else {
        // Close annotation panel if open
        if (state.annMode) toggleAnnotationMode();
        const iframe = document.getElementById('crIframe');
        if (!iframe.src || iframe.src === '' || iframe.src === window.location.href) {
            iframe.src = _url('/static/cr_placenta.html');
        }
        panel.classList.add('visible');
        btn.classList.add('active');
        handle.classList.add('visible');
    }
    if (state.osdViewer) setTimeout(() => state.osdViewer.viewport.resize(), 300);
}

// ── Sidebar Resize ───────────────────────────────────────
(function() {
    const handle = document.getElementById('resizeHandle');
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('dragOverlay');
    const MIN_W = 140, MAX_W = 600;
    let dragging = false, startX, startW;
    function startDrag(x) {
        dragging = true; startX = x; startW = sidebar.offsetWidth;
        handle.classList.add('dragging'); overlay.classList.add('active');
    }
    function doDrag(x) {
        if (!dragging) return;
        const w = Math.min(MAX_W, Math.max(MIN_W, startW + (x - startX)));
        sidebar.style.width = w + 'px'; sidebar.style.minWidth = w + 'px';
    }
    function stopDrag() {
        if (!dragging) return;
        dragging = false; handle.classList.remove('dragging'); overlay.classList.remove('active');
        if (state.osdViewer) setTimeout(() => state.osdViewer.viewport.resize(), 50);
    }
    handle.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX); });
    document.addEventListener('mousemove', (e) => doDrag(e.clientX));
    document.addEventListener('mouseup', stopDrag);
    overlay.addEventListener('mousemove', (e) => doDrag(e.clientX));
    overlay.addEventListener('mouseup', stopDrag);
    handle.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientX), { passive: true });
    document.addEventListener('touchmove', (e) => { if (dragging) doDrag(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend', stopDrag);
})();

// ── Right Panel Resize ───────────────────────────────────
(function() {
    const handle = document.getElementById('resizeHandleRight');
    const crPanel = document.getElementById('rightPanel');
    const annPanel = document.getElementById('annPanel');
    const overlay = document.getElementById('dragOverlay');
    const MIN_W = 280, MAX_W = 900;
    let dragging = false, startX, startW, activePanel;

    function getActivePanel() {
        if (annPanel.classList.contains('visible')) return annPanel;
        if (crPanel.classList.contains('visible')) return crPanel;
        return null;
    }

    function startDrag(x) {
        activePanel = getActivePanel();
        if (!activePanel) return;
        dragging = true; startX = x; startW = activePanel.offsetWidth;
        handle.classList.add('dragging'); overlay.classList.add('active');
        activePanel.classList.add('no-transition');
    }
    function doDrag(x) {
        if (!dragging || !activePanel) return;
        const w = Math.min(MAX_W, Math.max(MIN_W, startW - (x - startX)));
        activePanel.style.width = w + 'px'; activePanel.style.minWidth = w + 'px';
    }
    function stopDrag() {
        if (!dragging) return;
        dragging = false; handle.classList.remove('dragging'); overlay.classList.remove('active');
        if (activePanel) activePanel.classList.remove('no-transition');
        if (state.osdViewer) setTimeout(() => state.osdViewer.viewport.resize(), 50);
    }
    handle.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX); });
    document.addEventListener('mousemove', (e) => doDrag(e.clientX));
    document.addEventListener('mouseup', stopDrag);
    overlay.addEventListener('mousemove', (e) => doDrag(e.clientX));
    overlay.addEventListener('mouseup', stopDrag);
    handle.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientX), { passive: true });
    document.addEventListener('touchmove', (e) => { if (dragging) doDrag(e.touches[0].clientX); }, { passive: true });
    document.addEventListener('touchend', stopDrag);
})();

// ── URL params & focused mode ────────────────────────────
(function() {
    const params = new URLSearchParams(window.location.search);
    const root = params.get('root');
    const slidePath = params.get('slide');
    if (root) document.getElementById('rootInput').value = root;

    if (root && slidePath) {
        document.querySelector('.folder-input-group').style.display = 'none';
        document.querySelector('.sidebar').style.display = 'none';
        document.querySelector('.resize-handle').style.display = 'none';
        state._autoSlide = slidePath;
    }
})();

// ── Auto-load ────────────────────────────────────────────
if (document.getElementById('rootInput').value.trim()) {
    loadCases().then(() => {
        if (state._autoSlide && state.cases.length) selectCase(0);
    });
}
