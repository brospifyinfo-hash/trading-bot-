/**
 * Schutz gegen Geheimnisse im Log.
 *
 * Bewusst als ALLOWLIST und nicht als Blocklist: eine Blocklist schuetzt nur vor
 * den Feldnamen, an die jemand gedacht hat. Bei einem System, das private
 * Schluessel in Reichweite hat, ist das die falsche Richtung — hier darf
 * standardmaessig nichts durch, ausser es steht ausdruecklich auf der Liste.
 */

/** Feldnamen, die im Log erscheinen duerfen. Alles andere wird ersetzt. */
export const LOG_ALLOWLIST: ReadonlySet<string> = new Set([
  "level", "time", "msg", "name", "hostname", "pid", "err", "error", "stack", "type",
  "traceId", "decisionId", "intentId", "positionId", "executionId", "tokenId",
  "strategyVersionId", "scoreEngineVersion", "costModelVersion", "methodVersion",
  "mint", "symbol", "pool", "dex", "route", "signature", "slot",
  "mode", "origin", "side", "state", "fromState", "toState", "kind", "reason", "reasons",
  "provider", "status", "latencyMs", "attempt", "retryable", "policy",
  "score", "finalScore", "subScores", "riskLevel", "dataCompleteness",
  "notionalMinor", "currency", "amountRaw", "priceUsd", "liquidityUsd",
  "slippageBps", "priceImpactBps", "feeBps", "costsMinor", "pnlMinor",
  "count", "durationMs", "queue", "jobId", "role", "version", "url", "method", "statusCode",
  // Betriebszustand des Workers. Booleans und Zaehler ohne Geheimnisgehalt —
  // sie standen nur nicht auf der Liste, und die Allowlist schweigt im Zweifel.
  // Das ist richtig so, macht aber genau die Meldungen unlesbar, die man beim
  // ersten Start braucht: "marketDataUsable: [redacted]" beantwortet die Frage
  // nicht, fuer die sie geloggt wurde.
  "marketDataUsable", "snapshotCount", "phase", "canPaperTrade", "liveTradingEnabled",
  "enqueued", "skipped", "ingested", "noSource", "rejected", "completed",
  // Zweiter Durchgang, diesmal systematisch: alle Felder, die die Worker-Rollen
  // tatsaechlich loggen. Der erste Durchgang hatte nur `marketDataUsable`
  // aufgenommen, und beim naechsten echten Start stand dann
  // "marketDataConnected: [redacted]" im Log — dieselbe Luecke, eine Zeile
  // weiter. Ermittelt durch Absuchen aller `logger.*({...})`-Aufrufe in
  // apps/worker und packages.
  //
  // Ausdruecklich NICHT dabei: `message`. Es stammt aus Fehlermeldungen, und
  // die tragen bei Datenbankfehlern die Verbindungszeichenfolge. Wer eine
  // Fehlermeldung braucht, benutzt `err`/`error` — dort ist die Behandlung
  // bewusst und sichtbar.
  "adapters", "attempted", "attempts", "cadence", "dead", "marketDataConnected",
  "measured", "note", "processed", "queued", "running", "summary", "waiting", "written",
  // Dritter Durchgang, mit einem Skript statt mit dem Auge: `added` und `known`
  // aus der Watchlist standen seit ihrer Einfuehrung nicht auf der Liste, und
  // die Startmeldung lautete entsprechend "Watchlist angewendet added:
  // [redacted]". Dazu die Felder des Discovery-Laufs. Zaehler und Kennungen,
  // kein Geheimnisgehalt.
  "added", "known",
  "seen", "fresh", "candidates", "watchlist", "duplicates", "failedSources",
  "withoutAuthorityCheck", "superseded", "noSourceReasons", "unusableQuotes", "mintShape", "wiring",
  // Vierter Durchgang, ausgeloest von einer Frage, die das Log nicht
  // beantworten konnte: „2 von 3 Marktdatenquellen verbunden" — welche denn
  // nicht? Eine Zusammenfassung, die zaehlt statt zu benennen, laesst genau
  // die Frage offen, fuer die man sie liest.
  "providers", "chain",
  // Die aussagekraeftigste Zahl des Systems und ihre Kehrseite: wie viele
  // Snapshots eine Einstiegsentscheidung tragen koennten — und warum die
  // uebrigen es nicht koennen.
  "entryReady", "entryBlocked",
]);

