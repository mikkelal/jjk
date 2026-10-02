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
