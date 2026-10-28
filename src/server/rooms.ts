import {
  DEFAULT_SETTINGS,
  fileCount,
  buildPreviewHtml,
  randomTopic,
  type ClientMessage,
  type AiMode,
  type ChatMessage,
  type PlayerPublic,
  type PublicRoom,
  type RoomSettings,
  type RoomView,
  type ServerMessage,
  type RoomChatMessage,
  type SubmissionPublic,
  type Phase,
  type RoundPublic,
} from "../shared";
import { Agent, modelLabel, normalizePath } from "./ai";

export interface Socket {
  send: (data: string) => void;
  close: () => void;
}

interface Player {
  id: string;
  name: string;
  socket: Socket | null;
  isHost: boolean;
  isJudge: boolean;
  status: "idle" | "thinking" | "done";
  activity: string;
  turns: number;
  files: Record<string, string>;
  chat: ChatMessage[];
  liveChatId: string | null;
  lastStreamAt: number;
  agent: Agent | null;
  joinedAt: number;
}

interface Room {
  code: string;
  players: Map<string, Player>;
  settings: RoomSettings;
  phase: Phase;
  topic: string;
  startsAt: number;
  endsAt: number;
  winnerId: string | null;
  winnerName: string | null;
  judgedAt: number | null;
  judgeId: string | null;
  hostId: string;
  submissions: SubmissionPublic[];
  chat: RoomChatMessage[];
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

const MAX_PLAYERS = 8;
const ROOM_TTL = 1000 * 60 * 60 * 4;
const rooms = new Map<string, Room>();
const watchers = new Set<Socket>();
let lobbyTimer: ReturnType<typeof setTimeout> | null = null;

function id(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function makeCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = "";
    for (let i = 0; i < 4; i++)
      code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return String(Math.floor(1000 + Math.random() * 9000));
}

function roomOf(code: string): Room | undefined {
  return rooms.get(code.toUpperCase());
}

function send(ws: Socket, msg: ServerMessage) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket closed */
  }
}

function publicPlayer(p: Player): PlayerPublic {
  return {
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    isJudge: p.isJudge,
    status: p.status,
    activity: p.activity,
    fileCount: fileCount(p.files),
    turns: p.turns,
  };
}

function roundOf(room: Room): RoundPublic | null {
  if (room.phase === "lobby") return null;
  return {
    topic: room.topic,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    phase: room.phase,
    winnerId: room.winnerId,
    winnerName: room.winnerName,
    judgedAt: room.judgedAt,
  };
}

function view(room: Room): RoomView {
  const players = [...room.players.values()].sort(
    (a, b) => Number(b.isHost) - Number(a.isHost) || a.joinedAt - b.joinedAt,
  );
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    players: players.map(publicPlayer),
    round: roundOf(room),
    modelLabel,
    judgeId: room.judgeId,
    hostId: room.hostId,
    serverNow: Date.now(),
    chat: room.chat,
  };
}

function broadcast(room: Room, except?: Player) {
  const msg = JSON.stringify({ t: "room", room: view(room) } satisfies ServerMessage);
  for (const p of room.players.values()) {
    if (p === except || !p.socket) continue;
    try {
      p.socket.send(msg);
    } catch {
      /* ignore */
    }
  }
  scheduleRooms();
}

function publicRooms(): PublicRoom[] {
  const list: PublicRoom[] = [];
  for (const room of rooms.values()) {
    const connected = [...room.players.values()].filter((p) => p.socket);
    if (connected.length === 0) continue;
    const host = room.players.get(room.hostId);
    list.push({
      code: room.code,
      hostName: host?.name ?? "—",
      playerCount: connected.length,
      maxPlayers: MAX_PLAYERS,
      phase: room.phase,
      durationSec: room.settings.durationSec,
      aiMode: room.settings.aiMode,
      topicMode: room.settings.topicMode,
      customTopic: room.settings.customTopic,
    });
  }
  return list.sort((a, b) => {
    if (a.phase === "lobby" && b.phase !== "lobby") return -1;
    if (b.phase === "lobby" && a.phase !== "lobby") return 1;
    return a.code.localeCompare(b.code);
  });
}

