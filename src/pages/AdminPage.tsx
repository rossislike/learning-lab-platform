import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { ACTIVE_STATUSES } from "../lib/format";
import { useNow } from "../lib/useNow";

export function AdminPage() {
  const sessions = useQuery(api.sessions.list);
  const labs = useQuery(api.labs.list);
  const heartbeat = useQuery(api.runners.latest, { runner: "kubernetes" });
  const seed = useMutation(api.labs.seedScenarios);
  const stop = useMutation(api.sessions.stop);
  const [message, setMessage] = useState<string | null>(null);
  const now = useNow(5_000);

  const labTitle = new Map((labs ?? []).map((lab) => [String(lab._id), lab.title]));
  const heartbeatAge = heartbeat ? now - heartbeat.lastSeenAt : null;
  const dispatcherHealthy = heartbeatAge !== null && heartbeatAge < 30_000;

  return (
    <section className="admin">
      <header className="admin-header">
        <h1>Admin</h1>
        <div className="admin-actions">
          <button
            className="button"
            onClick={async () => {
              setMessage(null);
              try {
                const ids = await seed({});
                setMessage(`Seeded ${ids.length} scenarios.`);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            Seed scenarios
          </button>
        </div>
      </header>
      {message ? <p className="muted">{message}</p> : null}

      <h2>Dispatcher</h2>
      <p className={dispatcherHealthy ? "status-ok" : "status-bad"}>
        {heartbeat
          ? `${dispatcherHealthy ? "Healthy" : "Stale"} — ${heartbeat.runnerId}, last seen ${Math.round((heartbeatAge ?? 0) / 1000)} s ago`
          : "No dispatcher heartbeat yet. Run npm run cluster:up."}
      </p>

      <h2>Sessions</h2>
      {sessions === undefined ? (
        <p className="muted">Loading…</p>
      ) : sessions.length === 0 ? (
        <p className="muted">No sessions.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Scenario</th>
              <th>Learner</th>
              <th>Status</th>
              <th>Step</th>
              <th>Pod</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session._id}>
                <td>{labTitle.get(String(session.labId)) ?? session.labId}</td>
                <td>{session.learnerLabel}</td>
                <td><span className={`pill pill-${session.status}`}>{session.status}</span></td>
                <td>{session.currentStep ?? 0}</td>
                <td className="mono">{session.podName ?? "—"}</td>
                <td>{new Date(session.expiresAt).toLocaleTimeString()}</td>
                <td>
                  {ACTIVE_STATUSES.has(session.status) && session.status !== "stopping" ? (
                    <button className="button button-small" onClick={() => void stop({ sessionId: session._id })}>Stop</button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
