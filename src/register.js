/**
 * Enregistre la commande /reserves sur ton serveur Discord (commande de guilde
 * = dispo instantanément). À lancer une fois (et à chaque changement de commande) :
 *
 *   DISCORD_APP_ID=... DISCORD_TOKEN=... GUILD_ID=... node src/register.js
 */

const { DISCORD_APP_ID, DISCORD_TOKEN, GUILD_ID } = process.env;

if (!DISCORD_APP_ID || !DISCORD_TOKEN || !GUILD_ID) {
  console.error("Manque DISCORD_APP_ID / DISCORD_TOKEN / GUILD_ID.");
  process.exit(1);
}

const commands = [
  {
    name: "reserves",
    description: "Afficher et activer les réserves de clan (officiers)",
    type: 1,
  },
];

const url = `https://discord.com/api/v10/applications/${DISCORD_APP_ID}/guilds/${GUILD_ID}/commands`;

const res = await fetch(url, {
  method: "PUT",
  headers: {
    authorization: `Bot ${DISCORD_TOKEN}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(commands),
});

if (res.ok) {
  console.log("✅ Commande /reserves enregistrée sur la guilde", GUILD_ID);
} else {
  console.error("❌ Échec :", res.status, await res.text());
  process.exit(1);
}
