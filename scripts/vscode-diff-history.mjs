import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const patch = await readFile(
  new URL("./vscode-diff-history-patch.js", import.meta.url),
  "utf8",
);

// Attach only to a locally launched workbench. Nothing is written to the app bundle.
export async function patchWindow(debuggerUrl, onArmed = () => {}) {
  const url = new URL(debuggerUrl);
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1") {
    throw new Error("Expected a loopback VS Code debugger URL");
  }
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("Cannot connect to VS Code"));
  });

  let nextId = 0;
  const pending = new Map();
  const scripts = [];
  let onPaused;
  let breakpointId;
  let paused = false;
  const owner = randomUUID();
  let claimed = false;
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Debugger.scriptParsed") {
      scripts.push(message.params);
    } else if (message.method === "Debugger.paused") {
      paused = true;
      onPaused?.(message.params);
    } else if (message.id) {
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(request.timeout);
      if (message.error) {
        request.reject(new Error(message.error.message));
      } else {
        request.resolve(message.result);
      }
    }
  };
  socket.onclose = () => {
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error("VS Code debugger disconnected"));
    }
    pending.clear();
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`VS Code debugger timed out: ${method}`));
      }, 10_000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    const installed = await send("Runtime.evaluate", {
      expression: "globalThis.__jjkDiffHistoryInstalled === true",
      returnByValue: true,
    });
    if (installed.result.value) {
      return "already installed";
    }
    // Several extension hosts can discover the same window. Only one may pause it.
    const claim = await send("Runtime.evaluate", {
      expression: `(() => {
        if (globalThis.__jjkDiffHistoryPending?.expires > Date.now()) return false;
        globalThis.__jjkDiffHistoryPending = { owner: ${JSON.stringify(owner)}, expires: Date.now() + 180000 };
        return true;
      })()`,
      returnByValue: true,
    });
    if (!claim.result.value) {
      return "pending";
    }
    claimed = true;
    await send("Debugger.enable");
    if (paused) {
      paused = false;
      throw new Error("VS Code is already paused in another debugger");
    }
    const script = await waitFor(() =>
      scripts.find((candidate) =>
        candidate.url.endsWith("/workbench.desktop.main.js"),
      ),
    );
    const { scriptSource } = await send("Debugger.getScriptSource", {
      scriptId: script.scriptId,
    });
    const matches = [
      ...scriptSource.matchAll(
        /addOrReplace\([^)]*\)\{this\.registerGroupListeners\(/g,
      ),
    ];
    if (matches.length !== 1) {
      throw new Error(
        "Unsupported VS Code build: navigation stack not found uniquely",
      );
    }
    const offset = matches[0].index + matches[0][0].indexOf("this.");
    const lines = scriptSource.slice(0, offset).split("\n");
    const stopped = new Promise((resolve) => {
      onPaused = resolve;
    });
    ({ breakpointId } = await send("Debugger.setBreakpoint", {
      location: {
        scriptId: script.scriptId,
        lineNumber: lines.length - 1,
        columnNumber: lines.at(-1).length,
      },
    }));
    await onArmed();
    let timeout;
    let stop;
    try {
      stop = await Promise.race([
        stopped,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () =>
              reject(
                new Error("Open a file or diff, then run the helper again"),
              ),
            120_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (!stop.hitBreakpoints.includes(breakpointId)) {
      paused = false;
      throw new Error("VS Code stopped at an unrelated breakpoint");
    }
    const result = await send("Debugger.evaluateOnCallFrame", {
      callFrameId: stop.callFrames[0].callFrameId,
      expression: patch,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          "History patch failed",
      );
    }
    return result.result.value;
  } finally {
    try {
      if (breakpointId) {
        await send("Debugger.removeBreakpoint", { breakpointId });
      }
      if (paused) {
        await send("Debugger.resume");
      }
      if (claimed) {
        await send("Runtime.evaluate", {
          expression: `if (globalThis.__jjkDiffHistoryPending?.owner === ${JSON.stringify(owner)}) delete globalThis.__jjkDiffHistoryPending`,
        });
      }
    } finally {
      socket.close();
    }
  }
}

export async function getWorkbenchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) {
    throw new Error(`Debugger returned HTTP ${response.status}`);
  }
  const targets = await response.json();
  return targets.filter(
    (target) =>
      target.type === "page" && /\/workbench[^/]*\.html/.test(target.url),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--attach")) {
    const child = spawn(
      "code",
      ["--remote-debugging-port=9347", ...(args.length ? args : ["."])],
      { stdio: "inherit" },
    );
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`VS Code launcher exited with ${code}`)),
      );
    });
  }
  let targets;
  try {
    targets = await waitFor(async () => {
      try {
        const result = await getWorkbenchTargets(9347);
        return result.length > 0 ? result : undefined;
      } catch {
        return undefined;
      }
    });
  } catch {
    throw new Error(
      "Quit VS Code completely, then run npm run vscode:diff-history again. An already-running VS Code cannot enable its debugging port.",
    );
  }
  await Promise.all(
    targets.map(async (target) => {
      const result = await patchWindow(target.webSocketDebuggerUrl, () => {
        console.log(
          `Open a file or diff in ${target.title} to activate native diff history.`,
        );
      });
      console.log(`Native jj diff history ${result}: ${target.title}`);
    }),
  );
}

async function waitFor(read) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) {
      return result;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for VS Code");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
