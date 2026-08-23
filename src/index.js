/**
 * GR0UT — Bot d'activation des réserves de clan (Cloudflare Worker).
 *
 * Multi-clans : on choisit d'abord le clan (GR0UT / GR0VT...), puis la réserve,
 * puis le niveau. Chaque clan a son propre compte WG (donc son propre token).
 *
 * Trois rôles :
 *  1. Endpoint d'interactions Discord (POST /interactions) : /reserves
 *     -> choix du clan -> choix de la réserve -> choix du niveau -> activation.
 *  2. Flux d'auth WG (GET /auth/login?key=...&clan=GR0UT -> /auth/callback/GR0UT) :
 *     un officier logue le compte de CHAQUE clan une fois ; token stocké par clan.
 *  3. Cron : prolonge chaque token + surveille les réserves de chaque clan.
 *
 * Secrets attendus (wrangler secret put ...):
 *   WG_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_TOKEN, DISCORD_APP_ID,
 *   OFFICER_ROLE_IDS, LOGIN_SECRET
 *   CLANS  = JSON [{"key":"GR0UT","clan_id":"500165786"},{"key":"GR0VT","clan_id":"500135793"}]
 *           (si absent -> valeurs par défaut GR0UT + GR0VT ci-dessous ;
 *            CLAN_ID reste accepté comme clan_id du clan primaire)
 * Binding KV : TOKENS. Var : WG_REGION (eu|na|asia).
 */

import {
  verifyKey,
  InteractionType,
  InteractionResponseType,
  InteractionResponseFlags,
} from "discord-interactions";

// --- Wargaming ---------------------------------------------------------------

const WG_HOSTS = {
  eu: "https://api.worldoftanks.eu",
  na: "https://api.worldoftanks.com",
  asia: "https://api.worldoftanks.asia",
};

const wgBase = (env) => WG_HOSTS[env.WG_REGION] || WG_HOSTS.eu;

/** Clans gérés : [{key, clan_id, name?}]. Surchargeable via le secret JSON CLANS. */
function getClans(env) {
  if (env.CLANS) {
    try {
      const c = JSON.parse(env.CLANS);
      if (Array.isArray(c) && c.length) return c;
    } catch (_) { /* JSON invalide -> valeurs par défaut */ }
  }
  return [
    { key: "GR0UT", clan_id: env.CLAN_ID || "500165786" },
    { key: "GR0VT", clan_id: "500135793" },
  ];
}
const findClan = (env, key) => getClans(env).find((c) => c.key === key) || null;
const clanLabel = (c) => c.name || c.key;

/** Libellés FR + emoji par type de réserve (fallback = nom renvoyé par l'API). */
const RESERVE_LABELS = {
  BATTLE_PAYMENTS: "💰 Crédits",
  TACTICAL_TRAINING: "⭐ XP véhicule",
  ADDITIONAL_BRIEFING: "🎖️ XP équipage",
  MILITARY_MANEUVERS: "📘 XP libre",
};

async function wgGetReserves(env, token, clanId) {
  const url = new URL(`${wgBase(env)}/wot/stronghold/clanreserves/`);
  url.searchParams.set("application_id", env.WG_APP_ID);
  url.searchParams.set("access_token", token);
  url.searchParams.set("clan_id", clanId);
  const r = await fetch(url);
  return r.json();
}

async function wgActivateReserve(env, token, reserveType, reserveLevel) {
  // Méthode "write" -> POST, paramètres dans le corps. Le clan visé est celui
  // du compte propriétaire du token (donc implicite).
  const body = new URLSearchParams({
    application_id: env.WG_APP_ID,
    access_token: token,
    reserve_type: reserveType,
    reserve_level: String(reserveLevel),
  });
  const r = await fetch(`${wgBase(env)}/wot/stronghold/activateclanreserve/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json();
}

async function wgProlongate(env, token) {
  const body = new URLSearchParams({
    application_id: env.WG_APP_ID,
    access_token: token,
  });
  const r = await fetch(`${wgBase(env)}/wot/auth/prolongate/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return r.json();
}

// --- Stockage des tokens (KV), un par clan -----------------------------------

const tokenKey = (clanKey) => `wg_token:${clanKey}`;

/** Token du clan. Compat : le clan primaire retombe sur l'ancien "wg_token". */
async function getToken(env, clanKey) {
  const t = await env.TOKENS.get(tokenKey(clanKey), "json");
  if (t) return t;
  const clans = getClans(env);
  if (clans[0] && clans[0].key === clanKey) {
    return env.TOKENS.get("wg_token", "json"); // ancien token unique
  }
  return null;
}
const saveToken = (env, clanKey, data) =>
  env.TOKENS.put(tokenKey(clanKey), JSON.stringify(data));

// --- Helpers Discord ---------------------------------------------------------

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const ephemeral = (content) =>
  json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { content, flags: InteractionResponseFlags.EPHEMERAL },
  });

