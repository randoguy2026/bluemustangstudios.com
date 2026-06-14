// Password-gated read endpoint. Returns aggregated visit stats from Firestore.
// All Firestore queries are single-field so no composite indexes are needed.
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

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { password, includeBots = false } = req.body || {};
    const expected = process.env.ADMIN_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: "ADMIN_PASSWORD not configured on the server." });
    }
    if (!timingSafeEq(String(password || ""), expected)) {
      return res.status(401).json({ error: "Wrong password." });
    }

    const firestore = getFirestore();
    const visits = firestore.collection("visits");

    const now = new Date();
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(now); sevenDaysAgo.setUTCDate(now.getUTCDate() - 7);
    const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setUTCDate(now.getUTCDate() - 30);

    // Single-field WHERE — no composite index needed.
    const last30Snap = await visits.where("ts", ">=", thirtyDaysAgo).get();
    const last30 = last30Snap.docs.map((d) => {
      const data = d.data();
      return {
        path: data.path || "/",
        ref: data.ref || "",
        ua: data.ua || "",
        ipHash: data.ipHash || "",
        isBot: !!data.isBot,
        tsDate: data.ts && data.ts.toDate ? data.ts.toDate() : null,
      };
    });

    const filtered30 = includeBots ? last30 : last30.filter((d) => !d.isBot);

    const todayCount = filtered30.filter((d) => d.tsDate && d.tsDate >= startOfDay).length;
    const last7Count = filtered30.filter((d) => d.tsDate && d.tsDate >= sevenDaysAgo).length;

    const uniqueToday = new Set();
    const uniqueLast7 = new Set();
    const uniqueLast30 = new Set();
    const pathCounts = {};
    for (const d of filtered30) {
      if (d.ipHash) {
        uniqueLast30.add(d.ipHash);
        if (d.tsDate && d.tsDate >= sevenDaysAgo) uniqueLast7.add(d.ipHash);
        if (d.tsDate && d.tsDate >= startOfDay) uniqueToday.add(d.ipHash);
      }
      if (d.path) pathCounts[d.path] = (pathCounts[d.path] || 0) + 1;
    }
    const topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([path, count]) => ({ path, count }));

    // Total via single .count() — no composite index.
    const totalSnap = includeBots
      ? await visits.count().get()
      : await visits.where("isBot", "==", false).count().get();
    const total = totalSnap.data().count;

    // Recent: orderBy only (no WHERE). Pull extra if we'll filter bots, then trim.
    const recentLimit = includeBots ? 25 : 60;
    const recentSnap = await visits.orderBy("ts", "desc").limit(recentLimit).get();
    let recent = recentSnap.docs.map((d) => {
      const data = d.data();
      return {
        path: data.path || "/",
        ref: data.ref || "",
        ua: data.ua || "",
        ipHash: data.ipHash || "",
        isBot: !!data.isBot,
        ts: data.ts && data.ts.toDate ? data.ts.toDate().toISOString() : null,
      };
    });
    if (!includeBots) recent = recent.filter((r) => !r.isBot);
    recent = recent.slice(0, 25);

    return res.status(200).json({
      total,
      today: todayCount,
      last7: last7Count,
      uniqueToday: uniqueToday.size,
      uniqueLast7: uniqueLast7.size,
      uniqueLast30: uniqueLast30.size,
      topPaths,
      recent,
      generatedAt: now.toISOString(),
      includeBots,
    });
  } catch (err) {
    console.error("admin-stats error:", err);
    // Surface the underlying message so we can diagnose from the UI.
    const msg = (err && (err.message || String(err))) || "unknown";
    return res.status(500).json({ error: "Stats error: " + String(msg).slice(0, 500) });
  }
};
