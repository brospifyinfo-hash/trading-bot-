/**
 * Startliste bekannter Adressen mit Sonderrolle.
 *
 * Ohne sie ist Wallet-Clustering wertlos: eine CEX-Hot-Wallet fundet zehntausende
 * voneinander unabhaengiger Nutzer. Nimmt man Funding als Kante, verschmilzt der
 * halbe Markt zu einem Cluster, und die Konzentrationsanalyse meldet Alarm, wo
 * keiner ist — oder, schlimmer, gar nichts mehr.
 *
 * Die Liste ist bewusst klein und ausschliesslich auf Programm- und
 * Systemadressen beschraenkt, die aus der Solana-Kernspezifikation stammen.
 * Boersen- und Bridge-Adressen werden NICHT geraten: sie kommen in Phase 6 aus
 * einer belegbaren Quelle, jeweils mit Herkunftsnachweis in der Spalte `source`.
 * Eine falsch gelabelte Adresse ist schlimmer als eine fehlende — sie schliesst
 * echte Signale stillschweigend aus.
 */

export interface WalletLabelSeed {
  readonly address: string;
  readonly kind:
    | "cex"
    | "bridge"
    | "dex_router"
    | "amm_pool"
    | "burn"
    | "system"
    | "known_bot"
    | "other";
  readonly name: string;
  readonly source: string;
}

export const WALLET_LABEL_SEED: readonly WalletLabelSeed[] = [
  {
    address: "11111111111111111111111111111111",
    kind: "system",
    name: "System Program",
    source: "solana-core",
  },
  {
    address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    kind: "system",
    name: "SPL Token Program",
    source: "solana-program-library",
  },
  {
    address: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    kind: "system",
    name: "SPL Token 2022 Program",
    source: "solana-program-library",
  },
  {
    address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    kind: "system",
    name: "Associated Token Account Program",
    source: "solana-program-library",
  },
  {
    address: "So11111111111111111111111111111111111111112",
    kind: "system",
    name: "Wrapped SOL Mint",
    source: "solana-program-library",
  },
];

/**
 * Adressen, die weiterhin gepflegt werden muessen, bevor Clustering belastbar ist.
 * Bewusst als offene Aufgabe dokumentiert statt mit geratenen Werten gefuellt.
 */
export const WALLET_LABEL_GAPS = [
  "CEX-Hot-Wallets (Binance, Coinbase, Bybit, OKX, Kraken)",
  "Bridge-Adressen (Wormhole, deBridge, Mayan)",
  "DEX-Router (Jupiter, Raydium, Orca, Meteora) — aus offizieller Doku",
  "Bekannte MEV-/Sniper-Bots",
] as const;