function sendRooms(ws: Socket) {
  send(ws, { t: "rooms", rooms: publicRooms() });
}

function scheduleRooms() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(() => {
    lobbyTimer = null;
    for (const ws of watchers) sendRooms(ws);
  }, 250);
  lobbyTimer.unref?.();
}

function watchLobby(ws: Socket) {
  watchers.add(ws);
  sendRooms(ws);
}

function sendTo(p: Player, msg: ServerMessage) {
  if (p.socket) send(p.socket, msg);
}

function addChat(p: Player, msg: ChatMessage) {
  p.chat.push(msg);
  if (p.chat.length > 80) p.chat.splice(0, p.chat.length - 80);
}

function systemChat(p: Player, text: string) {
  addChat(p, { id: id("m"), role: "system", text });
  sendTo(p, { t: "chat", chat: p.chat });
}

function ensureAgent(room: Room, p: Player): Agent {
  if (p.agent) return p.agent;
  const agent = new Agent(
    {
      topic: room.topic,
      mode: room.settings.aiMode,
      playerName: p.name,
      getFiles: () => p.files,
      setFile: (path, content) => {
        p.files[path] = content;
      },
      deleteFile: (path) => {
        delete p.files[path];
      },
    },
    {
      onActivity: (text) => {
        p.activity = text;
        if (text === "thinking") p.status = "thinking";
        if (text === "done" || text === "ready") p.status = "done";
        if (text === "error") p.status = "idle";
        broadcast(room);
      },
      onFiles: (files) => {
        p.files = files;
        sendTo(p, { t: "files", files: p.files });
        broadcast(room);
      },
      onStream: (delta) => {
        if (!delta) return;
        if (!p.liveChatId) {
          p.liveChatId = id("live_");
          addChat(p, { id: p.liveChatId, role: "assistant", text: delta });
        } else {
          const live = p.chat.find((m) => m.id === p.liveChatId);
          if (live) live.text += delta;
          else addChat(p, { id: p.liveChatId, role: "assistant", text: delta });
        }
        const now = Date.now();
        if (now - p.lastStreamAt > 180) {
          p.lastStreamAt = now;
          sendTo(p, { t: "chat", chat: p.chat });
        }
      },
      onChat: (text) => {
        const liveId = p.liveChatId;
        p.liveChatId = null;
        if (liveId) {
          const live = p.chat.find((m) => m.id === liveId);
          if (live) {
            if (text) live.text = text;
            else p.chat = p.chat.filter((m) => m.id !== liveId);
          } else if (text) {
            addChat(p, { id: id("m"), role: "assistant", text });
          }
        } else if (text) {
          addChat(p, { id: id("m"), role: "assistant", text });
        }
        sendTo(p, { t: "chat", chat: p.chat });
      },
      onTurns: (turns) => {
        p.turns = turns;
        broadcast(room);
      },
    },
  );
  p.agent = agent;
  return agent;
}

function clearTimer(room: Room) {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
}

function startRound(room: Room) {
  clearTimer(room);
  const topic =
    room.settings.topicMode === "custom" && room.settings.customTopic.trim()
      ? room.settings.customTopic.trim()
      : randomTopic(room.topic);
  room.topic = topic;
  room.phase = "playing";
  room.startsAt = Date.now();
  room.endsAt = room.startsAt + room.settings.durationSec * 1000;
  room.winnerId = null;
  room.winnerName = null;
  room.judgedAt = null;
  room.submissions = [];
  for (const p of room.players.values()) {
    p.agent?.stop();
    p.agent = null;
    p.files = {};
    p.chat = [];
    p.turns = 0;
    p.liveChatId = null;
    p.lastStreamAt = 0;
    p.status = "idle";
    p.activity = "waiting for a prompt";
  }
  room.timer = setTimeout(() => endRound(room), room.settings.durationSec * 1000);
  for (const p of room.players.values()) {
    ensureAgent(room, p).reset();
    sendTo(p, { t: "files", files: p.files });
    sendTo(p, { t: "chat", chat: p.chat });
    systemChat(
      p,
      room.settings.aiMode === "html"
        ? "Workers mode: your AI can only write a single index.html."
        : "Workspace mode: your AI can write HTML, CSS and JS files.",
    );
  }
  broadcast(room);
}

