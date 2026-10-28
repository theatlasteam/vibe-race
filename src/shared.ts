export type AiMode = "workspace" | "html";
export type Phase = "lobby" | "playing" | "judging" | "results";

export interface PlayerPublic {
  id: string;
  name: string;
  isHost: boolean;
  isJudge: boolean;
  status: "idle" | "thinking" | "done";
  activity: string;
  fileCount: number;
  turns: number;
}

export interface RoomSettings {
  durationSec: number;
  aiMode: AiMode;
  topicMode: "random" | "custom";
  customTopic: string;
}

export interface RoundPublic {
  topic: string;
  startsAt: number;
  endsAt: number;
  phase: Phase;
  winnerId: string | null;
  winnerName: string | null;
  judgedAt: number | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
}

export interface RoomChatMessage {
  id: string;
  playerId: string;
  name: string;
  text: string;
  at: number;
  judge: boolean;
  host: boolean;
}

export interface SubmissionPublic {
  playerId: string;
  name: string;
  html: string;
  fileCount: number;
  turns: number;
}

export interface PublicRoom {
  code: string;
  hostName: string;
  playerCount: number;
  maxPlayers: number;
  phase: Phase;
  durationSec: number;
  aiMode: AiMode;
  topicMode: "random" | "custom";
  customTopic: string;
}

export interface RoomView {
  code: string;
  phase: Phase;
  settings: RoomSettings;
  players: PlayerPublic[];
  round: RoundPublic | null;
  modelLabel: string;
  judgeId: string | null;
  hostId: string;
  serverNow: number;
  chat: RoomChatMessage[];
}

export type ServerMessage =
  | { t: "hello"; playerId: string; room: RoomView; files: Record<string, string>; chat: ChatMessage[] }
  | { t: "room"; room: RoomView }
  | { t: "rooms"; rooms: PublicRoom[] }
  | { t: "files"; files: Record<string, string> }
  | { t: "chat"; chat: ChatMessage[] }
  | { t: "submissions"; submissions: SubmissionPublic[] }
  | { t: "error"; message: string }
  | { t: "system"; message: string }
  | { t: "sessionExpired" };

export type ClientMessage =
  | { t: "create"; name: string; settings: Partial<RoomSettings> }
  | { t: "join"; code: string; name: string }
  | { t: "browse" }
  | { t: "leave" }
  | { t: "settings"; settings: Partial<RoomSettings> }
  | { t: "start" }
  | { t: "prompt"; text: string }
  | { t: "say"; text: string }
  | { t: "stop" }
  | { t: "write"; path: string; content: string }
  | { t: "createFile"; path: string }
  | { t: "deleteFile"; path: string }
  | { t: "judgePick"; playerId: string }
  | { t: "reset" };

export const DEFAULT_SETTINGS: RoomSettings = {
  durationSec: 600,
  aiMode: "workspace",
  topicMode: "random",
  customTopic: "",
};

export const TOPICS = [
  "Landing page for a next-gen SaaS startup",
  "A portfolio for a type designer who only works in black and white",
  "Product page for a $4,000 mechanical keyboard",
  "Homepage for a fictional space tourism company",
  "A pricing page for an AI that writes bedtime stories",
  "A dashboard for a coffee shop that tracks bean inventory",
  "Landing page for a service that rents out houseplants",
  "A museum site for lost and found objects",
  "A waitlist page for a private members club for dogs",
  "Landing page for a startup that turns voicemails into poems",
  "A brutalist news site for slow news",
  "A booking page for a barber who only cuts in silence",
  "A storefront for handmade ceramic ashtrays",
  "Landing page for an API that measures vibes",
  "A personal site for a retired competitive eater",
  "A dashboard for a rooftop weather station",
  "A manifesto page for an anti-algorithm reading club",
  "A product launch for a candle that smells like an old library",
  "A job board for lighthouse keepers",
  "Landing page for a startup that sells unfinished furniture",
];

export function randomTopic(exclude?: string): string {
  const pool = TOPICS.filter((t) => t !== exclude);
  return pool[Math.floor(Math.random() * pool.length)] ?? TOPICS[0]!;
}

export function fileCount(files: Record<string, string>): number {
  return Object.keys(files).length;
}

export function buildPreviewHtml(files: Record<string, string>): string {
  let html = files["index.html"];
  if (typeof html !== "string") {
    return `<!doctype html><html><body style="margin:0;display:grid;place-items:center;height:100vh;background:#f4f4f0;color:#111;font:14px ui-monospace,monospace"><div>No index.html yet.</div></body></html>`;
  }
  const lookup = (p: string) => {
    const clean = p.replace(/^\.\//, "").replace(/^\//, "");
    return files[clean];
  };
  html = html.replace(
    /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi,
    (tag) => {
      const m = tag.match(/href=["']([^"']+)["']/i);
      const css = m?.[1] ? lookup(m[1]) : undefined;
      if (css === undefined) return tag;
      return `<style>\n${css}\n</style>`;
    },
  );
  html = html.replace(
    /<script\b([^>]*)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
    (tag, pre: string, src: string, post: string) => {
      if (/^https?:|^\/\//i.test(src)) return tag;
      const js = lookup(src);
      if (js === undefined) return tag;
      return `<script${pre}${post}>\n${js}\n</script>`;
    },
  );
  return html;
}

export function secondsLeft(endsAt: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((endsAt - now) / 1000));
}

export function formatClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
