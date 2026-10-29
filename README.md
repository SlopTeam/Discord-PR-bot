# Discord PR Bot

Poste dans un salon Discord les pull requests ouvertes de plusieurs repos GitHub (SlopBattle back, front, puis back-office), et les tient à jour :

- PR ouverte, rouverte ou sortie de draft : un embed est posté (couleur et libellé par repo).
- PR renommée : l'embed est mis à jour.
- PR fermée, mergée ou repassée en draft : l'embed est supprimé.
- Review : ✅ approuvée, ❌ changements demandés, 💬 commentaire. Une approbation annulée retire le ✅.
- À chaque événement de PR, le bot resynchronise le repo concerné (PR manquantes ajoutées, PR fermées retirées).

Le bot n'utilise que l'API REST de Discord (pas de connexion permanente), donc il tourne très bien sur Cloud Run, qui s'éteint quand il n'y a pas de webhook.

## Ajouter un repo

Tout se passe dans `repos.json` :

```json
{
  "repos": {
    "SlopTeam/SlopBattle-back": { "label": "Back", "colour": "#E67E22" },
    "SlopTeam/SlopBattle-front": { "label": "Front", "colour": "#3498DB" },
    "SlopTeam/SlopBattle-backoffice": { "label": "Back-office", "colour": "#9B59B6" }
  }
}
```

Options par repo, toutes facultatives :

| Clé | Rôle | Défaut |
| --- | --- | --- |
| `label` | Nom affiché dans l'embed | nom du repo |
| `colour` | Couleur de l'embed | `#5865F2` |
| `channelId` | Salon Discord dédié à ce repo | `CHANNEL_ID` |
| `mentionRoleId` | Rôle Discord à mentionner à chaque nouvelle PR | aucun |

Sur Cloud Run, on peut aussi passer ce JSON dans la variable `REPOS_JSON`, qui remplace alors le fichier.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `DISCORD_TOKEN` | Token du bot Discord |
| `CHANNEL_ID` | Salon par défaut |
| `GITHUB_TOKEN` | Token GitHub en lecture sur les pull requests (obligatoire pour un repo privé) |
| `GITHUB_WEBHOOK_SECRET` | Secret partagé avec le webhook GitHub |
| `PORT` | Port HTTP, 8080 par défaut (Cloud Run le fournit) |
| `DISCORD_GATEWAY` | `true` pour que le bot reste affiché en ligne. Il passe en « Ne pas déranger » avec le message d'erreur quand un webhook échoue, et redevient en ligne au succès suivant. Il faut alors un hébergement allumé en permanence (voir plus bas). |

### Garder le bot en ligne (`DISCORD_GATEWAY=true`)

Sur Cloud Run, ajoute `--min-instances 1 --no-cpu-throttling --cpu 1` au déploiement et `DISCORD_GATEWAY=true` dans `--set-env-vars`, sinon l'instance s'endort et le bot apparaît hors ligne. Cette instance allumée en continu n'est plus gratuite : compte quelques dizaines d'euros par mois selon la région. Pour rester gratuit, fais tourner le même conteneur sur une VM e2-micro (offre gratuite, régions us-west1, us-central1 ou us-east1) ou sur ton serveur Proxmox/Portainer.

## Lancer en local

```bash
cp .env.example .env   # puis remplir
npm install
npm run discord:login  # une seule fois, voir plus bas
npm start
```

## Déploiement sur le serveur (Portainer)

C'est le déploiement retenu : voir [portainer/README.md](portainer/README.md).

## Alternative : Google Cloud Run

### 1. Préparer Discord

