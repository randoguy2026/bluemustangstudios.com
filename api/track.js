// Visit beacon: each public-page load POSTs here. Writes one Postgres row.
// Accepts a `site` tag so other BMS properties (e.g. mymoveprep) can report
// into the same table cross-origin. Fail-quiet so analytics never break a site.
const crypto = require("crypto");
const { getDb, ensureSchema, schema } = require("../db");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(204).end();

  try {
    const { path = "/", ref = "", site = "bluemustangstudios" } = req.body || {};
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || "";
    const ua = String(req.headers["user-agent"] || "").slice(0, 300);
    const salt = process.env.IP_HASH_SALT || "bms-default-salt-change-me";
    const ipHash = ip
      ? crypto.createHash("sha256").update(ip + salt).digest("hex").slice(0, 16)
      : "";
    const isBot = /bot|crawler|spider|preview|facebook|whatsapp|slackbot|discord|telegram|skype/i.test(ua);

    await ensureSchema();
    await getDb().insert(schema.visits).values({
      site: String(site).slice(0, 60),
      path: String(path).slice(0, 200),
      ref: String(ref).slice(0, 300),
      ua,
      ipHash,
      isBot,
    });
    return res.status(204).end();
  } catch (err) {
    console.error("track error:", err);
    return res.status(204).end();
  }
};
