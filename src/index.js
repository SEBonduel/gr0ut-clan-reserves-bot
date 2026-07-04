/**
 * GR0UT — Bot d'activation des réserves de clan (Cloudflare Worker).
 *
 * Trois rôles :
 *  1. Endpoint d'interactions Discord (POST /interactions) : commande /reserves
 *     + boutons -> active une réserve via l'API Wargaming.
 *  2. Flux d'auth WG (GET /auth/login -> /auth/callback) : un officier se logue
 *     une fois, on stocke son access_token dans KV.
 *  3. Cron quotidien : renouvelle (prolongate) le token pour qu'il n'expire pas.
 *
 * Secrets attendus (wrangler secret put ...):
 *   WG_APP_ID, DISCORD_PUBLIC_KEY, DISCORD_TOKEN, DISCORD_APP_ID,
 *   OFFICER_ROLE_ID, CLAN_ID, LOGIN_SECRET
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

/** Libellés FR + emoji par type de réserve (fallback = nom renvoyé par l'API). */
const RESERVE_LABELS = {
  COMBAT_PAYMENTS: "💰 Crédits",
  TACTICAL_TRAINING: "⭐ XP véhicule",
  MILITARY_EXERCISES: "🎖️ XP équipage",
  ADDITIONAL_BRIEFING: "📘 XP libre",
};

async function wgGetReserves(env, token) {
  const url = new URL(`${wgBase(env)}/wot/stronghold/clanreserves/`);
  url.searchParams.set("application_id", env.WG_APP_ID);
  url.searchParams.set("access_token", token);
  url.searchParams.set("clan_id", env.CLAN_ID);
  const r = await fetch(url);
  return r.json();
}

async function wgActivateReserve(env, token, reserveType, reserveLevel) {
  // Méthode "write" -> POST, paramètres dans le corps.
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

// --- Stockage du token (KV) --------------------------------------------------

const TOKEN_KEY = "wg_token";

const getToken = (env) => env.TOKENS.get(TOKEN_KEY, "json");
const saveToken = (env, data) =>
  env.TOKENS.put(TOKEN_KEY, JSON.stringify(data));

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

const isOfficer = (interaction, env) =>
  (interaction.member?.roles || []).includes(env.OFFICER_ROLE_ID);

/** Construit le message avec un bouton par réserve disponible. */
function reservesMessage(payload, env) {
  const list = payload?.data?.[env.CLAN_ID] || [];
  if (!Array.isArray(list) || list.length === 0) {
    return { content: "Aucune réserve de clan disponible pour le moment." };
  }
  const rows = [];
  let row = { type: 1, components: [] };
  for (const res of list) {
    // Champs défensifs : l'API renvoie type + (level|levels) + in_stock/name.
    const type = res.type || res.reserve_type;
    const level = res.level ?? res.reserve_level ?? 1;
    const stock = res.in_stock ?? res.count ?? "?";
    const label = `${RESERVE_LABELS[type] || res.name || type} (niv ${level})`;
    row.components.push({
      type: 2, // button
      style: 1, // primary
      label: `${label} · x${stock}`,
      custom_id: `ask:${type}:${level}`,
    });
    if (row.components.length === 5) {
      rows.push(row);
      row = { type: 1, components: [] };
    }
  }
  if (row.components.length) rows.push(row);
  return {
    content: "🏰 **Réserves de clan disponibles** — clique pour activer :",
    components: rows.slice(0, 5),
  };
}

const confirmMessage = (type, level) => ({
  content: `⚠️ Confirmer l'activation de **${
    RESERVE_LABELS[type] || type
  }** (niveau ${level}) ? Cela consomme une réserve du clan.`,
  flags: InteractionResponseFlags.EPHEMERAL,
  components: [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 4, // danger
          label: "✅ Confirmer l'activation",
          custom_id: `do:${type}:${level}`,
        },
        { type: 2, style: 2, label: "Annuler", custom_id: "cancel" },
      ],
    },
  ],
});

// --- Traitement des interactions --------------------------------------------

async function handleInteraction(interaction, env) {
  // Ping de vérification Discord.
  if (interaction.type === InteractionType.PING) {
    return json({ type: InteractionResponseType.PONG });
  }

  // Commande /reserves : liste les réserves + boutons.
  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    if (!isOfficer(interaction, env)) {
      return ephemeral("⛔ Réservé aux officiers du clan.");
    }
    const token = await getToken(env);
    if (!token?.access_token) {
      return ephemeral(
        "🔒 Aucun compte WG lié. Un officier doit d'abord se connecter via le lien d'auth (voir README)."
      );
    }
    const payload = await wgGetReserves(env, token.access_token);
    if (payload.status !== "ok") {
      return ephemeral(
        `Erreur API Wargaming : \`${payload.error?.message || "inconnue"}\`. ` +
          "Le token a peut-être expiré (relogue-toi)."
      );
    }
    return json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: reservesMessage(payload, env),
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

    // 1er clic : demander confirmation.
    if (id.startsWith("ask:")) {
      const [, type, level] = id.split(":");
      return json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: confirmMessage(type, level),
      });
    }

    // 2e clic : activer réellement.
    if (id.startsWith("do:")) {
      const [, type, level] = id.split(":");
      const token = await getToken(env);
      const res = await wgActivateReserve(env, token.access_token, type, level);
      const who = interaction.member?.user?.username || "un officier";
      if (res.status === "ok") {
        return json({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: {
            content: `✅ **${RESERVE_LABELS[type] || type}** (niv ${level}) activée par **${who}**.`,
            components: [],
          },
        });
      }
      return json({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `❌ Échec : \`${res.error?.message || "erreur inconnue"}\`.`,
          components: [],
        },
      });
    }
  }

  return ephemeral("Interaction non reconnue.");
}

// --- Flux d'authentification Wargaming --------------------------------------

function authLoginRedirect(env, url) {
  // Protège le lien par un secret pour éviter qu'un inconnu ne lie son compte.
  if (url.searchParams.get("key") !== env.LOGIN_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }
  const redirectUri = `${url.origin}/auth/callback`;
  const login = new URL(`${wgBase(env)}/wot/auth/login/`);
  login.searchParams.set("application_id", env.WG_APP_ID);
  login.searchParams.set("redirect_uri", redirectUri);
  login.searchParams.set("display", "page");
  return Response.redirect(login.toString(), 302);
}

async function authCallback(env, url) {
  const status = url.searchParams.get("status");
  if (status !== "ok") {
    return new Response("Connexion Wargaming refusée.", { status: 400 });
  }
  await saveToken(env, {
    access_token: url.searchParams.get("access_token"),
    account_id: url.searchParams.get("account_id"),
    nickname: url.searchParams.get("nickname"),
    expires_at: Number(url.searchParams.get("expires_at")) || null,
  });
  return new Response(
    "✅ Compte Wargaming lié. Tu peux fermer cette page et utiliser /reserves sur Discord.",
    { headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

// --- Entrées du Worker -------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/auth/login") return authLoginRedirect(env, url);
    if (url.pathname === "/auth/callback") return authCallback(env, url);

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

  // Cron : renouvelle le token WG pour qu'il n'expire pas (~2 semaines sinon).
  async scheduled(event, env, ctx) {
    const token = await getToken(env);
    if (!token?.access_token) return;
    const res = await wgProlongate(env, token.access_token);
    if (res.status === "ok" && res.data?.access_token) {
      await saveToken(env, {
        ...token,
        access_token: res.data.access_token,
        expires_at: res.data.expires_at,
      });
    }
  },
};
