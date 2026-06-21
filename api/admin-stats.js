// Password-gated read endpoint. Returns BMS visit stats (from Postgres) plus a
// `products` block aggregated from each product's own source:
//   - Astelos / MarketHop: their secret-gated /api/stats endpoints
//   - mymoveprep: PostHog (unique visitors)
// Each product fetch is isolated — one failing source never breaks the dashboard.
const crypto = require("crypto");
const { and, eq, gte, desc, count } = require("drizzle-orm");
const { getDb, ensureSchema, schema } = require("../db");

const SITE = "bluemustangstudios";

function timingSafeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ── BMS's own visit stats (Postgres) ────────────────────────────────
async function getBmsStats(includeBots) {
  await ensureSchema();
  const db = getDb();
  const v = schema.visits;

  const now = new Date();
  const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
  const sevenDaysAgo = new Date(now); sevenDaysAgo.setUTCDate(now.getUTCDate() - 7);
  const thirtyDaysAgo = new Date(now); thirtyDaysAgo.setUTCDate(now.getUTCDate() - 30);

  const botCond = includeBots ? undefined : eq(v.isBot, false);
  const where = (extra) => and(eq(v.site, SITE), botCond, extra);

  const [totalRow] = await db.select({ c: count() }).from(v).where(where());
  const [todayRow] = await db.select({ c: count() }).from(v).where(where(gte(v.ts, startOfDay)));
  const [last7Row] = await db.select({ c: count() }).from(v).where(where(gte(v.ts, sevenDaysAgo)));

  const rows30 = await db.select().from(v).where(where(gte(v.ts, thirtyDaysAgo)));
  const uToday = new Set(), u7 = new Set(), u30 = new Set();
  const pathCounts = {};
  for (const r of rows30) {
    const t = r.ts instanceof Date ? r.ts : (r.ts ? new Date(r.ts) : null);
    if (r.ipHash) {
      u30.add(r.ipHash);
      if (t && t >= sevenDaysAgo) u7.add(r.ipHash);
      if (t && t >= startOfDay) uToday.add(r.ipHash);
    }
    if (r.path) pathCounts[r.path] = (pathCounts[r.path] || 0) + 1;
  }
  const topPaths = Object.entries(pathCounts).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([path, c]) => ({ path, count: c }));

  const recentRows = await db.select().from(v).where(where()).orderBy(desc(v.ts)).limit(25);
  const recent = recentRows.map((r) => ({
    path: r.path || "/",
    ref: r.ref || "",
    ua: r.ua || "",
    ipHash: r.ipHash || "",
    isBot: !!r.isBot,
    ts: r.ts instanceof Date ? r.ts.toISOString() : (r.ts ? new Date(r.ts).toISOString() : null),
  }));

  return {
    total: Number(totalRow.c) || 0,
    today: Number(todayRow.c) || 0,
    last7: Number(last7Row.c) || 0,
    uniqueToday: uToday.size,
    uniqueLast7: u7.size,
    uniqueLast30: u30.size,
    topPaths,
    recent,
  };
}

// ── Fetch helper with timeout ───────────────────────────────────────
async function fetchJson(url, options, timeoutMs = 8000) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

// ── Astelos: secret-gated /api/stats ────────────────────────────────
async function getAstelos() {
  const secret = process.env.STATS_SECRET;
  const url = process.env.ASTELOS_STATS_URL || "https://astelos.io/api/stats";
  if (!secret) return { ok: false, error: "STATS_SECRET not set" };
  try {
    const d = await fetchJson(url, { headers: { authorization: `Bearer ${secret}` } });
    return { ok: true, signups: d.signups ?? 0, waitlist: d.waitlist ?? 0 };
  } catch (e) {
    return { ok: false, error: e.message || "fetch failed" };
  }
}

// ── MarketHop: secret-gated /api/stats ──────────────────────────────
async function getMarketHop() {
  const secret = process.env.STATS_SECRET;
  const url = process.env.MARKETHOP_STATS_URL || "https://markethop.io/api/stats";
  if (!secret) return { ok: false, error: "STATS_SECRET not set" };
  try {
    const d = await fetchJson(url, { headers: { authorization: `Bearer ${secret}` } });
    return {
      ok: true,
      markets: d.markets ?? 0,
      organizers: d.organizers ?? 0,
      openMarkets: d.openMarkets ?? 0,
    };
  } catch (e) {
    return { ok: false, error: e.message || "fetch failed" };
  }
}

// ── mymoveprep: PostHog unique visitors ─────────────────────────────
async function getMyMovePrep() {
  const key = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  const host = process.env.POSTHOG_HOST || "https://us.i.posthog.com";
  if (!key || !projectId) return { ok: false, error: "PostHog not configured" };

  // HogQL: all-time + last-30d unique persons who triggered a pageview.
  const query =
    "SELECT count(DISTINCT person_id) AS all_time, " +
    "count(DISTINCT if(timestamp >= now() - INTERVAL 30 DAY, person_id, NULL)) AS last_30d " +
    "FROM events WHERE event = '$pageview'";
  try {
    const d = await fetchJson(
      `${host}/api/projects/${projectId}/query/`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      },
      10000
    );
    const row = (d.results && d.results[0]) || [];
    return { ok: true, uniqueAllTime: Number(row[0]) || 0, uniqueLast30: Number(row[1]) || 0 };
  } catch (e) {
    return { ok: false, error: e.message || "fetch failed" };
  }
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

    // BMS stats must succeed; product stats are best-effort (isolated).
    const [bms, astelos, markethop, mymoveprep] = await Promise.all([
      getBmsStats(includeBots),
      getAstelos(),
      getMarketHop(),
      getMyMovePrep(),
    ]);

    return res.status(200).json({
      ...bms,
      products: { astelos, markethop, mymoveprep },
      generatedAt: new Date().toISOString(),
      includeBots,
    });
  } catch (err) {
    console.error("admin-stats error:", err);
    const msg = (err && (err.message || String(err))) || "unknown";
    return res.status(500).json({ error: "Stats error: " + String(msg).slice(0, 500) });
  }
};
