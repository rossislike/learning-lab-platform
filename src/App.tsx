import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  CheckCircle2,
  CircleDashed,
  Clock3,
  Cloud,
  Folder,
  Play,
  RefreshCw,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type AppProps = {
  convexUrl?: string;
  missingConvexUrl?: boolean;
};

type LabSummary = {
  _id: Id<"labs">;
  slug: string;
  title: string;
  summary: string;
  status: string;
};

type SessionSummary = {
  _id: Id<"sessions">;
  learnerLabel: string;
  status: string;
  runner: string;
  workspaceUrl?: string;
  previewUrl?: string;
  terminalUrl?: string;
  editorProvider?: string;
  editorContainerName?: string;
  editorPort?: number;
  previewPort?: number;
  toolsPort?: number;
  workspacePath?: string;
  lastCheckSummary?: string;
  lastCheckScore?: number;
  createdAt: number;
  expiresAt: number;
  stoppedAt?: number;
  stopReason?: string;
  cleanedAt?: number;
  cleanupSummary?: string;
};

type SessionEvent = {
  _id: Id<"sessionEvents">;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: unknown;
  createdAt: number;
};

type ValidationAssertion = {
  title?: string;
  status?: string;
};

type ValidationMetadata = {
  assertions?: ValidationAssertion[];
  score?: number;
  passed?: boolean;
  summary?: string;
};

type AppTab = "dashboard" | "workspace";

export default function App({ convexUrl, missingConvexUrl = false }: AppProps) {
  if (missingConvexUrl || !convexUrl) {
    return <SetupRequiredApp />;
  }

  return <ConnectedApp convexUrl={convexUrl} />;
}

function SetupRequiredApp() {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Learning Lab Platform</p>
          <h1>React labs, disposable sessions, AWS runners.</h1>
        </div>
        <nav className="nav-list" aria-label="Main">
          <a href="#setup">Setup</a>
          <a href="#runner">Runner</a>
        </nav>
      </aside>

      <section className="content">
        <div className="notice" id="setup">
          <strong>Convex URL missing.</strong>
          <span>Run `npx convex dev`, then set VITE_CONVEX_URL in .env.local.</span>
        </div>

        <header className="topbar">
          <div>
            <p className="eyebrow">First milestone</p>
            <h2>Optimize Product Dashboard</h2>
          </div>
        </header>

        <section className="grid">
          <article className="panel lab-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Active lab</p>
                <h3>React Product Dashboard</h3>
              </div>
              <span className="status-pill">setup</span>
            </div>
            <p className="muted">
              The scaffold is ready. Connect Convex to seed labs and request
              learner sessions.
            </p>
            <div className="meta-row">
              <span>Vite preview</span>
              <span>Vitest validation</span>
              <span>Container runner</span>
            </div>
          </article>

          <RunnerContractPanel />
        </section>
      </section>
    </main>
  );
}

