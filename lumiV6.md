# MISSION — Labellisation rapide des lames

**Composant** : FoetoPath Viewer V5 (Lumi)
**Objectif** : Rendre le labeling slide-level trivial — 3 clics pour une lame normale, 5-8 pour une lame pathologique.
**Principes** : Le panneau droit devient un outil de travail lame. Le labeling est l'activité primaire, l'annotation spatiale est secondaire.

---

## 0. Contexte diagnostique

"Normal" est un **acte diagnostique positif** : j'ai examiné cette lame, cet organe est dans les limites de la normale. Ce n'est pas une absence de pathologie, c'est une conclusion médicale active.

Trois états par organe sur une lame :

| État | Signification | Représentation |
|------|--------------|----------------|
| **Non examiné** | Pas encore vu / pas d'avis | Aucune entrée en base |
| **Normal** | Examiné, RAS — acte diagnostique actif | `organ_status.status = 'normal'` |
| **Pathologique** | Examiné, signes présents | `organ_status.status = 'patho'` + entrées `diagnoses` |

En fœtopathologie, c'est **une lame = un organe** (sauf rares exceptions). Pas de persistance d'organe d'une lame à l'autre — chaque lame part en gris.

---

## 1. Schéma DB — ajouts à `lames.db`

### 1.1. Table `organ_status` (nouvelle)

```sql
CREATE TABLE IF NOT EXISTS organ_status (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slide_id    TEXT NOT NULL REFERENCES slides(slide_id) ON DELETE CASCADE,
    organ       TEXT NOT NULL,
    status      TEXT NOT NULL CHECK(status IN ('normal', 'patho')),
    created_at  TEXT NOT NULL,
    UNIQUE(slide_id, organ)
);
CREATE INDEX IF NOT EXISTS idx_organ_status_slide ON organ_status(slide_id);
```

L'absence de ligne = non examiné. Une ligne `normal` = acte diagnostique. Une ligne `patho` = au moins un signe dans `diagnoses`.

### 1.2. Table `slide_notes` (nouvelle)

```sql
CREATE TABLE IF NOT EXISTS slide_notes (
    slide_id    TEXT PRIMARY KEY REFERENCES slides(slide_id) ON DELETE CASCADE,
    note        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

Une note par lame (pas par diagnostic). Texte libre, compact.

### 1.3. Table `diagnoses` (existante, inchangée)

La table `diagnoses` existante (`slide_id`, `diagnosis`, `created_at`) reste intacte. Un diagnostic est un `foeto_term.id` associé à la lame. La relation avec l'organe est implicite via `organ_status` de la même lame.

### 1.4. Migrations

Dans `database.py`, ajouter les deux `CREATE TABLE IF NOT EXISTS` au `SCHEMA` existant. Pas de migration destructive — les tables sont nouvelles.

---

## 2. API — nouvelles routes

### 2.1. `GET /api/slide/label-status?slide_id=...`

Retourne l'état de labellisation complet d'une lame :

```json
{
  "organs": [
    {"organ": "rein", "status": "patho"}
  ],
  "diagnoses": ["FOETO_042", "FOETO_078"],
  "note": "Nécrose tubulaire focale, à corréler avec biométrie",
  "labeled": true
}
```

`labeled` = true si au moins un `organ_status` existe (l'utilisateur a pris position).

### 2.2. `POST /api/slide/label-save`

Payload :

```json
{
  "slide_id": "lame_HE_rein",
  "organs": [
    {"organ": "rein", "status": "normal"}
  ],
  "diagnoses": [],
  "note": ""
}
```

Logique :
- UPSERT `organ_status` pour chaque organe
- DELETE + INSERT `diagnoses` pour cette lame (remplacement complet, comme le save actuel)
- UPSERT `slide_notes` si note non vide, DELETE si vide
- Retourne `{"ok": true, "labeled": true}`

### 2.3. `GET /api/slides/similar?diagnosis=FOETO_042&root=...`

Retourne les lames partageant le même signe :

```json
{
  "diagnosis": "FOETO_042",
  "label": "Nécrose tubulaire aiguë",
  "slides": [
    {"slide_id": "...", "folder": "...", "filename": "...", "organs": ["rein"]}
  ]
}
```

`JOIN diagnoses ON diagnosis` + `JOIN slides` pour le path. Le thumbnail sera résolu côté front via `/api/slide/thumbnail?path=...`.

### 2.4. `GET /api/slides/label-summary?folder=...`

Pour les badges carousel — retourne le statut de labellisation de toutes les lames d'un cas :

```json
{
  "statuses": {
    "lame_HE_rein": "labeled",
    "lame_HE_poumon": "unlabeled",
    "lame_HE_foie": "labeled"
  }
}
```

`labeled` = au moins un `organ_status`. Le front fait la couleur (vert/gris).

---

## 3. Frontend — refactoring du panneau droit

### 3.1. Deux onglets

Le panneau droit (`#rightPanel`) gagne deux onglets en barre haute :

