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
  Save,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { ConvexHttpClient } from "convex/browser";
import { Group, Panel, Separator } from "react-resizable-panels";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

type AppProps = {
  authMode?: string;
  convexUrl?: string;
  missingConvexUrl?: boolean;
  productSurface?: string;
  sessionAccessMode?: string;
};

type LabSummary = {
  _id: Id<"labs">;
  slug: string;
  title: string;
  summary: string;
  status: string;
  difficulty: number;
  tags: string[];
  remediationFile?: string;
  expectedBehavior?: string;
  domainTitle?: string;
  domainSummary?: string;
  displayOrder?: number;
  scenarioLabel?: string;
};

type SessionSummary = {
  _id: Id<"sessions">;
  labId: Id<"labs">;
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
  completedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
  cleanupRequestedAt?: number;
  cleanedAt?: number;
  cleanupSummary?: string;
  removedFromListAt?: number;
};

type ScenarioAttemptSummary = {
  attempts: number;
  passed: number;
  failed: number;
  bestScore?: number;
  lastAttemptAt?: number;
};

type ProgressRecord = {
  _id: Id<"progressRecords">;
  labId: Id<"labs">;
  sessionId: Id<"sessions">;
  learnerLabel: string;
  status: string;
  score?: number;
  summary?: string;
  startedAt: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
};

type SessionEvent = {
  _id: Id<"sessionEvents">;
  level: "info" | "warn" | "error";
  message: string;
  metadata?: unknown;
  createdAt: number;
};

type RunnerHeartbeat = {
  _id: Id<"runnerHeartbeats">;
  runner: string;
  runnerId: string;
  pollMs: number;
  pid?: number;
  hostname?: string;
  lastSeenAt: number;
  createdAt: number;
  updatedAt: number;
};

type ObservabilitySummary = {
  sampleSize: number;
  averageStartupMs?: number;
  averageValidationMs?: number;
  averageCleanupMs?: number;
  failureCount: number;
  failureRate: number;
  terminalSessionCount: number;
};

type ValidationAssertion = {
  title?: string;
  status?: string;
  message?: string;
};

type ValidationMetadata = {
  assertions?: ValidationAssertion[];
  score?: number;
  passed?: boolean;
  summary?: string;
};

type AppTab = "dashboard" | "workspace";
type WorkspaceLayout = {
  editor: number;
  preview: number;
};

type EmptyStateTone = "neutral" | "info" | "success" | "warning" | "danger";
type EmptyStateCopy = {
  title: string;
  body: string;
  tone: EmptyStateTone;
};
type EndpointKey = "workspace" | "tools" | "preview";
type EndpointStatus = "missing" | "checking" | "reachable" | "stale";
type EndpointHealth = {
  status: EndpointStatus;
  checkedAt?: number;
  message: string;
};
type SessionEndpointHealth = Record<EndpointKey, EndpointHealth>;

const defaultWorkspaceLayout: WorkspaceLayout = { editor: 62, preview: 38 };
const workspaceLayoutStorageKey = "learning-lab-workspace-layout";
const selectedSessionStorageKey = "learning-lab-selected-session-id";

export default function App({
  authMode = "disabled",
  convexUrl,
  missingConvexUrl = false,
  productSurface = "local",
  sessionAccessMode = "local-only",
}: AppProps) {
  if (missingConvexUrl || !convexUrl) {
    return <SetupRequiredApp />;
  }

  const securityBlocker = hostedSecurityBlocker(productSurface, authMode, sessionAccessMode);
  if (securityBlocker) {
    return (
      <HostedSecurityRequiredApp
        authMode={authMode}
        productSurface={productSurface}
        securityBlocker={securityBlocker}
        sessionAccessMode={sessionAccessMode}
      />
    );
  }

  return <ConnectedApp convexUrl={convexUrl} />;
}

function hostedSecurityBlocker(
  productSurface: string,
  authMode: string,
  sessionAccessMode: string
) {
  if (!["hosted", "public"].includes(productSurface)) {
    return null;
  }
  if (authMode !== "configured") {
    return "authentication";
  }
  if (sessionAccessMode !== "authorized") {
    return "session access authorization";
  }
  return null;
}

