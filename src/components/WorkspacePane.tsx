import { useCallback, useRef, useState } from "react";
import { Terminal, type TerminalHandle, type TerminalStatus } from "./Terminal";
import { editorUrl } from "../lib/gateway";
import type { AgentSummary } from "../lib/gateway";
import type { Session } from "../lib/useScenarioSession";

export type WorkspaceTab = { id: string; kind: "terminal" | "editor" | "preview"; label: string };

type Props = {
  session: Session | null;
  tabs: string[];
  agent: AgentSummary | null;
  connect: boolean;
  statusText: string;
  countdown: string | null;
  onStop: () => void;
  /** A terminal gave up reconnecting (access revoked, gateway refusing): re-check access. */
  onConnectionLost?: () => void;
  /** Shown in place of the preview when its host could not be authorized. */
  previewProblem?: string | null;
};

// Endpoint content runs on its own host (ADR 0004), so allow-same-origin only
// gives it its own origin; the sandbox still blocks top navigation of the app.
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

export type WorkspaceHandle = { run: (command: string) => void };

export function useWorkspace() {
  const terminals = useRef(new Map<string, TerminalHandle | null>());
  const [activeId, setActiveId] = useState("terminal-1");
  const run = useCallback(
    (command: string) => {
      const target = activeId.startsWith("terminal-") ? activeId : "terminal-1";
      const handle = terminals.current.get(target);
      setActiveId(target);
      handle?.write(`${command}\n`);
      handle?.focus();
    },
    [activeId]
  );
  return { terminals, activeId, setActiveId, run };
}

export function WorkspacePane({
  session,
  tabs,
  agent,
  connect,
  statusText,
  countdown,
  onStop,
  onConnectionLost,
  previewProblem,
  workspace,
}: Props & { workspace: ReturnType<typeof useWorkspace> }) {
  const [terminalCount, setTerminalCount] = useState(1);
  const { terminals, activeId, setActiveId } = workspace;
  const terminalTabs: WorkspaceTab[] = Array.from({ length: terminalCount }, (_, index) => ({
    id: `terminal-${index + 1}`,
    kind: "terminal",
    label: terminalCount > 1 ? `Terminal ${index + 1}` : "Terminal",
  }));
  const extraTabs: WorkspaceTab[] = [];
  if (tabs.includes("editor")) extraTabs.push({ id: "editor", kind: "editor", label: "Editor" });
  if (tabs.includes("preview")) extraTabs.push({ id: "preview", kind: "preview", label: "Preview" });
  const allTabs = [...extraTabs, ...terminalTabs];
  const workspaceUrl = session?.workspaceUrl;
  const editorReady = agent?.editor.status === "running";
  const previewReady = agent?.preview.status === "running";
  const onTerminalStatus = useCallback(
    (status: TerminalStatus) => {
      if (status === "failed") onConnectionLost?.();
    },
    [onConnectionLost]
  );

  return (
    <section className="workspace">
      <div className="workspace-bar">
        <div className="tabstrip" role="tablist">
          {allTabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeId === tab.id}
              className={`tab ${activeId === tab.id ? "is-active" : ""}`}
              onClick={() => setActiveId(tab.id)}
            >
              {tab.label}
            </button>
          ))}
          <button className="tab tab-add" title="New terminal" onClick={() => { setTerminalCount((n) => Math.min(n + 1, 6)); setActiveId(`terminal-${Math.min(terminalCount + 1, 6)}`); }}>
            +
          </button>
        </div>
        <div className="workspace-status">
          <span className="muted small">{statusText}</span>
          {countdown ? <span className="countdown" title="Time left">{countdown}</span> : null}
          {session ? (
            <button className="button button-small button-danger" onClick={onStop}>
              Stop
            </button>
          ) : null}
        </div>
      </div>
      <div className="workspace-body">
        {workspaceUrl
          ? terminalTabs.map((tab) => (
              <Terminal
                key={tab.id}
                ref={(handle) => {
                  terminals.current.set(tab.id, handle);
                }}
                workspaceUrl={workspaceUrl}
                terminalId={tab.id.replace("terminal-", "")}
                active={activeId === tab.id}
                connect={connect}
                onStatus={onTerminalStatus}
              />
            ))
          : null}
        {!workspaceUrl || !connect ? (
          <div className={`workspace-placeholder ${activeId.startsWith("terminal-") ? "" : "is-hidden"}`}>
            <pre className="boot-log">{statusText}</pre>
          </div>
        ) : null}
        {tabs.includes("editor") ? (
          <div className="frame-wrap" hidden={activeId !== "editor"}>
            {workspaceUrl && connect && editorReady && agent ? (
              <iframe
                className="frame"
                title="Editor"
                src={editorUrl(workspaceUrl, agent.editor.path)}
                allow="clipboard-read; clipboard-write"
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="workspace-placeholder"><pre className="boot-log">Starting the editor…</pre></div>
            )}
          </div>
        ) : null}
        {tabs.includes("preview") ? (
          <div className="frame-wrap" hidden={activeId !== "preview"}>
            {session?.previewUrl && connect && previewReady && !previewProblem ? (
              <iframe
                className="frame frame-light"
                title="Preview"
                src={session.previewUrl}
                sandbox={FRAME_SANDBOX}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="workspace-placeholder"><pre className="boot-log">
                  {previewProblem ?? (agent?.setup.status === "running" ? "Installing dependencies…" : "Starting the preview…")}
                </pre></div>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}
