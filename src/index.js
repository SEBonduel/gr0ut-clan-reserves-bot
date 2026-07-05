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
  BATTLE_PAYMENTS: "💰 Crédits",
  TACTICAL_TRAINING: "⭐ XP véhicule",
  ADDITIONAL_BRIEFING: "🎖️ XP équipage",
  MILITARY_MANEUVERS: "📘 XP libre",
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

// OFFICER_ROLE_IDS = un ou plusieurs id de rôles séparés par des virgules.
const isOfficer = (interaction, env) => {
  const allowed = (env.OFFICER_ROLE_IDS || "").split(",").map((s) => s.trim());
  const roles = interaction.member?.roles || [];
  return roles.some((r) => allowed.includes(r));
};

/**
 * Construit le message d'état des réserves + boutons.
 * `data` est une LISTE de réserves ; chacune a `in_stock` = niveaux, avec un
 * `status` par niveau : "active" (en cours), "cannot_be_activated" (bloqué),
 * ou autre/null (activable). On ne pilote que les boosters de clan
 * (disposable=false) : crédits / XP / XP équipage / XP libre.
 */
function reservesMessage(payload) {
  const list = Array.isArray(payload?.data) ? payload.data : [];
  const boosters = list.filter((r) => r.disposable === false);
  if (!boosters.length) {
    return { content: "Aucune réserve de clan pilotable pour le moment." };
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
        custom_id: `lvl:${r.type}`,
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
    content:
      "🏰 **Réserves de clan**\n" +
      lines.join("\n") +
      (rows.length ? "\n\nClique pour activer :" : ""),
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
function levelChoiceMessage(reserve) {
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
    custom_id: `do:${reserve.type}:${s.level}`,
  }));
  return {
    content: `⚠️ **${name}** — choisis le niveau à activer (cela **consomme** une réserve du clan) :`,
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
      data: reservesMessage(payload),
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

    // 1er clic : afficher les niveaux activables de cette réserve.
    if (id.startsWith("lvl:")) {
      const [, type] = id.split(":");
      const token = await getToken(env);
      const payload = await wgGetReserves(env, token.access_token);
      const reserve = (Array.isArray(payload.data) ? payload.data : []).find(
        (r) => r.type === type
      );
      if (!reserve) return ephemeral("Réserve introuvable (relance /reserves).");
      return json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: levelChoiceMessage(reserve),
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

/** Compare aux activables précédents ; notifie celles qui redeviennent dispo. */
async function checkReserveSlots(env, token) {
  if (!env.RESERVES_WEBHOOK_URL) return;
  const payload = await wgGetReserves(env, token.access_token);
  if (payload.status !== "ok") return;

  const current = activatableTypes(payload);
  const prev = (await env.TOKENS.get("reserve_activatable", "json")) || [];
  await env.TOKENS.put("reserve_activatable", JSON.stringify(current));

  const fresh = current.filter((t) => !prev.includes(t));
  if (!fresh.length) return;

  const names = fresh.map((t) => RESERVE_LABELS[t] || t).join(", ");
  await fetch(env.RESERVES_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: `💡 Réserve(s) de nouveau activable(s) : **${names}** — un créneau s'est libéré, utilisez \`/reserves\` pour l'activer.`,
    }),
  });
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

  // Crons : renouvellement quotidien du token + surveillance des réserves.
  async scheduled(event, env, ctx) {
    const token = await getToken(env);
    if (!token?.access_token) return;

    // Les crons fréquents (≠ 06:00) servent à repérer les réserves activables.
    if (event.cron !== "0 6 * * *") {
      await checkReserveSlots(env, token);
      return;
    }

    // Cron quotidien : prolonge le token pour qu'il n'expire pas (~2 sem).
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
