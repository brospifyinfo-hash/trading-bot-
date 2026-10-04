import { and, desc, eq, isNull, lte } from "drizzle-orm";

import type { Database } from "../client";
import { tokenPools, tokens, tokenSecurity, tokenSnapshots } from "../schema/tokens";
import { decisions } from "../schema/decisions";
import { opportunities, paperPositions } from "../schema/opportunities";
import { selectActivePaperTokens } from "../repositories/discovery";

/**
 * „Warum hat er DIESEN Coin nicht gekauft?"
 *
 * Die Frage, die der Betreiber zweimal gestellt hat und die bis hierher nur
 * mit Logzeilen und Vermutungen zu beantworten war. Sie gehoert ins
 * Dashboard: eine Adresse hinein, und heraus kommt Tor fuer Tor, was die
 * gespeicherten Daten sagen.
 *
 * ### Was das beantwortet und was nicht
 *
 * Gelesen wird ausschliesslich, was in der Datenbank STEHT — der juengste
 * Snapshot, der Sicherheitsbefund, die letzte Entscheidung, der Suchraum aus
 * derselben Abfrage, die auch der Worker benutzt.
 *
 * Es ist ausdruecklich KEINE Nachstellung der Entscheidung von damals: die
 * Tore pruefen den HEUTIGEN Stand gegen die HEUTIGEN Einstellungen. Ein Coin,
 * der vor zwei Stunden zu teuer war und jetzt billig ist, erscheint hier als
 * durchgelassen. Wo das zaehlt, steht der Zeitpunkt der Messung daneben, damit
 * niemand das eine fuer das andere haelt. Was der Bot damals SELBST notiert
 * hat, steht getrennt davon in `notierteGruende` — das ist das Protokoll, die
 * Tore sind die Rechnung von jetzt.
 *
 * Kennt die Datenbank die Adresse gar nicht, ist das die wichtigste Antwort
 * von allen: dann hat die Suche den Coin nie gefunden, und keine Einstellung
 * der Welt haette ihn gekauft.
 */
export type CheckVerdict = "OK" | "BLOCKIERT" | "UNBEKANNT";

export interface CoinCheck {
  readonly verdict: CheckVerdict;
  /** Welches Tor. Kurz, aus eigenem Code. */
  readonly tor: string;
  /** Der gemessene Wert gegen die Grenze, als Satz. */
  readonly detail: string;
}

export interface CoinExplanation {
  /** Die Eingabe, so wie sie gestellt wurde. */
  readonly gesucht: string;
  /** Die Mint-Adresse des gefundenen Coins, oder die Eingabe, wenn nichts passte. */
  readonly mint: string;
  readonly bekannt: boolean;
  /**
   * Wie die Eingabe aufgeloest wurde.
   *
   * DexScreener-Links tragen die Adresse des HANDELSPAARS, nicht die des
   * Coins. Wer so einen Link kopiert, sucht mit der Paar-Adresse — und eine
   * Suche, die darauf „nicht gefunden" sagt, waere formal richtig und
   * praktisch eine Falschauskunft.
   */
  readonly gefundenUeber: "MINT" | "HANDELSPAAR" | null;
  readonly symbol: string | null;
  readonly state: string | null;
  readonly firstSeenAt: Date | null;
  readonly launchedAt: Date | null;
  readonly blacklistedAt: Date | null;
  readonly blacklistReason: string | null;
  /** Zeitpunkt des juengsten Snapshots, aus dem die Pruefungen lesen. */
  readonly snapshotAt: Date | null;
  readonly snapshotProvider: string | null;
  /**
   * Wuerde dieser Coin im naechsten Lauf ueberhaupt bewertet? Nicht
   * nachgerechnet, sondern aus derselben Abfrage gelesen, die der Worker
   * benutzt.
   */
  readonly imSuchraum: boolean;
  /**
   * Und wuerde er es auch im Budget von 20 Pruefungen je Lauf? Ein Coin kann
   * alle Filter passieren und trotzdem jeden Lauf hinter 20 besseren liegen.
   */
  readonly imBudget: boolean;
  readonly checks: readonly CoinCheck[];
  readonly letzteEntscheidung: {
    readonly at: Date;
    readonly kind: string;
    readonly finalScore: number | null;
    readonly dataCompleteness: number;
  } | null;
  /** Was der Bot bei der letzten Bewertung selbst aufgeschrieben hat. */
  readonly notierteGruende: {
    readonly at: Date;
    readonly kind: string;
    readonly gruende: readonly string[];
  } | null;
  readonly offenePosition: boolean;
}

