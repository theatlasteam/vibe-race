import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@astryxdesign/core/theme";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Badge } from "@astryxdesign/core/Badge";
import {
  ArrowRight,
  Cross,
  CrossSmall,
  ExternalSmall,
  Message,
  PaperAirplane,
  RefreshClockwise,
  Sparkles,
} from "geist-icons";
import { themes, defaultThemeSlug } from "../../astryx-themes.ts";
import {
  buildPreviewHtml,
  formatClock,
  type ChatMessage,
  type ClientMessage,
  type PublicRoom,
  type RoomView,
  type ServerMessage,
  type SubmissionPublic,
} from "../shared";
import "./styles.css";

const SESSION_KEY = "vibe-race-session";

interface Session {
  code: string;
  playerId: string;
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (s.code && s.playerId) return s;
  } catch {
    /* ignore */
  }
  return null;
}

function saveSession(s: Session | null) {
  try {
    if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

interface Conn {
  connected: boolean;
  playerId: string | null;
  room: RoomView | null;
  files: Record<string, string>;
  chat: ChatMessage[];
  submissions: SubmissionPublic[];
  publicRooms: PublicRoom[];
  error: string | null;
  offset: number;
  send: (msg: ClientMessage) => void;
  clearError: () => void;
  leave: () => void;
}

function useConn(): Conn {
  const [connected, setConnected] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const [submissions, setSubmissions] = useState<SubmissionPublic[]>([]);
  const [publicRooms, setPublicRooms] = useState<PublicRoom[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const sessionRef = useRef<Session | null>(loadSession());
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      const s = sessionRef.current;
      const qs = s
        ? `?code=${encodeURIComponent(s.code)}&player=${encodeURIComponent(s.playerId)}`
        : "";
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws${qs}`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(connect, 1400);
      };
      ws.onmessage = (ev) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        switch (msg.t) {
          case "hello": {
            sessionRef.current = { code: msg.room.code, playerId: msg.playerId };
            saveSession(sessionRef.current);
            setPlayerId(msg.playerId);
            setRoom(msg.room);
            setFiles(msg.files);
            setChat(msg.chat);
            setSubmissions([]);
            setOffset(msg.room.serverNow - Date.now());
            break;
          }
          case "room":
            setRoom(msg.room);
            setOffset(msg.room.serverNow - Date.now());
            break;
          case "files":
            setFiles(msg.files);
            break;
          case "chat":
            setChat(msg.chat);
            break;
          case "submissions":
            setSubmissions(msg.submissions);
            break;
          case "rooms":
            setPublicRooms(msg.rooms);
            break;
          case "error":
            setError(msg.message);
            break;
          case "sessionExpired":
            sessionRef.current = null;
            saveSession(null);
            setPlayerId(null);
            setRoom(null);
            setFiles({});
            setChat([]);
            setSubmissions([]);
            break;
          case "system":
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else setError("Not connected. Reconnecting…");
  }, []);

  const leave = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "leave" }));
    sessionRef.current = null;
    saveSession(null);
    setPlayerId(null);
    setRoom(null);
    setFiles({});
    setChat([]);
    setSubmissions([]);
  }, []);

  return {
    connected,
    playerId,
    room,
    files,
    chat,
    submissions,
    publicRooms,
    error,
    offset,
    send,
    clearError: () => setError(null),
    leave,
  };
}

function useTick(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function Toast({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDone, 5000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="toast" role="status">
      <span>{message}</span>
      <button onClick={onDone} aria-label="Dismiss">
        <Cross size={14} />
      </button>
    </div>
  );
}

function TopBar({ conn }: { conn: Conn }) {
  const { room, connected } = conn;
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">V</span>
        <span className="brand-word">
          VIBE<span className="brand-slash">/</span>RACE
        </span>
      </div>
      <div className="topbar-mid">
        {room ? (
          <>
            <span className="micro">ROOM</span>
            <span className="room-code-mini">{room.code}</span>
            <span className={`phase-pill phase-${room.phase}`}>{room.phase}</span>
          </>
        ) : (
          <span className="micro">TIMED DESIGN DUELS</span>
        )}
      </div>
      <div className="topbar-right">
        <span className="model-tag">
          <span className="micro">AI</span> {room?.modelLabel ?? "configured on server"}
        </span>
        <span className={`conn ${connected ? "live" : ""}`}>
          <span className="dot" />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
      </div>
    </header>
  );
}

function Marquee() {
  const items = [
    "10 MINUTES",
    "ONE THEME",
    "AN AI THAT WORKS FOR YOU",
    "A JUDGE WITH TASTE",
    "NO PEEKING",
    "SHIP SOMETHING",
  ];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {[0, 1].map((i) => (
          <div className="marquee-set" key={i}>
            {items.map((t) => (
              <span key={t}>
                {t} <b><Sparkles size={10} /></b>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function PublicLobbies({
  rooms,
  name,
  onJoin,
  onRefresh,
}: {
  rooms: PublicRoom[];
  name: string;
  onJoin: (code: string) => void;
  onRefresh: () => void;
}) {
  const ready = name.trim().length > 0;
  return (
    <section className="public-lobbies">
      <div className="public-head">
        <div>
          <span className="micro">PUBLIC LOBBIES</span>
          <h2>Open rooms. Anyone can walk in.</h2>
        </div>
        <div className="public-actions">
          <span className="fine">
            {ready ? "Join with your name above." : "Type a name above to join a room."}
          </span>
          <button className="refresh" onClick={onRefresh}>
            REFRESH <RefreshClockwise size={11} />
          </button>
        </div>
      </div>

      <div className="lobby-table">
        <div className="lt-row lt-head">
          <span>ROOM</span>
          <span>HOST</span>
          <span>PLAYERS</span>
          <span>CLOCK</span>
          <span>MODE</span>
          <span>STATUS</span>
          <span />
        </div>
        {rooms.length === 0 && (
          <div className="lt-empty">
            <span className="micro">NOTHING OPEN</span>
            <p>No public rooms right now. Create one above and it appears here instantly.</p>
          </div>
        )}
        {rooms.map((r) => {
          const open = r.phase === "lobby" && r.playerCount < r.maxPlayers;
          return (
            <div className={`lt-row ${open ? "" : "busy"}`} key={r.code}>
              <span className="lt-code">{r.code}</span>
              <span className="lt-host">{r.hostName}</span>
              <span>
                {r.playerCount}/{r.maxPlayers}
              </span>
              <span>{Math.round(r.durationSec / 60)} MIN</span>
              <span>{r.aiMode === "html" ? "HTML ONLY" : "WORKSPACE"}</span>
              <span>
                <span className={`lt-phase ${r.phase}`}>{r.phase}</span>
              </span>
              <span className="lt-action">
                {open ? (
                  <Button
                    label="Join"
                    variant="secondary"
                    size="sm"
                    isDisabled={!ready}
                    onClick={() => onJoin(r.code)}
                  />
                ) : (
                  <span className="micro dim">IN PLAY</span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Home({ conn }: { conn: Conn }) {
  const [name, setName] = useState(() => localStorage.getItem("vibe-race-name") ?? "");
  const [code, setCode] = useState(() => {
    const q = new URLSearchParams(location.search).get("room");
    return (q ?? "").toUpperCase().slice(0, 8);
  });
  const rememberName = (v: string) => {
    setName(v);
    try {
      localStorage.setItem("vibe-race-name", v);
    } catch {
      /* ignore */
    }
  };
  const canCreate = name.trim().length > 0;
  const canJoin = canCreate && code.trim().length >= 3;

  return (
    <main className="home">
      <section className="hero">
        <div className="hero-grid">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="blink-dot" /> MULTIPLAYER · TIMED · FEARLESS
            </div>
            <h1>
              Ten minutes.
              <br />
              <em>One theme.</em>
              <br />
              No excuses.
            </h1>
            <p className="hero-sub">
              You get a blank workspace, an AI, and the same theme as everyone else. Build the
              best thing before the clock hits zero. A judge picks the winner. You never see the
              other sites until time is up.
            </p>
            <div className="hero-stats">
              <div>
                <span className="micro">FORMAT</span>
                <strong>2–8 players</strong>
              </div>
              <div>
                <span className="micro">THE CLOCK</span>
                <strong>3 / 5 / 10 / 15 min</strong>
              </div>
              <div>
                <span className="micro">MODES</span>
                <strong>Workspace or single HTML</strong>
              </div>
            </div>
          </div>

          <div className="home-cards">
            <div className="panel create-panel">
              <div className="panel-head">
                <span className="micro">01 — START A RACE</span>
                <span className="panel-index">HOST</span>
              </div>
              <label className="field">
                <span className="micro">YOUR NAME</span>
                <div className="mono-filter">
                  <TextInput
                    label="Your name"
                    isLabelHidden
                    value={name}
                    onChange={rememberName}
                    placeholder="e.g. Ada"
                    width="100%"
                    size="lg"
                    hasAutoFocus
                  />
                </div>
              </label>
              <Button
                label="Create room"
                icon={<ArrowRight size={15} />}
                variant="primary"
                size="lg"
                width="100%"
                isDisabled={!canCreate}
                onClick={() =>
                  conn.send({ t: "create", name: name.trim(), settings: {} })
                }
              />
              <p className="fine">
                You become host and judge. Settings can be changed in the lobby.
              </p>
            </div>

            <div className="panel join-panel">
              <div className="panel-head">
                <span className="micro">02 — JOIN A RACE</span>
                <span className="panel-index">PLAYER</span>
              </div>
              <label className="field">
                <span className="micro">ROOM CODE</span>
                <div className="mono-filter">
                  <TextInput
                    label="Room code"
                    isLabelHidden
                    value={code}
                    onChange={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6))}
                    placeholder="ABCD"
                    width="100%"
                    size="lg"
                  />
                </div>
              </label>
              <Button
                label="Join room"
                icon={<ArrowRight size={15} />}
                variant="secondary"
                size="lg"
                width="100%"
                isDisabled={!canJoin}
                onClick={() =>
                  conn.send({ t: "join", code: code.trim(), name: name.trim() })
                }
              />
              <p className="fine">Ask the host for the four-character code.</p>
            </div>
          </div>
        </div>
      </section>

      <Marquee />

      <PublicLobbies
        rooms={conn.publicRooms}
        name={name}
        onJoin={(code) => conn.send({ t: "join", code, name: name.trim() })}
        onRefresh={() => conn.send({ t: "browse" })}
      />

      <section className="rules">
        <div className="rule">
          <span className="micro">01 / THE PROMPT</span>
          <h3>A theme drops</h3>
          <p>
            Random, or set by the host. Everyone gets the same one at the same second. No prep,
            no warning.
          </p>
        </div>
        <div className="rule">
          <span className="micro">02 / THE WORK</span>
          <h3>Direct your AI</h3>
          <p>
            Prompt it, steer it, edit the files yourself. Your workspace is private — rivals only
            see how far along you are.
          </p>
        </div>
        <div className="rule">
          <span className="micro">03 / THE VERDICT</span>
          <h3>A judge decides</h3>
          <p>
            When time is up, every site goes on the wall. The judge opens each one and picks the
            best. That is the whole game.
          </p>
        </div>
      </section>
      <footer className="footer">
        <span>VIBE/RACE — built for workers who ship</span>
        <span>NO PEEKING · NO MERCY</span>
      </footer>
    </main>
  );
}

function Lobby({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const isHost = room.hostId === conn.playerId;
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}?room=${room.code}`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* ignore */
    }
  };

  const setSettings = (patch: Partial<RoomView["settings"]>) =>
    conn.send({ t: "settings", settings: patch });

  return (
    <main className="lobby">
      <section className="lobby-head">
        <div>
          <div className="eyebrow">THE LOBBY · WAITING FOR PLAYERS</div>
          <h1 className="lobby-title">
            Get everyone in.<br />
            <em>Then it begins.</em>
          </h1>
        </div>
        <div className="code-card">
          <span className="micro">ROOM CODE</span>
          <button className="code" onClick={() => copy(link)} title="Copy invite link">
            {room.code}
          </button>
          <button className="copy-line" onClick={() => copy(link)}>
            {copied ? "COPIED INVITE LINK" : <>COPY INVITE LINK <ExternalSmall size={10} /></>}
          </button>
        </div>
      </section>

      <section className="lobby-grid">
        <div className="panel roster">
          <div className="panel-head">
            <span className="micro">PLAYERS — {room.players.length}/8</span>
            <span className="panel-index">{isHost ? "YOU ARE HOST + JUDGE" : "HOST JUDGES"}</span>
          </div>
          <ol className="player-list">
            {room.players.map((p, i) => (
              <li key={p.id} className={p.id === conn.playerId ? "you" : ""}>
                <span className="p-index">{String(i + 1).padStart(2, "0")}</span>
                <span className="p-name">{p.name}</span>
                <span className="p-tags">
                  {p.isHost && <span className="tag">HOST</span>}
                  {p.isJudge && <span className="tag">JUDGE</span>}
                  {p.id === conn.playerId && <span className="tag ghost">YOU</span>}
                </span>
              </li>
            ))}
            {room.players.length < 2 && (
              <li className="empty">
                <span className="p-index">+</span>
                <span>Waiting for a challenger…</span>
              </li>
            )}
          </ol>
          <div className="roster-foot">
            <span className="micro">PRIVATE WORKSPACES · SHARED CLOCK</span>
            <Button
              label="Leave"
              variant="ghost"
              size="sm"
              onClick={() => conn.leave()}
            />
          </div>
        </div>

        <div className="panel settings">
          <div className="panel-head">
            <span className="micro">RACE SETTINGS</span>
            {!isHost && <span className="panel-index">HOST ONLY</span>}
          </div>

          <div className="setting">
            <span className="micro">TIME LIMIT</span>
            <div className="seg">
              {[180, 300, 600, 900, 1200].map((s) => (
                <button
                  key={s}
                  className={room.settings.durationSec === s ? "on" : ""}
                  disabled={!isHost}
                  onClick={() => setSettings({ durationSec: s })}
                >
                  {s / 60} MIN
                </button>
              ))}
            </div>
          </div>

          <div className="setting">
            <span className="micro">AI MODE</span>
            <div className="modes">
              <button
                className={`mode ${room.settings.aiMode === "workspace" ? "on" : ""}`}
                disabled={!isHost}
                onClick={() => setSettings({ aiMode: "workspace" })}
              >
                <span className="mode-title">Workspace</span>
                <span className="mode-sub">HTML + CSS + JS. Multiple files. The full toy box.</span>
              </button>
              <button
                className={`mode ${room.settings.aiMode === "html" ? "on" : ""}`}
                disabled={!isHost}
                onClick={() => setSettings({ aiMode: "html" })}
              >
                <span className="mode-title">Workers</span>
                <span className="mode-sub">Single index.html. Inline everything. Constraint is the game.</span>
              </button>
            </div>
          </div>

          <div className="setting">
            <span className="micro">THEME</span>
            <div className="seg">
              <button
                className={room.settings.topicMode === "random" ? "on" : ""}
                disabled={!isHost}
                onClick={() => setSettings({ topicMode: "random" })}
              >
                RANDOM
              </button>
              <button
                className={room.settings.topicMode === "custom" ? "on" : ""}
                disabled={!isHost}
                onClick={() => setSettings({ topicMode: "custom" })}
              >
                WRITE ONE
              </button>
            </div>
            {room.settings.topicMode === "custom" && (
              <div className="mono-filter custom-topic">
                <TextInput
                  label="Custom theme"
                  isLabelHidden
                  value={room.settings.customTopic}
                  onChange={(v) => setSettings({ customTopic: v })}
                  placeholder="Landing page for a next-gen SaaS startup"
                  width="100%"
                  isDisabled={!isHost}
                />
              </div>
            )}
          </div>

          <div className="start-row">
            {isHost ? (
              <Button
                label="Start the race"
                icon={<ArrowRight size={15} />}
                variant="primary"
                size="lg"
                width="100%"
                onClick={() => conn.send({ t: "start" })}
              />
            ) : (
              <div className="waiting-box">
                <span className="blink-dot" /> Waiting for the host to start…
              </div>
            )}
            <p className="fine">
              {room.players.length < 2
                ? "You can start solo to test the flow, or wait for friends."
                : "When the clock starts, everyone builds at once."}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

function Preview({ html, title = "preview" }: { html: string; title?: string }) {
  return (
    <iframe
      className="frame"
      title={title}
      sandbox="allow-scripts"
      srcDoc={html}
    />
  );
}

function Arena({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const round = room.round!;
  const now = useTick(true);
  const remaining = Math.max(0, Math.ceil((round.endsAt - (now + conn.offset)) / 1000));
  const urgent = remaining <= 60;
  const html = useMemo(() => buildPreviewHtml(conn.files), [conn.files]);
  const others = room.players.filter((p) => p.id !== conn.playerId);

  return (
    <main className="arena">
      <div className="arena-head">
        <div className="topic-block">
          <span className="micro">THEME</span>
          <h2>{round.topic}</h2>
        </div>
        <div className={`clock ${urgent ? "urgent" : ""}`} aria-live="off">
          <span className="micro">TIME LEFT</span>
          <span className="clock-digits">{formatClock(remaining)}</span>
        </div>
        <div className="arena-opponents">
          <span className="micro">IN THE ROOM</span>
          <div className="opponents">
            {others.length === 0 && <span className="dim">No one else. Still counts.</span>}
            {others.map((p) => (
              <span key={p.id} className="opponent">
                <span className={`status-dot ${p.status}`} />
                {p.name}
                <b>{p.status === "thinking" ? p.activity : `${p.fileCount}f`}</b>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="arena-grid">
        <section className="pane workspace-pane">
          <div className="pane-head">
            <span className="micro">YOUR WORKSPACE</span>
            <span className="micro dim">{room.settings.aiMode === "html" ? "WORKERS MODE" : "FULL WORKSPACE"}</span>
          </div>
          <Editor conn={conn} />
        </section>

        <section className="pane preview-pane">
          <div className="pane-head">
            <span className="micro">LIVE PREVIEW</span>
            <span className="micro dim">ONLY YOU CAN SEE THIS</span>
          </div>
          <div className="preview-body">
            <Preview html={html} title="Your live preview" />
          </div>
        </section>

        <section className="pane chat-pane">
          <Chat conn={conn} />
        </section>
      </div>

      {remaining === 0 && (
        <div className="time-up">
          <span className="micro">TIME</span>
          <strong>Editing locked. The judge is looking.</strong>
        </div>
      )}
    </main>
  );
}

function Editor({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const files = conn.files;
  const paths = useMemo(() => Object.keys(files).sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b))), [files]);
  const [active, setActive] = useState("index.html");
  const [draft, setDraft] = useState(files[active] ?? "");
  const [newPath, setNewPath] = useState("");
  const dirty = useRef(false);
  const lastSent = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const f = files[active];
    if (dirty.current && f !== lastSent.current) return;
    dirty.current = false;
    setDraft(f ?? "");
  }, [active, files[active], files]);

  useEffect(() => {
    if (files[active] === undefined && paths[0]) setActive(paths[0]);
  }, [paths, active, files]);

  const flush = useCallback(
    (path: string, content: string) => {
      lastSent.current = content;
      conn.send({ t: "write", path, content });
    },
    [conn],
  );

  const onChange = (value: string) => {
    setDraft(value);
    dirty.current = true;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(active, value), 500);
  };

  const create = () => {
    const p = newPath.trim().replace(/^\/+/, "");
    if (!p) return;
    conn.send({ t: "createFile", path: p });
    setNewPath("");
    setActive(p);
  };

  const workers = room.settings.aiMode === "html";

  return (
    <div className="workspace">
      <div className="files">
        <div className="file-list">
          {paths.length === 0 && <div className="file-empty">No files yet</div>}
          {paths.map((p) => (
            <div key={p} className={`file ${p === active ? "on" : ""}`}>
              <button onClick={() => setActive(p)}>{p}</button>
              {!workers && p !== "index.html" && (
                <button
                  className="file-del"
                  title={`Delete ${p}`}
                  onClick={() => conn.send({ t: "deleteFile", path: p })}
                >
                  <CrossSmall size={10} />
                </button>
              )}
            </div>
          ))}
        </div>
        {!workers && (
          <div className="new-file">
            <input
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="new-file.css"
              aria-label="New file path"
            />
            <button onClick={create}>ADD</button>
          </div>
        )}
      </div>
      <textarea
        className="code-editor"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        aria-label={`Edit ${active}`}
        placeholder={
          paths.length === 0
            ? "This space is empty. Ask the AI to build something, or start typing here."
            : undefined
        }
      />
      <div className="editor-foot">
        <span className="micro">{active}</span>
        <span className="micro dim">
          {draft.length.toLocaleString()} CHARS · AUTOSAVED
        </span>
      </div>
    </div>
  );
}

function Chat({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const chat = conn.chat;
  const [text, setText] = useState("");
  const [showStop, setShowStop] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const me = room.players.find((p) => p.id === conn.playerId);
  const busy = me?.status === "thinking";
  const [busySince, setBusySince] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());

  const live = [...chat].reverse().find((m) => m.role === "assistant" && m.id.startsWith("live_"));
  const streaming = busy && !!live;
  const elapsed = busySince ? Math.max(0, Math.floor((clock - busySince) / 1000)) : 0;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, busy, clock]);

  useEffect(() => {
    setBusySince(busy ? Date.now() : null);
    setShowStop(busy);
  }, [busy]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (busy) return;
    conn.send({ t: "prompt", text: t });
    setText("");
  };

  const chips = [
    "Build the first version",
    "Make it bolder",
    "Tighten the copy",
    "Add a pricing section",
    "Fix the mobile layout",
  ];

  return (
    <div className="chat">
      <div className="pane-head chat-head">
        <span className="micro">YOUR AI</span>
        <span className="model-pill">{room.modelLabel}</span>
      </div>

      <div className="messages" ref={listRef}>
        {chat.filter((m) => m.role !== "system").length === 0 && (
          <div className="chat-intro">
            <p>You have {Math.round(room.settings.durationSec / 60)} minutes and a blank canvas.</p>
            <p className="dim">Tell your AI what to make. It can only touch your workspace.</p>
          </div>
        )}
        {chat.map((m) => {
          const isLive = busy && m.id.startsWith("live_");
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              <span className="msg-role">
                {m.role === "user" ? "YOU" : m.role === "assistant" ? "AI" : "NOTE"}
              </span>
              <div className={`msg-body ${isLive ? "live" : ""}`}>
                {m.text}
                {isLive && (
                  <span className="stream-meta">
                    {" "}
                    · {elapsed}s
                  </span>
                )}
              </div>
            </div>
          );
        })}
        {busy && !streaming && (
          <div className="msg assistant">
            <span className="msg-role">AI</span>
            <div className="msg-body typing">
              <i />
              <i />
              <i />
              <span className="typing-note">
                {me?.activity ?? "thinking"} · {elapsed}s
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="chips">
        {chips.map((c) => (
          <button key={c} onClick={() => setText(c)} disabled={busy}>
            {c}
          </button>
        ))}
      </div>

      <div className="compose">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={busy ? "The AI is working…" : "Direct your AI. Enter to send."}
          aria-label="Message your AI"
          rows={2}
        />
        <div className="compose-actions">
          {showStop ? (
            <button className="stop" onClick={() => conn.send({ t: "stop" })}>
              STOP
            </button>
          ) : (
            <span className="micro dim">SHIFT+ENTER FOR A NEW LINE</span>
          )}
          <Button
            label="Send"
            variant="primary"
            size="sm"
            icon={<PaperAirplane size={13} />}
            isDisabled={!text.trim() || busy}
            onClick={submit}
          />
        </div>
      </div>
    </div>
  );
}

function Thumb({
  html,
  onClick,
  label,
}: {
  html: string;
  onClick?: () => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = width / 1280;
  return (
    <div className="thumb" ref={ref} onClick={onClick} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={(e) => e.key === "Enter" && onClick?.()}>
      <div className="thumb-inner" style={{ transform: `scale(${scale})` }}>
        <iframe title={label} sandbox="allow-scripts" srcDoc={html} tabIndex={-1} />
      </div>
      <span className="thumb-open">OPEN <ExternalSmall size={9} /></span>
    </div>
  );
}

function Modal({
  submission,
  onClose,
  canJudge,
  onPick,
  isWinner,
}: {
  submission: SubmissionPublic;
  onClose: () => void;
  canJudge: boolean;
  onPick: () => void;
  isWinner: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <span className="micro">ENTRY</span>
            <strong>{submission.name}</strong>
            {isWinner && <Badge label="WINNER" variant="success" />}
          </div>
          <div className="modal-actions">
            {canJudge && (
              <Button label="Pick as winner" variant="primary" size="sm" onClick={onPick} />
            )}
            <button className="modal-close" onClick={onClose} aria-label="Close preview">
              <Cross size={16} />
            </button>
          </div>
        </div>
        <div className="modal-body">
          <Thumb html={submission.html} label={`${submission.name} project`} />
        </div>
      </div>
    </div>
  );
}

function Verdict({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const results = room.phase === "results";
  const isJudge = room.judgeId === conn.playerId;
  const isHost = room.hostId === conn.playerId;
  const [open, setOpen] = useState<SubmissionPublic | null>(null);
  const subs = conn.submissions;
  const judge = room.players.find((p) => p.id === room.judgeId);

  return (
    <main className={`verdict ${results ? "done" : ""}`}>
      <section className="verdict-head">
        <div>
          <div className="eyebrow">{results ? "THE VERDICT" : "TIME IS UP · JUDGING"}</div>
          {results ? (
            <h1 className="verdict-title">
              <em>{room.round?.winnerName}</em> takes it.
            </h1>
          ) : (
            <h1 className="verdict-title">
              Every site,<br />
              <em>on the wall.</em>
            </h1>
          )}
          <p className="verdict-sub">
            Theme: <strong>{room.round?.topic}</strong>
          </p>
        </div>
        <div className="verdict-side">
          <span className="micro">JUDGE</span>
          <strong>{judge?.name ?? "—"}</strong>
          <span className="micro dim">
            {results ? "DECISION MADE" : isJudge ? "YOU PICK THE WINNER" : "THE JUDGE IS DECIDING"}
          </span>
          {results && isHost && (
            <Button
              label="New round"
              variant="primary"
              icon={<ArrowRight size={14} />}
              onClick={() => conn.send({ t: "reset" })}
            />
          )}
          {results && !isHost && <span className="fine">The host can start another round.</span>}
        </div>
      </section>

      <div className="wall">
        {subs.map((s, i) => {
          const winner = room.round?.winnerId === s.playerId;
          return (
            <article className={`entry ${winner ? "winner" : ""}`} key={s.playerId}>
              <div className="entry-head">
                <span className="entry-index">{String(i + 1).padStart(2, "0")}</span>
                <span className="entry-name">{s.name}</span>
                {winner && <span className="tag">WINNER</span>}
                {room.players.find((p) => p.id === s.playerId)?.isJudge && (
                  <span className="tag ghost">JUDGE</span>
                )}
              </div>
              <Thumb
                html={s.html}
                label={`${s.name} project`}
                onClick={() => setOpen(s)}
              />
              <div className="entry-foot">
                <span className="micro dim">
                  {s.fileCount} FILES · {s.turns} AI TURNS
                </span>
                {!results && isJudge && (
                  <Button
                    label="Pick winner"
                    variant="primary"
                    size="sm"
                    onClick={() => conn.send({ t: "judgePick", playerId: s.playerId })}
                  />
                )}
                {results && (
                  <span className={`micro ${winner ? "" : "dim"}`}>
                    {winner ? "SELECTED" : "—"}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="footer">
        <span>VIBE/RACE — same clock, different ideas</span>
        <span>{room.phase.toUpperCase()}</span>
      </footer>

      {open && (
        <Modal
          submission={open}
          onClose={() => setOpen(null)}
          canJudge={!results && isJudge}
          isWinner={room.round?.winnerId === open.playerId}
          onPick={() => {
            conn.send({ t: "judgePick", playerId: open.playerId });
            setOpen(null);
          }}
        />
      )}
    </main>
  );
}

function RoomChat({ conn }: { conn: Conn }) {
  const room = conn.room!;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [seen, setSeen] = useState(room.chat.length);
  const listRef = useRef<HTMLDivElement>(null);
  const count = room.chat.length;
  const unread = open ? 0 : Math.max(0, count - seen);

  useEffect(() => {
    if (!open) return;
    setSeen(count);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [open, count]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    conn.send({ t: "say", text: t });
    setText("");
  };

  return (
    <>
      <button
        className={`roomchat-toggle ${open ? "on" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <Message size={15} />
        <span>ROOM CHAT</span>
        {unread > 0 && <b>{unread > 9 ? "9+" : unread}</b>}
      </button>

      {open && (
        <aside className="roomchat">
          <div className="roomchat-head">
            <span className="micro">ROOM CHAT · {room.players.length} IN ROOM</span>
            <button onClick={() => setOpen(false)} aria-label="Close room chat">
              <Cross size={14} />
            </button>
          </div>
          <div className="roomchat-list" ref={listRef}>
            {room.chat.length === 0 && (
              <p className="roomchat-empty">
                Say something. Everyone in the room sees it — judge included.
              </p>
            )}
            {room.chat.map((m) => (
              <div key={m.id} className={`rc-msg ${m.playerId === conn.playerId ? "me" : ""}`}>
                <div className="rc-meta">
                  <strong>{m.name}</strong>
                  {m.judge && <span className="tag">JUDGE</span>}
                  {m.host && !m.judge && <span className="tag ghost">HOST</span>}
                  <time>
                    {new Date(m.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <div className="rc-text">{m.text}</div>
              </div>
            ))}
          </div>
          <div className="roomchat-compose">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder="Message the room…"
              aria-label="Message the room"
              maxLength={500}
            />
            <button onClick={submit} disabled={!text.trim()} aria-label="Send room message">
              <PaperAirplane size={14} />
            </button>
          </div>
        </aside>
      )}
    </>
  );
}

function App() {
  const conn = useConn();
  const room = conn.room;

  const screen = !room
    ? "home"
    : room.phase === "lobby"
      ? "lobby"
      : room.phase === "playing"
        ? "arena"
        : "verdict";

  return (
    <div className="app">
      <TopBar conn={conn} />
      {screen === "home" && <Home conn={conn} />}
      {screen === "lobby" && <Lobby conn={conn} />}
      {screen === "arena" && <Arena conn={conn} />}
      {screen === "verdict" && <Verdict conn={conn} />}
      {room && <RoomChat conn={conn} />}
      <Toast message={conn.error} onDone={conn.clearError} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <Theme theme={themes[defaultThemeSlug]} mode="light">
    <App />
  </Theme>,
);
