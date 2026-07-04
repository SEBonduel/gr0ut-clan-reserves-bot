# GR0UT — Bot d'activation des réserves de clan (Discord + Cloudflare Workers)

Un salon Discord avec des **boutons** pour activer les **réserves de clan** WoT
(crédits, XP, XP équipage, XP libre…) sans passer par le jeu. Réservé aux
**officiers** (contrôle par rôle Discord). Hébergement **gratuit** et *serverless*
via Cloudflare Workers.

> ⚠️ Les réserves sont une ressource **limitée** du clan. Chaque activation en
> consomme une : les boutons sont donc restreints à un rôle d'officiers et une
> **confirmation** est demandée avant toute activation.

## Comment ça marche

- **Cloudflare Worker** = endpoint HTTPS qui reçoit les clics de boutons Discord,
  vérifie le rôle, et appelle l'API Wargaming (`activateclanreserve`).
- **Auth WG** : un officier se connecte **une fois** via un lien ; son
  `access_token` est stocké (chiffré) dans Cloudflare KV et **renouvelé
  automatiquement** chaque jour (cron `prolongate`) pour ne jamais expirer.

## Prérequis à récupérer (toi)

| Valeur | Où |
|---|---|
| `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_TOKEN` | https://discord.com/developers/applications → *New Application* → onglet *Bot* (token) et *General Information* (App ID + Public Key) |
| `GUILD_ID` | Discord (mode développeur activé) → clic droit sur le serveur → *Copier l'identifiant* |
| `OFFICER_ROLE_IDS` | Paramètres serveur → Rôles → clic droit sur chaque rôle officier → *Copier l'identifiant* (plusieurs, séparés par des virgules) |
| `WG_APP_ID` | `00eed50e0468215e87ec936f17c52d8f` (déjà créé) |
| `CLAN_ID` | `500165786` (GR0UT) |
| `LOGIN_SECRET` | invente une chaîne aléatoire (protège le lien de login) |

## Installation pas à pas

### 1. Cloudflare
```bash
npm install
npx wrangler login                       # ouvre le navigateur
npx wrangler kv namespace create TOKENS  # copie l'id renvoyé
```
Colle l'id dans `wrangler.toml` (`id = "..."`).

### 2. Secrets
```bash
npx wrangler secret put WG_APP_ID          # 00eed50e0468215e87ec936f17c52d8f
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DISCORD_TOKEN
npx wrangler secret put DISCORD_APP_ID
npx wrangler secret put OFFICER_ROLE_IDS    # id de rôles séparés par des virgules
npx wrangler secret put CLAN_ID            # 500165786
npx wrangler secret put LOGIN_SECRET
```

### 3. Déployer
```bash
npx wrangler deploy
```
Note l'URL du Worker (ex. `https://gr0ut-clan-reserves.<toi>.workers.dev`).

### 4. Brancher Discord
- Portail Discord → ton app → *General Information* → **Interactions Endpoint URL** :
  `https://…workers.dev/interactions` → *Save* (Discord envoie un ping de test,
  le Worker doit répondre ✅).
- Enregistrer la commande :
  ```bash
  DISCORD_APP_ID=... DISCORD_TOKEN=... GUILD_ID=... node src/register.js
  ```
- Inviter le bot sur le serveur (onglet *OAuth2 → URL Generator* : scopes
  `bot` + `applications.commands`).

### 5. Lier le compte Wargaming (un officier, une fois)
Ouvre dans ton navigateur :
```
https://…workers.dev/auth/login?key=<LOGIN_SECRET>
```
→ connexion WG → le token est stocké. C'est ce compte (avec le droit clan
d'activer les réserves) qui servira pour toutes les activations.

### 6. Utiliser
Dans le salon « Réserves » : `/reserves` → boutons → confirmation → activation.

## À vérifier au premier `/reserves`
Je n'ai pas pu voir la **structure exacte** renvoyée par `clanreserves`
(elle exige un token). Le code lit les champs de façon défensive
(`type`, `level`, `in_stock`, `name`). Au premier appel réel, si les libellés
ou niveaux paraissent faux, envoie-moi la réponse brute de l'API et j'ajuste
`reservesMessage()` en 2 min.

## Notes
- Région : `WG_REGION=eu` dans `wrangler.toml` (change en `na`/`asia` au besoin).
- Le token WG expire ~2 semaines ; le cron quotidien le renouvelle. Si personne
  ne l'utilise très longtemps et qu'il expire quand même, il suffit de refaire
  l'étape 5.
- Sécurité : seuls les rôles listés dans `OFFICER_ROLE_IDS` peuvent déclencher les boutons ; le
  lien de login est protégé par `LOGIN_SECRET`.