1. Sur https://discord.com/developers/applications, crée l'application, onglet Bot, copie le token.
2. Invite le bot avec ce lien (remplace `CLIENT_ID`) : `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=85056`. Ça donne : voir le salon, envoyer des messages, intégrer des liens, lire l'historique, ajouter des réactions.
3. Active le mode développeur de Discord, clic droit sur le salon, « Copier l'identifiant » : c'est `CHANNEL_ID`.
4. Lance `npm run discord:login` une fois en local avec le token dans `.env`. Discord refuse qu'un bot poste tant qu'il ne s'est jamais connecté au gateway, et le bot déployé ne s'y connecte pas.

### 2. Préparer GitHub

1. Crée un fine-grained token (Settings, Developer settings, Personal access tokens, Fine-grained) : propriétaire `SlopTeam`, repos concernés (ou « All repositories » pour ne pas y revenir avec le back-office), permission **Pull requests : Read-only**. Si l'organisation exige une validation des tokens, un owner devra l'approuver.
2. Génère un secret de webhook : `openssl rand -hex 32`.

### 3. Préparer le projet GCP

Installe le SDK (https://cloud.google.com/sdk/docs/install), puis :

```bash
gcloud auth login
gcloud projects create slopbattle-pr-bot          # ou un projet existant
gcloud config set project slopbattle-pr-bot
# Lier un compte de facturation dans la console (obligatoire, même pour le gratuit)
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

### 4. Stocker les secrets

```bash
printf '%s' 'TOKEN_DISCORD' | gcloud secrets create discord-token --data-file=-
printf '%s' 'TOKEN_GITHUB'  | gcloud secrets create github-token --data-file=-
printf '%s' 'SECRET_WEBHOOK' | gcloud secrets create github-webhook-secret --data-file=-

PROJECT_NUMBER=$(gcloud projects describe $(gcloud config get-value project) --format='value(projectNumber)')
gcloud projects add-iam-policy-binding $(gcloud config get-value project) \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/secretmanager.secretAccessor
```

Sous PowerShell, remplace les `\` de fin de ligne par des backticks.

### 5. Déployer

Depuis le dossier du bot :

```bash
gcloud run deploy discord-pr-bot \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --min-instances 0 --max-instances 1 \
  --memory 256Mi \
  --set-env-vars CHANNEL_ID=ID_DU_SALON \
  --set-secrets DISCORD_TOKEN=discord-token:latest,GITHUB_TOKEN=github-token:latest,GITHUB_WEBHOOK_SECRET=github-webhook-secret:latest
```

`--max-instances 1` est voulu : les webhooks sont traités un par un dans une seule instance, ce qui évite les messages en double. La commande affiche l'URL du service (`https://discord-pr-bot-xxxx.europe-west1.run.app`).

### 6. Brancher le webhook GitHub

Le plus simple est un webhook d'organisation, qui couvre tous les repos de SlopTeam, y compris le back-office quand il existera : `https://github.com/organizations/SlopTeam/settings/hooks`, « Add webhook ».

- Payload URL : l'URL Cloud Run
- Content type : `application/json` (important, la signature est vérifiée sur ce format)
- Secret : le secret de l'étape 2
- Events : « Let me select individual events », coche **Pull requests**, **Pull request reviews**, **Pull request review comments**, **Issue comments**

Les repos absents de `repos.json` sont ignorés (réponse 202), donc le webhook d'org ne pose pas de souci.

GitHub envoie un ping à la création. Dans « Recent Deliveries », il doit répondre 200 `pong`.

### 7. Vérifier

```bash
gcloud run services logs read discord-pr-bot --region europe-west1 --limit 50
```

Ouvre une PR de test : elle doit apparaître dans le salon.

### Mettre à jour

Après une modif du code ou de `repos.json`, relance la même commande `gcloud run deploy` (les variables et secrets sont conservés, tu peux omettre `--set-env-vars` et `--set-secrets`).

### Coût

Avec le volume d'une équipe, ça reste dans le niveau gratuit de Cloud Run, Cloud Build, Artifact Registry et Secret Manager. Pour être tranquille, crée une alerte de budget à quelques euros dans Facturation, Budgets et alertes.