| Onglet | Contenu | Activation |
|--------|---------|------------|
| **Labellisation** | Fiche lame (organe, statut, signes, note) | Par défaut à l'ouverture d'une lame |
| **Annotation** | Dessin polygone, classes LDA, liste annotations | Clic sur onglet OU via menu contextuel OSD "Annoter ici →" |

Le domain toggle (Placenta / Fœtus) **monte au-dessus des onglets** — il conditionne le contenu des deux onglets.

Le contenu actuel du panneau d'annotation (canvas overlay, annotation list, mesures) migre dans l'onglet Annotation sans modification fonctionnelle.

### 3.2. Onglet Labellisation — layout

```
┌─────────────────────────────────┐
│ [Placenta] [Fœtus]             │  ← domain toggle (existant, remonté)
├─────────────────────────────────┤
│ [● Labellisation] [○ Annoter]  │  ← onglets
├─────────────────────────────────┤
│                                 │
│  Organe(s)                      │
│  [Cerveau] [Cœur] [Poumon] ... │  ← pills, GRIS à chaque lame
│                                 │
│  ── Statut ──────────────────── │
│  [✓ Normal]  [✗ Pathologique]  │  ← toggle par organe sélectionné
│                                 │
│  ── Signes (si patho) ───────── │
│  [NTA] [Dysplasie] [CRG] ...  │  ← quick picks top-5
│  [____________________🔍]       │  ← autocomplete dès 3 lettres
│  ✓ FOETO_042 Nécrose tubul.    │  ← signes sélectionnés (toggleable)
│  ✓ FOETO_078 Glomérulosclérose │
│                                 │
│  ── Rétention Genest ────────── │
│  [Pycnose] [Autolyse cort.] ...│  ← pills Genest (si fœtus)
│                                 │
│  ── Note ────────────────────── │
│  [Texte libre, 2 lignes    ]   │
│                                 │
│  [💾 Sauver]    [W: Normal →]  │  ← Ctrl+S / raccourci W
└─────────────────────────────────┘
```

### 3.3. Comportement du toggle Normal / Patho

- **Au chargement d'une lame** : organes non sélectionnés (gris), pas de toggle visible.
- **À la sélection d'un organe** : le toggle Normal / Patho apparaît. Si un `organ_status` existe en base, il est pré-chargé.
- **Clic "Normal"** : enregistre l'acte diagnostique. Les sections Signes/Rétention restent masquées (ou grisées). Le bouton Normal est vert plein.
- **Clic "Pathologique"** : ouvre les sections Signes et Rétention. Le bouton Patho est rouge plein.
- **Switch** : passer de Patho → Normal efface les signes sélectionnés pour cet organe (avec confirmation si des signes étaient cochés).

### 3.4. Autocomplete signes

- Champ texte avec filtre `oninput` après 3 caractères minimum
- Source : `foeto_terms` axe `pathologie` filtré sur l'organe sélectionné (déjà disponible via `/api/foeto/terms?organs=...`)
- Résultats en dropdown sous le champ, clic pour toggle
- Signes sélectionnés affichés sous le champ en pills avec `×` pour retirer

### 3.5. Raccourci W — Normal + Next

1. Vérifie qu'au moins un organe est sélectionné → sinon toast d'erreur
2. Marque `status = 'normal'` pour chaque organe sélectionné
3. Sauvegarde via `/api/slide/label-save`
4. Passe à la lame suivante (`navNext()`)
5. Reset complet du panneau (organes dé-sélectionnés, toggle masqué)

### 3.6. Carousel badges

Sur chaque thumbnail du carousel, un indicateur visuel :

```css
.carousel-item::after {
    content: '';
    position: absolute;
    bottom: 4px;
    right: 4px;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--badge-color, #555);  /* gris = non labelisé */
}
.carousel-item.labeled::after {
    background: #27ae60;  /* vert = labelisé */
}
```

Le statut est chargé en batch via `/api/slides/label-summary?folder=...` au `selectCase()`, puis `labeled` est mis à jour localement après chaque save sans re-fetch.

---

## 4. Menu contextuel OSD (clic droit)

### 4.1. Capture

```javascript
document.getElementById('viewer').addEventListener('contextmenu', e => {
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e.clientX, e.clientY);
});
```

### 4.2. Contenu du menu

Le menu est un `<div>` positionné `fixed` à `(clientX, clientY)`, fermé au clic extérieur ou Escape.

