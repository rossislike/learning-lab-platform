import { spawn } from "node:child_process";

const processes = [];
let shuttingDown = false;

const commands = [
  {
    name: "convex",
    command: "npx",
    args: ["convex", "dev"],
  },
  {
    name: "dashboard",
    command: "npm",
    args: ["run", "dev"],
  },
  // Sessions run on the local kind cluster (dispatcher + gateway in-cluster).
  // `cluster up` is idempotent: creates the cluster once, rebuilds/loads the
  // images, and upgrades the Helm chart. Set SKIP_CLUSTER=1 to leave it alone.
  ...(process.env.SKIP_CLUSTER
    ? []
    : [
        {
          name: "cluster",
          command: "node",
          args: ["scripts/cluster.mjs", "up"],
          delayMs: Number(process.env.CLUSTER_START_DELAY_MS ?? 8000),
          oneShot: true,
        },
      ]),
];

function log(name, chunk, stream) {
  const lines = chunk
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);

  for (const line of lines) {
    stream.write(`[${name}] ${line}\n`);
  }
}

function stopAll(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const child of processes) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  }
}

function startProcess(entry) {
  if (shuttingDown) return;

  const child = spawn(entry.command, entry.args, {
    env: { ...process.env, ...entry.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  processes.push(child);
  child.stdout.on("data", (chunk) => log(entry.name, chunk, process.stdout));
  child.stderr.on("data", (chunk) => log(entry.name, chunk, process.stderr));
  child.on("exit", (code, signal) => {
    if (entry.oneShot) {
      // A one-shot step (the kind cluster) must not take Convex and the
      // dashboard down with it: report, and leave the long-running
      // processes alone so the developer can fix it and re-run it by hand.
      if (code === 0) console.log(`[supervisor] ${entry.name} finished`);
      else if (!shuttingDown) {
        console.error(
          `[supervisor] ${entry.name} exited with ${signal ?? `code ${code}`}; Convex and the dashboard keep running. Fix it and re-run: npm run cluster:up`
        );
      }
      return;
    }
    if (!shuttingDown && code !== 0) {
      console.error(
        `[supervisor] ${entry.name} exited with ${signal ?? `code ${code}`}; stopping local dev stack.`
      );
      stopAll();
      process.exitCode = code ?? 1;
    }
  });
}

for (const entry of commands) {
  if (entry.delayMs) {
    console.log(`[supervisor] starting ${entry.name} in ${entry.delayMs}ms`);
    setTimeout(() => startProcess(entry), entry.delayMs);
  } else {
    startProcess(entry);
  }
}

console.log(
  process.env.SKIP_CLUSTER
    ? "[supervisor] started Convex and the dashboard (SKIP_CLUSTER set; sessions need npm run cluster:up)"
    : "[supervisor] started Convex and the dashboard; the kind cluster (dispatcher + gateway) follows"
);
console.log("[supervisor] open the dashboard at http://app.lab.localhost:8080 (through the gateway) for workspace access");
console.log("[supervisor] press Ctrl-C to stop all processes");

process.on("SIGINT", () => {
  console.log("\n[supervisor] stopping local dev stack");
  stopAll("SIGINT");
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});