// OFFICER_ROLE_IDS = un ou plusieurs id de rôles séparés par des virgules.
const isOfficer = (interaction, env) => {
  const allowed = (env.OFFICER_ROLE_IDS || "").split(",").map((s) => s.trim());
  const roles = interaction.member?.roles || [];
  return roles.some((r) => allowed.includes(r));
};

/** 1re étape : boutons de choix du clan. */
function clanChoiceMessage(env) {
  const btns = getClans(env).slice(0, 5).map((c) => ({
    type: 2,
    style: 1,
    label: clanLabel(c),
    custom_id: `clan:${c.key}`,
  }));
  return {
    content: "🏰 **Réserves de clan** — pour quel clan veux-tu les activer ?",
    components: [{ type: 1, components: btns }],
  };
}

/**
 * Message d'état des réserves + boutons (pour un clan donné).
 * `data` est une LISTE de réserves ; chacune a `in_stock` = niveaux, avec un
 * `status` par niveau : "active" (en cours), "cannot_be_activated" (bloqué),
 * ou autre/null (activable). On ne pilote que les boosters (disposable=false).
 */
function reservesMessage(payload, clanKey, clan) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const boosters = list.filter((r) => r.disposable === false);
  const header = `🏰 **Réserves — ${clanLabel(clan)}**\n`;
  if (!boosters.length) {
    return { content: header + "Aucune réserve de clan pilotable pour le moment." };
  }

  const lines = [];
  const rows = [];
  let row = { type: 1, components: [] };
  const pushBtn = (btn) => {
    if (row.components.length === 5) {
      rows.push(row);
      row = { type: 1, components: [] };
    }
    row.components.push(btn);
  };

  for (const r of boosters) {
    const name = RESERVE_LABELS[r.type] || r.name;
    const stock = r.in_stock || [];
    const active = stock.find((s) => s.status === "active");
    if (active) {
      lines.push(`✅ **${name}** — déjà en cours (niveau ${active.level})`);
      continue;
    }
    const usableLevels = stock.filter(
      (s) =>
        s.status !== "active" &&
        s.status !== "cannot_be_activated" &&
        (s.amount ?? 0) > 0
    );
    if (usableLevels.length) {
      const niv = usableLevels.map((s) => s.level).join(", ");
      lines.push(`▶️ **${name}** — disponible (niveaux ${niv})`);
      pushBtn({
        type: 2,
        style: 1,
        label: name,
        custom_id: `lvl:${clanKey}:${r.type}`,
      });
    } else {
      const total = stock.reduce((n, s) => n + (s.amount || 0), 0);
      lines.push(
        `⛔ **${name}** — activation impossible maintenant (x${total} en stock)`
      );
    }
  }
  if (row.components.length) rows.push(row);

  const out = {
    content: header + lines.join("\n") + (rows.length ? "\n\nClique pour activer :" : ""),
  };
  if (rows.length) out.components = rows.slice(0, 5);
  return out;
}

/** Bonus principal (batailles de clan) + durée d'un niveau de réserve. */
function bonusLabel(stockLevel) {
  const bv = stockLevel.bonus_values || [];
  const clan = bv.find((b) => /Clan/i.test(b.battle_type)) || bv[0];
  const dur = stockLevel.action_time
    ? `${Math.round(stockLevel.action_time / 3600)}h`
    : "";
  return [clan ? `x${clan.value}` : "", dur].filter(Boolean).join(" · ");
}