| Entrée | Action |
|--------|--------|
| **✓ Normal** | Raccourci W (normal + save + next) |
| Quick pick 1 | Toggle le signe (le + fréquent de l'organe courant) |
| Quick pick 2 | Toggle |
| Quick pick 3 | Toggle |
| --- | séparateur |
| **Annoter ici →** | Switch onglet Annotation + active le mode dessin |
| **Lames similaires →** | Ouvre la gallery si un signe est sélectionné |
| **Note...** | Focus sur le textarea de note |

Les quick picks ne sont affichés que si un organe est sélectionné et le statut est "patho". Si aucun organe n'est sélectionné, le menu affiche seulement les entrées structurelles.

### 4.3. Fermeture

- Clic en dehors du menu
- Touche Escape
- Sélection d'une entrée (sauf toggle signes, qui garde le menu ouvert)

---

## 5. Gallery "Lames similaires"

### 5.1. Déclenchement

- Clic sur un signe sélectionné dans le panneau → bouton "Voir les lames avec ce signe"
- Menu contextuel OSD → "Lames similaires →"
- Désactivé si aucun signe n'est sélectionné

### 5.2. UI

`<dialog>` modal avec :

```
┌─────────────────────────────────────────────┐
│  Lames avec : Nécrose tubulaire aiguë       │
│  (FOETO_042) — 7 lames                   [×]│
├─────────────────────────────────────────────┤
│  ┌─────┐  ┌─────┐  ┌─────┐  ┌─────┐       │
│  │ th. │  │ th. │  │ th. │  │ th. │       │
│  │     │  │     │  │     │  │     │       │
│  └─────┘  └─────┘  └─────┘  └─────┘       │
│  Case_042  Case_042  Case_089  Case_089     │
│  HE_rein   PAS_rein  HE_rein   Trich_rein  │
│                                              │
│  ┌─────┐  ┌─────┐  ┌─────┐                 │
│  │ th. │  │ th. │  │ th. │                 │
│  └─────┘  └─────┘  └─────┘                 │
│  Case_112  Case_145  Case_201               │
│  HE_rein   HE_rein   HE_rein               │
└─────────────────────────────────────────────┘
```

- Thumbnails chargés via `/api/slide/thumbnail?path=...`
- Clic sur une vignette → navigation directe : `loadSlide()` avec le path correspondant (si même cas) ou chargement du cas + lame (si cas différent)
- Grille responsive CSS Grid (`auto-fill, minmax(120px, 1fr)`)
- Fermé par `×`, Escape, ou clic sur backdrop

---

## 6. Plan PITU

### Phase 1 — Schéma + API + refactoring panneau (fondation)

- Ajouter `organ_status` et `slide_notes` dans `database.py`
- Fonctions CRUD dans `database.py` : `upsert_organ_status()`, `get_organ_statuses()`, `upsert_slide_note()`, `get_slide_note()`, `get_label_summary()`
- Routes API : `/api/slide/label-status`, `/api/slide/label-save`, `/api/slides/label-summary`
- Refactoring front : split panneau droit en 2 onglets (Labellisation / Annotation)
- Onglet Labellisation : organe pills + toggle Normal/Patho + save
- Reset organes à chaque changement de lame

### Phase 2 — Signes + autocomplete + workflow rapide

- Quick picks dans l'onglet Labellisation (top-5 par organe, déjà dispo via API)
- Autocomplete dès 3 lettres (filtre sur `/api/foeto/terms`)
- Note libre (textarea + persist `slide_notes`)
- Raccourci W (Normal + Save + Next)
- Carousel badges (vert/gris)

### Phase 3 — Menu contextuel OSD

- `contextmenu` handler + div positionné
- Entrées dynamiques (quick picks si organe sélectionné + patho)
- "Annoter ici →" switch onglet + mode dessin
- Fermeture propre (clic dehors, Escape)

### Phase 4 — Gallery lames similaires

- Route `/api/slides/similar`
- `<dialog>` modal avec grille de thumbnails
- Navigation cross-case
- Bouton de déclenchement sur les pills de signes sélectionnés

---

## 7. Ce qui ne change PAS

- Le système d'annotation spatiale (polygones, canvas overlay, GeoJSON) reste intact dans l'onglet Annotation
- Les classes LDA placenta (3 niveaux) restent inchangées
- Les mesures restent inchangées
- Les presets IHC restent inchangés
- Le CR placenta (panneau iframe) reste inchangé
- La route `/api/annotations/report` continue de fonctionner (elle lit les GeoJSON, pas les tables de labelling)
- `concat_report.py` reste inchangé

---

## 8. Risques et points d'attention

**Cohérence Patho ↔ Diagnoses** : si `status = 'patho'` mais 0 signes, c'est un état légitime (l'utilisateur sait que c'est patho mais n'a pas encore spécifié quoi). Ne pas forcer la saisie de signes au save.

**Multi-organe sur une lame** : rare en fœtopath mais possible (ex: lame "bloc multi-organe"). Le schéma le supporte (N entrées `organ_status` par lame), l'UI pills le supporte (multi-sélection). Le toggle Normal/Patho s'applique **par organe sélectionné** — si deux organes sont cochés, les deux toggles sont indépendants.

**Performance carousel badges** : le `/api/slides/label-summary` fait un seul SELECT sur `organ_status` pour tout le cas. Pas de N+1. Le badge est mis à jour localement après save sans re-fetch.

**FRANCINE queue résiduelle** : `francine_queue_bp.py` et `francine_queue.js` sont toujours dans le repo mais débranchés. Les supprimer du repo dans un commit de nettoyage séparé.
