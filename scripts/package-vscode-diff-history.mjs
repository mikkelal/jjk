import { createVSIX } from "@vscode/vsce";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
export const companionPath = path.join(
  project,
  "out",
  "native-diff-history-extension",
);
export const packagePath = path.join(
  project,
  "out",
  "jjk-native-diff-history.vsix",
);

export async function prepareCompanionExtension() {
  await mkdir(companionPath, { recursive: true });
  await writeFile(
    path.join(companionPath, "package.json"),
    JSON.stringify(
      {
        name: "native-diff-history",
        displayName: "JJK Native Diff History",
        description:
          "Keep jj diff previews in VS Code's native Back/Forward history.",
        publisher: "jjk",
        version: "0.2.0",
        license: "MIT",
        engines: { vscode: "^1.138.0" },
        extensionKind: ["ui"],
        activationEvents: ["*"],
        main: "./extension.cjs",
        files: [
          "extension.cjs",
          "vscode-diff-history.mjs",
          "vscode-diff-history-patch.js",
          "README.md",
          "LICENSE",
        ],
        contributes: {
          commands: [
            {
              command: "jjk.nativeDiffHistory.retry",
              title: "JJK: Reconnect Native Diff History",
            },
          ],
          configuration: {
            title: "JJK Native Diff History",
            properties: {
              "jjk.nativeDiffHistory.debugPort": {
                type: "integer",
                default: 9347,
                minimum: 1,
                maximum: 65535,
                scope: "machine",
                description:
                  "Local debugger port configured as remote-debugging-port in VS Code's argv.json. Restart VS Code after changing the runtime argument.",
              },
            },
          },
        },
      },
      null,
      2,
    ),
  );
  await copyFile(
    path.join(project, "scripts", "native-diff-history-extension.cjs"),
    path.join(companionPath, "extension.cjs"),
  );
  await copyFile(
    path.join(project, "scripts", "vscode-diff-history.mjs"),
    path.join(companionPath, "vscode-diff-history.mjs"),
  );
  await copyFile(
    path.join(project, "scripts", "vscode-diff-history-patch.js"),
    path.join(companionPath, "vscode-diff-history-patch.js"),
  );
  await copyFile(
    path.join(project, "LICENSE"),
    path.join(companionPath, "LICENSE"),
  );
  await writeFile(
    path.join(companionPath, "README.md"),
    `# JJK Native Diff History

Applies a private, in-memory workbench patch automatically to keep jj diff previews
in the native Back/Forward history. Application files and keybindings are unchanged.
Explorer also follows historical files and diffs using the existing auto-reveal
settings, without moving keyboard focus. Files absent from the workspace have no
matching Explorer entry to select.

Use **Preferences: Configure Runtime Arguments** to add
\`"remote-debugging-port": "9347"\` to argv.json, then quit and restart VS Code.
This local debugger permits local processes to control the editor.

The companion reconnects after window reloads. Diagnostics appear in the
**JJK Native Diff History** output channel. Tested on VS Code 1.139.1.

To remove the workaround, uninstall this companion, remove the runtime argument,
and restart VS Code. No background service or special launcher is installed.
`,
  );
  return companionPath;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await prepareCompanionExtension();
  await createVSIX({
    cwd: companionPath,
    packagePath,
    dependencies: false,
    allowStarActivation: true,
    allowMissingRepository: true,
  });
  console.log(packagePath);
}
