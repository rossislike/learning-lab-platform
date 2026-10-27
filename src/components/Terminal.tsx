import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { resizeFrame, terminalSocketUrl } from "../lib/gateway";

export type TerminalHandle = { write: (text: string) => void; focus: () => void };

/** "failed": the socket kept closing without ever opening; reconnecting stopped. */
export type TerminalStatus = "connecting" | "open" | "closed" | "failed";

type Props = {
  workspaceUrl: string;
  terminalId: string;
  active: boolean;
  /** When false the socket is not opened (session not usable yet). */
  connect: boolean;
  onStatus?: (status: TerminalStatus) => void;
};

const RECONNECT_MS = [500, 1000, 2000, 4000, 8000];
/** Consecutive closes without an open before giving up (≈ 15 s of backoff). */
const MAX_FAILED_ATTEMPTS = 5;

const encoder = new TextEncoder();

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal(
  { workspaceUrl, terminalId, active, connect, onStatus },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const onStatusRef = useRef(onStatus);

  useEffect(() => {
    onStatusRef.current = onStatus;
  }, [onStatus]);

  useImperativeHandle(ref, () => ({
    write(text) {
      const socket = socketRef.current;
      // Input goes as binary frames: the agent treats a text frame starting
      // with "\0" as a control message, binary frames are always keystrokes.
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(text));
    },
    focus() {
      termRef.current?.focus();
    },
  }));

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      theme: { background: "#1e1e1e", foreground: "#e6e6e6", cursor: "#e6e6e6" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
        const socket = socketRef.current;
        if (socket?.readyState === WebSocket.OPEN) socket.send(resizeFrame(term.cols, term.rows));
      } catch {
        /* container hidden */
      }
    });
    observer.observe(containerRef.current);
    const dataDisposable = term.onData((data) => {
      const socket = socketRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(encoder.encode(data));
    });
    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      // Close the socket before the terminal goes away so no late message is
      // written into a disposed xterm.
      socketRef.current?.close();
      socketRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term || !connect) return;
    // Per-run state: a socket from an earlier run (StrictMode, reconnect,
    // workspace change) must never touch this run's terminal or socketRef.
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let failures = 0;
    const report = (status: TerminalStatus) => {
      if (!closed) onStatusRef.current?.(status);
    };

    const open = () => {
      if (closed) return;
      report("connecting");
      const socket = new WebSocket(terminalSocketUrl(workspaceUrl, terminalId, term.cols, term.rows));
      socket.binaryType = "arraybuffer";
      socketRef.current = socket;
      let opened = false;
      const current = () => !closed && socketRef.current === socket && termRef.current === term;
      socket.onopen = () => {
        if (!current()) return socket.close();
        opened = true;
        attempt = 0;
        failures = 0;
        // The agent replays the scrollback on every attach; start from a clean
        // screen so a reconnect does not duplicate it.
        term.reset();
        report("open");
        socket.send(resizeFrame(term.cols, term.rows));
      };
      socket.onmessage = (event) => {
        if (!current()) return;
        term.write(typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer));
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        if (!opened) failures += 1;
        if (failures >= MAX_FAILED_ATTEMPTS) {
          if (termRef.current === term) term.write("\r\n\x1b[2m[connection lost]\x1b[0m\r\n");
          report("failed");
          return;
        }
        report("closed");
        const delay = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)];
        attempt += 1;
        timer = setTimeout(open, delay);
      };
      socket.onerror = () => socket.close();
    };
    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [workspaceUrl, terminalId, connect]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
        termRef.current?.focus();
      });
    }
  }, [active]);

  return <div ref={containerRef} className="terminal" hidden={!active} />;
});