/** Message éphémère : un bouton par niveau activable (le clic = activation). */
function levelChoiceMessage(reserve, clanKey, clan) {
  const name = RESERVE_LABELS[reserve.type] || reserve.name;
  const levels = (reserve.in_stock || []).filter(
    (s) =>
      s.status !== "active" &&
      s.status !== "cannot_be_activated" &&
      (s.amount ?? 0) > 0
  );
  if (!levels.length) {
    return {
      content: `⚠️ **${name}** n'est plus activable pour le moment.`,
      flags: InteractionResponseFlags.EPHEMERAL,
    };
  }
  const btns = levels.slice(0, 5).map((s) => ({
    type: 2,
    style: 4, // danger : le clic déclenche l'activation réelle
    label: `Niv ${s.level} · ${bonusLabel(s)} (x${s.amount})`,
    custom_id: `do:${clanKey}:${reserve.type}:${s.level}`,
  }));
  return {
    content: `⚠️ **${name}** (${clanLabel(clan)}) — choisis le niveau à activer (cela **consomme** une réserve du clan) :`,
    flags: InteractionResponseFlags.EPHEMERAL,
    components: [
      { type: 1, components: btns },
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: "Annuler", custom_id: "cancel" },
        ],
      },
    ],
  };
}

/** Récupère + construit le message des réserves d'un clan (ou {error}). */
async function buildReservesData(env, clanKey) {
  const clan = findClan(env, clanKey);
  if (!clan) return { error: "Clan inconnu (relance /reserves)." };
  const token = await getToken(env, clanKey);
  if (!token?.access_token) {
    return {
      error:
        `🔒 Aucun compte WG lié pour **${clanLabel(clan)}**. Un officier doit se ` +
        `connecter via le lien d'auth de ce clan (voir README).`,
    };
  }
  const payload = await wgGetReserves(env, token.access_token, clan.clan_id);
  if (payload.status !== "ok") {
    return {
      error:
        `Erreur API Wargaming (${clan.key}) : \`${payload.error?.message || "inconnue"}\`. ` +
        "Le token a peut-être expiré (relogue le compte de ce clan).",
    };
  }
  return { data: reservesMessage(payload, clanKey, clan) };
}

// --- Traitement des interactions --------------------------------------------

async function handleInteraction(interaction, env) {
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // Commande /reserves : choix du clan (ou direct si un seul clan).
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    if (!isOfficer(interaction, env)) {
      return ephemeral("⛔ Réservé aux officiers du clan.");
    }
    const clans = getClans(env);
    if (clans.length === 1) {
      const r = await buildReservesData(env, clans[0].key);
      if (r.error) return ephemeral(r.error);
      return json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: r.data,
      });
    }
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: clanChoiceMessage(env),
    });
  }

  // Clics de boutons.
  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    if (!isOfficer(interaction, env)) {
      return ephemeral("⛔ Réservé aux officiers du clan.");
    }
    const id = interaction.data.custom_id;

    if (id === "cancel") {
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: { content: "Activation annulée.", components: [] },
      });
    }

    // Étape 1 : clan choisi -> liste ses réserves.
    if (id.startsWith("clan:")) {
      const key = id.slice("clan:".length);
      const r = await buildReservesData(env, key);
      if (r.error) return ephemeral(r.error);
      return json({ type: InteractionResponseType.UPDATE_MESSAGE, data: r.data });
    }

    // Étape 2 : réserve choisie -> niveaux activables.
    if (id.startsWith("lvl:")) {
      const [, key, type] = id.split(":");
      const clan = findClan(env, key);
      const token = await getToken(env, key);
      if (!clan || !token?.access_token) {
        return ephemeral("Session expirée, relance /reserves.");
      }
      const payload = await wgGetReserves(env, token.access_token, clan.clan_id);
      const reserve = (Array.isArray(payload.data) ? payload.data : []).find(
        (r) => r.type === type
      );
      if (!reserve) return ephemeral("Réserve introuvable (relance /reserves).");
      return json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: levelChoiceMessage(reserve, key, clan),
      });
    }

    // Étape 3 : niveau choisi -> activation réelle.
    if (id.startsWith("do:")) {
      const [, key, type, level] = id.split(":");
      const clan = findClan(env, key);
      const token = await getToken(env, key);
      if (!clan || !token?.access_token) {
        return ephemeral("Session expirée, relance /reserves.");
      }
      const res = await wgActivateReserve(env, token.access_token, type, level);
      const who = interaction.member?.user?.username || "un officier";
      if (res.status === "ok") {
        let enCours = [];
        try {
          enCours = activeReservesList(
            await wgGetReserves(env, token.access_token, clan.clan_id)
          );
        } catch (e) { /* on garde la confirmation même si la relecture échoue */ }
        const liste = enCours.length ? enCours.join("\n") : "_aucune pour le moment_";
        return json({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content:
              `✅ **Réserve activée** (${clanLabel(clan)}) : ${RESERVE_LABELS[type] || type} ` +
              `(niveau ${level}) — par **${who}**.\n\n**Réserves en cours :**\n${liste}`,
            components: [],
          },
        });
      }
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `❌ Échec (${clan.key}) : \`${res.error?.message || "erreur inconnue"}\`.`,
          components: [],
        },
      });
    }
  }

  return ephemeral("Interaction non reconnue.");
}