function HostedSecurityRequiredApp({
  authMode,
  productSurface,
  securityBlocker,
  sessionAccessMode,
}: {
  authMode: string;
  productSurface: string;
  securityBlocker: string;
  sessionAccessMode: string;
}) {
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div>
          <p className="eyebrow">Learning Lab Platform</p>
          <h1>React labs, disposable sessions, AWS runners.</h1>
        </div>
        <nav className="nav-list" aria-label="Main">
          <a href="#auth">Auth gate</a>
        </nav>
      </aside>

      <section className="content">
        <div className="notice" id="auth">
          <strong>Hosted security gate blocked startup.</strong>
          <span>
            Configure {securityBlocker} before running a {productSurface} surface.
            Current auth mode is <code>{authMode}</code> and session access mode is{" "}
            <code>{sessionAccessMode}</code>.
          </span>
        </div>

        <section className="grid">
          <article className="panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Product readiness</p>
                <h3>Hosted/public deployment is blocked</h3>
              </div>
              <span className="status-pill status-errored">blocked</span>
            </div>
            <p className="muted">
              Local development can run with local-only access. Hosted and public surfaces must
              configure authentication plus authorized session and workspace URL access before
              exposing learner data.
            </p>
          </article>
        </section>
      </section>
    </main>
  );
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
  const [progressRecords, setProgressRecords] = useState<ProgressRecord[]>([]);
  const [runnerHeartbeat, setRunnerHeartbeat] = useState<RunnerHeartbeat | null>(null);
  const [observabilitySummary, setObservabilitySummary] =
    useState<ObservabilitySummary | null>(null);
  const [selectedSessionEvents, setSelectedSessionEvents] = useState<SessionEvent[]>([]);
  const [selectedEndpointHealth, setSelectedEndpointHealth] =
    useState<SessionEndpointHealth>(() => emptyEndpointHealth());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [learnerLabel, setLearnerLabel] = useState("local-learner");
  const [activeTab, setActiveTab] = useState<AppTab>(() => tabFromHash(window.location.hash));
  const [selectedLabId, setSelectedLabId] = useState<Id<"labs"> | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<Id<"sessions"> | null>(
    () => readSelectedSessionId()
  );

  const scenarios = useMemo(
    () =>
      [...labs].sort((a, b) => {
        const orderDelta = (a.displayOrder ?? 999) - (b.displayOrder ?? 999);
        return orderDelta || a.title.localeCompare(b.title);
      }),
    [labs]
  );
  const selectedScenario =
    scenarios.find((lab) => lab._id === selectedLabId) ?? scenarios[0];
  const selectedSession = sessions.find((session) => session._id === selectedSessionId);

  const refreshDashboard = useCallback(async () => {
    try {
      const [
        nextLabs,
        nextSessions,
        nextProgressRecords,
        nextRunnerHeartbeat,
        nextObservabilitySummary,
      ] = await Promise.all([
        convex.query(api.labs.list, {}),
        convex.query(api.sessions.list, {}),
        convex.query(api.progress.list, {}),
        convex.query(api.runners.latest, { runner: "local" }),
        convex.query(api.observability.sessionSummary, {}),
      ]);
      setLabs(nextLabs as LabSummary[]);
      setSessions(nextSessions as SessionSummary[]);
      setProgressRecords(nextProgressRecords as ProgressRecord[]);
      setRunnerHeartbeat(nextRunnerHeartbeat as RunnerHeartbeat | null);
      setObservabilitySummary(nextObservabilitySummary as ObservabilitySummary);
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

  useEffect(() => {
    let cancelled = false;

    async function checkEndpoints() {
      if (!selectedSession) {
        setSelectedEndpointHealth(emptyEndpointHealth());
        return;
      }

      setSelectedEndpointHealth(checkingEndpointHealth(selectedSession));
      const nextHealth = await probeSessionEndpoints(selectedSession);
      if (!cancelled) {
        setSelectedEndpointHealth(nextHealth);
      }
    }

    void checkEndpoints();
    const interval = window.setInterval(() => {
      void checkEndpoints();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [selectedSession]);

  useEffect(() => {
    if (sessions.length === 0) {
      if (selectedSessionId !== null) {
        selectSession(null);
      }
      return;
    }

    const selectedSessionExists = sessions.some(
      (session) => session._id === selectedSessionId
    );
    if (!selectedSessionExists) {
      selectSession(sessions[0]._id);
    }
  }, [selectedSessionId, sessions]);

  async function startSession() {
    if (!selectedScenario) return;
    const sessionId = await convex.mutation(api.sessions.request, {
      labId: selectedScenario._id,
      learnerLabel,
      runner: "local",
      ttlSeconds: 60 * 60,
    });
    selectSession(sessionId as Id<"sessions">);
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

  async function requestCleanup(sessionId: Id<"sessions">) {
    await convex.mutation(api.sessions.requestCleanup, { sessionId });
    await refreshDashboard();
    await refreshEvents(sessionId);
  }

  async function removeSessionFromList(sessionId: Id<"sessions">) {
    await convex.mutation(api.sessions.removeFromList, { sessionId });
    if (selectedSessionId === sessionId) {
      selectSession(null);
    }
    await refreshDashboard();
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

  async function seedScenarios() {
    await convex.mutation(api.labs.seedScenarios, {});
    await refreshDashboard();
  }

  function changeTab(tab: AppTab) {
    setActiveTab(tab);
    window.history.replaceState(null, "", tab === "workspace" ? "#workspace" : "#dashboard");
  }

  function selectSession(sessionId: Id<"sessions"> | null) {
    setSelectedSessionId(sessionId);
    if (sessionId) {
      window.localStorage.setItem(selectedSessionStorageKey, sessionId);
    } else {
      window.localStorage.removeItem(selectedSessionStorageKey);
    }
  }

  return (
    <main className={`app-shell ${activeTab === "workspace" ? "workspace-mode" : ""}`}>
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
            <p className="eyebrow">Local MVP</p>
            <h2>React Scenario Catalog</h2>
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
            <button className="secondary-button" onClick={() => seedScenarios()}>
              <RefreshCw size={16} />
              Seed scenarios
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
            endpointHealth={selectedEndpointHealth}
            events={selectedSessionEvents}
            learnerLabel={learnerLabel}
            observabilitySummary={observabilitySummary}
            progressRecords={progressRecords}
            runnerHeartbeat={runnerHeartbeat}
            scenarios={scenarios}
            selectedScenario={selectedScenario}
            selectedSession={selectedSession}
            sessions={sessions}
            onLearnerLabelChange={setLearnerLabel}
            onRunCheck={runSessionCheck}
            onRequestCleanup={requestCleanup}
            onRemoveSessionFromList={removeSessionFromList}
            onSelectScenario={setSelectedLabId}
            onSelectSession={selectSession}
            onStartSession={startSession}
            onStop={stopSession}
          />
        ) : (
          <WorkspaceTab
            endpointHealth={selectedEndpointHealth}
            session={selectedSession}
            scenario={selectedSession ? scenarioForSession(selectedSession, scenarios) : undefined}
            events={selectedSessionEvents}
            onRunCheck={runSessionCheck}
            onRequestCleanup={requestCleanup}
            onStop={stopSession}
          />
        )}
      </section>
    </main>
  );
}

function DashboardTab({
  endpointHealth,
  events,
  learnerLabel,
  observabilitySummary,
  progressRecords,
  runnerHeartbeat,
  scenarios,
  selectedScenario,
  selectedSession,
  sessions,
  onLearnerLabelChange,
  onRunCheck,
  onRequestCleanup,
  onRemoveSessionFromList,
  onSelectScenario,
  onSelectSession,
  onStartSession,
  onStop,
}: {
  endpointHealth: SessionEndpointHealth;
  events: SessionEvent[];
  learnerLabel: string;
  observabilitySummary: ObservabilitySummary | null;
  progressRecords: ProgressRecord[];
  runnerHeartbeat: RunnerHeartbeat | null;
  scenarios: LabSummary[];
  selectedScenario?: LabSummary;
  selectedSession?: SessionSummary;
  sessions: SessionSummary[];
  onLearnerLabelChange: (value: string) => void;
  onRunCheck: (session: SessionSummary) => Promise<void>;
  onRequestCleanup: (sessionId: Id<"sessions">) => Promise<void>;
  onRemoveSessionFromList: (sessionId: Id<"sessions">) => Promise<void>;
  onSelectScenario: (labId: Id<"labs">) => void;
  onSelectSession: (sessionId: Id<"sessions">) => void;
  onStartSession: () => Promise<void>;
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
}) {
  const requestedLocalSessions = sessions.filter(
    (session) => session.runner === "local" && session.status === "requested"
  );
  const [sessionScenarioFilter, setSessionScenarioFilter] = useState("all");
  const [sessionStatusFilter, setSessionStatusFilter] = useState("all");
  const [sessionLearnerFilter, setSessionLearnerFilter] = useState("");
  const sessionStatuses = useMemo(
    () => [...new Set(sessions.map((session) => session.status))].sort(),
    [sessions]
  );
  const filteredSessions = useMemo(() => {
    const learnerQuery = sessionLearnerFilter.trim().toLocaleLowerCase();

    return sessions.filter((session) => {
      const matchesScenario =
        sessionScenarioFilter === "all" || session.labId === sessionScenarioFilter;
      const matchesStatus =
        sessionStatusFilter === "all" || session.status === sessionStatusFilter;
      const matchesLearner =
        learnerQuery.length === 0 ||
        session.learnerLabel.toLocaleLowerCase().includes(learnerQuery);

      return matchesScenario && matchesStatus && matchesLearner;
    });
  }, [sessionLearnerFilter, sessionScenarioFilter, sessionStatusFilter, sessions]);
  const selectedScenarioSessions = useMemo(() => {
    if (!selectedScenario) {
      return [];
    }

    return sessions
      .filter((session) => session.labId === selectedScenario._id)
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [selectedScenario, sessions]);
  const scenarioAttemptSummaries = useMemo(
    () => summarizeScenarioAttempts(progressRecords),
    [progressRecords]
  );

  return (
    <div className="tab-panel" id="dashboard" role="tabpanel">
      <ScenarioCatalog
        attemptSummaries={scenarioAttemptSummaries}
        scenarios={scenarios}
        selectedScenario={selectedScenario}
        onSelectScenario={onSelectScenario}
      />

      {requestedLocalSessions.length > 0 ? (
        <div className="notice runner-notice">
          <strong>Local runner required.</strong>
          <span>
            {requestedLocalSessions.length} requested session
            {requestedLocalSessions.length === 1 ? "" : "s"} will stay queued until
            <code>npm run runner:local</code> is running in this project.
          </span>
        </div>
      ) : null}

      <section className="grid request-grid">
        <article className="panel request-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Request session</p>
              <h3>{selectedScenario?.title ?? "No scenario selected"}</h3>
            </div>
            <span className="status-pill">{selectedScenario?.status ?? "missing"}</span>
          </div>

          <p className="muted">
            {selectedScenario?.summary ??
              "Seed scenarios, then select a card to request a local learner session."}
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

          <button className="primary-button" disabled={!selectedScenario} onClick={onStartSession}>
            <Play size={16} />
            Request session
          </button>
        </article>

        <RunnerHealthPanel
          heartbeat={runnerHeartbeat}
          observability={observabilitySummary}
          requestedCount={requestedLocalSessions.length}
        />
      </section>

      <ScenarioSessionHistory
        attemptSummary={
          selectedScenario ? scenarioAttemptSummaries.get(selectedScenario._id) : undefined
        }
        scenario={selectedScenario}
        selectedSession={selectedSession}
        sessions={selectedScenarioSessions}
        onSelectSession={onSelectSession}
      />

      <section className="panel" id="sessions">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Recent sessions</p>
            <h3>Control-plane state</h3>
          </div>
        </div>

        <div className="session-filter-bar" aria-label="Session filters">
          <label className="filter-field">
            Scenario
            <select
              value={sessionScenarioFilter}
              onChange={(event) => setSessionScenarioFilter(event.target.value)}
            >
              <option value="all">All scenarios</option>
              {scenarios.map((scenario) => (
                <option key={scenario._id} value={scenario._id}>
                  {scenario.title}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            Status
            <select
              value={sessionStatusFilter}
              onChange={(event) => setSessionStatusFilter(event.target.value)}
            >
              <option value="all">All statuses</option>
              {sessionStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label className="filter-field">
            Learner
            <input
              placeholder="Filter by label"
              value={sessionLearnerFilter}
              onChange={(event) => setSessionLearnerFilter(event.target.value)}
            />
          </label>
        </div>

        <div className="session-table">
          <div className="session-row session-head">
            <span>Learner</span>
            <span>Scenario</span>
            <span>Status</span>
            <span>Runner</span>
            <span>Score</span>
            <span>Actions</span>
          </div>
          {filteredSessions.map((session: SessionSummary) => (
            <div
              className={`session-row session-button ${
                selectedSession?._id === session._id ? "selected" : ""
              }`}
              key={session._id}
              onClick={() => onSelectSession(session._id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectSession(session._id);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span>{session.learnerLabel}</span>
              <span>{formatScenarioTitle(session, scenarios)}</span>
              <span><StatusPill status={session.status} /></span>
              <span>{session.runner}</span>
              <span>{session.lastCheckScore ?? "-"}</span>
              <span className="session-actions">
                <button
                  className="table-action-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void onRemoveSessionFromList(session._id);
                  }}
                >
                  Remove
                </button>
              </span>
            </div>
          ))}
          {sessions.length === 0 ? (
            <EmptyState
              title="No sessions yet"
              body="Select a scenario, confirm the learner label, and request a local session."
            />
          ) : null}
          {sessions.length > 0 && filteredSessions.length === 0 ? (
            <EmptyState
              title="No matching sessions"
              body="Adjust the scenario, status, or learner filter to show more sessions."
            />
          ) : null}
        </div>
      </section>

      <SessionDetailPanel
        endpointHealth={endpointHealth}
        session={selectedSession}
        scenario={selectedSession ? scenarioForSession(selectedSession, scenarios) : undefined}
        events={events}
        onStop={onStop}
        onRunCheck={onRunCheck}
        onRequestCleanup={onRequestCleanup}
      />
    </div>
  );
}

function ScenarioSessionHistory({
  attemptSummary,
  scenario,
  selectedSession,
  sessions,
  onSelectSession,
}: {
  attemptSummary?: ScenarioAttemptSummary;
  scenario?: LabSummary;
  selectedSession?: SessionSummary;
  sessions: SessionSummary[];
  onSelectSession: (sessionId: Id<"sessions">) => void;
}) {
  return (
    <section className="panel scenario-session-history">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Scenario history</p>
          <h3>{scenario?.title ?? "Select a scenario"}</h3>
        </div>
        {scenario ? (
          <div className="history-summary">
            <span>{formatAttemptCount(attemptSummary?.attempts ?? 0)}</span>
            <span>{attemptSummary?.passed ?? 0} passed</span>
            <span>{formatBestScore(attemptSummary?.bestScore)}</span>
          </div>
        ) : null}
      </div>

      {!scenario ? (
        <EmptyState
          title="No scenario selected"
          body="Select a scenario to review its previous sessions."
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          title="No sessions for this scenario"
          body="Request a session to begin this scenario history."
        />
      ) : (
        <div className="scenario-history-list">
          <div className="scenario-history-row scenario-history-head">
            <span>Learner</span>
            <span>Status</span>
            <span>Score</span>
            <span>Started</span>
            <span>Completed</span>
            <span>Latest check</span>
          </div>
          {sessions.map((session) => (
            <button
              className={`scenario-history-row ${
                selectedSession?._id === session._id ? "selected" : ""
              }`}
              key={session._id}
              onClick={() => onSelectSession(session._id)}
            >
              <span>{session.learnerLabel}</span>
              <span><StatusPill status={session.status} /></span>
              <span>{formatScore(session.lastCheckScore)}</span>
              <span>{formatTime(session.createdAt)}</span>
              <span>{formatOptionalTime(session.completedAt)}</span>
              <span>{session.lastCheckSummary ?? "Not run"}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function ScenarioCatalog({
  attemptSummaries,
  scenarios,
  selectedScenario,
  onSelectScenario,
}: {
  attemptSummaries: Map<string, ScenarioAttemptSummary>;
  scenarios: LabSummary[];
  selectedScenario?: LabSummary;
  onSelectScenario: (labId: Id<"labs">) => void;
}) {
  const groupedScenarios = useMemo(() => {
    const groups = new Map<
      string,
      { title: string; summary: string; order: number; scenarios: LabSummary[] }
    >();

    for (const scenario of scenarios) {
      const title = scenario.domainTitle ?? "React Scenarios";
      const group = groups.get(title) ?? {
        title,
        summary: scenario.domainSummary ?? "Hands-on React practice scenarios",
        order: scenario.displayOrder ?? 999,
        scenarios: [],
      };
      group.order = Math.min(group.order, scenario.displayOrder ?? 999);
      if (!group.summary && scenario.domainSummary) {
        group.summary = scenario.domainSummary;
      }
      group.scenarios.push(scenario);
      groups.set(title, group);
    }

    return [...groups.values()]
      .map((group) => ({
        ...group,
        scenarios: group.scenarios.sort((a, b) => {
          const orderDelta = (a.displayOrder ?? 999) - (b.displayOrder ?? 999);
          return orderDelta || a.title.localeCompare(b.title);
        }),
      }))
      .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }, [scenarios]);

  return (
    <section className="scenario-catalog" id="labs">
      {groupedScenarios.length === 0 ? (
        <article className="panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Scenarios</p>
              <h3>No scenarios seeded yet</h3>
            </div>
          </div>
          <p className="muted">Use Seed scenarios to load the React MVP scenarios.</p>
        </article>
      ) : (
        groupedScenarios.map((group) => (
          <div className="domain-section" key={group.title}>
            <div className="domain-heading">
              <h3>{group.title}</h3>
              <p>{group.summary}</p>
            </div>
            <div className="scenario-card-grid">
              {group.scenarios.map((scenario) => {
                const selected = selectedScenario?._id === scenario._id;
                const attemptSummary = attemptSummaries.get(scenario._id);
                return (
                  <button
                    aria-pressed={selected}
                    className={`scenario-card ${selected ? "selected" : ""}`}
                    key={scenario._id}
                    onClick={() => onSelectScenario(scenario._id)}
                  >
                    <span className="scenario-title">{scenario.title}</span>
                    <span className="scenario-summary">{scenario.summary}</span>
                    {scenario.scenarioLabel ? (
                      <span className="scenario-label">{scenario.scenarioLabel}</span>
                    ) : null}
                    <span className="scenario-attempt-summary">
                      <span>{formatAttemptCount(attemptSummary?.attempts ?? 0)}</span>
                      <span>{attemptSummary?.passed ?? 0} passed</span>
                      <span>{formatBestScore(attemptSummary?.bestScore)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function SessionDetailPanel({
  endpointHealth,
  session,
  scenario,
  events,
  onStop,
  onRunCheck,
  onRequestCleanup,
}: {
  endpointHealth: SessionEndpointHealth;
  session?: SessionSummary;
  scenario?: LabSummary;
  events: SessionEvent[];
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
  onRunCheck: (session: SessionSummary) => Promise<void>;
  onRequestCleanup: (sessionId: Id<"sessions">) => Promise<void>;
}) {
  const validation = useMemo(() => latestValidation(events), [events]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function runAction(action: "stop" | "check" | "cleanup") {
    if (!session) return;
    setActionError(null);
    setActionBusy(action);
    try {
      if (action === "stop") {
        await onStop(session._id);
      } else if (action === "cleanup") {
        await onRequestCleanup(session._id);
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
              disabled={!canRunChecks(session, endpointHealth) || actionBusy !== null}
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
            <button
              className="secondary-button"
              disabled={!canRequestCleanup(session) || actionBusy !== null}
              onClick={() => void runAction("cleanup")}
            >
              {cleanupButtonLabel(session, actionBusy)}
            </button>
          </div>
        ) : null}
      </div>

      {!session ? (
        <EmptyState
          title="No session selected"
          body="Request or select a session to inspect runner output, workspace links, checks, and events."
        />
      ) : (
        <>
          <SessionStatusState session={session} />

          <div className="detail-grid">
            <DetailItem label="Scenario" value={scenario?.title ?? "Unknown scenario"} />
            <DetailItem label="Domain" value={scenario?.domainTitle ?? "-"} />
            <DetailItem label="Runner" value={session.runner} />
            <DetailItem label="Score" value={formatScore(session.lastCheckScore)} />
            <DetailItem label="Created" value={formatTime(session.createdAt)} />
            <DetailItem label="Completed" value={formatOptionalTime(session.completedAt)} />
            <DetailItem label="Expires" value={formatTime(session.expiresAt)} />
          </div>

          {actionError ? <p className="error-text">{actionError}</p> : null}

          <div className="url-grid">
            <UrlItem
              health={endpointHealth.workspace}
              icon={<Folder size={16} />}
              label="Workspace"
              value={session.workspaceUrl}
            />
            <UrlItem
              health={endpointHealth.tools}
              icon={<SquareTerminal size={16} />}
              label="Tools"
              value={session.terminalUrl}
            />
            <UrlItem
              health={endpointHealth.preview}
              icon={<Cloud size={16} />}
              label="Preview"
              value={session.previewUrl}
            />
          </div>

          <div className="metadata-grid">
            <DetailItem label="Editor provider" value={session.editorProvider ?? "-"} />
            <DetailItem label="Container" value={session.editorContainerName ?? "-"} />
            <DetailItem label="Editor port" value={formatNumber(session.editorPort)} />
            <DetailItem label="Preview port" value={formatNumber(session.previewPort)} />
            <DetailItem label="Tools port" value={formatNumber(session.toolsPort)} />
            <DetailItem label="Workspace path" value={session.workspacePath ?? "-"} />
            <DetailItem label="Stopped" value={formatOptionalTime(session.stoppedAt)} />
            <DetailItem label="Cleanup requested" value={formatOptionalTime(session.cleanupRequestedAt)} />
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
                    <span>
                      <strong>{friendlyAssertionTitle(assertion)}</strong>
                      <small className="assertion-message">
                        {friendlyAssertionMessage(assertion)}
                      </small>
                      {assertion.message ? (
                        <details className="technical-detail">
                          <summary>Technical detail</summary>
                          <code>{assertion.message}</code>
                        </details>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <ValidationEmptyState session={session} />
            )}
          </div>

          <div className="event-section">
            <div className="section-heading">
              <p className="eyebrow">Event timeline</p>
            </div>
            {events.length > 0 ? (
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
            ) : (
              <EventEmptyState session={session} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function WorkspaceTab({
  endpointHealth,
  session,
  scenario,
  events,
  onStop,
  onRunCheck,
  onRequestCleanup,
}: {
  endpointHealth: SessionEndpointHealth;
  session?: SessionSummary;
  scenario?: LabSummary;
  events: SessionEvent[];
  onStop: (sessionId: Id<"sessions">) => Promise<void>;
  onRunCheck: (session: SessionSummary) => Promise<void>;
  onRequestCleanup: (sessionId: Id<"sessions">) => Promise<void>;
}) {
  const validation = useMemo(() => latestValidation(events), [events]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function runAction(action: "stop" | "check" | "cleanup") {
    if (!session) return;
    setActionError(null);
    setActionBusy(action);
    try {
      if (action === "stop") {
        await onStop(session._id);
      } else if (action === "cleanup") {
        await onRequestCleanup(session._id);
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
              disabled={!canRunChecks(session, endpointHealth) || actionBusy !== null}
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
            <button
              className="secondary-button"
              disabled={!canRequestCleanup(session) || actionBusy !== null}
              onClick={() => void runAction("cleanup")}
            >
              {cleanupButtonLabel(session, actionBusy)}
            </button>
          </div>
        ) : null}
      </div>

      {!session ? (
        <section className="panel">
          <EmptyState
            title="No workspace selected"
            body="Request or select a session on the Dashboard tab to open its editor and preview here."
          />
        </section>
      ) : (
        <>
          {actionError ? <p className="error-text">{actionError}</p> : null}

          <TaskInstructionsPanel scenario={scenario} session={session} />
          <WorkspaceGuidanceState
            actionBusy={actionBusy}
            endpointHealth={endpointHealth}
            session={session}
            validation={validation}
          />
          <PassStateNextSteps endpointHealth={endpointHealth} session={session} validation={validation} />
          <FailStateRemediation scenario={scenario} session={session} validation={validation} />
          <section className="workspace-link-strip url-grid" aria-label="Standalone workspace links">
            <UrlItem
              health={endpointHealth.workspace}
              icon={<Folder size={16} />}
              label="OpenVSCode"
              value={session.workspaceUrl}
            />
            <UrlItem
              health={endpointHealth.preview}
              icon={<Cloud size={16} />}
              label="Preview"
              value={session.previewUrl}
            />
            <UrlItem
              health={endpointHealth.tools}
              icon={<SquareTerminal size={16} />}
              label="Tools"
              value={session.terminalUrl}
            />
          </section>

          <div className="workspace-meta-strip">
            <DetailItem label="Score" value={formatScore(session.lastCheckScore)} />
            <DetailItem label="Validation" value={validation?.summary ?? session.lastCheckSummary ?? "Not run"} />
            <DetailItem label="Editor" value={session.workspaceUrl ?? "not available"} />
            <DetailItem label="Preview" value={session.previewUrl ?? "not available"} />
          </div>

          <div className="workspace-live-area">
            <WorkspaceSplitView endpointHealth={endpointHealth} session={session} />
            <ChecklistProgressPanel session={session} validation={validation} />
          </div>
        </>
      )}
    </section>
  );
}

function FailStateRemediation({
  scenario,
  session,
  validation,
}: {
  scenario?: LabSummary;
  session: SessionSummary;
  validation: ValidationMetadata | null;
}) {
  const failed = session.status === "failed" || validation?.passed === false;
  const failingAssertion = validation?.assertions?.find(
    (assertion) => assertion.status !== "passed"
  );

  if (!failed) {
    return null;
  }

  return (
    <section className="fail-remediation" aria-labelledby="fail-remediation-title">
      <XCircle size={20} />
      <div>
        <p className="eyebrow">Remediation</p>
        <h3 id="fail-remediation-title">Check the expected behavior</h3>
        <div className="fail-remediation-grid">
          <DetailItem label="File" value={scenario?.remediationFile ?? "Scenario file not published"} />
          <DetailItem
            label="Expected"
            value={
              scenario?.expectedBehavior ??
              (failingAssertion
                ? friendlyAssertionTitle(failingAssertion)
                : "Review the scenario requirement.")
            }
          />
        </div>
        {failingAssertion ? (
          <p className="fail-remediation-message">
            {friendlyAssertionMessage(failingAssertion)}
          </p>
        ) : null}
      </div>
    </section>
  );
}

function PassStateNextSteps({
  endpointHealth,
  session,
  validation,
}: {
  endpointHealth: SessionEndpointHealth;
  session: SessionSummary;
  validation: ValidationMetadata | null;
}) {
  const passed = session.status === "passed" || validation?.passed;

  if (!passed) {
    return null;
  }

  return (
    <section className="pass-next-steps" aria-labelledby="pass-next-steps-title">
      <CheckCircle2 size={20} />
      <div>
        <p className="eyebrow">Complete</p>
        <h3 id="pass-next-steps-title">Scenario passed</h3>
        <ol>
          <li>Review the passing preview and checklist while the workspace is still available.</li>
          <li>Capture any notes or code you want to keep outside the disposable session.</li>
          <li>Stop the session when review is finished so the local runner can clean it up.</li>
        </ol>
        <div className="pass-next-step-links">
          {session.previewUrl?.startsWith("http") ? (
            <a href={session.previewUrl} target="_blank" rel="noreferrer">
              Open preview
            </a>
          ) : null}
          {session.terminalUrl?.startsWith("http") && endpointHealth.tools.status !== "stale" ? (
            <a href={session.terminalUrl} target="_blank" rel="noreferrer">
              Open tools
            </a>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function WorkspaceGuidanceState({
  actionBusy,
  endpointHealth,
  session,
  validation,
}: {
  actionBusy: string | null;
  endpointHealth: SessionEndpointHealth;
  session: SessionSummary;
  validation: ValidationMetadata | null;
}) {
  const state = workspaceGuidanceState(session, endpointHealth, validation, actionBusy);
  const Icon = state.icon;

  return (
    <section className={`workspace-guidance-state ${state.tone}`}>
      <Icon size={18} />
      <div>
        <strong>{state.title}</strong>
        <span>{state.body}</span>
      </div>
    </section>
  );
}

function TaskInstructionsPanel({
  scenario,
  session,
}: {
  scenario?: LabSummary;
  session: SessionSummary;
}) {
  const tags = scenario?.tags.slice(0, 5) ?? [];

  return (
    <section className="task-instructions-panel" aria-labelledby="task-instructions-title">
      <div className="task-instructions-main">
        <p className="eyebrow">Task</p>
        <h3 id="task-instructions-title">
          {scenario?.title ?? "Scenario details unavailable"}
        </h3>
        <p>{scenario?.summary ?? "Select a seeded scenario to view its task details."}</p>
        <p className="task-guidance">
          Make the requested change in the editor, save it, then run checks for this session.
        </p>
      </div>
      <div className="task-instructions-meta">
        <DetailItem label="Domain" value={scenario?.domainTitle ?? "Unknown"} />
        <DetailItem label="Difficulty" value={formatDifficulty(scenario?.difficulty)} />
        <DetailItem label="Session" value={session.learnerLabel} />
        <DetailItem label="Status" value={session.status} />
      </div>
      {tags.length > 0 ? (
        <div className="task-tag-list" aria-label="Scenario tags">
          {tags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function WorkspaceSplitView({
  endpointHealth,
  session,
}: {
  endpointHealth: SessionEndpointHealth;
  session: SessionSummary;
}) {
  const editorReady = session.workspaceUrl?.startsWith("http");
  const previewReady = session.previewUrl?.startsWith("http");
  const editorUrl = session.workspaceUrl ?? "";
  const previewUrl = session.previewUrl ?? "";
  const editorReachable = endpointHealth.workspace.status !== "stale";
  const previewReachable = endpointHealth.preview.status !== "stale";
  const compactLayout = useMediaQuery("(max-width: 900px)");
  const [layout, setLayout] = useState<WorkspaceLayout>(() => readWorkspaceLayout());

  function saveLayout(nextLayout: Record<string, number>) {
    if (typeof nextLayout.editor !== "number" || typeof nextLayout.preview !== "number") {
      return;
    }
    const next: WorkspaceLayout = {
      editor: nextLayout.editor,
      preview: nextLayout.preview,
    };
    setLayout(next);
    window.localStorage.setItem(workspaceLayoutStorageKey, JSON.stringify(next));
  }

  return (
    <div className="workspace-section" id="workspace">
      <div className="section-heading">
        <p className="eyebrow">Workspace</p>
        <strong>Editor and preview</strong>
      </div>

      {editorReady && previewReady && editorReachable && previewReachable ? (
        compactLayout ? (
          <div className="workspace-split workspace-split-stacked">
            <WorkspaceFrame
              allowClipboard
              className="editor-frame"
              label="OpenVSCode"
              title={`${session.learnerLabel} OpenVSCode editor`}
              url={editorUrl}
            />
            <WorkspaceFrame
              className="preview-frame"
              label="Preview"
              title={`${session.learnerLabel} Vite preview`}
              url={previewUrl}
            />
          </div>
        ) : (
        <Group
          className="workspace-split"
          defaultLayout={layout}
          onLayoutChanged={saveLayout}
          orientation="horizontal"
        >
          <Panel className="workspace-panel" defaultSize={`${layout.editor}%`} id="editor" minSize="35%">
            <WorkspaceFrame
              allowClipboard
              className="editor-frame"
              label="OpenVSCode"
              title={`${session.learnerLabel} OpenVSCode editor`}
              url={editorUrl}
            />
          </Panel>

          <Separator
            aria-label="Resize editor and preview panes"
            className="workspace-resize-handle"
          />

          <Panel className="workspace-panel" defaultSize={`${layout.preview}%`} id="preview" minSize="25%">
            <WorkspaceFrame
              className="preview-frame"
              label="Preview"
              title={`${session.learnerLabel} Vite preview`}
              url={previewUrl}
            />
          </Panel>
        </Group>
        )
      ) : (
        <WorkspaceEmptyState endpointHealth={endpointHealth} session={session} />
      )}
    </div>
  );
}

function WorkspaceFrame({
  allowClipboard = false,
  className,
  label,
  title,
  url,
}: {
  allowClipboard?: boolean;
  className: string;
  label: string;
  title: string;
  url: string;
}) {
  return (
    <div className={`workspace-frame-shell ${className}`}>
      <div className="frame-header">
        <span>{label}</span>
        <a href={url} target="_blank" rel="noreferrer">
          Open
        </a>
      </div>
      <iframe
        allow={allowClipboard ? "clipboard-read; clipboard-write" : undefined}
        className="workspace-frame"
        src={url}
        title={title}
      />
    </div>
  );
}

function ChecklistProgressPanel({
  session,
  validation,
}: {
  session: SessionSummary;
  validation: ValidationMetadata | null;
}) {
  const assertions = validation?.assertions ?? [];
  const total = assertions.length;
  const passed = assertions.filter((assertion) => assertion.status === "passed").length;
  const percent = total > 0 ? Math.round((passed / total) * 100) : 0;

  return (
    <aside className="checklist-progress-panel" aria-labelledby="checklist-progress-title">
      <div className="section-heading">
        <p className="eyebrow">Checklist</p>
        <strong id="checklist-progress-title">
          {total > 0 ? `${passed}/${total} complete` : "Not checked yet"}
        </strong>
      </div>

      <div
        aria-label={`Checklist progress ${percent}%`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={percent}
        className="checklist-progress-meter"
        role="progressbar"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      {total > 0 ? (
        <ol className="checklist-progress-list">
          {assertions.map((assertion, index) => (
            <li key={`${assertion.title}-${index}`}>
              {assertion.status === "passed" ? (
                <CheckCircle2 size={16} className="pass-icon" />
              ) : (
                <XCircle size={16} className="fail-icon" />
              )}
              <span>{friendlyAssertionTitle(assertion)}</span>
            </li>
          ))}
        </ol>
      ) : (
        <ValidationEmptyState session={session} />
      )}
    </aside>
  );
}

function EmptyState({
  title,
  body,
  tone = "neutral",
}: {
  title: string;
  body: string;
  tone?: EmptyStateTone;
}) {
  return (
    <div className={`empty-state empty-state-${tone}`}>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

function SessionStatusState({ session }: { session: SessionSummary }) {
  const state = sessionStateCopy(session);
  return <EmptyState title={state.title} body={state.body} tone={state.tone} />;
}

function ValidationEmptyState({ session }: { session: SessionSummary }) {
  const state = validationStateCopy(session);
  return <EmptyState title={state.title} body={state.body} tone={state.tone} />;
}

function EventEmptyState({ session }: { session: SessionSummary }) {
  const state = eventStateCopy(session);
  return <EmptyState title={state.title} body={state.body} tone={state.tone} />;
}

function WorkspaceEmptyState({
  endpointHealth,
  session,
}: {
  endpointHealth?: SessionEndpointHealth;
  session: SessionSummary;
}) {
  const state = workspaceStateCopy(session, endpointHealth);
  return <EmptyState title={state.title} body={state.body} tone={state.tone} />;
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
  health,
  icon,
  label,
  value,
}: {
  health?: EndpointHealth;
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
        {health ? <EndpointHealthPill health={health} /> : null}
      </div>
    </div>
  );
}

function EndpointHealthPill({ health }: { health: EndpointHealth }) {
  return (
    <small className={`endpoint-health endpoint-health-${health.status}`}>
      {endpointStatusLabel(health)}
    </small>
  );
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function scenarioForSession(session: SessionSummary, scenarios: LabSummary[]) {
  return scenarios.find((scenario) => scenario._id === session.labId);
}

function formatScenarioTitle(session: SessionSummary, scenarios: LabSummary[]) {
  return scenarioForSession(session, scenarios)?.title ?? "Unknown scenario";
}

function summarizeScenarioAttempts(progressRecords: ProgressRecord[]) {
  const summaries = new Map<string, ScenarioAttemptSummary>();

  for (const record of progressRecords) {
    const summary = summaries.get(record.labId) ?? {
      attempts: 0,
      passed: 0,
      failed: 0,
    };

    summary.attempts += 1;
    if (record.status === "passed") {
      summary.passed += 1;
    }
    if (record.status === "failed") {
      summary.failed += 1;
    }
    if (typeof record.score === "number") {
      summary.bestScore =
        typeof summary.bestScore === "number"
          ? Math.max(summary.bestScore, record.score)
          : record.score;
    }
    summary.lastAttemptAt =
      typeof summary.lastAttemptAt === "number"
        ? Math.max(summary.lastAttemptAt, record.startedAt)
        : record.startedAt;

    summaries.set(record.labId, summary);
  }

  return summaries;
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

function friendlyAssertionTitle(assertion: ValidationAssertion) {
  if (assertion.title?.trim()) {
    return humanizeValidationText(assertion.title);
  }

  return assertion.status === "passed" ? "Check passed" : "Check needs attention";
}

function friendlyAssertionMessage(assertion: ValidationAssertion) {
  if (assertion.status === "passed") {
    return "This requirement is complete.";
  }

  if (assertion.message?.startsWith("Expected heading")) {
    return assertion.message;
  }

  return "This requirement is not passing yet. Review the task, update the app, save your changes, and run checks again.";
}

function humanizeValidationText(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function emptyEndpointHealth(): SessionEndpointHealth {
  return {
    workspace: {
      status: "missing",
      message: "No workspace URL published",
    },
    tools: {
      status: "missing",
      message: "No tools URL published",
    },
    preview: {
      status: "missing",
      message: "No preview URL published",
    },
  };
}

function checkingEndpointHealth(session: SessionSummary): SessionEndpointHealth {
  return {
    workspace: checkingEndpoint("workspace", session.workspaceUrl),
    tools: checkingEndpoint("tools", session.terminalUrl),
    preview: checkingEndpoint("preview", session.previewUrl),
  };
}

function checkingEndpoint(label: string, url?: string): EndpointHealth {
  if (!url?.startsWith("http")) {
    return {
      status: "missing",
      message: `No ${label} URL published`,
    };
  }

  return {
    status: "checking",
    message: "Checking endpoint reachability",
  };
}

async function probeSessionEndpoints(
  session: SessionSummary
): Promise<SessionEndpointHealth> {
  const [workspace, tools, preview] = await Promise.all([
    probeEndpoint("workspace", session.workspaceUrl),
    probeEndpoint("tools", session.terminalUrl),
    probeEndpoint("preview", session.previewUrl),
  ]);

  return { workspace, tools, preview };
}

async function probeEndpoint(label: string, url?: string): Promise<EndpointHealth> {
  if (!url?.startsWith("http")) {
    return {
      status: "missing",
      message: `No ${label} URL published`,
    };
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 1500);

  try {
    await fetch(url, {
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal,
    });

    return {
      status: "reachable",
      checkedAt: Date.now(),
      message: `${label} endpoint responded`,
    };
  } catch (error) {
    return {
      status: "stale",
      checkedAt: Date.now(),
      message:
        error instanceof DOMException && error.name === "AbortError"
          ? `${label} endpoint timed out`
          : `${label} endpoint is not responding`,
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function endpointStatusLabel(health: EndpointHealth) {
  const checked = health.checkedAt ? ` at ${formatTime(health.checkedAt)}` : "";

  switch (health.status) {
    case "reachable":
      return `reachable${checked}`;
    case "checking":
      return "checking";
    case "stale":
      return `${health.message}${checked}`;
    case "missing":
      return health.message;
  }
}

function canRunChecks(session: SessionSummary, endpointHealth: SessionEndpointHealth) {
  return Boolean(
    session.terminalUrl?.startsWith("http") &&
    !["stopped", "expired", "errored"].includes(session.status) &&
      endpointHealth.tools.status !== "stale"
  );
}

function canRequestCleanup(session: SessionSummary) {
  return Boolean(
    ["stopped", "expired"].includes(session.status) &&
      !session.cleanedAt &&
      !session.cleanupRequestedAt
  );
}

function cleanupButtonLabel(session: SessionSummary, actionBusy: string | null) {
  if (actionBusy === "cleanup") return "Requesting cleanup";
  if (session.cleanedAt) return "Cleaned";
  if (session.cleanupRequestedAt) return "Cleanup requested";
  if (["stopped", "expired"].includes(session.status)) return "Request cleanup";
  return "Cleanup unavailable";
}

function sessionStateCopy(session: SessionSummary): EmptyStateCopy {
  switch (session.status) {
    case "requested":
      return {
        title: "Queued for local runner",
        body: "The session request is saved. Keep the local runner polling to create the editor, preview, and tools.",
        tone: "warning",
      };
    case "starting":
      return {
        title: "Workspace is starting",
        body: "The runner is preparing the starter files, dependencies, editor, preview, and tools endpoints.",
        tone: "info",
      };
    case "running":
      return {
        title: "Workspace is ready",
        body: "The learner can work in OpenVSCode and run checks when they are ready for validation.",
        tone: "info",
      };
    case "checking":
      return {
        title: "Checks are running",
        body: "Validation is in progress. The result will update this session when the tools server reports back.",
        tone: "info",
      };
    case "passed":
      return {
        title: "Scenario passed",
        body: "The latest validation passed. The workspace remains available until it is stopped or expires.",
        tone: "success",
      };
    case "failed":
      return {
        title: "Checks need attention",
        body: "The latest validation failed. Review the checklist, update the exercise files, then run checks again.",
        tone: "danger",
      };
    case "stopped":
      if (session.cleanedAt) {
        return {
          title: "Session stopped and cleaned",
          body: "The operator stopped this session and the local runner has cleaned up its editor, preview, and tools resources.",
          tone: "neutral",
        };
      }
      return {
        title: "Session stopped",
        body: "The operator stopped this session. Local runner cleanup removes the editor, preview, and tools resources.",
        tone: "neutral",
      };
    case "expired":
      if (session.cleanedAt) {
        return {
          title: "Session expired and cleaned",
          body: "The TTL elapsed and the local runner has cleaned up this session's editor, preview, and tools resources.",
          tone: "neutral",
        };
      }
      return {
        title: "Session expired",
        body: "The TTL elapsed. Start a new session if the learner needs another workspace.",
        tone: "neutral",
      };
    case "errored":
      return {
        title: "Runner error",
        body: "The runner could not complete this session. Check the event timeline and local runner logs for the failure.",
        tone: "danger",
      };
    default:
      return {
        title: "Session state unknown",
        body: "Refresh the dashboard to reload the latest control-plane state.",
        tone: "neutral",
      };
  }
}

function validationStateCopy(session: SessionSummary): EmptyStateCopy {
  switch (session.status) {
    case "requested":
    case "starting":
      return {
        title: "Checks unavailable",
        body: "Validation becomes available after the runner starts the tools server for this session.",
        tone: "warning",
      };
    case "running":
      return {
        title: "No checks run yet",
        body: "Run checks after the learner has made and saved their changes.",
        tone: "info",
      };
    case "checking":
      return {
        title: "Waiting for check results",
        body: "The tools server is running validation and will publish the checklist when it finishes.",
        tone: "info",
      };
    case "passed":
      return {
        title: "Passed without checklist details",
        body: "The session is marked passed, but no checklist payload is attached to the current event stream.",
        tone: "success",
      };
    case "failed":
      return {
        title: "Failed without checklist details",
        body: "The session is marked failed, but no checklist payload is attached. Run checks again to refresh details.",
        tone: "danger",
      };
    case "stopped":
    case "expired":
      return {
        title: "Validation closed",
        body: "This session is no longer active. Request a new session to run validation again.",
        tone: "neutral",
      };
    case "errored":
      return {
        title: "Validation unavailable",
        body: "The session errored before checks could complete. Inspect the event timeline for startup or runner errors.",
        tone: "danger",
      };
    default:
      return {
        title: "No validation state",
        body: "Refresh the dashboard to reload the latest check state.",
        tone: "neutral",
      };
  }
}

function workspaceGuidanceState(
  session: SessionSummary,
  endpointHealth: SessionEndpointHealth,
  validation: ValidationMetadata | null,
  actionBusy: string | null
): EmptyStateCopy & { icon: typeof Save } {
  if (actionBusy === "check" || session.status === "checking") {
    return {
      title: "Checks running",
      body: "Keep the editor open while validation reads the saved workspace files.",
      tone: "info",
      icon: RefreshCw,
    };
  }

  if (["requested", "starting"].includes(session.status)) {
    return {
      title: "Workspace starting",
      body: "The editor, preview, and tools links will appear after the local runner finishes setup.",
      tone: "warning",
      icon: Clock3,
    };
  }

  if (["stopped", "expired"].includes(session.status)) {
    return {
      title: "Session closed",
      body: "Request a new session before making more OpenVSCode edits.",
      tone: "neutral",
      icon: XCircle,
    };
  }

  if (session.status === "errored") {
    return {
      title: "Workspace unavailable",
      body: "Check the event timeline and runner logs before editing this session.",
      tone: "danger",
      icon: XCircle,
    };
  }

  if (endpointHealth.tools.status === "stale" || !session.terminalUrl) {
    return {
      title: "Checks unavailable",
      body: "You can keep editing, but validation needs the tools server to respond.",
      tone: "warning",
      icon: SquareTerminal,
    };
  }

  if (session.status === "passed" || validation?.passed) {
    return {
      title: "Scenario passed",
      body: "The latest saved workspace state satisfies the checklist.",
      tone: "success",
      icon: CheckCircle2,
    };
  }

  if (session.status === "failed") {
    return {
      title: "Save edits, then run checks again",
      body: "Update the files in OpenVSCode, save them, and rerun validation when the preview reflects the change.",
      tone: "danger",
      icon: Save,
    };
  }

  return {
    title: "Save edits before running checks",
    body: "OpenVSCode changes must be saved before validation can read the latest workspace files.",
    tone: "info",
    icon: Save,
  };
}

function eventStateCopy(session: SessionSummary): EmptyStateCopy {
  if (["requested", "starting"].includes(session.status)) {
    return {
      title: "No runner events yet",
      body: "Events will appear as the local runner claims and starts this session.",
      tone: "warning",
    };
  }

  return {
    title: "No events recorded",
    body: "The control plane has no timeline entries for this session yet.",
    tone: "neutral",
  };
}

function workspaceStateCopy(
  session: SessionSummary,
  endpointHealth?: SessionEndpointHealth
): EmptyStateCopy {
  const staleEndpoints = endpointHealth
    ? ([
        ["editor", endpointHealth.workspace],
        ["preview", endpointHealth.preview],
      ] as const)
        .filter(([, health]) => health.status === "stale")
        .map(([label]) => label)
    : [];

  if (staleEndpoints.length > 0) {
    return {
      title: "Workspace endpoint stale",
      body: `The ${staleEndpoints.join(" and ")} endpoint ${
        staleEndpoints.length === 1 ? "is" : "are"
      } no longer responding. Check runner health or stop and recreate the session.`,
      tone: "danger",
    };
  }

  switch (session.status) {
    case "requested":
      return {
        title: "Workspace queued",
        body: "The editor and preview will appear after the local runner picks up the requested session.",
        tone: "warning",
      };
    case "starting":
      return {
        title: "Workspace booting",
        body: "The runner is still starting OpenVSCode, Vite preview, and the tools server.",
        tone: "info",
      };
    case "stopped":
      return {
        title: "Workspace stopped",
        body: "The editor and preview are no longer active for this session.",
        tone: "neutral",
      };
    case "expired":
      return {
        title: "Workspace expired",
        body: "The session TTL elapsed and local resources should be cleaned up by the runner.",
        tone: "neutral",
      };
    case "errored":
      return {
        title: "Workspace failed to start",
        body: "The runner did not publish usable editor and preview URLs. Check the event timeline for the error.",
        tone: "danger",
      };
    default:
      return {
        title: "Workspace URLs unavailable",
        body: "Refresh the dashboard or check runner health if the editor and preview should already be running.",
        tone: "info",
      };
  }
}

function formatScore(score?: number) {
  return typeof score === "number" ? `${score}%` : "-";
}

function formatBestScore(score?: number) {
  return typeof score === "number" ? `Best ${score}%` : "No score";
}

function formatAttemptCount(count: number) {
  return `${count} attempt${count === 1 ? "" : "s"}`;
}

function formatDifficulty(difficulty?: number) {
  return typeof difficulty === "number" ? `Level ${difficulty}` : "-";
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

function formatMilliseconds(value?: number) {
  if (typeof value !== "number") return "-";
  if (value < 1000) return `${value}ms`;
  return `${Math.round(value / 100) / 10}s`;
}

function formatPercentage(value?: number) {
  if (typeof value !== "number") return "-";
  return `${Math.round(value * 100)}%`;
}

function formatAge(milliseconds: number) {
  if (milliseconds < 1000) return "just now";
  if (milliseconds < 60_000) return `${Math.floor(milliseconds / 1000)}s ago`;
  return `${Math.floor(milliseconds / 60_000)}m ago`;
}

function runnerHealthFor(heartbeat: RunnerHeartbeat | null) {
  if (!heartbeat) {
    return { active: false, ageLabel: "-" };
  }

  const ageMs = Date.now() - heartbeat.lastSeenAt;
  const staleAfterMs = Math.max(heartbeat.pollMs * 3, 10_000);
  return {
    active: ageMs <= staleAfterMs,
    ageLabel: formatAge(ageMs),
  };
}

function tabFromHash(hash: string): AppTab {
  return hash.startsWith("#workspace") ? "workspace" : "dashboard";
}

function readWorkspaceLayout(): WorkspaceLayout {
  try {
    const saved = JSON.parse(
      window.localStorage.getItem(workspaceLayoutStorageKey) ?? "null"
    ) as Partial<WorkspaceLayout> | null;

    if (
      saved &&
      typeof saved.editor === "number" &&
      typeof saved.preview === "number" &&
      Number.isFinite(saved.editor) &&
      Number.isFinite(saved.preview)
    ) {
      return { editor: saved.editor, preview: saved.preview };
    }
  } catch {
    return defaultWorkspaceLayout;
  }

  return defaultWorkspaceLayout;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener("change", updateMatches);
    return () => mediaQuery.removeEventListener("change", updateMatches);
  }, [query]);

  return matches;
}

function readSelectedSessionId(): Id<"sessions"> | null {
  return window.localStorage.getItem(selectedSessionStorageKey) as Id<"sessions"> | null;
}

function RunnerHealthPanel({
  heartbeat,
  observability,
  requestedCount,
}: {
  heartbeat: RunnerHeartbeat | null;
  observability: ObservabilitySummary | null;
  requestedCount: number;
}) {
  const health = runnerHealthFor(heartbeat);
  const statusLabel = heartbeat
    ? health.active
      ? "polling"
      : "stale"
    : "not seen";

  return (
    <article className="panel runner-health-panel" id="runner">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Runner health</p>
          <h3>Local runner</h3>
        </div>
        <span
          className={`status-pill ${
            health.active ? "status-running" : "status-stopped"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <p className="muted">
        {health.active
          ? "The local runner is actively polling Convex for requested sessions."
          : requestedCount > 0
            ? "Requested sessions are queued until the local runner is polling."
            : "Start the local runner before requesting a session to avoid queued work."}
      </p>

      <div className="runner-health-grid">
        <DetailItem
          label="Last poll"
          value={heartbeat ? `${formatTime(heartbeat.lastSeenAt)} (${health.ageLabel})` : "-"}
        />
        <DetailItem label="Poll interval" value={formatMilliseconds(heartbeat?.pollMs)} />
        <DetailItem label="Runner ID" value={heartbeat?.runnerId ?? "-"} />
        <DetailItem
          label="Process"
          value={
            heartbeat
              ? [heartbeat.hostname, heartbeat.pid ? `pid ${heartbeat.pid}` : undefined]
                  .filter(Boolean)
                  .join(" / ") || "-"
              : "-"
          }
        />
      </div>

      <div className="runner-health-grid observability-grid">
        <DetailItem
          label="Avg startup"
          value={formatMilliseconds(observability?.averageStartupMs)}
        />
        <DetailItem
          label="Avg validation"
          value={formatMilliseconds(observability?.averageValidationMs)}
        />
        <DetailItem
          label="Failure rate"
          value={formatPercentage(observability?.failureRate)}
        />
        <DetailItem
          label="Avg cleanup"
          value={formatMilliseconds(observability?.averageCleanupMs)}
        />
      </div>
    </article>
  );
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
