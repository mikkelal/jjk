import * as assert from "assert";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { ResourceViewCommandArgs } from "../types";
import { assertExplorerSelection, readExplorerState } from "./explorerState";

// Run with scripts/test-vscode-diff-history.mjs, which installs the native hook.
suite("Native diff navigation history", () => {
  let resources: ResourceViewCommandArgs[];
  let repoRoot: string;
  let originalOperation: string;

  suiteSetup(async () => {
    await waitForHistoryHook();
    const api = await getExtensionAPI();
    await vscode.commands.executeCommand("jj.refresh");
    const repo = api.workspaceSCM.repoSCMs[0];
    repoRoot = repo.repositoryRoot;
    originalOperation = (
      await execJJPromise(
        'operation log --limit 1 --no-graph --template "self.id()"',
        { cwd: repoRoot },
      )
    ).stdout.trim();
    for (const name of ["first.txt", "second.txt", "third.txt"]) {
      await fs.writeFile(path.join(repoRoot, name), "oldest\n");
    }
    await execJJPromise("new", { cwd: repoRoot });
    for (const name of ["first.txt", "second.txt", "third.txt"]) {
      await fs.writeFile(path.join(repoRoot, name), "before\n");
    }
    await execJJPromise("new", { cwd: repoRoot });
    for (const name of ["first.txt", "second.txt", "third.txt"]) {
      await fs.writeFile(path.join(repoRoot, name), "after\n");
    }
    await vscode.commands.executeCommand("jj.refresh");
    resources = repo.workingCopyResourceGroup.resourceStates.map(
      (state) => state.command?.arguments?.[0] as ResourceViewCommandArgs,
    );
    assert.strictEqual(resources.length, 3);
  });

  setup(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await vscode.commands.executeCommand("workbench.action.clearEditorHistory");
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    if (originalOperation) {
      await execJJPromise(`operation restore ${originalOperation}`, {
        cwd: repoRoot,
      });
    }
  });

  test("Back and Forward restore replaced previews in order", async () => {
    for (const resource of resources) {
      await openResource(resource);
    }
    assertSinglePreview();
    for (let round = 0; round < 3; round++) {
      await back();
      assertDiff(resources[1]);
      await back();
      assertDiff(resources[0]);
      await forward();
      assertDiff(resources[1]);
      await forward();
      assertDiff(resources[2]);
      assertSinglePreview();
    }
  });

  test("diffs with the same modified file retain distinct original revisions", async () => {
    const api = await getExtensionAPI();
    const current = resources[0];
    const previous: ResourceViewCommandArgs = {
      beforeUri: api.uri.toJJUri(current.afterUri, { rev: "@--" }),
      afterUri: current.afterUri,
      title: "Compare against an older revision",
    };
    await openResource(previous);
    await openResource(current);
    await back();
    assertDiff(previous);
    await forward();
    assertDiff(current);
    assertSinglePreview();
  });

  test("read-only revision diffs survive preview replacement", async () => {
    const api = await getExtensionAPI();
    const historic = resources.map((resource) => ({
      beforeUri: api.uri.toJJUri(resource.afterUri, { rev: "@--" }),
      afterUri: api.uri.toJJUri(resource.afterUri, { rev: "@-" }),
      title: "Previous revision",
    }));
    await openResource(historic[0]);
    await openResource(historic[1]);
    await back();
    assertDiff(historic[0]);
    await forward();
    assertDiff(historic[1]);
    assertSinglePreview();
  });

  test("ordinary files and diff previews share the native navigation order", async () => {
    await vscode.commands.executeCommand("vscode.open", resources[2].afterUri, {
      preview: true,
    });
    await openResource(resources[0]);
    await openResource(resources[1]);
    await back();
    assertDiff(resources[0]);
    await back();
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    assert.ok(input instanceof vscode.TabInputText);
    assert.strictEqual(input.uri.toString(), resources[2].afterUri.toString());
    await forward();
    assertDiff(resources[0]);
    await forward();
    assertDiff(resources[1]);
    assertSinglePreview();
  });

  test("opening another diff after Back discards the forward branch", async () => {
    await openResource(resources[0]);
    await openResource(resources[1]);
    await back();
    assertDiff(resources[0]);
    await openResource(resources[2]);
    await forward();
    assertDiff(resources[2]);
    await back();
    assertDiff(resources[0]);
    assertSinglePreview();
  });

  test("switching a resource from diff to file keeps the diff in history", async () => {
    await openResource(resources[0]);
    await openResource(resources[0]);
    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
        vscode.TabInputText,
    );
    await back();
    assertDiff(resources[0]);
    await forward();
    assert.ok(
      vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
        vscode.TabInputText,
    );
    assertSinglePreview();
  });

  test("clear history also clears retained diff previews", async () => {
    await openResource(resources[0]);
    await openResource(resources[1]);
    await vscode.commands.executeCommand("workbench.action.clearEditorHistory");
    await back();
    assertDiff(resources[1]);
    await forward();
    assertDiff(resources[1]);
  });

  test("Explorer follows historical files and Back/Forward without moving focus", async () => {
    const api = await getExtensionAPI();
    await vscode.commands.executeCommand("workbench.view.explorer");
    for (const resource of resources.slice(0, 2)) {
      await vscode.commands.executeCommand(
        "vscode.open",
        api.uri.toJJUri(resource.afterUri, { rev: "@-" }),
      );
      await assertExplorerSelection(path.basename(resource.afterUri.fsPath));
    }
    await back();
    await assertExplorerSelection("first.txt");
    await forward();
    await assertExplorerSelection("second.txt");
  });

  test("Explorer follows historical diffs and Back/Forward without moving focus", async () => {
    const api = await getExtensionAPI();
    await vscode.commands.executeCommand("workbench.view.explorer");
    const historic = resources.map((resource) => ({
      beforeUri: api.uri.toJJUri(resource.afterUri, { rev: "@--" }),
      afterUri: api.uri.toJJUri(resource.afterUri, { rev: "@-" }),
      title: "Previous revision",
    }));
    await vscode.commands.executeCommand(
      "vscode.diff",
      historic[0].beforeUri,
      historic[0].afterUri,
    );
    await assertExplorerSelection("first.txt");
    await vscode.commands.executeCommand(
      "vscode.diff",
      historic[1].beforeUri,
      historic[1].afterUri,
    );
    await assertExplorerSelection("second.txt");
    await back();
    await assertExplorerSelection("first.txt");
    await forward();
    await assertExplorerSelection("second.txt");
  });

  test("Explorer respects disabled auto-reveal and excluded historical files", async () => {
    const api = await getExtensionAPI();
    const configuration = vscode.workspace.getConfiguration("explorer");
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand("vscode.open", resources[0].afterUri);
    await assertExplorerSelection("first.txt");
    try {
      await configuration.update(
        "autoReveal",
        false,
        vscode.ConfigurationTarget.Workspace,
      );
      await vscode.commands.executeCommand(
        "vscode.open",
        api.uri.toJJUri(resources[1].afterUri, { rev: "@-" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assertExplorerSelection("first.txt");
      await configuration.update(
        "autoRevealExclude",
        { "**/third.txt": true },
        vscode.ConfigurationTarget.Workspace,
      );
      await configuration.update(
        "autoReveal",
        "focusNoScroll",
        vscode.ConfigurationTarget.Workspace,
      );
      await vscode.commands.executeCommand(
        "vscode.open",
        api.uri.toJJUri(resources[2].afterUri, { rev: "@-" }),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await assertExplorerSelection("first.txt");
      await vscode.commands.executeCommand(
        "vscode.open",
        api.uri.toJJUri(resources[1].afterUri, { rev: "@--" }),
      );
      await assertExplorerSelection("second.txt");
    } finally {
      await configuration.update(
        "autoReveal",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
      await configuration.update(
        "autoRevealExclude",
        undefined,
        vscode.ConfigurationTarget.Workspace,
      );
    }
  });

  test("historical files do not open a hidden Explorer", async () => {
    const api = await getExtensionAPI();
    await vscode.commands.executeCommand("workbench.view.scm");
    await vscode.commands.executeCommand(
      "vscode.open",
      api.uri.toJJUri(resources[0].afterUri, { rev: "@-" }),
    );
    assert.strictEqual((await readExplorerState()).visible, false);
    await vscode.commands.executeCommand("workbench.view.explorer");
    await vscode.commands.executeCommand(
      "workbench.action.focusActiveEditorGroup",
    );
    await assertExplorerSelection("first.txt");
  });
});

async function waitForHistoryHook() {
  if (process.env.JJK_DIFF_HISTORY_AUTOMATIC === "1") {
    const companion = vscode.extensions.getExtension("jjk.native-diff-history");
    assert.ok(companion, "Native diff history companion is missing");
    await companion.activate();
    for (let attempt = 0; attempt < 200; attempt++) {
      const states = await vscode.commands.executeCommand<string[]>(
        "jjk.nativeDiffHistory.status",
      );
      if (states.some((state) => state === "armed" || state === "installed")) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.fail("Companion did not connect to the native history");
  }
  const ready = process.env.JJK_DIFF_HISTORY_READY;
  assert.ok(ready, "Use npm run test:diff-history to install the native hook");
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      await fs.access(ready);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.fail("Native history hook was not armed");
}

async function openResource(resource: ResourceViewCommandArgs) {
  await vscode.commands.executeCommand("jj.openResourceView", resource);
}

async function back() {
  await vscode.commands.executeCommand("workbench.action.navigateBack");
}

async function forward() {
  await vscode.commands.executeCommand("workbench.action.navigateForward");
}

function assertDiff(resource: ResourceViewCommandArgs) {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  assert.ok(input instanceof vscode.TabInputTextDiff);
  assert.strictEqual(input.original.toString(), resource.beforeUri.toString());
  assert.strictEqual(input.modified.toString(), resource.afterUri.toString());
}

function assertSinglePreview() {
  const tabs = vscode.window.tabGroups.activeTabGroup.tabs;
  assert.strictEqual(tabs.length, 1);
  assert.strictEqual(tabs[0].isPreview, true);
}
