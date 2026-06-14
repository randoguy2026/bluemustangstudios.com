// Visit beacon: each public-page load POSTs here. Writes one Firestore doc.
// Fail-quiet so analytics issues never break the site.
const admin = require("firebase-admin");
const crypto = require("crypto");

function formatPrivateKey(key) {
  key = key.replace(/^["']|["']$/g, "");
  return key.replace(/\\n/g, "\n");
}

let db;
function getFirestore() {
  if (!db) {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: formatPrivateKey(process.env.FIREBASE_PRIVATE_KEY || ""),
        }),
      });
    }
    db = admin.firestore();
  }
  return db;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(204).end();

  try {
    const { path = "/", ref = "" } = req.body || {};
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = fwd || (req.socket && req.socket.remoteAddress) || "";
    const ua = String(req.headers["user-agent"] || "").slice(0, 300);
    const salt = process.env.IP_HASH_SALT || "bms-default-salt-change-me";
    const ipHash = ip
      ? crypto.createHash("sha256").update(ip + salt).digest("hex").slice(0, 16)
      : "";

    // Skip obvious bots from the count by a simple UA test.
    const isBot = /bot|crawler|spider|preview|facebook|whatsapp|slackbot|discord|telegram|skype/i.test(ua);

    await getFirestore().collection("visits").add({
      path: String(path).slice(0, 200),
      ref: String(ref).slice(0, 300),
      ua,
      ipHash,
      isBot,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
    return res.status(204).end();
  } catch (err) {
    console.error("track error:", err);
    return res.status(204).end();
  }
};
