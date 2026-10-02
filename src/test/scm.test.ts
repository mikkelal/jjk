import * as assert from "assert";
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { execJJPromise } from "./utils";
import { getExtensionAPI } from "./extensionApi";
import type { WorkspaceSourceControlManager } from "../repoHandle";

suite("SCM Integration Tests", () => {
  let workspaceSCM: WorkspaceSourceControlManager;
  let repoRoot: string;
  let originalOperation: string;

  suiteSetup(async function () {
    this.timeout(30_000);

    const api = await getExtensionAPI();
    workspaceSCM = api.workspaceSCM;

    // Wait for initial repo detection if needed
    if (workspaceSCM.repoSCMs.length === 0) {
      await workspaceSCM.refresh();
      for (let i = 0; i < 10 && workspaceSCM.repoSCMs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        await workspaceSCM.refresh();
      }
    }

    assert.ok(workspaceSCM.repoSCMs.length > 0, "No jj repositories detected");
    repoRoot = workspaceSCM.repoSCMs[0].repositoryRoot;

    // Ensure state is fully populated
    await vscode.commands.executeCommand("jj.refresh");

    const output = await execJJPromise(
      'operation log --limit 1 --no-graph --template "self.id()"',
    );
    originalOperation = output.stdout.trim();
  });

  teardown(async function () {
    this.timeout(10_000);
    await execJJPromise(`operation restore ${originalOperation}`);
    // Let the extension pick up the restored state
    await vscode.commands.executeCommand("jj.refresh");
  });

  test("edit file → save → verify resource groups → jj.new → verify state", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];

    // Working copy should start clean (no file changes)
    const initialResourceStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      initialResourceStates.length,
      0,
      `Expected clean working copy, but found ${initialResourceStates.length} files: ${initialResourceStates.map((s) => s.resourceUri.fsPath).join(", ")}`,
    );

    // Create a new file in the repo
    const testFileName = "test-integration-file.txt";
    const testFilePath = path.join(repoRoot, testFileName);
    await fs.writeFile(testFilePath, "hello from integration test\n");

    // Open and save the file through VS Code (triggers file watchers)
    const doc = await vscode.workspace.openTextDocument(testFilePath);
    await vscode.window.showTextDocument(doc);
    await doc.save();

    // Refresh — this snapshots the working copy and updates SCM state.
    // jj.refresh awaits the full poll() cycle, so state is current when it resolves.
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the file shows up in the working copy resource group
    const workingCopyStates = repoSCM.workingCopyResourceGroup.resourceStates;
    const addedFile = workingCopyStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      addedFile,
      `Expected ${testFileName} in working copy resource group, but found: ${workingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );

    // Record the current working copy change ID
    const workingCopyChangeIdBefore = repoSCM.status?.workingCopy.changeId;
    assert.ok(workingCopyChangeIdBefore, "Expected a working copy change ID");

    // Execute jj.new via the source control.
    // The command handler calls repository.new() but does not await a refresh.
    // The file watcher will eventually trigger checkForUpdates, but we force
    // a refresh afterwards to get deterministic timing.
    await vscode.commands.executeCommand("jj.new", repoSCM.sourceControl);
    await vscode.commands.executeCommand("jj.refresh");

    // Verify the working copy is now empty (new change has no modifications)
    const postNewWorkingCopyStates =
      repoSCM.workingCopyResourceGroup.resourceStates;
    assert.strictEqual(
      postNewWorkingCopyStates.length,
      0,
      `Expected empty working copy after jj.new, but found ${postNewWorkingCopyStates.length} files: ${postNewWorkingCopyStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ")}`,
    );

    // Verify the working copy change ID has changed
    const workingCopyChangeIdAfter = repoSCM.status?.workingCopy.changeId;
    assert.ok(
      workingCopyChangeIdAfter,
      "Expected a working copy change ID after jj.new",
    );
    assert.notStrictEqual(
      workingCopyChangeIdAfter,
      workingCopyChangeIdBefore,
      "Working copy change ID should have changed after jj.new",
    );

    // Verify the file now shows up in a parent resource group
    assert.ok(
      repoSCM.parentResourceGroups.length > 0,
      "Expected at least one parent resource group after jj.new",
    );
    const parentStates = repoSCM.parentResourceGroups.flatMap(
      (g) => g.resourceStates,
    );
    const fileInParent = parentStates.find((state) =>
      state.resourceUri.fsPath.endsWith(testFileName),
    );
    assert.ok(
      fileInParent,
      `Expected ${testFileName} in parent resource group, but found: ${parentStates.map((s) => path.basename(s.resourceUri.fsPath)).join(", ") || "(empty)"}`,
    );
  });

  test("renders configured aggregate diffs as custom view groups", async function () {
    this.timeout(30_000);
    const repoSCM = workspaceSCM.repoSCMs[0];
    const { decorationProvider } = await getExtensionAPI();
    const rootUri = repoSCM.sourceControl.rootUri;
    assert.ok(rootUri);
    const canonicalRepoRoot = await fs.realpath(repoRoot);
    const workspaceFolder = await Promise.all(
      (vscode.workspace.workspaceFolders ?? []).map(async (folder) => ({
        folder,
        canonicalPath: await fs.realpath(folder.uri.fsPath),
      })),
    ).then((folders) =>
      folders.find((folder) => folder.canonicalPath === canonicalRepoRoot),
    );
    assert.ok(workspaceFolder, "Expected a workspace folder for the jj repo");
    const configuration = vscode.workspace.getConfiguration(
      "jjk",
      workspaceFolder.folder.uri,
    );
    const testFileName = "custom-view-integration.txt";
    const addedFileName = "custom-view-added.txt";
    const deletedFileName = "nested/custom-view-deleted.txt";
    const originalFileName = "custom-view-original.txt";
    const renamedFileName = "custom-view-renamed.txt";
    const decorationChanges: vscode.Uri[] = [];
    const decorationSubscription =
      decorationProvider.onDidChangeFileDecorations((uris) =>
        decorationChanges.push(...uris),
      );

    try {
      await fs.mkdir(path.join(repoRoot, "nested"), { recursive: true });
      await fs.writeFile(path.join(repoRoot, testFileName), "base content\n");
      await fs.writeFile(path.join(repoRoot, deletedFileName), "to delete\n");
      await fs.writeFile(path.join(repoRoot, originalFileName), "to rename\n");
      await execJJPromise("new", { cwd: repoRoot });
      await fs.writeFile(path.join(repoRoot, testFileName), "edited content\n");
      await fs.writeFile(path.join(repoRoot, addedFileName), "new content\n");
      await fs.unlink(path.join(repoRoot, deletedFileName));
      await fs.rename(
        path.join(repoRoot, originalFileName),
        path.join(repoRoot, renamedFileName),
      );
      await vscode.commands.executeCommand("jj.refresh");
      const workingCopyRename =
        repoSCM.workingCopyResourceGroup.resourceStates.find(
          (state) =>
            state.resourceUri.fsPath === path.join(repoRoot, renamedFileName),
        );
      assert.ok(workingCopyRename, "Expected the rename in Working Copy");
      const renameTooltip = `${originalFileName} → ${renamedFileName}`;
      assert.strictEqual(workingCopyRename.decorations?.tooltip, renameTooltip);
      assert.strictEqual(
        decorationProvider.provideFileDecoration(workingCopyRename.resourceUri)
          ?.tooltip,
        renameTooltip,
      );
      await execJJPromise("new", { cwd: repoRoot });
      await fs.writeFile(path.join(repoRoot, addedFileName), "newer content\n");
      await configuration.update(
        "customViews",
        [
          { name: "All Changes", from: "@--", to: "@" },
          { name: "Previous Changes", from: "@--", to: "@-" },
        ],
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      await vscode.commands.executeCommand("jj.refresh");

      for (const group of [
        ...repoSCM.parentResourceGroups,
        ...repoSCM.customViewResourceGroups,
      ]) {
        for (const state of group.resourceStates) {
          assert.strictEqual(
            state.resourceUri.scheme,
            rootUri.scheme,
            `Files in ${group.label} must use the repository URI scheme so the tree shows relative paths`,
          );
        }
        const rename = group.resourceStates.find(
          (state) =>
            state.resourceUri.fsPath === path.join(repoRoot, renamedFileName),
        );
        assert.ok(rename, `Expected the rename in ${group.label}`);
        assert.strictEqual(rename.decorations?.tooltip, renameTooltip);
        if (repoSCM.parentResourceGroups.includes(group)) {
          assert.strictEqual(
            decorationProvider.provideFileDecoration(rename.resourceUri)
              ?.tooltip,
            renameTooltip,
          );
          assert.ok(
            decorationChanges.some(
              (uri) => uri.toString() === rename.resourceUri.toString(),
            ),
            "Parent row decorations must refresh when revision statuses change",
          );
        }
      }

      assert.strictEqual(repoSCM.customViewResourceGroups.length, 2);
      for (const customGroup of repoSCM.customViewResourceGroups) {
        for (const [fileName, badge] of [
          [addedFileName, "A"],
          [testFileName, "M"],
          [deletedFileName, "D"],
          [renamedFileName, "R"],
        ]) {
          const state = customGroup.resourceStates.find((resource) =>
            resource.resourceUri.fsPath.endsWith(fileName),
          );
          assert.ok(state, `Expected ${fileName} in ${customGroup.label}`);
          assert.ok(state.command);
          for (const theme of ["light", "dark"] as const) {
            const icon: vscode.SourceControlResourceThemableDecorations["iconPath"] =
              state.decorations?.[theme]?.iconPath;
            assert.ok(icon instanceof vscode.Uri);
            assert.strictEqual(icon.scheme, "data");
            const svg = Buffer.from(
              icon.path.split(",")[1],
              "base64",
            ).toString();
            assert.ok(
              svg.includes(`>${badge}</text>`),
              `Expected ${badge} for ${fileName} in ${customGroup.label}`,
            );
          }
          assert.strictEqual(state.decorations?.strikeThrough, badge === "D");
          const commandArgs: unknown[] = state.command?.arguments ?? [];
          const openedUri =
            state.command?.command === "vscode.open"
              ? commandArgs[0]
              : (commandArgs[0] as { afterUri?: unknown }).afterUri;
          assert.ok(openedUri instanceof vscode.Uri);
          if (badge === "D") {
            assert.strictEqual(
              state.resourceUri.toString(),
              vscode.Uri.joinPath(rootUri, deletedFileName).toString(),
              "Deleted files must stay under their repository-relative folder",
            );
            assert.strictEqual(openedUri.scheme, "jj");
            await vscode.commands.executeCommand(
              state.command.command,
              ...commandArgs,
            );
            const input =
              vscode.window.tabGroups.activeTabGroup.activeTab?.input;
            assert.ok(input instanceof vscode.TabInputText);
            assert.strictEqual(input.uri.toString(), openedUri.toString());
            const document = await vscode.workspace.openTextDocument(input.uri);
            assert.strictEqual(document.getText(), "to delete\n");
          } else if (customGroup === repoSCM.customViewResourceGroups[0]) {
            assert.strictEqual(
              state.resourceUri.toString(),
              openedUri.toString(),
              `Selecting ${fileName} must stay in ${customGroup.label}`,
            );
          } else {
            assert.strictEqual(openedUri.scheme, "jj");
          }
        }
      }
      assert.strictEqual(
        decorationProvider.provideFileDecoration(
          vscode.Uri.file(path.join(repoRoot, addedFileName)),
        )?.badge,
        "M",
        "The working-copy status must remain independent of the aggregate status",
      );
      assert.strictEqual(
        decorationProvider.provideFileDecoration(
          vscode.Uri.file(path.join(repoRoot, testFileName)),
        )?.badge,
        undefined,
        "Files changed only in the stack must remain clean in the working copy",
      );
      const branchAddedFile =
        repoSCM.customViewResourceGroups[0].resourceStates.find(
          (state) =>
            state.resourceUri.fsPath === path.join(repoRoot, addedFileName),
        );
      assert.ok(branchAddedFile);
      await vscode.commands.executeCommand(
        "jj.restoreResourceState",
        branchAddedFile,
      );
      assert.strictEqual(
        await fs.readFile(path.join(repoRoot, addedFileName), "utf8"),
        "newer content\n",
        "Branch rows sharing a working-copy URI must remain protected from restore commands",
      );
      const group = repoSCM.customViewResourceGroups[0];
      assert.match(group.label, /View: All Changes/);
      const resource = group.resourceStates.find((state) =>
        state.resourceUri.fsPath.endsWith(testFileName),
      );
      assert.ok(
        resource,
        "Expected the aggregate diff to contain the test file",
      );
      assert.strictEqual(resource.command?.command, "jj.openResourceView");
      const commandArguments: unknown[] = resource.command?.arguments ?? [];
      const resourceViewArgs = commandArguments[0] as {
        beforeUri?: unknown;
        afterUri?: unknown;
      };
      const beforeUri = resourceViewArgs.beforeUri;
      const afterUri = resourceViewArgs.afterUri;
      assert.ok(beforeUri instanceof vscode.Uri);
      assert.ok(afterUri instanceof vscode.Uri);
      assert.strictEqual(beforeUri.scheme, "jj");
      assert.strictEqual(afterUri.scheme, "file");
      assert.strictEqual(
        resource.resourceUri.toString(),
        afterUri.toString(),
        "The branch row must match the opened editor so SCM auto-reveal keeps it selected",
      );

      await vscode.commands.executeCommand(
        resource.command.command,
        ...commandArguments,
        false,
      );
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff,
        "Expected the first open to show the diff",
      );

      await vscode.commands.executeCommand(
        resource.command.command,
        ...commandArguments,
        false,
      );
      const activeFileInput =
        vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      assert.ok(activeFileInput instanceof vscode.TabInputText);
      assert.strictEqual(
        activeFileInput.uri.toString(),
        afterUri.toString(),
        "Expected the second open to show the file",
      );

      await vscode.commands.executeCommand(
        resource.command.command,
        ...commandArguments,
        true,
      );
      assert.ok(
        vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof
          vscode.TabInputTextDiff,
        "Expected the next click to switch back to the diff",
      );
    } finally {
      decorationSubscription.dispose();
      await configuration.update(
        "customViews",
        undefined,
        vscode.ConfigurationTarget.WorkspaceFolder,
      );
      await vscode.commands.executeCommand("jj.refresh");
    }
  });
});