function endRound(room: Room) {
  if (room.phase !== "playing") return;
  clearTimer(room);
  room.phase = "judging";
  room.endsAt = Math.min(room.endsAt, Date.now());
  const subs: SubmissionPublic[] = [];
  for (const p of room.players.values()) {
    p.agent?.stop();
    if (p.status !== "idle") p.status = "done";
    p.activity = "time";
    subs.push({
      playerId: p.id,
      name: p.name,
      html: buildPreviewHtml(p.files),
      fileCount: fileCount(p.files),
      turns: p.turns,
    });
  }
  room.submissions = subs;
  const msg: ServerMessage = { t: "submissions", submissions: subs };
  for (const p of room.players.values()) sendTo(p, msg);
  broadcast(room);
}

function pickWinner(room: Room, judge: Player, playerId: string) {
  if (room.phase !== "judging") throw new Error("Judging is not open.");
  if (room.judgeId !== judge.id) throw new Error("Only the judge can pick a winner.");
  const sub = room.submissions.find((s) => s.playerId === playerId);
  if (!sub) throw new Error("That entry does not exist.");
  room.winnerId = sub.playerId;
  room.winnerName = sub.name;
  room.judgedAt = Date.now();
  room.phase = "results";
  const winner = room.players.get(playerId);
  if (winner) {
    systemChat(winner, "The judge picked your project. You won this round.");
  }
  broadcast(room);
}

function resetRoom(room: Room, player: Player) {
  if (!player.isHost) throw new Error("Only the host can start a new round.");
  clearTimer(room);
  room.phase = "lobby";
  room.topic = "";
  room.startsAt = 0;
  room.endsAt = 0;
  room.winnerId = null;
  room.winnerName = null;
  room.judgedAt = null;
  room.submissions = [];
  for (const p of room.players.values()) {
    p.agent?.stop();
    p.agent = null;
    p.files = {};
    p.chat = [];
    p.turns = 0;
    p.liveChatId = null;
    p.lastStreamAt = 0;
    p.status = "idle";
    p.activity = "waiting in the lobby";
    sendTo(p, { t: "files", files: p.files });
    sendTo(p, { t: "chat", chat: p.chat });
  }
  broadcast(room);
}

function cleanup() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const empty = [...room.players.values()].every((p) => !p.socket);
    if (now - room.createdAt > ROOM_TTL || (empty && now - room.createdAt > 1000 * 60 * 30)) {
      clearTimer(room);
      for (const p of room.players.values()) p.agent?.stop();
      rooms.delete(code);
    }
  }
  scheduleRooms();
}
setInterval(cleanup, 60_000).unref?.();

function addPlayer(
  room: Room,
  name: string,
  ws: Socket,
  opts: { host?: boolean; judge?: boolean } = {},
): Player {
  const p: Player = {
    id: id("p_"),
    name,
    socket: ws,
    isHost: !!opts.host,
    isJudge: !!opts.judge,
    status: "idle",
    activity: room.phase === "playing" ? "just joined" : "waiting in the lobby",
    turns: 0,
    files: {},
    chat: [],
    liveChatId: null,
    lastStreamAt: 0,
    agent: null,
    joinedAt: Date.now(),
  };
  room.players.set(p.id, p);
  if (p.isHost) room.hostId = p.id;
  if (p.isJudge) room.judgeId = p.id;
  return p;
}

export class Hub {
  private sockets = new Map<Socket, { roomCode: string; playerId: string }>();

  handleOpen(ws: Socket, resumed = false) {
    if (!resumed) watchLobby(ws);
  }

  handleClose(ws: Socket) {
    watchers.delete(ws);
    const link = this.sockets.get(ws);
    if (!link) return;
    this.sockets.delete(ws);
    const room = roomOf(link.roomCode);
    if (!room) return;
    const p = room.players.get(link.playerId);
    if (!p) return;
    p.socket = null;
    p.agent?.stop();
    if (room.phase === "playing" && p.status === "thinking") p.status = "idle";
    broadcast(room);
    scheduleRooms();
  }