// --- Flux d'authentification Wargaming --------------------------------------

function authLoginRedirect(env, url) {
  // Protège le lien par un secret + exige le clan à lier.
  if (url.searchParams.get("key") !== env.LOGIN_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const clanKey = url.searchParams.get("clan");
  if (!findClan(env, clanKey)) {
    const keys = getClans(env).map((c) => c.key).join(", ");
    return new Response(
      `Paramètre 'clan' manquant ou inconnu. Utilise ?key=<secret>&clan=<${keys}>`,
      { status: 400 }
    );
  }
  const redirectUri = `${url.origin}/auth/callback/${clanKey}`;
  const login = new URL(`${wgBase(env)}/wot/auth/login/`);
  login.searchParams.set("application_id", env.WG_APP_ID);
  login.searchParams.set("redirect_uri", redirectUri);
  login.searchParams.set("display", "page");
  return Response.redirect(login.toString(), 302);
}

async function authCallback(env, url, clanKey) {
  if (!findClan(env, clanKey)) {
    return new Response("Clan inconnu.", { status: 400 });
  }
  const status = url.searchParams.get("status");
  if (status !== "ok") {
    return new Response("Connexion Wargaming refusée.", { status: 400 });
  }
  await saveToken(env, clanKey, {
    access_token: url.searchParams.get("access_token"),
    account_id: url.searchParams.get("account_id"),
    nickname: url.searchParams.get("nickname"),
    expires_at: Number(url.searchParams.get("expires_at")) || null,
  });
  return new Response(
    `✅ Compte Wargaming lié pour ${clanKey}. Tu peux fermer cette page et utiliser /reserves sur Discord.`,
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

// --- Surveillance : réserve redevenue activable -----------------------------

/** Types de boosters actuellement activables (ni en cours, ni bloqués). */
function activatableTypes(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const r of list) {
    if (r.disposable !== false) continue; // on ignore les consommables
    const stock = r.in_stock || [];
    if (stock.some((s) => s.status === "active")) continue; // déjà en cours
    const usable = stock.some(
      (s) =>
        s.status !== "active" &&
        s.status !== "cannot_be_activated" &&
        (s.amount ?? 0) > 0
    );
    if (usable) out.push(r.type);
  }
  return out;
}

/** Liste lisible des réserves actuellement en cours. */
function activeReservesList(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const active = [];
  for (const r of list) {
    if (r.disposable !== false) continue;
    const a = (r.in_stock || []).find((s) => s.status === "active");
    if (a) active.push(`🟢 **${RESERVE_LABELS[r.type] || r.name}** (niveau ${a.level})`);
  }
  return active;
}

/** Compare aux activables précédents d'un clan ; notifie celles redevenues dispo. */
async function checkReserveSlots(env, clan, token) {
  if (!env.RESERVES_WEBHOOK_URL) return;
  const payload = await wgGetReserves(env, token.access_token, clan.clan_id);
  if (payload.status !== "ok") return;

  const current = activatableTypes(payload);
  const kvKey = `reserve_activatable:${clan.key}`;
  const prev = (await env.TOKENS.get(kvKey, "json")) || [];
  await env.TOKENS.put(kvKey, JSON.stringify(current));

  const fresh = current.filter((t) => !prev.includes(t));
  if (!fresh.length) return;

  const names = fresh.map((t) => RESERVE_LABELS[t] || t).join(", ");
  await fetch(env.RESERVES_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `💡 **[${clan.key}]** Réserve(s) de nouveau activable(s) : **${names}** — utilisez \`/reserves\` (clan ${clan.key}).`,
    }),
  });
}

