// Drizzle client for BMS. Mirrors MarketHop's proven postgres-js pattern:
// a single client reused across warm invocations, prepare:false for
// pgBouncer/Neon-pooler compatibility.
const { drizzle } = require("drizzle-orm/postgres-js");
const postgres = require("postgres");
const schema = require("./schema");

let _client, _db, _ready;

function client() {
  if (!_client) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set.");
    }
    _client = postgres(connectionString, { prepare: false });
  }
  return _client;
}

function getDb() {
  if (!_db) _db = drizzle(client(), { schema });
  return _db;
}

// Idempotent: ensures the visits table + indexes exist. Cached so it runs
// at most once per process. Makes the app self-healing — no manual DDL needed.
function ensureSchema() {
  if (!_ready) {
    const sql = client();
    _ready = (async () => {
      await sql`create table if not exists visits (
        id uuid primary key default gen_random_uuid(),
        site text not null default 'bluemustangstudios',
        path text not null default '/',
        ref text,
        ua text,
        ip_hash text,
        is_bot boolean not null default false,
        ts timestamptz not null default now()
      )`;
      await sql`create index if not exists visits_site_idx on visits(site)`;
      await sql`create index if not exists visits_ts_idx on visits(ts)`;
      await sql`create index if not exists visits_is_bot_idx on visits(is_bot)`;
    })();
  }
  return _ready;
}

module.exports = { getDb, ensureSchema, schema };
