// BMS Postgres schema (Drizzle). Plain CJS so it runs in the no-build
// Vercel serverless functions without a transpile step.
const {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  index,
} = require("drizzle-orm/pg-core");

// One row per page load across BMS-operated sites. `site` tags which property
// the hit came from (e.g. "bluemustangstudios", "mymoveprep") so a single
// table can back multi-site analytics. IPs are stored hashed, never raw.
const visits = pgTable(
  "visits",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    site: text("site").notNull().default("bluemustangstudios"),
    path: text("path").notNull().default("/"),
    ref: text("ref"),
    ua: text("ua"),
    ipHash: text("ip_hash"),
    isBot: boolean("is_bot").notNull().default(false),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("visits_site_idx").on(t.site),
    index("visits_ts_idx").on(t.ts),
    index("visits_is_bot_idx").on(t.isBot),
  ]
);

module.exports = { visits };
