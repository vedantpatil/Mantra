import { useEffect, useRef, useState } from "react";
import type { FleetProject, FleetSnapshot, IntentSource } from "../shared.js";

interface Line {
  readonly kind: "you" | "sys" | "err";
  readonly text: string;
}

const DOTS = 6;

function Project({ p }: { p: FleetProject }): JSX.Element {
  return (
    <div className={`pcard${p.blocked ? " alert" : ""}`}>
      <div className="pcard-h">
        <span className={`hp ${p.health}`} />
        <span className="nm">{p.name}</span>
        <span className="st">{p.agents.length} agents · :{p.port}</span>
      </div>
      <div className="srail">
        {Array.from({ length: DOTS }, (_, i) => {
          const cls = p.blocked && i === p.stageIndex ? "blk" : i < p.stageIndex ? "done" : i === p.stageIndex ? "now" : "";
          return <span key={i} className={`d ${cls}`} />;
        })}
        <span className="lab">{p.stage}</span>
      </div>
      <div className="crew">
        {p.agents.map((a) => (
          <div className="agent" key={a.role}>
            <span className={`badge ${a.badge}`}>{a.badge}</span>
            <span className="an">{a.role}</span>
            <span className="task">{a.task}</span>
            <span className={`as ${a.status}`}>{a.status}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App(): JSX.Element {
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null);
  const [mode, setMode] = useState<IntentSource>("console");
  const [listening, setListening] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { kind: "sys", text: "Mantra ready. Run a task: `run <project>: <what to do>` (read-only). Use `run!` to allow edits." },
    { kind: "sys", text: "Also: /queue, /status, /help — or hold the mic to speak. ⌘K focuses the console." },
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognition = useRef<{ start(): void; stop(): void } | null>(null);

  useEffect(() => {
    void window.mantra.getFleet().then(setFleet);
    const unsub = window.mantra.onAgentEvent((e) => {
      if (e.kind === "line") setLines((ls) => [...ls, { kind: "sys", text: e.text }]);
      else if (e.kind === "done") {
        const detail = e.diffStat ? `\n${e.diffStat}\nreview: git -C ${e.worktreePath} diff` : " · no file changes";
        setLines((ls) => [...ls, { kind: "sys", text: `✓ done · cost $${e.costUsd.toFixed(4)} · ${e.stopReason}${detail}` }]);
      } else setLines((ls) => [...ls, { kind: "err", text: `✗ ${e.message}` }]);
    });
    return unsub;
  }, []);
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [lines]);

  /** `run <target>: <task>` (read-only) or `run! <target>: <task>` (edits allowed). */
  function parseRun(text: string): { target: string; task: string; dryRun: boolean } | null {
    const m = /^run(!?)\s+([^:]+):\s*(.+)$/i.exec(text);
    if (!m) return null;
    return { target: m[2].trim(), task: m[3].trim(), dryRun: m[1] !== "!" };
  }

  async function submit(raw: string, source: IntentSource): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    setLines((ls) => [...ls, { kind: "you", text }]);
    setInput("");
    const run = parseRun(text);
    const ack = run
      ? await window.mantra.runTask(run)
      : await window.mantra.submitIntent(text, source);
    setLines((ls) => [...ls, { kind: ack.ok ? "sys" : "err", text: ack.message }]);
  }

  function togglePushToTalk(): void {
    // Voice is the equal peer of the console (§5.7). Real STT (whisper.cpp) lands in P5;
    // here we use the platform SpeechRecognition when present, else note it's pending.
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => typeof recognition.current }).webkitSpeechRecognition;
    if (!SR) {
      setListening((v) => !v);
      setLines((ls) => [...ls, { kind: "sys", text: "🎙 push-to-talk armed — local STT (whisper.cpp) wiring is P5; type in the console meanwhile." }]);
      return;
    }
    if (listening) {
      recognition.current?.stop();
      setListening(false);
      return;
    }
    const r = new SR() as unknown as {
      start(): void; stop(): void; continuous: boolean; interimResults: boolean;
      onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
      onend: () => void;
    };
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => setInput(e.results[0]?.[0]?.transcript ?? "");
    r.onend = () => setListening(false);
    recognition.current = r;
    r.start();
    setListening(true);
  }

  return (
    <div className="app">
      <header className="topbar">
        <span className="logo no-drag" />
        <span className="brand">Mantra</span>
        <span className="sub">Overseer</span>
        <span className="spacer" />
        <span className="spend no-drag">${fleet ? fleet.spendToday.toFixed(2) : "0.00"} / ${fleet?.budget ?? 30}</span>
        <span className="pill no-drag"><span className="dot" />healthy</span>
      </header>

      <div className="body">
        <main className="center">
          <div className="center-h">
            <h2>Fleet</h2>
            <span className="sub">{fleet?.projects.length ?? 0} projects · autonomy on</span>
            <div className="kpis">
              <div className="kpi"><div className="v teal">{fleet?.agents ?? 0}</div><div className="l">Agents</div></div>
              <div className="kpi"><div className="v amber">{fleet?.needYou ?? 0}</div><div className="l">Need you</div></div>
            </div>
          </div>
          <div className="fleet">
            {fleet?.projects.map((p) => <Project key={p.id} p={p} />)}
          </div>
        </main>

        <aside className="rail">
          <div className="rail-h">Decisions queue <span className="cnt">{fleet?.decisions.length ?? 0} open</span></div>
          {fleet?.decisions.map((d) => (
            <div className={`dcard${d.critical ? " crit" : ""}`} key={d.id}>
              <span className="pj">{d.project}</span>
              <div className="t">{d.title}</div>
              <div className="s">{d.summary}</div>
              <div className="dbtns">
                {d.actions.map((a, i) => (
                  <button
                    key={a}
                    className={`db${i === d.actions.length - 1 ? " primary" : ""}`}
                    onClick={() => void submit(`/${a.toLowerCase().split(" ")[0]} ${d.project}`, "console")}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </aside>
      </div>

      <section className="console">
        <div className="con-scroll" ref={scrollRef}>
          {lines.map((l, i) => (
            <div className={`cl ${l.kind}`} key={i}>
              <span className="gut">{l.kind === "you" ? "›" : "·"}</span>
              <span className="tx">{l.text}</span>
            </div>
          ))}
        </div>
        <div className="con-bar">
          <div className="modes">
            <button className={mode === "voice" ? "on" : ""} onClick={() => setMode("voice")}>🎙 Voice</button>
            <button className={mode === "console" ? "on" : ""} onClick={() => setMode("console")}>⌨ Console</button>
          </div>
          <button className={`ptt${listening ? " live" : ""}`} onClick={togglePushToTalk}>
            <span className="rec" />{listening ? "listening…" : "hold to talk"}
          </button>
          <form
            className="con-input"
            onSubmit={(e) => { e.preventDefault(); void submit(input, mode); }}
          >
            <span className="scope">›</span>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="run website: summarize the stack   ·   what needs me?   ·   /help"
              autoFocus
            />
          </form>
          <button className="send" onClick={() => void submit(input, mode)}>Run</button>
        </div>
      </section>
    </div>
  );
}