function ConnectedApp({ convexUrl }: { convexUrl: string }) {
  const convex = useMemo(() => new ConvexHttpClient(convexUrl), [convexUrl]);
  const [labs, setLabs] = useState<LabSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionEvents, setSelectedSessionEvents] = useState<SessionEvent[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [learnerLabel, setLearnerLabel] = useState("local-learner");
  const [activeTab, setActiveTab] = useState<AppTab>(() => tabFromHash(window.location.hash));
  const [selectedSessionId, setSelectedSessionId] = useState<Id<"sessions"> | null>(
    null
  );

  const activeLab = useMemo(
    () =>
      labs?.find((lab: LabSummary) => lab.slug === "react-product-dashboard") ??
      labs?.[0],
    [labs]
  );
  const selectedSession =
    sessions?.find((session) => session._id === selectedSessionId) ?? sessions?.[0];

  const refreshDashboard = useCallback(async () => {
    try {
      const [nextLabs, nextSessions] = await Promise.all([
        convex.query(api.labs.list, {}),
        convex.query(api.sessions.list, {}),
      ]);
      setLabs(nextLabs as LabSummary[]);
      setSessions(nextSessions as SessionSummary[]);
      setLastRefreshAt(Date.now());
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [convex]);

  const refreshEvents = useCallback(
    async (sessionId: Id<"sessions"> | undefined) => {
      if (!sessionId) {
        setSelectedSessionEvents([]);
        return;
      }

      try {
        const events = await convex.query(api.sessions.listEvents, { sessionId });
        setSelectedSessionEvents(events as SessionEvent[]);
        setLoadError(null);
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : String(error));
      }
    },
    [convex]
  );

  useEffect(() => {
    function handleHashChange() {
      setActiveTab(tabFromHash(window.location.hash));
    }

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshDashboard();
    }, 0);
    const interval = window.setInterval(() => {
      void refreshDashboard();
    }, 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshDashboard]);

  useEffect(() => {
    const initial = window.setTimeout(() => {
      void refreshEvents(selectedSession?._id);
    }, 0);
    const interval = window.setInterval(() => {
      void refreshEvents(selectedSession?._id);
    }, 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshEvents, selectedSession?._id]);

  async function startSession() {
    if (!activeLab) return;
    await convex.mutation(api.sessions.request, {
      labId: activeLab._id,
      learnerLabel,
      runner: "local",
      ttlSeconds: 60 * 60,
    });
    await refreshDashboard();
  }

  async function stopSession(sessionId: Id<"sessions">) {
    await convex.mutation(api.sessions.stop, {
      sessionId,
      reason: "Stopped by operator",
    });
    await refreshDashboard();
    await refreshEvents(sessionId);
  }

  async function runSessionCheck(session: SessionSummary) {
    if (!session.terminalUrl?.startsWith("http")) return;

    const checkUrl = new URL("/api/check", session.terminalUrl).toString();
    const response = await fetch(checkUrl, { method: "POST" });
    if (!response.ok) {
      throw new Error(`Check failed with HTTP ${response.status}`);
    }
    await refreshDashboard();
    await refreshEvents(session._id);
  }

  async function seedReactLab() {
    await convex.mutation(api.labs.seedReactProductDashboard, {});
    await refreshDashboard();
  }

  function changeTab(tab: AppTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tab === "workspace" ? "#workspace" : "#dashboard");
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Learning Lab Platform</p>
          <h1>React labs, disposable sessions, AWS runners.</h1>
        </div>
        <nav className="nav-list" aria-label="Main">
          <a href="#dashboard" onClick={() => changeTab("dashboard")}>Dashboard</a>
          <a href="#workspace" onClick={() => changeTab("workspace")}>Workspace</a>
        </nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">First milestone</p>
            <h2>Optimize Product Dashboard</h2>
          </div>
          <div className="topbar-actions">
            <span className="refresh-state">
              {loadError
                ? `Sync error: ${loadError}`
                : lastRefreshAt
                  ? `Updated ${formatTime(lastRefreshAt)}`
                  : "Loading"}
            </span>
            <button className="secondary-button" onClick={() => refreshDashboard()}>
              <RefreshCw size={16} />
              Refresh
            </button>
            <button className="secondary-button" onClick={() => seedReactLab()}>
              <RefreshCw size={16} />
              Seed lab
            </button>
          </div>
        </header>

        <div className="tab-list" role="tablist" aria-label="Primary views">
          <button
            aria-selected={activeTab === "dashboard"}
            className={activeTab === "dashboard" ? "active" : ""}
            role="tab"
            onClick={() => changeTab("dashboard")}
          >
            Dashboard
          </button>
          <button
            aria-selected={activeTab === "workspace"}
            className={activeTab === "workspace" ? "active" : ""}
            role="tab"
            onClick={() => changeTab("workspace")}
          >
            Editor and Preview
          </button>
        </div>

        {activeTab === "dashboard" ? (
          <DashboardTab
            activeLab={activeLab}
            events={selectedSessionEvents}
            learnerLabel={learnerLabel}
            selectedSession={selectedSession}
            sessions={sessions}
            onLearnerLabelChange={setLearnerLabel}
            onRunCheck={runSessionCheck}
            onSelectSession={setSelectedSessionId}
            onStartSession={startSession}
            onStop={stopSession}
          />
        ) : (
          <WorkspaceTab
            session={selectedSession}
            events={selectedSessionEvents}
            onRunCheck={runSessionCheck}
            onStop={stopSession}
          />
        )}
      </section>
    </main>
  );
}

