import { spawn } from "node:child_process";
import { readEnvLocalValue } from "./env-local.mjs";

const localRunnerSecret =
  process.env.RUNNER_SHARED_SECRET ??
  (await readEnvLocalValue(
    "RUNNER_SHARED_SECRET",
    new URL("../.env.local", import.meta.url),
  ));

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
  {
    name: "runner",
    command: "npm",
    args: ["run", "runner:local"],
    delayMs: Number(process.env.LOCAL_RUNNER_START_DELAY_MS ?? 6000),
    env: {
      LOCAL_EDITOR_PROVIDER:
        process.env.LOCAL_EDITOR_PROVIDER ?? "openvscode-docker",
      ...(localRunnerSecret ? { RUNNER_SHARED_SECRET: localRunnerSecret } : {}),
    },
  },
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

console.log("[supervisor] started Convex, dashboard, and local runner");
console.log("[supervisor] press Ctrl-C to stop all processes");

process.on("SIGINT", () => {
  console.log("\n[supervisor] stopping local dev stack");
  stopAll("SIGINT");
});

process.on("SIGTERM", () => {
  stopAll("SIGTERM");
});