  handleMessage(ws: Socket, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return send(ws, { t: "error", message: "Malformed message." });
    }
    try {
      switch (msg.t) {
        case "create":
          return this.create(ws, msg);
        case "join":
          return this.join(ws, msg);
        case "browse":
          return sendRooms(ws);
        default:
          return this.act(ws, msg);
      }
    } catch (err) {
      return send(ws, { t: "error", message: (err as Error).message });
    }
  }

  private create(ws: Socket, msg: { name: string; settings?: Partial<RoomSettings> }) {
    const name = String(msg.name || "").trim().slice(0, 24) || "Host";
    const code = makeCode();
    const settings: RoomSettings = { ...DEFAULT_SETTINGS, ...sanitizeSettings(msg.settings) };
    const room: Room = {
      code,
      players: new Map(),
      settings,
      phase: "lobby",
      topic: "",
      startsAt: 0,
      endsAt: 0,
      winnerId: null,
      winnerName: null,
      judgedAt: null,
      judgeId: null,
      hostId: "",
      submissions: [],
      chat: [],
      timer: null,
      createdAt: Date.now(),
    };
    rooms.set(code, room);
    const p = addPlayer(room, name, ws, { host: true, judge: true });
    this.sockets.set(ws, { roomCode: code, playerId: p.id });
    watchers.delete(ws);
    send(ws, { t: "hello", playerId: p.id, room: view(room), files: p.files, chat: p.chat });
    broadcast(room);
  }

  private join(ws: Socket, msg: { code: string; name: string }) {
    const room = roomOf(String(msg.code || "").trim());
    if (!room) throw new Error("Room not found. Check the code.");
    if (room.players.size >= MAX_PLAYERS) throw new Error("This room is full (8 players).");
    if (room.phase !== "lobby")
      throw new Error("This round already started. Wait for the lobby.");
    const name = String(msg.name || "").trim().slice(0, 24) || "Player";
    if ([...room.players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase()))
      throw new Error("That name is taken in this room.");
    const p = addPlayer(room, name, ws);
    this.sockets.set(ws, { roomCode: room.code, playerId: p.id });
    watchers.delete(ws);
    send(ws, { t: "hello", playerId: p.id, room: view(room), files: p.files, chat: p.chat });
    broadcast(room);
  }

  private resume(ws: Socket, code: string, playerId: string): boolean {
    const room = roomOf(code);
    if (!room) return false;
    const p = room.players.get(playerId);
    if (!p) return false;
    p.socket = ws;
    this.sockets.set(ws, { roomCode: room.code, playerId: p.id });
    if (room.phase === "playing") ensureAgent(room, p);
    send(ws, {
      t: "hello",
      playerId: p.id,
      room: view(room),
      files: p.files,
      chat: p.chat,
    });
    if (room.phase === "judging" || room.phase === "results")
      send(ws, { t: "submissions", submissions: room.submissions });
    broadcast(room);
    return true;
  }

  tryResume(ws: Socket, code: string, playerId: string) {
    return this.resume(ws, code, playerId);
  }

  private ctx(ws: Socket) {
    const link = this.sockets.get(ws);
    if (!link) throw new Error("Join a room first.");
    const room = roomOf(link.roomCode);
    if (!room) throw new Error("Room no longer exists.");
    const player = room.players.get(link.playerId);
    if (!player) throw new Error("Player no longer exists.");
    return { room, player };
  }

  private act(ws: Socket, msg: Exclude<ClientMessage, { t: "create" } | { t: "join" }>) {
    const { room, player } = this.ctx(ws);
    switch (msg.t) {
      case "leave": {
        player.agent?.stop();
        room.players.delete(player.id);
        this.sockets.delete(ws);
        if (room.players.size === 0) {
          clearTimer(room);
          rooms.delete(room.code);
          watchLobby(ws);
          scheduleRooms();
          return;
        }
        if (room.hostId === player.id) {
          const next = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
          if (next) {
            next.isHost = true;
            room.hostId = next.id;
          }
        }
        if (room.judgeId === player.id) {
          const next = room.players.get(room.hostId);
          if (next) {
            next.isJudge = true;
            room.judgeId = next.id;
          }
        }
        watchLobby(ws);
        broadcast(room);
        return;
      }
      case "settings": {
        if (!player.isHost) throw new Error("Only the host can change settings.");
        if (room.phase !== "lobby") throw new Error("Settings are locked during a round.");
        room.settings = { ...room.settings, ...sanitizeSettings(msg.settings) };
        broadcast(room);
        return;
      }
      case "start": {
        if (!player.isHost) throw new Error("Only the host can start the round.");
        if (room.phase === "playing") throw new Error("The round is already running.");
        startRound(room);
        return;
      }
      case "prompt": {
        if (room.phase !== "playing") throw new Error("The round is not running.");
        const text = String(msg.text || "").trim().slice(0, 4000);
        if (!text) return;
        const agent = ensureAgent(room, player);
        addChat(player, { id: id("m"), role: "user", text });
        sendTo(player, { t: "chat", chat: player.chat });
        player.status = "thinking";
        player.activity = "thinking";
        broadcast(room);
        void agent.send(text).catch((err) => {
          player.status = "idle";
          player.activity = "error";
          systemChat(player, (err as Error).message);
          broadcast(room);
        });
        return;
      }
      case "stop": {
        player.agent?.stop();
        player.liveChatId = null;
        player.status = "idle";
        player.activity = "stopped";
        systemChat(player, "Stopped the AI.");
        broadcast(room);
        return;
      }
      case "say": {
        const text = String(msg.text || "").trim().slice(0, 500);
        if (!text) return;
        const entry: RoomChatMessage = {
          id: id("c"),
          playerId: player.id,
          name: player.name,
          text,
          at: Date.now(),
          judge: player.isJudge,
          host: player.isHost,
        };
        room.chat.push(entry);
        if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100);
        broadcast(room);
        return;
      }
      case "write": {
        if (room.phase !== "playing") throw new Error("Editing is locked.");
        const path = normalizePath(msg.path, room.settings.aiMode);
        if (!path) throw new Error("That file is not allowed in this mode.");
        player.files[path] = String(msg.content ?? "").slice(0, 400_000);
        sendTo(player, { t: "files", files: player.files });
        broadcast(room);
        return;
      }
      case "createFile": {
        if (room.phase !== "playing") throw new Error("Editing is locked.");
        const path = normalizePath(msg.path, room.settings.aiMode);
        if (!path) throw new Error("That file is not allowed in this mode.");
        if (player.files[path] !== undefined) throw new Error("That file already exists.");
        player.files[path] = "";
        sendTo(player, { t: "files", files: player.files });
        broadcast(room);
        return;
      }
      case "deleteFile": {
        if (room.phase !== "playing") throw new Error("Editing is locked.");
        if (room.settings.aiMode === "html") throw new Error("Workers mode has only index.html.");
        if (msg.path === "index.html") throw new Error("Keep index.html.");
        delete player.files[msg.path];
        sendTo(player, { t: "files", files: player.files });
        broadcast(room);
        return;
      }
      case "judgePick":
        return pickWinner(room, player, msg.playerId);
      case "reset":
        return resetRoom(room, player);
    }
  }
}

function sanitizeSettings(input: unknown): Partial<RoomSettings> {
  if (!input || typeof input !== "object") return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<RoomSettings> = {};
  if (typeof raw.durationSec === "number") {
    const allowed = [180, 300, 600, 900, 1200];
    if (process.env.DEV_SHORT_ROUNDS === "1") allowed.push(6);
    out.durationSec = allowed.includes(raw.durationSec) ? raw.durationSec : 600;
  }
  if (raw.aiMode === "workspace" || raw.aiMode === "html") out.aiMode = raw.aiMode;
  if (raw.topicMode === "random" || raw.topicMode === "custom")
    out.topicMode = raw.topicMode;
  if (typeof raw.customTopic === "string")
    out.customTopic = raw.customTopic.slice(0, 140);
  return out;
}
