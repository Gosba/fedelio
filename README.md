# Fidélio — cartes de fidélité pour commerçants

Une plateforme à abonnement (29 € / mois par boutique) qui remplace la carte à tampons en carton. Elle compte trois espaces :

| Espace | Adresse | Pour qui |
|---|---|---|
| Administration (accès maintenance) | `/admin` | Vous : créer les boutiques, suivre les abonnements, encaisser, suspendre, ouvrir l'espace d'un commerçant pour l'aider |
| Espace commerçant | `/pro` | Le commerçant : caisse, réglages de la carte, périodes, notifications, affiche |
| Carte client | `/s/nom-de-la-boutique` | Le client : il scanne l'affiche, sa carte s'ouvre sans inscription |

## Démarrer en local

Il faut Node.js 22.5 ou plus récent.

```bash
npm install
ADMIN_PASSWORD=choisissez-un-mot-de-passe npm start
```

Ouvrez ensuite http://localhost:3000/admin. Sans `ADMIN_PASSWORD`, un mot de passe est généré et affiché dans la console au premier lancement.

## Le parcours

1. **Vous** créez la boutique dans `/admin`. La plateforme génère l'identifiant et le mot de passe du commerçant, et ouvre une période d'essai de 14 jours.
2. **Le commerçant** se connecte sur `/pro`, règle sa carte (couleurs, nombre de tampons, récompense), puis imprime l'affiche avec le QR code.
3. **Le client** scanne le QR code. Sa carte est créée de façon anonyme et enregistrée dans son navigateur.
4. **À chaque passage**, deux façons de valider :
   - le client touche « Valider mon passage » et le commerçant tape son code à 4 chiffres sur le téléphone du client ;
   - ou le commerçant saisit (ou scanne) le code carte du client dans l'onglet Caisse.
5. **Quand la carte est pleine**, la récompense se valide de la même façon, puis le compteur repart.
6. **Quand le commerçant paie**, vous cliquez « +1 mois payé » dans `/admin`. Une boutique expirée ou suspendue ne peut plus distribuer de tampons, mais ses clients gardent leurs points.

## Périodes

Le commerçant programme des périodes avec une date de début et une date de fin : points x2 ou x3, objectif ou récompense spécifique, couleur de carte, message. Pendant la période, toutes les cartes changent automatiquement. Une notification peut partir le premier jour.

## Notifications

