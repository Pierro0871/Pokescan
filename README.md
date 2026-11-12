# PokeScan

Appli Android pour scanner ses cartes Pokémon françaises et suivre sa collection.
Données et prix Cardmarket : [TCGdex](https://tcgdex.dev).

## Installer
1. Onglet **Releases** du dépôt → dernière version → `PokeScan.apk`.
2. Ouvrir le fichier sur le téléphone, autoriser l'installation depuis cette source.
3. Les nouvelles versions s'installent par-dessus sans perdre la collection.

## Utiliser
- **Collection** → choisir une extension → *Activer le scan* (télécharge empreintes + prix, à faire une fois par extension, en wifi).
- **Scan** → poser la carte dans le rectangle jaune : reconnaissance automatique, toucher la carte proposée pour l'ajouter (5 choix si doute après 3 s). Image anglaise utilisée si l'image FR manque.
- Toucher une carte (classeur, toast après scan) pour régler variante, état, quantité, note (1ère éd., Shadowless, tampon, PSA…).
- **Stats** → valeur, doublons, coefficients de prix par état, export CSV, sauvegarde / restauration.

## Dev
`www/` = l'appli (HTML/JS sans framework), `www/fp.js` = empreintes et calculs (testés par `npm test`).
Chaque push sur `main` compile l'APK (GitHub Actions) et publie une release.
