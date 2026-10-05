// Evaluated in a paused VS Code renderer, where `this` is an EditorNavigationStack.
// Keep this independent of extension-host APIs: the native history lives in the renderer.
(function installDiffHistory(stack) {
  if (globalThis.__jjkDiffHistoryInstalled) {
    return "already installed";
  }
  if (
    !stack?.editorHelper ||
    !Array.isArray(stack.stack) ||
    typeof stack.addOrReplace !== "function"
  ) {
    throw new Error("Unsupported VS Code navigation stack");
  }

  patchExplorerSelection(stack);

  const patchedHelpers = new WeakSet();
  const prototype = Object.getPrototypeOf(stack);
  const addOrReplace = prototype.addOrReplace;
  prototype.addOrReplace = function (...args) {
    patchHelper(this);
    return addOrReplace.apply(this, args);
  };
  patchHelper(stack);
  globalThis.__jjkDiffHistoryInstalled = true;
  return "installed";

  function patchExplorerSelection(navigationStack) {
    const instantiationService =
      navigationStack.editorService?.instantiationService;
    let explorerService;
    for (let scope = instantiationService; scope; scope = scope._parent) {
      const entries = scope._services?._entries;
      if (!(entries instanceof Map)) {
        continue;
      }
      const id = [...entries.keys()].find(
        (key) => String(key) === "explorerService",
      );
      if (id) {
        explorerService = instantiationService.invokeFunction((accessor) =>
          accessor.get(id),
        );
        break;
      }
    }
    if (typeof explorerService?.select !== "function") {
      throw new Error("Unsupported VS Code Explorer service");
    }

    const select = explorerService.select;
    const selectHistoricalResource = function (resource, reveal) {
      // Keep Explorer's normal focus, scrolling, and exclusion behavior; only
      // translate historical editor URIs to their corresponding workspace paths.
      if (resource?.scheme === "jj") {
        resource = resource.with({ scheme: "file", query: "", fragment: "" });
      }
      return select.call(this, resource, reveal);
    };
    explorerService.select = selectHistoricalResource;
    // Lazy service proxies cache bound methods separately from their instance.
    Object.defineProperty(explorerService, "select", {
      value: selectHistoricalResource,
      configurable: true,
      writable: true,
    });
    // The active-editor event that installed the hook may have already reached Explorer.
    explorerService.view?.selectActiveFile().catch((error) => {
      navigationStack.logService.warn(
        "JJK: failed to reveal historical file",
        error,
      );
    });
  }

  function patchHelper(navigationStack) {
    const helper = navigationStack.editorHelper;
    if (patchedHelpers.has(helper)) {
      return;
    }
    patchedHelpers.add(helper);
    const preferResourceEditorInput = helper.preferResourceEditorInput;
    const matchesEditor = helper.matchesEditor;

    helper.preferResourceEditorInput = function (editor) {
      if (editor?.__jjkNavigationDiff) {
        return editor;
      }
      if (
        editor?.typeId === "workbench.editors.diffEditorInput" &&
        (editor.original?.resource?.scheme === "jj" ||
          editor.modified?.resource?.scheme === "jj")
      ) {
        const input = editor.toUntyped();
        if (input?.original?.resource && input?.modified?.resource) {
          // Untyped inputs survive disposal of the replaced preview tab.
          return { ...input, __jjkNavigationDiff: true };
        }
      }
      return preferResourceEditorInput.call(this, editor);
    };

    helper.matchesEditor = function (left, right) {
      if (!left?.__jjkNavigationDiff && !right?.__jjkNavigationDiff) {
        return matchesEditor.call(this, left, right);
      }
      if (
        left?.original?.resource &&
        left?.modified?.resource &&
        right?.original?.resource &&
        right?.modified?.resource
      ) {
        // The modified URI alone cannot distinguish two bases of the same file.
        return (
          this.uriIdentityService.extUri.isEqual(
            left.original.resource,
            right.original.resource,
          ) &&
          this.uriIdentityService.extUri.isEqual(
            left.modified.resource,
            right.modified.resource,
          )
        );
      }
      const snapshot = left?.__jjkNavigationDiff ? left : right;
      const other = snapshot === left ? right : left;
      if (
        typeof other?.contains === "function" ||
        typeof other?.isOperation === "function"
      ) {
        return this.matchesFile(snapshot.modified.resource, other);
      }
      return false;
    };

    // Preserve any still-open diff that was recorded before the hook activated.
    for (const entry of navigationStack.stack) {
      const input = helper.preferResourceEditorInput(entry.editor);
      if (input?.__jjkNavigationDiff && input !== entry.editor) {
        helper.clearOnEditorDispose(
          entry.editor,
          navigationStack.mapEditorToDisposable,
        );
        entry.editor = input;
      }
    }
  }
})(this);