Elles utilisent le Web Push standard, sans application à installer.
- Android, Chrome, Edge, Firefox : fonctionne directement après acceptation.
- iPhone (iOS 16.4 et plus récent) : le client doit d'abord ajouter la carte à l'écran d'accueil (Partager → « Sur l'écran d'accueil »). La carte le lui explique.
- Le site doit être servi en **HTTPS** (c'est automatique chez les hébergeurs ci-dessous).
- Pour ne pas lasser les clients, un commerçant peut envoyer au maximum 3 messages par jour. Chaque message s'affiche aussi dans les actualités de la carte.

## Données personnelles

La plateforme ne demande ni nom, ni e-mail, ni téléphone aux clients. Elle enregistre seulement un identifiant aléatoire de carte, le nombre de points, les dates de passage et, si le client accepte les notifications, l'adresse technique d'envoi fournie par son navigateur. Côté commerçants, seuls le nom de la boutique, l'e-mail de connexion et l'état de l'abonnement sont conservés. Faites quand même relire vos CGV et mentions légales avant le lancement.

## Mettre en ligne sur Railway

1. **GitHub** : créez un dépôt privé et poussez-y le contenu de ce dossier (sans `node_modules` ni `data`, déjà exclus par `.gitignore`).
2. **Railway** : New Project → *Deploy from GitHub repo* → choisissez le dépôt. Railway détecte Node et lance `npm start` (réglé dans `railway.json`).
3. **Volume (indispensable)** : dans le service, faites clic droit ou ⌘K → *Add Volume*, chemin de montage `/data`. Sans volume, toutes les données sont effacées à chaque redéploiement.
4. **Adresse publique** : Settings → Networking → *Generate Domain*. Vous obtenez `https://xxx.up.railway.app`. Vous pourrez brancher votre propre nom de domaine plus tard, au même endroit.
5. **Variables** : onglet Variables → *Raw Editor*, collez le contenu de `.env.example` et complétez-le (`PUBLIC_URL` = l'adresse de l'étape 4). Railway redéploie automatiquement.
6. Ouvrez `https://xxx.up.railway.app/admin` et connectez-vous avec `ADMIN_PASSWORD`.

Pour sauvegarder les données, Railway propose des *Backups* sur le volume. Activez-les.

## Brancher PayPal

### 1. Tester avec de faux paiements (sandbox)
1. Allez sur **developer.paypal.com** et connectez-vous avec votre compte PayPal.
2. *Apps & Credentials* → onglet **Sandbox** → *Create App* (type Merchant). Copiez le **Client ID** et le **Secret**.
3. Dans Railway, renseignez `PAYPAL_MODE=sandbox`, `PAYPAL_CLIENT_ID` et `PAYPAL_CLIENT_SECRET`.
4. Dans `/admin`, cliquez **« Configurer PayPal automatiquement »**. L'application crée chez PayPal l'offre à 29 € / mois et le webhook qui l'informe de chaque prélèvement.
5. Testez avec une boutique d'essai : onglet *Abonnement & compte* → bouton PayPal. Payez avec le compte acheteur fictif que PayPal fournit dans *Sandbox accounts* (sur developer.paypal.com).

### 2. Passer en réel
1. Sur developer.paypal.com, basculez sur l'onglet **Live** → *Create App* et copiez les nouvelles clés. Votre compte PayPal doit être un compte **Professionnel**.
2. Dans Railway : `PAYPAL_MODE=live` et les clés live.
3. Dans `/admin`, cliquez de nouveau **« Configurer PayPal automatiquement »**. L'offre réelle est distincte de l'offre de test.

### Ce que fait l'application
- Le commerçant s'abonne depuis son espace, avec PayPal ou par carte bancaire.
- Les jours d'essai (ou déjà payés) sont conservés : le premier prélèvement a lieu à la fin de ces jours.
- Chaque prélèvement réussi prolonge l'abonnement automatiquement et apparaît dans l'historique des paiements de la boutique, côté admin.
- Si le commerçant résilie, ou si PayPal arrête l'abonnement après des échecs de paiement, la boutique reste active jusqu'à la fin du mois payé, puis passe en « expirée ».
- « +1 mois payé » reste disponible pour les paiements par virement ou en espèces.

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `ADMIN_PASSWORD` | Mot de passe administrateur (réappliqué à chaque démarrage) | généré au premier lancement |
| `PUBLIC_URL` | Adresse publique utilisée dans les QR codes | adresse de la requête |
| `APP_NAME` | Nom affiché de la plateforme | Fidélio |
| `PRICE_EUR` | Prix mensuel affiché et compté | 29 |
| `TRIAL_DAYS` | Durée de l'essai gratuit | 14 |
| `DATA_DIR` | Dossier de la base de données | `./data` |
| `VAPID_SUBJECT` | Contact déclaré aux services de notification (`mailto:vous@domaine.fr`) | `mailto:contact@example.com` |
| `SECURE_COOKIES` | Mettre `1` en production HTTPS | — |
| `PAYPAL_MODE` | `sandbox` (test) ou `live` (réel) | sandbox |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Clés de l'app PayPal | — |
| `PORT` | Port d'écoute (fourni par Railway) | 3000 |

## Google Wallet (Android)

Le client touche « Ajouter à Google Wallet » sur sa carte. Ses tampons s'y mettent à jour à chaque passage, et les messages du commerçant y apparaissent avec une notification.

1. Sur **pay.google.com/business/console**, créez un compte émetteur Google Wallet (gratuit) et notez l'**Issuer ID**.
2. Sur **console.cloud.google.com**, créez un projet, activez l'**API Google Wallet**, créez un **compte de service** et téléchargez sa clé au format JSON.
3. Dans la console Google Wallet, onglet *Utilisateurs*, invitez l'e-mail du compte de service avec le rôle *Développeur*.
4. Dans Railway, ajoutez `GOOGLE_WALLET_ISSUER_ID` (l'Issuer ID) et `GOOGLE_WALLET_SA_JSON` (le contenu complet du fichier JSON).
5. Tant que Google n'a pas validé votre compte pour la production, seuls les comptes Google ajoutés comme testeurs peuvent enregistrer les cartes. Demandez l'accès production depuis la console.

## Pistes pour la suite

- Prélèvement SEPA avec Stripe, en complément de PayPal.
- E-mail automatique au commerçant à J-5 de l'échéance.
- Plusieurs points de vente pour une même enseigne.
- Apple Wallet (demande l'Apple Developer Program, payant).
