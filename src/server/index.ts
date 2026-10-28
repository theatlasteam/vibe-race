import { Hub } from "./rooms";
import { isMock, modelLabel } from "./ai";

const PORT = Number(process.env.PORT || 3000);
const DIST = new URL("../../dist/", import.meta.url).pathname;

async function buildClient() {
  if (process.env.SKIP_BUILD === "1") return;
  const result = await Bun.build({
    entrypoints: [new URL("../../index.html", import.meta.url).pathname],
    outdir: DIST,
    minify: true,
    target: "browser",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Client build failed");
  }
}

await buildClient();

const hub = new Hub();

type SocketData = { code?: string; player?: string };

const server = Bun.serve<SocketData>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const code = url.searchParams.get("code") || "";
      const player = url.searchParams.get("player") || "";
      if (srv.upgrade(req, { data: { code, player } })) return;
      return new Response("Expected websocket", { status: 400 });
    }

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        model: modelLabel,
        mock: isMock,
        rooms: "in-memory",
        now: Date.now(),
      });
    }

    // Static assets from dist
    const safePath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (safePath.includes("..")) return new Response("Not found", { status: 404 });
    const file = Bun.file(DIST + safePath.slice(1));
    if (await file.exists()) {
      const headers: Record<string, string> = {};
      if (safePath.endsWith(".html")) headers["Cache-Control"] = "no-store";
      else headers["Cache-Control"] = "public, max-age=31536000, immutable";
      return new Response(file, { headers });
    }
    // SPA fallback
    const index = Bun.file(DIST + "index.html");
    if (await index.exists())
      return new Response(index, { headers: { "Content-Type": "text/html" } });
    return new Response("Build missing. Run: bun run build", { status: 503 });
  },
  websocket: {
    open(ws) {
      const { code, player } = ws.data;
      let resumed = false;
      if (code && player) {
        resumed = hub.tryResume(ws as never, code, player);
        if (!resumed) {
          ws.send(
            JSON.stringify({
              t: "error",
              message: "That room or session has expired. Create a new room.",
            }),
          );
          ws.send(JSON.stringify({ t: "sessionExpired" }));
        }
      }
      hub.handleOpen(ws as never, resumed);
    },
    message(ws, message) {
      hub.handleMessage(ws as never, String(message));
    },
    close(ws) {
      hub.handleClose(ws as never);
    },
  },
});

console.log(
  `\n  VIBE RACE  ·  http://localhost:${server.port}  ·  model: ${modelLabel}${isMock ? " (local demo)" : ""}\n`,
);

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
