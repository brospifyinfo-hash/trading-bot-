import { NextResponse } from "next/server";

/**
 * Health-Endpunkt.
 *
 * Bewusst ohne Details zu Konfiguration, Versionen oder Providern: ein
 * oeffentlich erreichbarer Endpunkt ist kein Ort fuer Betriebsinformationen.
 */
export function GET() {
  return NextResponse.json({ status: "ok" });
}