function DashboardTab({
  activeLab,
  events,
  learnerLabel,
  selectedSession,
  sessions,
  onLearnerLabelChange,
  onRunCheck,
  onSelectSession,
  onStartSession,
  onStop,
}: {
  activeLab?: LabSummary;
  events: SessionEvent[];
  learnerLabel: string;
  selectedSession?: SessionSummary;
  sessions: SessionSummary[];
  onLearnerLabelChange: (value: string) => void;
  onRunCheck: (session: SessionSummary) => Promise<void>;
  onSelectSession: (sessionId: Id<"sessions">) => void;
  onStartSession: () => Promise<void>;
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
}) {
  return (
    <div className="tab-panel" id="dashboard" role="tabpanel">
      <section className="grid">
        <article className="panel lab-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Active lab</p>
              <h3>{activeLab?.title ?? "No lab seeded yet"}</h3>
            </div>
            <span className="status-pill">{activeLab?.status ?? "missing"}</span>
          </div>

          <p className="muted">
            {activeLab?.summary ??
              "Seed the React Product Dashboard lab to create the first scenario."}
          </p>

          <div className="meta-row">
            <span>Vite preview</span>
            <span>Vitest validation</span>
            <span>Container runner</span>
          </div>

          <label className="field">
            Learner label
            <input
              value={learnerLabel}
              onChange={(event) => onLearnerLabelChange(event.target.value)}
            />
          </label>

          <button className="primary-button" disabled={!activeLab} onClick={onStartSession}>
            <Play size={16} />
            Request session
          </button>
        </article>

        <RunnerContractPanel />
      </section>

      <section className="panel" id="sessions">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Recent sessions</p>
            <h3>Control-plane state</h3>
          </div>
        </div>

        <div className="session-table">
          <div className="session-row session-head">
            <span>Learner</span>
            <span>Status</span>
            <span>Runner</span>
            <span>Score</span>
          </div>
          {(sessions ?? []).map((session: SessionSummary) => (
            <button
              className={`session-row session-button ${
                selectedSession?._id === session._id ? "selected" : ""
              }`}
              key={session._id}
              onClick={() => onSelectSession(session._id)}
            >
              <span>{session.learnerLabel}</span>
              <span><StatusPill status={session.status} /></span>
              <span>{session.runner}</span>
              <span>{session.lastCheckScore ?? "-"}</span>
            </button>
          ))}
          {sessions?.length === 0 ? (
            <p className="empty-state">No sessions yet. Request one from the lab panel.</p>
          ) : null}
        </div>
      </section>

      <SessionDetailPanel
        session={selectedSession}
        events={events}
        onStop={onStop}
        onRunCheck={onRunCheck}
      />
    </div>
  );
}