export interface CoinLimits {
  readonly maxMarketCapUsd: bigint;
  readonly maxCoinAgeMinutes: number | null;
  readonly minFinalScore: number;
  /**
   * Der gespeicherte Modus. Er entscheidet bei der Haelfte der Tore, ob eine
   * Wissenslucke ein Ausschluss ist — ohne ihn waere diese Auskunft fuer einen
   * der beiden Modi falsch.
   */
  readonly mode: "VORSICHTIG" | "OFFENSIV";
}

/** Untergrenze der Liquiditaet im Suchraum-SQL. Gilt in BEIDEN Modi. */
const LIQUIDITAET_SUCHRAUM_USD = 5_000;
/** Pruefungen je Lauf. Siehe `selectActivePaperTokens`. */
const BUDGET_JE_LAUF = 20;
/** Wie alt Marktdaten hoechstens sein duerfen, um in den Suchraum zu zaehlen. */
const MARKTDATEN_MAX_STUNDEN = 6;

const zahl = (v: number | null): string =>
  v === null ? "nicht gemeldet" : v.toLocaleString("de-DE", { maximumFractionDigits: 2 });

const usd = (v: bigint): string => Number(v).toLocaleString("de-DE");

/** Die Gruende stehen als `jsonb`. Was kein String ist, wird nicht angezeigt. */
function nurTexte(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.length > 0 && v.length <= 200);
}

