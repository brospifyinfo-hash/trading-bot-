import {
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { tokens } from "./tokens";

/**
 * Bekannte Adressen mit besonderer Rolle.
 *
 * Ohne diese Liste ist Wallet-Clustering wertlos: CEX-Hot-Wallets, Bridges und
 * Router funden tausende voneinander unabhaengiger Nutzer. Nimmt man sie als
 * Funding-Kante, kollabiert der halbe Markt zu einem einzigen Cluster.
 */
export const walletLabels = pgTable("wallet_labels", {
  address: text("address").primaryKey(),
  kind: text("kind", {
    enum: ["cex", "bridge", "dex_router", "amm_pool", "burn", "system", "known_bot", "other"],
  }).notNull(),
  name: text("name"),
  /** Adressen dieser Art werden bei der Cluster-Bildung als Kante ignoriert. */
  excludeFromClustering: text("exclude_from_clustering").notNull().default("true"),
  source: text("source").notNull(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

export const walletTransactions = pgTable(
  "wallet_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    wallet: text("wallet").notNull(),
    mint: text("mint").notNull(),
    signature: text("signature").notNull(),
    side: text("side", { enum: ["buy", "sell", "transfer_in", "transfer_out"] }).notNull(),
    amountRaw: bigint("amount_raw", { mode: "bigint" }).notNull(),
    solValueLamports: bigint("sol_value_lamports", { mode: "bigint" }),
    /** Blockzeit laut Chain. */
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    /** Wann WIR die Transaktion indexiert haben. */
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("wallet_tx_wallet_time_idx").on(t.wallet, t.blockTime),
    index("wallet_tx_mint_idx").on(t.mint),
    index("wallet_tx_sig_idx").on(t.signature),
  ],
);

/**
 * Qualifizierte Wallets.
 *
 * `qualifiedAt` ist die kritischste Spalte des gesamten Schemas. Fuer eine
 * Entscheidung zum Zeitpunkt t duerfen ausschliesslich Wallets zaehlen, die
 * VOR t qualifiziert waren. Wer stattdessen die heutige Bestenliste auf die
 * Vergangenheit anwendet, baut einen Backtest, der Gewinner "erkennt", die er
 * bereits kannte — der haeufigste unentdeckte Look-Ahead in Wallet-Intelligence.
 *
 * `disqualifiedAt` beendet die Zugehoerigkeit, loescht sie aber nicht: eine
 * Wallet, die im Maerz qualifiziert war und im Mai nicht mehr, muss fuer eine
 * Aprilentscheidung weiterhin zaehlen.
 */
export const smartMoneyWallets = pgTable(
  "smart_money_wallets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    address: text("address").notNull(),
    qualifiedAt: timestamp("qualified_at", { withTimezone: true }).notNull(),
    disqualifiedAt: timestamp("disqualified_at", { withTimezone: true }),
    /** Version des Qualifikationsverfahrens — Aenderungen sind nicht rueckwirkend. */
    methodVersion: text("method_version").notNull(),
    realizedPnlUsd: doublePrecision("realized_pnl_usd"),
    winRate: doublePrecision("win_rate"),
    tradeCount: integer("trade_count"),
    avgReturnPct: doublePrecision("avg_return_pct"),
    earlyEntryRate: doublePrecision("early_entry_rate"),
    medianHoldSeconds: integer("median_hold_seconds"),
    score: integer("score"),
  },
  (t) => [
    index("smart_money_qualified_idx").on(t.qualifiedAt),
    index("smart_money_address_idx").on(t.address),
  ],
);

export const walletClusters = pgTable(
  "wallet_clusters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    methodVersion: text("method_version").notNull(),
    tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }),
    memberCount: integer("member_count").notNull(),
    confidence: doublePrecision("confidence").notNull(),
  },
  (t) => [index("wallet_clusters_token_idx").on(t.tokenId, t.computedAt)],
);

export const walletClusterMembers = pgTable(
  "wallet_cluster_members",
  {
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => walletClusters.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** Welche Kanten die Zuordnung tragen: funding, timing, counterparty, amount. */
    evidence: jsonb("evidence").notNull().default([]),
    confidence: doublePrecision("confidence").notNull(),
  },
  (t) => [primaryKey({ columns: [t.clusterId, t.address] })],
);

export const devWallets = pgTable(
  "dev_wallets",
  {
    address: text("address").primaryKey(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    launchCount: integer("launch_count"),
    rugCount: integer("rug_count"),
    realizedPnlUsd: doublePrecision("realized_pnl_usd"),
    medianTokenLifetimeSeconds: integer("median_token_lifetime_seconds"),
    /** Typische Muster: schnelles Abstossen, gestaffelte Verkaeufe, LP-Abzug. */
    behaviourFlags: jsonb("behaviour_flags").notNull().default([]),
    devScore: integer("dev_score"),
  },
);