/**
 * Eine Haeufigkeitsauszaehlung als EIN Wert statt als Objekt.
 *
 * Die Allowlist prueft **jeden** Schluessel, auch die in verschachtelten
 * Objekten. Bei einem Histogramm sind die Schluessel aber Daten und keine
 * Feldnamen: `{ POOL_TOO_YOUNG: 4 }` wird zu
 * `{ POOL_TOO_YOUNG: "[redacted]" }` — die Namen kommen durch, die Zahlen
 * nicht. Im Betrieb stand deshalb eine Liste von Gruenden ohne jede Angabe,
 * wie oft welcher zutraf, also genau die Haelfte der Auskunft, um die es
 * ging.
 *
 * Die Gruende einzeln auf die Allowlist zu setzen waere der falsche Weg: es
 * sind offene Wertemengen (Ablehnungsgruende, Fehlerklassen, Anbieternamen),
 * und die Liste waere schon beim naechsten neuen Grund wieder unvollstaendig.
 * Ein String unter einem erlaubten Feldnamen ist die richtige Form.
 *
 * Sortiert nach Haeufigkeit, bei Gleichstand alphabetisch — damit dieselbe
 * Auszaehlung immer gleich aussieht und zwei Zeilen vergleichbar sind.
 */
export function tally(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts);
  if (entries.length === 0) return "";
  return entries
    .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([name, count]) => `${name}=${String(count)}`)
    .join(" ");
}

/**
 * Benannte Zustaende als EIN Wert — dieselbe Begruendung wie bei `tally`.
 *
 * Der Anlass: die Flottenmeldung sagte „2 von 3 Marktdatenquellen verbunden"
 * und verschwieg, welche die dritte war. Eine Zahl beantwortet die Frage
 * „laeuft es?", aber nie die Frage „was fehlt?" — und die zweite ist die, mit
 * der jemand vor dem Log sitzt.
 *
 * Sortiert nach Namen und nicht nach Wert: die Reihenfolge soll zwischen zwei
 * Takten stabil sein, damit ein Unterschied im Log ein Unterschied in der Sache
 * ist und nicht eine Umsortierung.
 */
export function pairs(entries: Readonly<Record<string, string>>): string {
  return Object.entries(entries)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
}

/**
 * Beschreibt die FORM eines Wertes, nie seinen Inhalt.
 *
 * Gedacht fuer genau einen Zweck: einen Anbietervertrag belegen, ohne die
 * Antwort auszugeben. Um ein Schema zu schreiben, braucht man Schluesselnamen,
 * Verschachtelung und Typen — die Werte braucht man nicht. Sie mitzuloggen
 * waere unnoetig und im Zweifel gefaehrlich; die Allowlist waere umgangen,
 * sobald ein Anbieter irgendwo eine Kennung mitschickt.
 *
 * Ausgabe: `result.value.data.parsed.info.decimals:number` je Pfad, sortiert,
 * damit zwei Messungen vergleichbar sind.
 *
 * `null` wird als eigener Typ gefuehrt und nicht mit „fehlt" verwechselt: bei
 * einem Mint-Account ist `mintAuthority: null` die Aussage „niemand kann
 * nachpraegen", also die wichtigste Information ueberhaupt.
 */
export function describeShape(value: unknown, maxPaths = 60): string {
  const paths: string[] = [];

  const walk = (v: unknown, path: string, depth: number): void => {
    if (paths.length >= maxPaths || depth > MAX_DEPTH) return;
    if (v === null) {
      paths.push(`${path}:null`);
      return;
    }
    if (Array.isArray(v)) {
      // Nur das erste Element: eine Liste beschreibt sich durch ihre Form,
      // nicht durch ihre Laenge.
      paths.push(`${path}:array[${String(v.length)}]`);
      if (v.length > 0) walk(v[0], `${path}[]`, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [key, inner] of Object.entries(v as Record<string, unknown>)) {
        walk(inner, path === "" ? key : `${path}.${key}`, depth + 1);
      }
      return;
    }
    paths.push(`${path}:${typeof v}`);
  };

  walk(value, "", 0);
  return paths.sort().join(" ");
}

export const REDACTED = "[redacted]";

const MAX_DEPTH = 6;

/**
 * Ersetzt alles, was nicht auf der Allowlist steht.
 *
 * Arrays und verschachtelte Objekte werden mitgezogen; die Tiefenbegrenzung
 * verhindert, dass ein zyklisches oder absurd tiefes Objekt den Logger blockiert.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[key] = LOG_ALLOWLIST.has(key) ? redact(v, depth + 1) : REDACTED;
    }
    return out;
  }
  return value;
}
