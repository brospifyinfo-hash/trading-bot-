"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function PaperRefresh() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible" && !pending) {
        startTransition(() => router.refresh());
      }
    };
    const timer = window.setInterval(refresh, 15_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [router, pending]);
  return <span className="muted">{pending ? "Aktualisiert …" : "Automatisch alle 15 Sekunden"}</span>;
}
