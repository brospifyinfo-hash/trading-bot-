import { createServer, type Server } from "node:http";

/**
 * Liveness und Readiness fuer Compose-Healthchecks.
 *
 * Getrennt, weil sie Unterschiedliches bedeuten: ein Worker, der noch lebt, aber
 * die Datenbank nicht erreicht, darf keine Jobs bekommen — er waere sonst ein
 * Prozess, der Entscheidungen ohne Datengrundlage trifft.
 */
export function startHealthServer(options: {
  readonly port: number;
  readonly isReady: () => boolean;
}): Server {
  const server = createServer((req, res) => {
    if (req.url === "/live") {
      res.writeHead(200).end("ok");
      return;
    }
    if (req.url === "/ready") {
      const ready = options.isReady();
      res.writeHead(ready ? 200 : 503).end(ready ? "ready" : "not-ready");
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(options.port);
  return server;
}
