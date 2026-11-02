## LokTake — revue des rendus HyperFrames

Après chaque rendu HyperFrames réussi (`npx hyperframes render`, `npm run render`…) :

1. Lance LokTake sur le projet, ou réutilise celui qui tourne déjà :
   `node ~/Projets/loktake/bin/loktake.js "<dossier du projet HyperFrames>" --background --no-open`
   La commande rend la main tout de suite et affiche une adresse `http://127.0.0.1:8093/#/p/…`.
2. Ouvre exactement cette adresse dans le navigateur intégré de l'app Claude, pour que la vidéo
   s'affiche à côté de la conversation. Si un onglet LokTake est déjà ouvert, recharge-le :
   le nouveau rendu s'y ouvre automatiquement.
3. Ne démarre jamais un second serveur et n'ouvre pas LokTake dans un autre navigateur.

Quand je colle un texte qui commence par « # Retours vidéo — » (copié depuis LokTake) :
applique les demandes de la section « Demandes de modification du code source » dans le code
HyperFrames, sans toucher aux sections marquées « ne pas modifier ». Les « Coupes faites sur le MP4
uniquement » n'ont pas modifié le code : reporte-les dans le code seulement si je le demande. Réponds
en citant chaque identifiant LT-…, puis relance un rendu sous un nouveau nom de fichier
(v02, v03…) pour que les versions restent comparables.
