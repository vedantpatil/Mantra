import { useEffect, useRef, useState } from "react";
import type { AuditEntry, AuthHealth, AuthMode, ConfirmRequest, FleetProject, FleetSnapshot, IntentSource, OpsIncident, ReviewItem, SettingsInfo } from "../shared.js";

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
        {p.agents.map((a, i) => (
          <div className="agent" key={`${a.role}-${a.status}-${i}`}>
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
  const [reviews, setReviews] = useState<readonly ReviewItem[]>([]);
  const [incidents, setIncidents] = useState<readonly OpsIncident[]>([]);
  const [audit, setAudit] = useState<readonly AuditEntry[]>([]);
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [authHealth, setAuthHealth] = useState<AuthHealth | null>(null);
  const [checkingAuth, setCheckingAuth] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [githubInput, setGithubInput] = useState("");
  const [projName, setProjName] = useState("");
  const [projPath, setProjPath] = useState("");
  const [monInputs, setMonInputs] = useState<Record<string, { name: string; url: string }>>({});
  const [mode, setMode] = useState<IntentSource>("console");
  const [listening, setListening] = useState(false);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<Line[]>([
    { kind: "sys", text: "Mantra ready. One agent: `run <project>: <task>` (read-only) / `run! …` (edits)." },
    { kind: "sys", text: "A crew: `crew <project>: <goal>` — Manager decomposes → Dev/QA → your review. Or /queue, /status, /help." },
    { kind: "sys", text: "Or just type plain English — Mantra picks the project and runs it (read-only unless you name a change)." },
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognition = useRef<{ start(): void; stop(): void } | null>(null);

  const refreshReviews = (): void => {
    void window.mantra.listReviews().then(setReviews);
  };
  const refreshFleet = (): void => {
    void window.mantra.getFleet().then(setFleet);
  };
  const refreshIncidents = (): void => {
    void window.mantra.listIncidents().then(setIncidents);
  };
  const refreshAudit = (): void => {
    void window.mantra.listAudit(12).then(setAudit);
  };

  const refreshSettings = (): Promise<SettingsInfo> =>
    window.mantra.getSettings().then((s) => { setSettings(s); return s; });

  useEffect(() => {
    refreshFleet();
    refreshReviews();
    refreshIncidents();
    refreshAudit();
    // Open Setup automatically on a fresh machine (no key + no projects) so the app is UI-only.
    void refreshSettings().then((s) => { if (!s.apiKeySet && s.projects.length === 0) setShowSettings(true); });
    const unsub = window.mantra.onAgentEvent((e) => {
      if (e.kind === "line") setLines((ls) => [...ls, { kind: "sys", text: e.text }]);
      else if (e.kind === "fleet-changed") { refreshFleet(); refreshAudit(); }
      else if (e.kind === "incidents-changed") { refreshIncidents(); refreshFleet(); refreshAudit(); }
      else if (e.kind === "reviews-changed") { refreshReviews(); refreshFleet(); refreshAudit(); }
      else if (e.kind === "done") {
        const detail = e.diffStat ? `\n${e.diffStat}\nreview: git -C ${e.worktreePath} diff` : " · no file changes";
        setLines((ls) => [...ls, { kind: "sys", text: `✓ done · cost $${e.costUsd.toFixed(4)} · ${e.stopReason}${detail}` }]);
      } else if (e.kind === "error") setLines((ls) => [...ls, { kind: "err", text: `✗ ${e.message}` }]);
    });
    const unsubConfirm = window.mantra.onConfirmRequest(setConfirmReq);
    return () => { unsub(); unsubConfirm(); };
  }, []);

  function answerConfirm(approved: boolean): void {
    if (!confirmReq) return;
    window.mantra.respondConfirm(confirmReq.id, approved);
    setLines((ls) => [...ls, { kind: approved ? "sys" : "err", text: `${approved ? "✓ approved" : "✗ denied"} ${confirmReq.kind}${confirmReq.command ? ` (${confirmReq.command})` : ""}` }]);
    setConfirmReq(null);
  }

  async function resolveReview(item: ReviewItem, approve: boolean): Promise<void> {
    const ack = await window.mantra.resolveReview(item.repoPath, item.id, approve);
    setLines((ls) => [...ls, { kind: "sys", text: `${approve ? "✓ approved" : "↩ sent back"}: ${item.title} — ${ack.message}` }]);
    refreshReviews();
    refreshFleet();
  }

  async function shipReview(item: ReviewItem): Promise<void> {
    const ack = await window.mantra.shipReview({ repoPath: item.repoPath, title: item.title });
    setLines((ls) => [...ls, { kind: ack.ok ? "sys" : "err", text: `🚢 ${ack.message}` }]);
  }

  async function onSaveApiKey(): Promise<void> {
    if (!apiKeyInput.trim()) return;
    setSettings(await window.mantra.saveApiKey(apiKeyInput.trim()));
    setApiKeyInput("");
    setLines((ls) => [...ls, { kind: "sys", text: "✓ API key saved — live runs are ready." }]);
  }
  async function onSaveGithub(): Promise<void> {
    if (!githubInput.trim()) return;
    setSettings(await window.mantra.saveGithubToken(githubInput.trim()));
    setGithubInput("");
    setLines((ls) => [...ls, { kind: "sys", text: "✓ GitHub token saved — Ship can push/merge without `gh auth login`." }]);
  }
  async function onSetAuthMode(mode: AuthMode): Promise<void> {
    setAuthHealth(null);
    setSettings(await window.mantra.setAuthMode(mode));
    setLines((ls) => [...ls, { kind: "sys", text: `auth mode → ${mode === "subscription" ? "Claude subscription" : "API key"}` }]);
  }
  async function onCheckAuth(): Promise<void> {
    setCheckingAuth(true);
    try {
      const h = await window.mantra.checkAuth();
      setAuthHealth(h);
      setLines((ls) => [...ls, { kind: h.ok ? "sys" : "err", text: `auth check: ${h.status}` }]);
    } finally {
      setCheckingAuth(false);
    }
  }
  async function onPickFolder(): Promise<void> {
    const p = await window.mantra.pickFolder();
    if (p) { setProjPath(p); if (!projName.trim()) setProjName(p.split("/").filter(Boolean).pop() ?? ""); }
  }
  const monInput = (repo: string): { name: string; url: string } => monInputs[repo] ?? { name: "", url: "" };
  const setMon = (repo: string, patch: Partial<{ name: string; url: string }>): void =>
    setMonInputs((m) => ({ ...m, [repo]: { ...monInput(repo), ...patch } }));
  async function onAddMonitor(repoPath: string): Promise<void> {
    const { name, url } = monInput(repoPath);
    if (!name.trim() || !url.trim()) return;
    setSettings(await window.mantra.addMonitor(repoPath, name.trim(), url.trim()));
    setMonInputs((m) => ({ ...m, [repoPath]: { name: "", url: "" } }));
  }
  async function onRemoveMonitor(repoPath: string, name: string): Promise<void> {
    setSettings(await window.mantra.removeMonitor(repoPath, name));
  }
  async function onAddProject(): Promise<void> {
    if (!projName.trim() || !projPath.trim()) return;
    setSettings(await window.mantra.addProject(projName.trim(), projPath.trim()));
    setProjName(""); setProjPath("");
    refreshFleet();
  }
  async function onRemoveProject(id: string): Promise<void> {
    setSettings(await window.mantra.removeProject(id));
    refreshFleet();
  }
  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [lines]);

  /** `<verb> <target>: <text>` — verb ∈ run | run! | crew. */
  function parseCommand(text: string): { verb: string; target: string; task: string; dryRun: boolean } | null {
    const m = /^(run!?|crew)\s+([^:]+):\s*(.+)$/i.exec(text);
    if (!m) return null;
    const verb = m[1].toLowerCase();
    return { verb, target: m[2].trim(), task: m[3].trim(), dryRun: verb === "run" };
  }

  async function submit(raw: string, source: IntentSource): Promise<void> {
    const text = raw.trim();
    if (!text) return;
    setLines((ls) => [...ls, { kind: "you", text }]);
    setInput("");
    const cmd = parseCommand(text);
    let ack;
    if (cmd?.verb === "crew") ack = await window.mantra.runCrew({ target: cmd.target, task: cmd.task, dryRun: false });
    else if (cmd) ack = await window.mantra.runTask({ target: cmd.target, task: cmd.task, dryRun: cmd.dryRun });
    else if (text.startsWith("/")) ack = await window.mantra.submitIntent(text, source); // slash commands
    else ack = await window.mantra.runIntent(text); // plain English → resolve project + run
    setLines((ls) => [...ls, { kind: ack.ok ? "sys" : "err", text: ack.message }]);
  }

  function togglePushToTalk(): void {
    // Voice is the equal peer of the console (§5.7): the transcript is normalized into the
    // same `<verb> <target>: <text>` grammar the console parses (main owns the normalizer).
    // Uses the platform SpeechRecognition when present; local whisper.cpp is the CLI path
    // (`mantra transcribe`) and the offline in-app capture is the remaining native wiring.
    const SR = (window as unknown as { webkitSpeechRecognition?: new () => typeof recognition.current }).webkitSpeechRecognition;
    if (!SR) {
      setListening((v) => !v);
      setLines((ls) => [...ls, { kind: "sys", text: "🎙 no in-browser STT here — use `mantra transcribe <file.wav>` (local whisper.cpp) or type below." }]);
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
    r.onresult = (e) => {
      const heard = e.results[0]?.[0]?.transcript ?? "";
      // Route through the canonical normalizer so voice and typing converge on one intent path.
      void window.mantra.normalizeVoice(heard).then((cmd) => setInput(cmd || heard));
    };
    r.onend = () => setListening(false);
    recognition.current = r;
    r.start();
    setListening(true);
  }

  return (
    <div className="app">
      {confirmReq && (
        <div className="modal-scrim">
          <div className="modal">
            <div className="modal-h">⚠ Irreversible action</div>
            <div className="modal-b">
              An agent wants to <b>{confirmReq.kind}</b> in <b>{confirmReq.project}</b>.
              {confirmReq.command && <pre className="modal-cmd">{confirmReq.command}</pre>}
              This cannot be undone. Approve only if you intend it.
            </div>
            <div className="modal-btns">
              <button className="db" onClick={() => answerConfirm(false)}>Deny</button>
              <button className="db primary" onClick={() => answerConfirm(true)}>Approve</button>
            </div>
          </div>
        </div>
      )}
      {showSettings && (
        <div className="modal-scrim" onClick={() => setShowSettings(false)}>
          <div className="modal settings" onClick={(e) => e.stopPropagation()}>
            <div className="modal-h">⚙ Setup</div>
            <div className="modal-b">
              <div className="set-sec">
                <div className="set-label">Authentication</div>
                <div className="set-row">
                  <select
                    className="set-input"
                    value={settings?.authMode ?? "subscription"}
                    onChange={(e) => void onSetAuthMode(e.target.value as AuthMode)}
                  >
                    <option value="subscription">Claude subscription (Pro/Max)</option>
                    <option value="apiKey">API key</option>
                  </select>
                  <button className="db" onClick={() => void onCheckAuth()} disabled={checkingAuth}>
                    {checkingAuth ? "Checking…" : "Check"}
                  </button>
                </div>
                <div className={`set-status${authHealth && !authHealth.ok ? " warn-txt" : ""}`}>
                  {authHealth
                    ? authHealth.status
                    : settings?.authMode === "apiKey"
                      ? "Runs bill the Anthropic API wallet (console.anthropic.com — separate from claude.ai credits)."
                      : "Runs use your Claude Pro/Max login — no API credit needed. Click Check to confirm."}
                </div>
              </div>

              <div className="set-sec">
                <div className="set-label">Anthropic API key</div>
                <div className="set-status">
                  {settings?.apiKeySet
                    ? <>✓ set <code>{settings.apiKeyMasked}</code>{settings.apiKeySource === "env" ? " (from shell env)" : ""}</>
                    : <span className={settings?.authMode === "apiKey" ? "warn-txt" : ""}>
                        not set{settings?.authMode === "apiKey" ? " — required for API-key mode" : " — only needed if you switch to API-key mode"}
                      </span>}
                </div>
                <div className="set-row">
                  <input
                    className="set-input" type="password" placeholder="sk-ant-…"
                    value={apiKeyInput} onChange={(e) => setApiKeyInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void onSaveApiKey(); }}
                  />
                  <button className="db primary" onClick={() => void onSaveApiKey()}>Save</button>
                </div>
              </div>

              <div className="set-sec">
                <div className="set-label">GitHub token <span style={{ textTransform: "none", letterSpacing: 0, color: "var(--faint)" }}>— for Ship (push / PR / merge)</span></div>
                <div className="set-status">
                  {settings?.githubSet
                    ? <>✓ set <code>{settings.githubMasked}</code></>
                    : <span className="warn-txt">not set — Ship needs it (a PAT with repo scope)</span>}
                </div>
                <div className="set-row">
                  <input
                    className="set-input" type="password" placeholder="ghp_… or github_pat_…"
                    value={githubInput} onChange={(e) => setGithubInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void onSaveGithub(); }}
                  />
                  <button className="db primary" onClick={() => void onSaveGithub()}>Save</button>
                </div>
              </div>

              <div className="set-sec">
                <div className="set-label">Projects &amp; monitors</div>
                {settings && settings.projects.length > 0 ? (
                  settings.projects.map((p) => (
                    <div className="set-proj" key={p.id}>
                      <div className="set-proj-t">{p.name}</div>
                      <div className="set-proj-p">{p.repoPath}</div>
                      {!p.isGitRepo && (
                        <div className="set-status warn-txt">⚠ not a git repo — runs need a worktree. Run <code>git init</code> here first.</div>
                      )}
                      <button className="db ghost" onClick={() => void onRemoveProject(p.id)}>Remove</button>
                      <div className="set-mons">
                        {p.monitors.map((m) => (
                          <div className="set-mon" key={m.name}>
                            <span className="set-mon-n">{m.name}</span>
                            <span className="set-mon-u">{m.url}</span>
                            <button className="mon-x" title="Remove monitor" onClick={() => void onRemoveMonitor(p.repoPath, m.name)}>✕</button>
                          </div>
                        ))}
                        <div className="set-row">
                          <input className="set-input sm" placeholder="monitor name" value={monInput(p.repoPath).name} onChange={(e) => setMon(p.repoPath, { name: e.target.value })} />
                          <input className="set-input sm" placeholder="https://…/health" value={monInput(p.repoPath).url} onChange={(e) => setMon(p.repoPath, { url: e.target.value })} />
                          <button className="db" onClick={() => void onAddMonitor(p.repoPath)} disabled={!monInput(p.repoPath).name.trim() || !monInput(p.repoPath).url.trim()}>+ Monitor</button>
                        </div>
                      </div>
                    </div>
                  ))
                ) : <div className="set-status">No projects yet.</div>}
                <div className="set-row">
                  <input className="set-input sm" placeholder="Name (e.g. VPSTech Website)" value={projName} onChange={(e) => setProjName(e.target.value)} />
                  <button className="db" onClick={() => void onPickFolder()}>{projPath ? "✓ folder" : "Choose folder…"}</button>
                  <button className="db primary" onClick={() => void onAddProject()} disabled={!projName.trim() || !projPath.trim()}>Add</button>
                </div>
                {projPath && <div className="set-proj-p" style={{ marginTop: 4 }}>{projPath}</div>}
              </div>
            </div>
            <div className="modal-btns">
              <button className="db primary" onClick={() => setShowSettings(false)}>Done</button>
            </div>
          </div>
        </div>
      )}
      <header className="topbar">
        <span className="logo no-drag" />
        <span className="brand">Mantra</span>
        <span className="sub">Overseer</span>
        <span className="spacer" />
        <span className="spend no-drag">${fleet ? fleet.spendToday.toFixed(2) : "0.00"} / ${fleet?.budget ?? 30}</span>
        <span className="pill no-drag"><span className="dot" />healthy</span>
        <button className="gear no-drag" title="Setup" onClick={() => setShowSettings(true)}>
          ⚙{settings && settings.authMode === "apiKey" && !settings.apiKeySet && <span className="gear-dot" />}
        </button>
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
          {fleet && fleet.projects.length === 0 ? (
            <div className="pcard" style={{ gridColumn: "1 / -1" }}>
              <div className="pcard-h"><span className="hp idle" /><span className="nm">No projects yet</span></div>
              <div className="s" style={{ color: "var(--muted)", fontSize: 12.5, marginBottom: 10 }}>
                {settings?.apiKeySet
                  ? "Add a project to start running crews from the console."
                  : "Set your Anthropic API key and add a project — all from Setup, no files to edit."}
              </div>
              <button className="db primary" onClick={() => setShowSettings(true)}>⚙ Open Setup</button>
            </div>
          ) : (
            <div className="fleet">
              {fleet?.projects.map((p) => <Project key={p.id} p={p} />)}
            </div>
          )}
        </main>

        <aside className="rail">
          {incidents.length > 0 && (
            <>
              <div className="rail-h">Incidents <span className="cnt">{incidents.length}</span></div>
              {incidents.map((inc) => (
                <div className={`dcard${inc.severity === "critical" ? " crit" : ""}`} key={`${inc.repoPath}::${inc.probe}`}>
                  <span className="pj">{inc.project}</span>
                  <div className="t">🚨 {inc.probe} — {inc.severity}</div>
                  <div className="s">{inc.note ?? "health signal degraded"} · escalated for your attention (remediation is human-gated).</div>
                </div>
              ))}
            </>
          )}
          {reviews.length > 0 && (
            <>
              <div className="rail-h">Awaiting your review <span className="cnt">{reviews.length}</span></div>
              {reviews.map((r) => (
                <div className="dcard crit" key={r.id}>
                  <span className="pj">{r.project}</span>
                  <div className="t">{r.title}</div>
                  <div className="s">Crew finished this — approve to accept, ship to promote (PR → CI → merge), or send back.</div>
                  <div className="dbtns">
                    <button className="db" onClick={() => void resolveReview(r, false)}>Reject</button>
                    <button className="db" onClick={() => void shipReview(r)}>Ship</button>
                    <button className="db primary" onClick={() => void resolveReview(r, true)}>Approve</button>
                  </div>
                </div>
              ))}
            </>
          )}
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
          {audit.length > 0 && (
            <>
              <div className="rail-h">Audit trail</div>
              <div className="audit">
                {audit.map((a, i) => (
                  <div className="arow" key={`${a.at}-${i}`}>
                    <span className="ak">{a.kind}</span>
                    <span className="as-txt">{a.project ? `${a.project}: ` : ""}{a.summary}</span>
                  </div>
                ))}
              </div>
            </>
          )}
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