// --- Rappel "Jeux de guerre" (samedi 19h Paris) -----------------------------

/**
 * Poste un rappel mentionnant les officiers, uniquement le samedi à 19h HEURE DE
 * PARIS. Les crons Cloudflare sont en UTC ; on déclenche à 17:00 et 18:00 UTC le
 * samedi (été/hiver) et on ne poste que si l'heure de Paris vaut bien 19h. Un
 * verrou par date (KV) évite tout doublon.
 */
/** Poste réellement le message (mention officiers), sans aucune garde. */
async function sendWarGamesMessage(env) {
  const webhook = env.WARGAMES_WEBHOOK_URL || env.RESERVES_WEBHOOK_URL;
  if (!webhook) {
    return { ok: false, reason: "Aucun webhook (WARGAMES_WEBHOOK_URL / RESERVES_WEBHOOK_URL)." };
  }
  const roleIds = (env.OFFICER_ROLE_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mentions = roleIds.map((r) => `<@&${r}>`).join(" ");
  const r = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content:
        `${mentions}\n🚨 **ATTENTION, CE SOIR JEUX DE GUERRE** 🚨\n` +
        `PAS DE RÉSERVE APRÈS 20H (tier 12 uniquement).`,
      allowed_mentions: { roles: roleIds },
    }),
  });
  return { ok: r.ok, status: r.status, roles: roleIds.length };
}

/** Garde : ne poste qu'au samedi 19h Paris, une seule fois (verrou KV par date). */
async function maybeSendWarGamesWarning(env) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  if (get("weekday") !== "Sat" || parseInt(get("hour"), 10) !== 19) return;

  const dateKey = `${get("year")}-${get("month")}-${get("day")}`;
  if ((await env.TOKENS.get("wargames_warned")) === dateKey) return;
  await env.TOKENS.put("wargames_warned", dateKey);

  await sendWarGamesMessage(env);
}

// --- Entrées du Worker -------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/login") return authLoginRedirect(env, url);
    if (url.pathname.startsWith("/auth/callback/")) {
      const clanKey = decodeURIComponent(url.pathname.slice("/auth/callback/".length));
      return authCallback(env, url, clanKey);
    }
    // Compat : ancien callback sans clan -> clan primaire.
    if (url.pathname === "/auth/callback") {
      return authCallback(env, url, getClans(env)[0].key);
    }

    if (url.pathname === "/interactions" && request.method === "POST") {
      const sig = request.headers.get("x-signature-ed25519");
      const ts = request.headers.get("x-signature-timestamp");
      const raw = await request.text();
      const valid =
        sig &&
        ts &&
        (await verifyKey(raw, sig, ts, env.DISCORD_PUBLIC_KEY));
      if (!valid) return new Response("Bad request signature", { status: 401 });
      return handleInteraction(JSON.parse(raw), env);
    }

    return new Response("GR0UT clan-reserves bot OK", { status: 200 });
  },

  // Crons : rappel Jeux de guerre (samedi) + renouvellement/surveillance par clan.
  async scheduled(event, env, ctx) {
    // Rappel "Jeux de guerre" : crons du samedi 17:00/18:00 UTC (poste à 19h Paris).
    if (event.cron === "0 17 * * 6" || event.cron === "0 18 * * 6") {
      await maybeSendWarGamesWarning(env);
      return;
    }

    for (const clan of getClans(env)) {
      const token = await getToken(env, clan.key);
      if (!token?.access_token) continue;

      // Crons fréquents (≠ 06:00) : repérer les réserves redevenues activables.
      if (event.cron !== "0 6 * * *") {
        await checkReserveSlots(env, clan, token);
        continue;
      }

      // Cron quotidien : prolonge le token pour qu'il n'expire pas (~2 sem).
      const res = await wgProlongate(env, token.access_token);
      if (res.status === "ok" && res.data?.access_token) {
        await saveToken(env, clan.key, {
          ...token,
          access_token: res.data.access_token,
          expires_at: res.data.expires_at,
        });
      }
    }
  },
};
