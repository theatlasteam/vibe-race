import { createOpenAI } from "@ai-sdk/openai";
import { isStepCount, streamText, tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import type { AiMode } from "../shared";

const BASE_URL = (process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const API_KEY = process.env.AI_API_KEY || "";
const MODEL = process.env.AI_MODEL || "gpt-4.1-mini";
const MODEL_LABEL = process.env.AI_MODEL_LABEL || MODEL;

export const isMock = !API_KEY;
export const modelLabel = isMock ? `${MODEL_LABEL} (local demo)` : MODEL_LABEL;

const provider = createOpenAI({
  apiKey: API_KEY || "not-configured",
  baseURL: BASE_URL,
  name: "vibe-race",
});

const model = provider.chat(MODEL);
const MAX_STEPS = 8;
const REQUEST_TIMEOUT_MS = 240_000;

export interface AgentEvents {
  onActivity: (text: string) => void;
  onFiles: (files: Record<string, string>) => void;
  onChat: (text: string) => void;
  onStream: (delta: string) => void;
  onTurns: (turns: number) => void;
}

function systemPrompt(topic: string, mode: AiMode): string {
  if (mode === "html") {
    return `You are a fast, opinionated web designer competing in a timed design race.

THEME: "${topic}"
TIME LIMIT: the round is already running. Work quickly and decisively.

HARD RULE — WORKERS MODE: you may ONLY write a single file at "index.html". Exactly one self-contained HTML file. All CSS and JS must be inline inside that file. No other files, no build tools, no external assets, fonts, images, or CDN links. Use system font stacks, inline SVG, gradients, and CSS shapes for visuals.

Match the theme exactly. Make it beautiful, specific, and surprising — not generic. Use real copy, not lorem ipsum. Ship something a human would screenshot.

Workflow: think briefly, then call write_file with path "index.html" and the COMPLETE file. You may rewrite it once to improve details. After the final write, stop — do not keep iterating. Do not write a file named anything else.`;
  }
  return `You are a fast, opinionated web designer competing in a timed design race.

THEME: "${topic}"
TIME LIMIT: the round is already running. Work quickly and decisively.

You have a small workspace. Always keep "index.html" as the entry point. You may create additional .css and .js files and link them with relative paths (e.g. <link rel="stylesheet" href="styles.css">, <script src="script.js"></script>). No external assets, fonts, images, or CDN links — use system fonts, inline SVG, gradients and CSS shapes.

Match the theme exactly. Make it beautiful, specific, and surprising — not generic. Use real copy, not lorem ipsum. Ship something a human would screenshot.

Workflow: think briefly, then call write_file with the complete file contents (not diffs). Keep the file count small and coherent. After the final write, stop — do not keep iterating.`;
}

export function normalizePath(raw: string, mode: AiMode): string | null {
  let p = String(raw || "")
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  if (!p || p.includes("..")) return null;
  if (mode === "html") return p === "index.html" ? p : null;
  if (!/^[a-zA-Z0-9_\-./]+$/.test(p)) return null;
  if (!/\.(html|css|js|svg|txt|json|md)$/i.test(p)) return null;
  return p;
}

export class Agent {
  history: ModelMessage[] = [];
  private controller: AbortController | null = null;
  turns = 0;
  busy = false;

  constructor(
    private ctx: {
      topic: string;
      mode: AiMode;
      playerName: string;
      getFiles: () => Record<string, string>;
      setFile: (path: string, content: string) => void;
      deleteFile: (path: string) => void;
    },
    private events: AgentEvents,
  ) {}

  stop() {
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
  }

  reset() {
    this.stop();
    this.history = [];
    this.turns = 0;
  }

  async send(userText: string) {
    if (this.busy) throw new Error("The AI is already working. Wait for it to finish.");
    this.busy = true;
    this.controller = new AbortController();
    const outer = this.controller;
    const inner = new AbortController();
    const onAbort = () => inner.abort();
    outer.signal.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      inner.abort();
    }, REQUEST_TIMEOUT_MS);

    this.events.onActivity("thinking");
    try {
      if (isMock) {
        await this.mockRun(userText);
        return;
      }
      this.history.push({ role: "user", content: userText });
      if (this.history.length > 40) this.history.splice(0, this.history.length - 40);

      const tools = this.tools();
      const result = streamText({
        model,
        system: systemPrompt(this.ctx.topic, this.ctx.mode),
        messages: this.history,
        tools,
        stopWhen: isStepCount(MAX_STEPS),
        abortSignal: inner.signal,
        temperature: 0.8,
        maxOutputTokens: 8000,
        providerOptions: {
          openai: { reasoningEffort: "low" },
        },
        maxRetries: 1,
        onStepFinish: ({ toolCalls }) => {
          if (toolCalls.length > 0) {
            this.turns++;
            this.events.onTurns(this.turns);
          }
        },
      });

      let text = "";
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") {
          text += part.text;
          this.events.onStream(part.text);
        } else if (part.type === "error") {
          throw part.error;
        } else if (part.type === "tool-call") {
          if (part.toolName !== "finish") this.events.onActivity(`using ${part.toolName}`);
        }
      }

      this.events.onChat(text.trim());
      this.history.push({ role: "assistant", content: text });
      this.events.onActivity("done");
    } catch (err) {
      if (timedOut) {
        const msg = `The AI took longer than ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. Try a shorter prompt.`;
        this.events.onActivity("error");
        this.events.onChat(`⚠ ${msg}`);
        throw new Error(msg);
      }
      if (outer.signal.aborted || (err as Error).name === "AbortError") return;
      this.events.onActivity("error");
      this.events.onChat(`⚠ ${(err as Error).message}`);
      throw err;
    } finally {
      clearTimeout(timer);
      outer.signal.removeEventListener("abort", onAbort);
      this.busy = false;
    }
  }

  private tools(): ToolSet {
    const ctx = this.ctx;
    const events = this.events;
    const isHtml = ctx.mode === "html";

    const writeFile = tool({
      description:
        "Create or overwrite a file with its complete contents. In workers mode the only allowed path is index.html.",
      inputSchema: z.object({
        path: z.string().describe(isHtml ? 'Must be "index.html".' : 'Relative path, e.g. "index.html".'),
        content: z.string().describe("Complete file contents, not a diff."),
      }),
      execute: async ({ path, content }) => {
        const p = normalizePath(path, ctx.mode);
        if (!p) {
          return isHtml
            ? 'Rejected. Workers mode allows only "index.html".'
            : "Invalid path. Use a relative .html, .css, .js, .svg, .json, .md or .txt path.";
        }
        events.onActivity(`writing ${p}`);
        ctx.setFile(p, content);
        events.onFiles(ctx.getFiles());
        return `Wrote ${p} (${content.length} chars).`;
      },
    });

    const readFile = tool({
      description: "Read one file back from the workspace.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const p = normalizePath(path, ctx.mode);
        if (!p) return "Invalid path.";
        const content = ctx.getFiles()[p];
        return content === undefined ? "File not found." : content;
      },
    });

    const listFiles = tool({
      description: "List the files in the workspace.",
      inputSchema: z.object({}),
      execute: async () => Object.keys(ctx.getFiles()).join("\n") || "(empty workspace)",
    });

    const finish = tool({
      description: "Call when the project is ready for judging.",
      inputSchema: z.object({ note: z.string().describe("One-line summary.") }),
      execute: async ({ note }) => {
        events.onActivity("done");
        return `Done: ${note}`;
      },
    });

    const tools: ToolSet = { write_file: writeFile, read_file: readFile, list_files: listFiles, finish };
    if (isHtml) return tools;

    const deleteFile = tool({
      description: "Delete a file from the workspace.",
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path }) => {
        const p = normalizePath(path, ctx.mode);
        if (!p) return "Invalid path.";
        ctx.deleteFile(p);
        events.onFiles(ctx.getFiles());
        return `Deleted ${p}.`;
      },
    });

    tools.delete_file = deleteFile;
    return tools;
  }

  private async mockRun(userText: string) {
    const files = this.ctx.getFiles();
    const existing = files["index.html"];
    this.events.onActivity("thinking");
    await sleep(650);
    if (!existing) {
      this.events.onActivity("writing index.html");
      this.ctx.setFile("index.html", mockPage(this.ctx.topic, userText));
    } else {
      this.events.onActivity("writing index.html");
      this.ctx.setFile("index.html", mockTweak(existing, userText));
    }
    this.events.onFiles(this.ctx.getFiles());
    this.turns++;
    this.events.onTurns(this.turns);
    const note =
      "Local demo model: built a starter page from your prompt. Set AI_API_KEY, AI_MODEL and AI_BASE_URL to use a real model.";
    this.events.onChat(note);
    this.events.onActivity("done");
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function esc(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mockPage(topic: string, prompt: string): string {
  const title = topic.replace(/^(a |an |the )/i, "");
  const kicker = prompt.slice(0, 80);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  :root { --ink:#0b0b0b; --paper:#f2f1ec; --line:#0b0b0b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:ui-serif,Georgia,serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:28px 24px 0; }
  header { display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid var(--line); padding-bottom:14px; font-family:ui-monospace,monospace; font-size:12px; letter-spacing:.14em; text-transform:uppercase; }
  nav a { color:inherit; text-decoration:none; margin-left:20px; }
  .hero { padding:14vh 0 10vh; border-bottom:1px solid var(--line); }
  h1 { font-size:clamp(44px,9vw,124px); line-height:.93; margin:0; font-weight:500; letter-spacing:-.04em; }
  h1 em { font-style:italic; }
  .sub { display:flex; gap:40px; justify-content:space-between; align-items:flex-end; margin-top:44px; flex-wrap:wrap; }
  .sub p { max-width:440px; font-size:19px; line-height:1.45; margin:0; }
  .cta { font-family:ui-monospace,monospace; text-transform:uppercase; letter-spacing:.12em; font-size:12px; border:1px solid var(--line); padding:18px 26px; background:var(--ink); color:var(--paper); text-decoration:none; display:inline-block; }
  .grid { display:grid; grid-template-columns:repeat(3,1fr); border-bottom:1px solid var(--line); }
  .cell { padding:34px 24px 40px; border-right:1px solid var(--line); }
  .cell:last-child { border-right:0; }
  .n { font-family:ui-monospace,monospace; font-size:11px; letter-spacing:.2em; opacity:.5; }
  .cell h3 { font-size:24px; font-weight:500; margin:70px 0 10px; letter-spacing:-.02em; }
  .cell p { font-size:15px; line-height:1.5; margin:0; opacity:.72; }
  footer { display:flex; justify-content:space-between; padding:22px 0 26px; font-family:ui-monospace,monospace; font-size:11px; text-transform:uppercase; letter-spacing:.16em; }
  .mark { display:inline-block; width:9px; height:9px; background:var(--ink); border-radius:50%; margin-right:8px; }
  @media (max-width:760px){ .grid{grid-template-columns:1fr} .cell{border-right:0;border-bottom:1px solid var(--line)} }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span><span class="mark"></span>${esc(title.split(" ").slice(0, 2).join(" "))}</span>
    <nav><a href="#">Work</a><a href="#">About</a><a href="#">Contact</a></nav>
  </header>
  <section class="hero">
    <h1>Built for<br/><em>the ones</em><br/>who notice.</h1>
    <div class="sub">
      <p>${esc(kicker || "A quiet, deliberate take on " + title.toLowerCase() + ".")}</p>
      <a class="cta" href="#">Start now</a>
    </div>
  </section>
  <section class="grid">
    <div class="cell"><div class="n">01</div><h3>Considered</h3><p>Every detail earns its place. Nothing decorative survives the edit.</p></div>
    <div class="cell"><div class="n">02</div><h3>Fast</h3><p>Built on plain HTML and real typography. It loads before you blink.</p></div>
    <div class="cell"><div class="n">03</div><h3>Honest</h3><p>No dark patterns, no growth hacks. Just the thing itself, working.</p></div>
  </section>
  <footer><span>© 2026 ${esc(title)}</span><span>Made in ten minutes</span></footer>
</div>
</body>
</html>`;
}

function mockTweak(html: string, prompt: string): string {
  return html.replace(
    /<\/body>/,
    `<div style="max-width:1100px;margin:0 auto;padding:0 24px 80px"><div style="border:1px solid #0b0b0b;padding:28px;font-family:ui-monospace,monospace;font-size:12px;text-transform:uppercase;letter-spacing:.14em">Applied: ${esc(prompt.slice(0, 120))}</div></div>\n</body>`,
  );
}
