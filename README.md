# PokeScan

Appli Android pour scanner ses cartes Pokémon françaises et suivre sa collection.
Données et prix Cardmarket : [TCGdex](https://tcgdex.dev).

## Installer
1. Onglet **Releases** du dépôt → dernière version → `PokeScan.apk`.
2. Ouvrir le fichier sur le téléphone, autoriser l'installation depuis cette source.
3. Les nouvelles versions s'installent par-dessus sans perdre la collection.

## Mettre à jour
L'appli vérifie au démarrage s'il y a une nouvelle release (bandeau jaune → *Installer*), ou via Stats → *Vérifier les mises à jour*. Nécessite un dépôt **public**.

## Utiliser
- **Collection** → choisir une extension → *Activer le scan* (télécharge empreintes + prix, à faire une fois par extension, en wifi).
- **Scan** → poser la carte dans le rectangle jaune : bords détectés (contour vert), numéro lu en bas de carte, reconnaissance automatique, toucher la carte proposée pour l'ajouter (5 choix si doute après 3 s). Image anglaise utilisée si l'image FR manque.
- Toucher une carte (classeur, toast après scan) pour régler variante, état, quantité, note (1ère éd., Shadowless, tampon, PSA…).
- **Stats** → valeur, doublons, coefficients de prix par état, export CSV, sauvegarde / restauration.

## Dev
`www/` = l'appli (HTML/JS sans framework) : `core.js` (stockage, collection, fiche carte), `scan.js` (caméra, reconnaissance, session, page de classeur, ajout rapide), `views.js` (écrans), `fp.js` (empreintes), `logic.js` (tris, boosters, succès, decks, QR), `fun.js` (decks, vitrine, échange QR), `vision.js` (OpenCV + Tesseract). Tests : `npm test`. Librairies copiées dans `www/vendor` par `npm run vendor`.
`native/` = code Android (mise à jour intégrée, widget, icônes), appliqué par `native/patch_android.py` dans le workflow.
Chaque push sur `main` compile l'APK (GitHub Actions) et publie une release.
