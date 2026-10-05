import { build } from "esbuild";
import { runTests } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getWorkbenchTargets, patchWindow } from "./vscode-diff-history.mjs";
import { prepareCompanionExtension } from "./package-vscode-diff-history.mjs";

const executable = process.argv[2];
if (!executable) {
  throw new Error(
    "Pass the VS Code executable path to npm run test:diff-history -- <path>",
  );
}
const project = fileURLToPath(new URL("../", import.meta.url));
const automatic = process.argv.includes("--automatic");
const output = path.join(project, "out", "diff-history");
await build({
  entryPoints: {
    "all-tests": "src/test/diffNavigation.test.ts",
    runner: "src/test/runner.ts",
  },
  absWorkingDir: project,
  outdir: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode", "mocha"],
});

const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "jjk-diff-history-repo-")),
);
const userData = await mkdtemp(path.join(tmpdir(), "jjk-diff-history-user-"));
execFileSync("jj", ["git", "init", root]);
const ready = path.join(root, ".jj", "history-hook-ready");
const server = createServer();
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const companionPath = automatic ? await prepareCompanionExtension() : undefined;
if (automatic) {
  await mkdir(path.join(userData, "user-data", "User"), { recursive: true });
  await writeFile(
    path.join(userData, "user-data", "User", "settings.json"),
    JSON.stringify({
      "jjk.nativeDiffHistory.debugPort": port,
    }),
  );
  await writeFile(
    path.join(userData, "argv.json"),
    JSON.stringify({ "remote-debugging-port": String(port) }),
  );
}
const launchArgs = [
  root,
  `--user-data-dir=${userData}`,
  "--disable-extensions",
  "--disable-workspace-trust",
  "--skip-welcome",
  "--skip-release-notes",
];
if (!automatic) {
  launchArgs.push(`--remote-debugging-port=${port}`);
}

async function installHook() {
  for (let attempt = 0; attempt < 150; attempt++) {
    let targets;
    try {
      targets = await getWorkbenchTargets(port);
    } catch {
      await delay(100);
      continue;
    }
    if (targets.length > 0) {
      const result = await patchWindow(targets[0].webSocketDebuggerUrl, () =>
        writeFile(ready, "armed"),
      );
      console.log(`Native diff history hook: ${result}`);
      return;
    }
    await delay(100);
  }
  throw new Error("Isolated VS Code debugger did not start");
}

await Promise.all([
  runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: companionPath
      ? [project, companionPath]
      : project,
    extensionTestsPath: path.join(output, "runner.js"),
    extensionTestsEnv: automatic
      ? {
          JJK_DIFF_HISTORY_AUTOMATIC: "1",
          JJK_TEST_DEBUG_PORT: String(port),
          VSCODE_PORTABLE: userData,
        }
      : {
          JJK_DIFF_HISTORY_READY: ready,
          JJK_TEST_DEBUG_PORT: String(port),
          VSCODE_PORTABLE: userData,
        },
    launchArgs,
  }),
  automatic ? Promise.resolve() : installHook(),
]);
