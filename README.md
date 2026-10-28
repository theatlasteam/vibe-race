# VIBE/RACE

A multiplayer game for workers: everyone gets the same theme, a private workspace, an AI, and a clock. Build the best thing before time runs out. A judge opens every site and picks the winner. You can't see anyone else's workspace until the round is over.

- Real multiplayer over WebSockets (Bun server, in-memory rooms, up to 8 players)
- **Public lobbies** anyone can browse and join, plus private invite links (`?room=CODE`)
- Two modes: **Workspace** (HTML + CSS + JS, multiple files) and **Workers** (the AI may only write a single self-contained `index.html`)
- Real editable workspace with file tree, code editor, live sandboxed preview, and streaming AI chat
- Server-side AI harness built on the Vercel AI SDK — players cannot see or choose the model; it comes from env
- **Live room chat** for the judge and every player, available in the lobby, during the round, and after judging
- Judge flow: after the timer, all entries go on the wall, the judge picks a winner; results broadcast to everyone
- Astryx design system, black-and-white editorial UI with Geist icons

## Run it

```bash
bun install
cp .env.example .env   # fill in AI_API_KEY, AI_MODEL, AI_BASE_URL
bun run start
```

Open http://localhost:3000.

Without an `AI_API_KEY` the app still runs with a local demo model so you can test the full flow (the UI says "local demo").

## Configure the AI

Any OpenAI-compatible `/chat/completions` endpoint with tool calling works:

```
AI_API_KEY=...
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=gpt-4.1-mini
AI_MODEL_LABEL=GPT-4.1 mini   # what players see in the UI
```

`AI_MODEL` is never sent to the browser — only `AI_MODEL_LABEL` is. The agent loop lives in `src/server/ai.ts`. It uses the Vercel AI SDK (`ai` + `@ai-sdk/openai`) against the OpenAI-compatible Chat Completions endpoint, with **streaming enabled**, a 240-second request timeout, and up to 8 tool steps. If your provider returns `504 upstream_timeout` without streaming, this harness already sends `stream: true`.

The AI gets tools for writing, reading, listing and deleting files, plus a finish signal. Workers mode hard-rejects every path except `index.html`, both in the tool layer and in the server's write handler.

## Play with friends

The server needs one public URL. On a box or VM (including a hosted cloud PC):

```bash
bun install
bun run start            # listens on 0.0.0.0:$PORT
cloudflared tunnel --url http://localhost:3000
```

Share the tunnel URL. Friends can open the site and pick your room from **Public lobbies**, or use the invite link (`?room=CODE`). The judge can talk to players in room chat while the round is running.

## Stack

- Bun — server, bundler, WebSockets
- React 19 + Astryx (`@astryxdesign/core`, neutral theme)
- Vercel AI SDK (`ai`, `@ai-sdk/openai`) — streamed tool-calling loop
- Geist icons (`geist-icons`)
- No database: rooms are in memory and expire after 4 idle hours

## Layout

```
src/shared.ts        protocol, topics, preview builder
src/server/ai.ts     AI SDK streaming harness + tools
src/server/rooms.ts  rooms, players, timer, judging
src/server/index.ts  Bun.serve static + websocket
src/client/main.tsx  React UI
src/client/styles.css
index.html
```
