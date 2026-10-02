const vscode = require("vscode");

exports.activate = async function (context) {
  const { getWorkbenchTargets, patchWindow } = await import(
    "./vscode-diff-history.mjs"
  );
  const output = vscode.window.createOutputChannel("JJK Native Diff History");
  const states = new Map();
  const inFlight = new Set();
  let disposed = false;
  let scanning = false;
  let lastConnectionError;

  const timer = setInterval(() => {
    void scan();
  }, 5000);
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand("jjk.nativeDiffHistory.status", () => [
      ...states.values(),
    ]),
    vscode.commands.registerCommand("jjk.nativeDiffHistory.retry", scan),
    {
      dispose() {
        disposed = true;
        clearInterval(timer);
      },
    },
  );
  void scan();

  async function scan() {
    if (disposed || scanning) {
      return;
    }
    scanning = true;
    try {
      const port = vscode.workspace
        .getConfiguration("jjk.nativeDiffHistory")
        .get("debugPort", 9347);
      const targets = await getWorkbenchTargets(port);
      lastConnectionError = undefined;
      const activeIds = new Set(targets.map((target) => target.id));
      for (const id of states.keys()) {
        if (!activeIds.has(id)) {
          states.delete(id);
        }
      }
      for (const target of targets) {
        if (inFlight.has(target.id)) {
          continue;
        }
        inFlight.add(target.id);
        void patchWindow(target.webSocketDebuggerUrl, () => {
          states.set(target.id, "armed");
        })
          .then((result) => {
            if (disposed) {
              return;
            }
            if (states.get(target.id) !== "installed" && result !== "pending") {
              output.appendLine(`${target.title}: ${result}`);
            }
            states.set(
              target.id,
              result === "pending" ? "pending" : "installed",
            );
          })
          .catch((error) => {
            if (!disposed) {
              states.set(target.id, "failed");
              output.appendLine(`${target.title}: ${error.message}`);
            }
          })
          .finally(() => inFlight.delete(target.id));
      }
    } catch (error) {
      if (lastConnectionError !== error.message && !disposed) {
        output.appendLine(
          `Waiting for the local VS Code debugger. Restart VS Code after configuring remote-debugging-port. ${error.message}`,
        );
        lastConnectionError = error.message;
      }
    } finally {
      scanning = false;
    }
  }
};
