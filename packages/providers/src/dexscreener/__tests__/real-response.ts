/**
 * Eine echte Antwort von DexScreener, unveraendert.
 *
 * Abgerufen am 2026-09-03:
 *
 *   GET https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112
 *
 * Sie ist die Primaerquelle, aus der `schema.ts` abgeleitet wurde, und liegt
 * hier **wortgleich** — nicht gekuerzt, nicht begradigt, nicht um Felder
 * ergaenzt, die praktisch waeren. Eine bereinigte Stichprobe wuerde ein
 * Antwortformat behaupten, das es so nie gab, und der Test daran waere ein
 * Test gegen unsere eigene Erwartung.
 *
 * Sichtbar bleiben soll insbesondere, was FEHLT: kein `fdv`, kein `marketCap`,
 * kein Zeitstempel zur Preisangabe.
 */
export const DEXSCREENER_REAL_RESPONSE = `[{"chainId":"solana","dexId":"raydium","url":"https://dexscreener.com/solana/58oqchx4ywmvkdwllzzbi4chocc2fqcuwbkwmihlyqo2","pairAddress":"58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2","baseToken":{"address":"So11111111111111111111111111111111111111112","name":"Wrapped SOL","symbol":"SOL"},"quoteToken":{"address":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","name":"USD Coin","symbol":"USDC"},"priceNative":"100.1749","priceUsd":"100.17","txns":{"m5":{"buys":275,"sells":290},"h1":{"buys":3990,"sells":4161},"h6":{"buys":33736,"sells":35190},"h24":{"buys":139017,"sells":128610}},"volume":{"h24":12461528.51,"h6":3308396.52,"h1":311435.21,"m5":20294.25},"priceChange":{"m5":-0.83,"h1":0.29,"h6":-0.45,"h24":1.95},"liquidity":{"usd":14247194.46,"base":70907,"quote":7144076},"pairCreatedAt":1669602450000,"info":{"imageUrl":"https://cdn.dexscreener.com/cms/images/fcfb87378d3198fe753ca08ba51a5552a84f34cf48cd09d83971aa195bdf00d2?width=800&height=800&quality=95&format=auto","header":"https://cdn.dexscreener.com/cms/images/7a8b9d77ffff37a36144cdebff51443a7c35bd737e8f327fc03f1121357731dd?width=1500&height=500&quality=95&format=auto","openGraph":"https://cdn.dexscreener.com/token-images/og/solana/So11111111111111111111111111111111111111112?timestamp=1788435600000","websites":[{"url":"https://solana.com","label":"Website"}],"socials":[{"url":"https://x.com/solana","type":"twitter"}]}}]`;

/** Die Mint-Adresse, zu der die Antwort abgerufen wurde. */
export const REAL_BASE_MINT = "So11111111111111111111111111111111111111112";
export const REAL_QUOTE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const REAL_PAIR_ADDRESS = "58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2";