export async function explainCoin(
  db: Database,
  mint: string,
  now: Date,
  limits: CoinLimits,
): Promise<CoinExplanation> {
  const [direkt] = await db.select().from(tokens).where(eq(tokens.mint, mint)).limit(1);

  // Zweiter Versuch ueber die Paar-Adresse. Siehe `gefundenUeber`.
  let token = direkt;
  let gefundenUeber: "MINT" | "HANDELSPAAR" | null = direkt === undefined ? null : "MINT";
  if (token === undefined) {
    const [ueberPaar] = await db
      .select({ token: tokens })
      .from(tokenPools)
      .innerJoin(tokens, eq(tokens.id, tokenPools.tokenId))
      .where(eq(tokenPools.address, mint))
      .limit(1);
    if (ueberPaar !== undefined) {
      token = ueberPaar.token;
      gefundenUeber = "HANDELSPAAR";
    }
  }

  if (token === undefined) {
    return {
      gesucht: mint,
      mint, bekannt: false, gefundenUeber: null, symbol: null, state: null, firstSeenAt: null, launchedAt: null,
      blacklistedAt: null, blacklistReason: null, snapshotAt: null, snapshotProvider: null,
      imSuchraum: false, imBudget: false,
      letzteEntscheidung: null, notierteGruende: null, offenePosition: false,
      checks: [{
        verdict: "BLOCKIERT",
        tor: "NICHT_GEFUNDEN",
        detail:
          "Diese Adresse steht nicht in der Datenbank — weder als Coin noch als " +
          "Handelspaar. Die Suche hat sie nie gefunden, damit konnte keine Einstellung " +
          "sie kaufen. Das ist eine Frage der Datenquellen, nicht der Einstiegsregeln.",
      }],
    };
  }

  const [snapshot] = await db
    .select()
    .from(tokenSnapshots)
    .where(and(eq(tokenSnapshots.tokenId, token.id), lte(tokenSnapshots.observedAt, now)))
    .orderBy(desc(tokenSnapshots.observedAt))
    .limit(1);

  const [security] = await db
    .select()
    .from(tokenSecurity)
    .where(and(eq(tokenSecurity.tokenId, token.id), lte(tokenSecurity.observedAt, now)))
    .orderBy(desc(tokenSecurity.observedAt))
    .limit(1);

  const [entscheidung] = await db
    .select({
      at: decisions.decidedAt, kind: decisions.decisionKind,
      finalScore: decisions.finalScore, dataCompleteness: decisions.dataCompleteness,
    })
    .from(decisions)
    .where(and(eq(decisions.tokenId, token.id), eq(decisions.isTestFixture, false)))
    .orderBy(desc(decisions.decidedAt))
    .limit(1);

  const [notiz] = await db
    .select({
      at: opportunities.decidedAt, kind: opportunities.decisionKind,
      gruende: opportunities.rejectionReasons, hinweise: opportunities.reasons,
    })
    .from(opportunities)
    .where(and(eq(opportunities.tokenId, token.id), eq(opportunities.isTestFixture, false)))
    .orderBy(desc(opportunities.decidedAt))
    .limit(1);

  // Der Pool traegt `created_at` — die Entstehungszeit, an der die
  // Altersgrenze eigentlich rechnet. Steht sie hier und fehlt sie am Token,
  // ist das kein Datenmangel des Anbieters, sondern ein Uebertragungsfehler
  // bei uns. Die beiden auseinanderhalten zu koennen ist der ganze Punkt.
  const [pool] = await db
    .select({ createdAt: tokenPools.createdAt, address: tokenPools.address })
    .from(tokenPools)
    .where(eq(tokenPools.tokenId, token.id))
    .orderBy(desc(tokenPools.observedAt))
    .limit(1);

  const [offen] = await db
    .select({ id: paperPositions.id })
    .from(paperPositions)
    .where(and(eq(paperPositions.tokenId, token.id), isNull(paperPositions.closedAt)))
    .limit(1);

  // Der Suchraum, nicht nachgerechnet, sondern gelesen: einmal weit (passiert
  // er die Filter?) und einmal mit dem echten Budget (kommt er auch dran?).
  const suchraumLimits = {
    maxMarketCapUsd: limits.maxMarketCapUsd,
    maxCoinAgeMinutes: limits.maxCoinAgeMinutes,
  };
  const [weit, budget] = await Promise.all([
    selectActivePaperTokens(db, now, 1_000, false, suchraumLimits),
    selectActivePaperTokens(db, now, BUDGET_JE_LAUF, false, suchraumLimits),
  ]);
  const imSuchraum = weit.some((t) => t.id === token.id);
  const imBudget = budget.some((t) => t.id === token.id);

  const offensiv = limits.mode === "OFFENSIV";
  /** Was eine WISSENSLUECKE bedeutet — nicht, was ein Befund bedeutet. */
  const lueckeVerdict: CheckVerdict = offensiv ? "UNBEKANNT" : "BLOCKIERT";
  const lueckeText = offensiv
    ? "Im offensiven Modus kein Ausschluss."
    : "Im vorsichtigen Modus ist das ein Ausschluss — er verlangt vollstaendige Daten.";

  const checks: CoinCheck[] = [];
  const pruefe = (verdict: CheckVerdict, tor: string, detail: string): void => {
    checks.push({ verdict, tor, detail });
  };

  // 0. Ist er ueberhaupt dran. Die Frage vor allen Toren.
  pruefe(imSuchraum ? "OK" : "BLOCKIERT", "SUCHRAUM",
    imSuchraum
      ? "Er passiert die Vorauswahl und wird bewertet."
      : "Er passiert die Vorauswahl NICHT und wird gar nicht bewertet. Welches der " +
        "Tore unten das verursacht, steht dort; Tore nach dem Suchraum laufen fuer " +
        "ihn nie.");
  if (imSuchraum) {
    pruefe(imBudget ? "OK" : "BLOCKIERT", "BUDGET",
      imBudget
        ? `Er liegt unter den ersten ${String(BUDGET_JE_LAUF)}, die je Lauf geprueft werden.`
        : `Er passiert die Filter, liegt aber hinter den ersten ${String(BUDGET_JE_LAUF)} ` +
          "Coins, die je Lauf geprueft werden — sortiert wird nach Kaufdruck, dann nach " +
          "Aktualitaet und Liquiditaet. Er wird also nicht abgelehnt, er kommt nicht dran.");
  }

  // 1. Sperre. Terminal, kein Score hilft.
  if (token.blacklistedAt !== null) {
    pruefe("BLOCKIERT", "GESPERRT",
      `Gesperrt am ${token.blacklistedAt.toISOString()}${token.blacklistReason === null ? "" : `: ${token.blacklistReason}`}. Das ist endgueltig.`);
  } else if (token.state === "REJECTED") {
    pruefe("BLOCKIERT", "ABGELEHNT", "Der Coin steht im Zustand REJECTED und wird nicht gehandelt.");
  } else {
    pruefe("OK", "NICHT_GESPERRT", `Zustand ${token.state}.`);
  }

  // 2. Marktdaten. Ohne sie gibt es keine Entscheidung.
  if (snapshot === undefined) {
    pruefe("BLOCKIERT", "KEINE_MARKTDATEN",
      "Zu diesem Coin wurde noch kein Marktdatensatz gespeichert. Die Suche kennt ihn, " +
      "hat aber nie Preis und Liquiditaet dazu geholt.");
  } else {
    const alterStunden = (now.getTime() - snapshot.observedAt.getTime()) / 3_600_000;
    pruefe(alterStunden <= MARKTDATEN_MAX_STUNDEN ? "OK" : "BLOCKIERT", "MARKTDATEN_FRISCH",
      `Juengster Datensatz vor ${alterStunden.toFixed(1)} Stunden (${snapshot.observedAt.toISOString()}), Quelle ${snapshot.sourceProviderId ?? "unbekannt"}. Verlangt: hoechstens ${String(MARKTDATEN_MAX_STUNDEN)} Stunden.`);

    pruefe(snapshot.priceUsd !== null && snapshot.priceUsd > 0 ? "OK" : "BLOCKIERT", "PREIS",
      `Preis ${zahl(snapshot.priceUsd)} USD. Ohne Preis gibt es keinen Einstiegskurs.`);

    pruefe(
      snapshot.liquidityUsd !== null && snapshot.liquidityUsd >= LIQUIDITAET_SUCHRAUM_USD
        ? "OK" : "BLOCKIERT",
      "LIQUIDITAET",
      `Liquiditaet ${zahl(snapshot.liquidityUsd)} USD. Verlangt: mindestens ${LIQUIDITAET_SUCHRAUM_USD.toLocaleString("de-DE")} USD — diese Grenze steht im Suchraum und gilt in BEIDEN Modi, der offensive macht sie nicht auf.`);

    pruefe(snapshot.volume24hUsd !== null && snapshot.volume24hUsd > 0 ? "OK" : "BLOCKIERT",
      "VOLUMEN", `24h-Volumen ${zahl(snapshot.volume24hUsd)} USD. Verlangt: mehr als 0.`);

    const cap = snapshot.marketCapUsd;
    pruefe(
      cap === null || cap <= 0 ? "BLOCKIERT" : cap <= Number(limits.maxMarketCapUsd) ? "OK" : "BLOCKIERT",
      "GROESSE",
      cap === null || cap <= 0
        ? "Keine Marktkapitalisierung gemeldet. Ohne sie ist die Groessengrenze nicht pruefbar, und der Coin faellt heraus."
        : `Marktkapitalisierung ${zahl(cap)} USD. Ihre Grenze: ${usd(limits.maxMarketCapUsd)} USD.`);

    // Die Ausfuehrungsfelder, an denen der strenge Modus haengt.
    pruefe(snapshot.priceImpactBps === null ? lueckeVerdict : "OK", "PREISEINFLUSS",
      snapshot.priceImpactBps === null
        ? `Nicht gemessen — kommt nur vom Router. ${lueckeText}`
        : `${zahl(snapshot.priceImpactBps)} Basispunkte.`);
    pruefe(snapshot.exitCapacityRatio === null ? lueckeVerdict : "OK", "AUSSTIEGSFAEHIGKEIT",
      snapshot.exitCapacityRatio === null
        ? `Nicht gemessen — braucht eine Verkaufssonde beim Router. ${lueckeText}`
        : `Faktor ${zahl(snapshot.exitCapacityRatio)}.`);

    // Kaufdruck. Die ZAHL blockiert in beiden Modi, der ANTEIL nur im strengen.
    const kaeufe = snapshot.buys5m;
    pruefe(kaeufe === null ? lueckeVerdict : kaeufe >= 1 ? "OK" : "BLOCKIERT", "KAUFDRUCK",
      kaeufe === null
        ? `Transaktionszahlen nicht gemeldet. ${lueckeText}`
        : `${String(kaeufe)} Kaeufe in fuenf Minuten, ${zahl(snapshot.sells5m)} Verkaeufe. Verlangt: mindestens 1 Kauf — in beiden Modi.`);
    if (kaeufe !== null && snapshot.sells5m !== null && kaeufe + snapshot.sells5m > 0) {
      const anteil = kaeufe / (kaeufe + snapshot.sells5m);
      pruefe(offensiv || anteil >= 0.3 ? "OK" : "BLOCKIERT", "KAUFANTEIL",
        `${(anteil * 100).toFixed(0)} % der Transaktionen sind Kaeufe. Verlangt: ${offensiv ? "nichts — der offensive Modus hat diese Grenze auf 0" : "mindestens 30 %"}.`);
    }
  }

  // 3. Alter.
  if (limits.maxCoinAgeMinutes === null) {
    pruefe("OK", "ALTER", "Keine Altersgrenze gesetzt.");
  } else if (token.launchedAt === null) {
    pruefe("BLOCKIERT", "ALTER",
      "Entstehungszeit des Pools unbekannt. Bei gesetzter Altersgrenze ist das ein " +
      "Ausschluss in beiden Modi: wer nur neue Coins will, kann einen Coin unbekannten " +
      "Alters nicht durchlassen." +
      (pool?.createdAt === undefined || pool.createdAt === null
        ? " Sie wird nachgetragen, sobald der Anbieter sie mitschickt."
        : ` ACHTUNG: am Handelspaar STEHT eine Entstehungszeit (${pool.createdAt.toISOString()}), ` +
          "nur am Coin fehlt sie. Das ist dann kein Datenmangel des Anbieters, sondern " +
          "ein Uebertragungsfehler bei uns — die Nachtragung greift hier."));
  } else {
    const alterMinuten = (now.getTime() - token.launchedAt.getTime()) / 60_000;
    pruefe(alterMinuten <= limits.maxCoinAgeMinutes ? "OK" : "BLOCKIERT", "ALTER",
      `Pool entstand vor ${alterMinuten.toFixed(0)} Minuten (${token.launchedAt.toISOString()}). Ihre Grenze: ${String(limits.maxCoinAgeMinutes)} Minuten.`);
  }

  // 4. Sicherheit. Die drei Befunde und die Risikostufe blockieren auch offensiv.
  if (security === undefined) {
    pruefe(lueckeVerdict, "SICHERHEIT",
      `Kein Sicherheitsbefund gespeichert — vier der dreizehn Pflichtfelder fehlen damit. ${lueckeText}`);
  } else {
    const befunde: readonly (readonly [string, boolean | null, boolean])[] = [
      ["Mint-Autoritaet aktiv", security.mintAuthorityActive, true],
      ["Freeze-Autoritaet aktiv", security.freezeAuthorityActive, true],
      ["Liquiditaet gesperrt oder verbrannt", security.lpBurnedOrLocked, false],
    ];
    for (const [name, wert, schlecht] of befunde) {
      pruefe(wert === null ? lueckeVerdict : wert === schlecht ? "BLOCKIERT" : "OK", "SICHERHEIT",
        `${name}: ${wert === null ? "nicht gemessen" : wert ? "ja" : "nein"}. ` +
        (wert === null
          ? lueckeText
          : wert === schlecht
            ? "Das blockiert auch im offensiven Modus — es ist ein BEFUND, keine Wissenslucke."
            : ""));
    }
    pruefe(
      security.riskLevel === "CRITICAL" ? "BLOCKIERT"
        : security.riskLevel === null ? lueckeVerdict : "OK",
      "RISIKOSTUFE",
      security.riskLevel === null
        ? `Risikostufe nicht gemessen. ${lueckeText}`
        : `Risikostufe ${security.riskLevel}. CRITICAL blockiert in beiden Modi.`);

    const grenze = offensiv ? 100 : 60;
    pruefe(
      security.top10HolderSharePct === null ? lueckeVerdict
        : security.top10HolderSharePct <= grenze ? "OK" : "BLOCKIERT",
      "HALTERKONZENTRATION",
      security.top10HolderSharePct === null
        ? `Nicht gemessen. ${lueckeText}`
        : `Die groessten zehn Halter haben ${zahl(security.top10HolderSharePct)} %. Grenze in Ihrem Modus: ${String(grenze)} %${offensiv ? " — also praktisch keine" : ""}.`);
  }

  // 5. Der Score gegen Ihre Schwelle. Erst hier, denn alles davor ist ein Tor
  //    und laeuft VOR der Schwelle: ein geschlossenes Tor macht die Schwelle
  //    bedeutungslos, und genau das war der Fehler aus §144.
  if (entscheidung !== undefined) {
    pruefe(
      entscheidung.finalScore === null ? "UNBEKANNT"
        : entscheidung.finalScore >= limits.minFinalScore ? "OK" : "BLOCKIERT",
      "SCHWELLE",
      entscheidung.finalScore === null
        ? `Beim letzten Lauf (${entscheidung.at.toISOString()}) kam kein Score zustande — die Datenlage reichte nicht. Dann entscheidet die Schwelle nichts, egal wie niedrig sie steht.`
        : `Letzter Score ${String(entscheidung.finalScore)} gegen Ihre Schwelle ${String(limits.minFinalScore)}, gemessen am ${entscheidung.at.toISOString()}.`);
  }

  // 6. Schon im Bestand.
  if (offen !== undefined) {
    pruefe("BLOCKIERT", "SCHON_IM_BESTAND",
      "Zu diesem Coin laeuft bereits eine offene Position. Ein zweiter Einstieg in " +
      "denselben Coin wird abgelehnt.");
  }

  const gruende = notiz === undefined
    ? []
    : [...nurTexte(notiz.gruende), ...nurTexte(notiz.hinweise)];

  return {
    gesucht: mint,
    mint: token.mint,
    bekannt: true,
    gefundenUeber,
    symbol: token.symbol,
    state: token.state,
    firstSeenAt: token.firstSeenAt,
    launchedAt: token.launchedAt,
    blacklistedAt: token.blacklistedAt,
    blacklistReason: token.blacklistReason,
    snapshotAt: snapshot?.observedAt ?? null,
    snapshotProvider: snapshot?.sourceProviderId ?? null,
    imSuchraum,
    imBudget,
    checks,
    letzteEntscheidung: entscheidung === undefined ? null : {
      at: entscheidung.at, kind: entscheidung.kind,
      finalScore: entscheidung.finalScore, dataCompleteness: entscheidung.dataCompleteness,
    },
    notierteGruende: notiz === undefined || gruende.length === 0 ? null : {
      at: notiz.at, kind: notiz.kind, gruende,
    },
    offenePosition: offen !== undefined,
  };
}
