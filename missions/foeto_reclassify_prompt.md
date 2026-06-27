# Reclassification des termes FOETO — Prompt Qwen

## Contexte

Base de terminologie fœtopathologique (`syndromes_foetaux.db`), table `foeto_terms` (3509 termes).
Chaque terme décrit un signe histologique observé en fœtopathologie (autopsie fœtale et examen du placenta).

Une nouvelle classification `type_new` a été créée avec 9 catégories. 3208 termes sont déjà classés. Il reste deux étapes.

---

## Étape 1 — Tri des 301 termes « trophisme » non classés

Ces 301 termes ont `type_new IS NULL` (anciennement `type_patho = 'trophisme'`). Classe chacun dans une des 9 catégories :

| Code | Label | Critères |
|------|-------|----------|
| MAL | Malformation | Anomalie innée de développement (agénésie, atrésie, malposition congénitale) |
| DYS | Dysplasie | Anomalie innée de différenciation tissulaire |
| CLA | Clastique | Lésion destructrice acquise in utero (nécrose, atrophie secondaire, destruction tissulaire) |
| VAS | Vasculaire | Lésion d'origine vasculaire/ischémique/thrombotique (infarctus, thrombose, fibrose ischémique, MVM, VTF, calcification vasculaire) |
| RET | Rétention | Signe de rétention in utero / MFIU / autolyse post-mortem |
| INF | Inflammatoire | Infection ou réaction immunitaire (infiltrat, villite, chorioamniotite) |
| MET | Métabolique | Maladie de surcharge, trouble métabolique |
| TUM | Tumoral | Néoplasie, prolifération tumorale |
| NOR | Normal/Maturation | Histologie normale, variante de la maturation, architecture descriptive |

### Consignes

- Un terme = un seul type. En cas d'ambiguïté, choisis le mécanisme **primaire** (ex. « fibrose myocardique cicatricielle » → VAS car séquelle ischémique, pas CLA).
- Les lésions vasculaires acquises (thrombose, infarctus, fibrose de remplacement, calcifications artérielles/myocardiques) → **VAS**.
- Les lésions de destruction tissulaire sans cause vasculaire claire (nécrose hémorrhagique, amincissement cortical, gliose réactionnelle) → **CLA**.
- Les descriptions d'histologie normale ou de maturation (calibre normal, architecture physiologique) → **NOR**.

### Format de sortie attendu

```sql
UPDATE foeto_terms SET type_new = 'VAS' WHERE id = 'FOETO:XXXXXXX';
UPDATE foeto_terms SET type_new = 'CLA' WHERE id = 'FOETO:YYYYYYY';
...
```

### Données

Les 301 termes à classer (id|label_fr|organe) :

```
{{COLLER ICI LE CONTENU DE /tmp/trophisme_301.txt}}
```

---

## Étape 2 — Vérification de TOUS les 3509 termes

Après l'étape 1, vérifie la cohérence de la classification complète. Pour chaque terme dont le `type_new` te semble **incorrect**, produis une correction.

### Requête pour extraire les termes classés

```sql
SELECT id, label_fr, organe, type_patho, type_new
FROM foeto_terms
ORDER BY type_new, organe, label_fr;
```

### Erreurs typiques à chercher

1. **Lésions vasculaires classées CLA** — ex. « infarctus rénal » en CLA devrait être VAS
2. **Lésions inflammatoires classées CLA** — ex. « abcès cérébral » en CLA devrait être INF
3. **Architecture/maturation classée MAL** — ex. « maturation pulmonaire accélérée » en MAL devrait être NOR
4. **Signes de rétention classés VAS ou CLA** — ex. « autolyse hépatique » en CLA devrait être RET
5. **Malformations classées DYS ou inversement** — agénésie = MAL, anomalie de différenciation = DYS
6. **Termes MVM/VTF non classés VAS** — tous les termes de malperfusion maternelle ou fœtale vasculaire → VAS
7. **Termes infectieux classés INF vs CLA** — abcès, granulome infectieux → INF même si destructeur

### Format de sortie attendu

```sql
-- [RAISON] label_fr (organe) : ancien_type → nouveau_type
UPDATE foeto_terms SET type_new = 'VAS' WHERE id = 'FOETO:XXXXXXX';
...
```

Si un terme est correctement classé, ne rien produire pour celui-ci.

---

## Tables de référence en base

```sql
-- Codes organes
SELECT * FROM foeto_organ_codes;
-- organe|code|domain : placenta|PLA|PP, cordon|COR|PP, membranes|MEM|PP, parenchyme|PAR|PP,
-- cerveau|CER|PF, coeur|COE|PF, digestif|DIG|PF, endocrine|END|PF, foie|FOI|PF,
-- genital|GEN|PF, hematolymphoide|HEM|PF, multi_organe|MUL|PF, muscle|MUS|PF,
-- oeil_oreille|ORL|PF, peau|PEA|PF, poumon|POU|PF, rein|REN|PF, squelette|SQU|PF

-- Codes types pathologiques
SELECT * FROM foeto_type_codes;
-- MAL|Malformation, DYS|Dysplasie, CLA|Clastique, VAS|Vasculaire,
-- RET|Rétention, INF|Inflammatoire, MET|Métabolique, TUM|Tumoral, NOR|Normal/Maturation
```