function SessionDetailPanel({
  session,
  events,
  onStop,
  onRunCheck,
}: {
  session?: SessionSummary;
  events: SessionEvent[];
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
  onRunCheck: (session: SessionSummary) => Promise<void>;
}) {
  const validation = useMemo(() => latestValidation(events), [events]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function runAction(action: "stop" | "check") {
    if (!session) return;
    setActionError(null);
    setActionBusy(action);
    try {
      if (action === "stop") {
        await onStop(session._id);
      } else {
        await onRunCheck(session);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <section className="panel session-detail">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Session detail</p>
          <h3>{session ? session.learnerLabel : "Select a session"}</h3>
        </div>
        {session ? (
          <div className="topbar-actions">
            <StatusPill status={session.status} />
            <button
              className="secondary-button"
              disabled={!session.terminalUrl?.startsWith("http") || actionBusy !== null}
              onClick={() => void runAction("check")}
            >
              <RefreshCw size={16} />
              {actionBusy === "check" ? "Checking" : "Run checks"}
            </button>
            <button
              className="danger-button"
              disabled={["stopped", "expired"].includes(session.status) || actionBusy !== null}
              onClick={() => void runAction("stop")}
            >
              Stop
            </button>
          </div>
        ) : null}
      </div>

      {!session ? (
        <p className="empty-state">Request or select a session to inspect runner output.</p>
      ) : (
        <>
          <div className="detail-grid">
            <DetailItem label="Runner" value={session.runner} />
            <DetailItem label="Score" value={formatScore(session.lastCheckScore)} />
            <DetailItem label="Created" value={formatTime(session.createdAt)} />
            <DetailItem label="Expires" value={formatTime(session.expiresAt)} />
          </div>

          {actionError ? <p className="error-text">{actionError}</p> : null}

          <div className="url-grid">
            <UrlItem icon={<Folder size={16} />} label="Workspace" value={session.workspaceUrl} />
            <UrlItem icon={<SquareTerminal size={16} />} label="Tools" value={session.terminalUrl} />
            <UrlItem icon={<Cloud size={16} />} label="Preview" value={session.previewUrl} />
          </div>

          <div className="metadata-grid">
            <DetailItem label="Editor provider" value={session.editorProvider ?? "-"} />
            <DetailItem label="Container" value={session.editorContainerName ?? "-"} />
            <DetailItem label="Editor port" value={formatNumber(session.editorPort)} />
            <DetailItem label="Preview port" value={formatNumber(session.previewPort)} />
            <DetailItem label="Tools port" value={formatNumber(session.toolsPort)} />
            <DetailItem label="Workspace path" value={session.workspacePath ?? "-"} />
            <DetailItem label="Stopped" value={formatOptionalTime(session.stoppedAt)} />
            <DetailItem label="Cleaned" value={formatOptionalTime(session.cleanedAt)} />
          </div>

          {session.stopReason || session.cleanupSummary ? (
            <div className="notice compact-notice">
              <strong>{session.stopReason ?? "Cleanup"}</strong>
              <span>{session.cleanupSummary ?? "Awaiting local runner cleanup."}</span>
            </div>
          ) : null}

          <div className="validation-section">
            <div className="section-heading">
              <p className="eyebrow">Validation</p>
              <strong>{validation?.summary ?? session.lastCheckSummary ?? "No validation yet"}</strong>
            </div>

            {validation?.assertions?.length ? (
              <ul className="validation-list">
                {validation.assertions.map((assertion, index) => (
                  <li key={`${assertion.title}-${index}`}>
                    {assertion.status === "passed" ? (
                      <CheckCircle2 size={16} className="pass-icon" />
                    ) : (
                      <XCircle size={16} className="fail-icon" />
                    )}
                    <span>{assertion.title}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">
                {session.status === "requested"
                  ? "Waiting for the local runner to start this session."
                  : "Use Run checks when the learner is ready for validation."}
              </p>
            )}
          </div>

          <div className="event-section">
            <div className="section-heading">
              <p className="eyebrow">Event timeline</p>
            </div>
            <ol className="event-list">
              {events.map((event) => (
                <li key={event._id}>
                  <span className={`event-dot ${event.level}`} />
                  <div>
                    <strong>{event.message}</strong>
                    <small>{formatTime(event.createdAt)}</small>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </section>
  );
}

function WorkspaceTab({
  session,
  events,
  onStop,
  onRunCheck,
}: {
  session?: SessionSummary;
  events: SessionEvent[];
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
  onRunCheck: (session: SessionSummary) => Promise<void>;
}) {
  const validation = useMemo(() => latestValidation(events), [events]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function runAction(action: "stop" | "check") {
    if (!session) return;
    setActionError(null);
    setActionBusy(action);
    try {
      if (action === "stop") {
        await onStop(session._id);
      } else {
        await onRunCheck(session);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(null);
    }
  }

  return (
    <section className="workspace-tab tab-panel" id="workspace" role="tabpanel">
      <div className="workspace-toolbar">
        <div>
          <p className="eyebrow">Workspace</p>
          <h3>{session ? session.learnerLabel : "Select a session"}</h3>
        </div>
        {session ? (
          <div className="topbar-actions">
            <StatusPill status={session.status} />
            <button
              className="secondary-button"
              disabled={!session.terminalUrl?.startsWith("http") || actionBusy !== null}
              onClick={() => void runAction("check")}
            >
              <RefreshCw size={16} />
              {actionBusy === "check" ? "Checking" : "Run checks"}
            </button>
            <button
              className="danger-button"
              disabled={["stopped", "expired"].includes(session.status) || actionBusy !== null}
              onClick={() => void runAction("stop")}
            >
              Stop
            </button>
          </div>
        ) : null}
      </div>

      {!session ? (
        <section className="panel">
          <p className="empty-state">Request a session from the dashboard to open a workspace.</p>
        </section>
      ) : (
        <>
          {actionError ? <p className="error-text">{actionError}</p> : null}

          <div className="workspace-meta-strip">
            <DetailItem label="Score" value={formatScore(session.lastCheckScore)} />
            <DetailItem label="Validation" value={validation?.summary ?? session.lastCheckSummary ?? "Not run"} />
            <DetailItem label="Editor" value={session.workspaceUrl ?? "not available"} />
            <DetailItem label="Preview" value={session.previewUrl ?? "not available"} />
          </div>

          <WorkspaceSplitView session={session} />
        </>
      )}
    </section>
  );
}

function WorkspaceSplitView({ session }: { session: SessionSummary }) {
  const editorReady = session.workspaceUrl?.startsWith("http");
  const previewReady = session.previewUrl?.startsWith("http");

  return (
    <div className="workspace-section" id="workspace">
      <div className="section-heading">
        <p className="eyebrow">Workspace</p>
        <strong>Editor and preview</strong>
      </div>

      {editorReady && previewReady ? (
        <div className="workspace-split">
          <div className="workspace-frame-shell editor-frame">
            <div className="frame-header">
              <span>OpenVSCode</span>
              <a href={session.workspaceUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
            <iframe
              allow="clipboard-read; clipboard-write"
              className="workspace-frame"
              src={session.workspaceUrl}
              title={`${session.learnerLabel} OpenVSCode editor`}
            />
          </div>

          <div className="workspace-frame-shell preview-frame">
            <div className="frame-header">
              <span>Preview</span>
              <a href={session.previewUrl} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
            <iframe
              className="workspace-frame"
              src={session.previewUrl}
              title={`${session.learnerLabel} Vite preview`}
            />
          </div>
        </div>
      ) : (
        <p className="muted">Workspace panes appear after the local runner starts the session.</p>
      )}
    </div>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function UrlItem({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value?: string;
}) {
  return (
    <div className="url-item">
      {icon}
      <div>
        <span>{label}</span>
        {value?.startsWith("http") ? (
          <a href={value} target="_blank" rel="noreferrer">
            {value}
          </a>
        ) : (
          <code>{value ?? "not available yet"}</code>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function latestValidation(events: SessionEvent[]): ValidationMetadata | null {
  for (const event of events) {
    const metadata = event.metadata as ValidationMetadata | undefined;
    if (metadata?.assertions?.length) {
      return metadata;
    }
  }

  return null;
}

function formatScore(score?: number) {
  return typeof score === "number" ? `${score}%` : "-";
}

function formatNumber(value?: number) {
  return typeof value === "number" ? String(value) : "-";
}

function formatOptionalTime(timestamp?: number) {
  return typeof timestamp === "number" ? formatTime(timestamp) : "-";
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function tabFromHash(hash: string): AppTab {
  return hash.startsWith("#workspace") ? "workspace" : "dashboard";
}

function RunnerContractPanel() {
  return (
    <article className="panel" id="runner">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Runner contract</p>
          <h3>Local now, AWS next</h3>
        </div>
        <Cloud size={22} />
      </div>
      <ul className="check-list">
        <li><CheckCircle2 size={16} /> Copy starter workspace</li>
        <li><SquareTerminal size={16} /> Expose editor, terminal, preview</li>
        <li><CheckCircle2 size={16} /> Run Vitest and return checklist results</li>
        <li><Clock3 size={16} /> Enforce TTL and teardown</li>
        <li><CircleDashed size={16} /> Swap local runner for AWS ECS</li>
      </ul>
    </article>
  );
}
