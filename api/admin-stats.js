// Password-gated read endpoint. Returns aggregated visit stats from Firestore.
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

    const botFilter = (q) => (includeBots ? q : q.where("isBot", "==", false));

    // Big totals via .count() — cheap aggregation queries.
    const [totalSnap, todaySnap, last7Snap] = await Promise.all([
      botFilter(visits).count().get(),
      botFilter(visits.where("ts", ">=", startOfDay)).count().get(),
      botFilter(visits.where("ts", ">=", sevenDaysAgo)).count().get(),
    ]);

    // For unique-visitor + by-path stats we need to scan a window.
    const last30Snap = await botFilter(visits.where("ts", ">=", thirtyDaysAgo)).get();
    const uniqueToday = new Set();
    const uniqueLast7 = new Set();
    const uniqueLast30 = new Set();
    const pathCounts = {};
    last30Snap.forEach((d) => {
      const data = d.data();
      const t = data.ts && data.ts.toDate ? data.ts.toDate() : null;
      if (data.ipHash) {
        uniqueLast30.add(data.ipHash);
        if (t && t >= sevenDaysAgo) uniqueLast7.add(data.ipHash);
        if (t && t >= startOfDay) uniqueToday.add(data.ipHash);
      }
      if (data.path) pathCounts[data.path] = (pathCounts[data.path] || 0) + 1;
    });
    const topPaths = Object.entries(pathCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([path, count]) => ({ path, count }));

    // Recent 25 visits.
    const recentSnap = await botFilter(visits).orderBy("ts", "desc").limit(25).get();
    const recent = recentSnap.docs.map((d) => {
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

    return res.status(200).json({
      total: totalSnap.data().count,
      today: todaySnap.data().count,
      last7: last7Snap.data().count,
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
    return res.status(500).json({ error: "Something went wrong." });
  }
};
