import assert from "node:assert/strict";
import { test } from "node:test";
import { installScmViewState } from "./scm-view-state.mjs";

test("each Changes list keeps its collapse state when commit groups are replaced", async () => {
  const view = createView();
  view.load("old-parent");
  view.tree.collapse(view.groups[0]);
  view.tree.collapse(view.groups[2]);
  installScmViewState(view);
  await view.tree.updateChildren(() => view.load("new-parent"));
  assert.deepEqual(
    view.groups.map((group) => view.tree.isCollapsed(group)),
    [true, false, true],
  );
  view.tree.collapse(view.groups[1]);
  view.tree.expand(view.groups[2]);
  await view.tree.updateChildren(() => view.load("old-parent"));
  assert.deepEqual(
    view.groups.map((group) => view.tree.isCollapsed(group)),
    [true, true, false],
  );
});

for (const groupIndex of [0, 1, 2]) {
  test(`selected file survives commit changes in list ${groupIndex}`, async () => {
    const view = createView();
    view.load("old-parent");
    const oldFile = view.groups[groupIndex].resources[1];
    view.tree.setSelection([oldFile]);
    view.tree.setFocus([oldFile]);
    installScmViewState(view);
    await view.tree.updateChildren(() => view.load("new-parent"));
    const newFile = view.groups[groupIndex].resources[1];
    assert.notEqual(newFile, oldFile);
    assert.deepEqual(view.tree.getSelection(), [newFile]);
    assert.deepEqual(view.tree.getFocus(), [newFile]);
  });
}

test("remembers a selected file through empty lists until the file returns", async () => {
  const view = createView();
  view.load("old-parent");
  view.tree.setSelection([view.groups[2].resources[1]]);
  installScmViewState(view);
  await view.tree.updateChildren(() => view.load("new-parent", []));
  assert.deepEqual(view.tree.getSelection(), []);
  await view.tree.updateChildren(() => view.load("old-parent"));
  assert.deepEqual(view.tree.getSelection(), [view.groups[2].resources[1]]);
});

test("a deliberate deselection does not resurrect the old selected file", async () => {
  const view = createView();
  view.load("old-parent");
  view.tree.setSelection([view.groups[2].resources[1]]);
  installScmViewState(view);
  view.tree.setSelection([], { type: "click" });
  await view.tree.updateChildren(() => view.load("new-parent"));
  assert.deepEqual(view.tree.getSelection(), []);
});

test("state stays with its repository and leaves other SCM providers untouched", async () => {
  const view = createView();
  view.load("old-parent");
  view.tree.collapse(view.groups[2]);
  view.tree.setSelection([view.groups[0].resources[1]]);
  installScmViewState(view);
  await view.tree.updateChildren(() =>
    view.load("new-parent", undefined, "/other"),
  );
  assert.equal(view.tree.isCollapsed(view.groups[2]), false);
  assert.deepEqual(view.tree.getSelection(), []);
  await view.tree.updateChildren(() => view.load("old-parent"));
  assert.equal(view.tree.isCollapsed(view.groups[2]), true);
  assert.deepEqual(view.tree.getSelection(), [view.groups[0].resources[1]]);
  await view.tree.updateChildren(() =>
    view.load("old-parent", undefined, "/repo", "git"),
  );
  assert.equal(view.tree.isCollapsed(view.groups[2]), false);
  assert.deepEqual(view.tree.getSelection(), []);
});

function createView() {
  let nodes = new Map();
  let selected = [];
  let focused = [];
  const selectionListeners = [];
  const focusListeners = [];
  const view = {
    groups: [],
    disposables: { add() {} },
    load(
      parent,
      names = ["first.txt", "second.txt"],
      root = "/repo",
      providerId = "jj",
    ) {
      const provider = {
        providerId,
        rootUri: { toString: () => `file://${root}` },
        groups: [],
      };
      view.groups = ["@", parent, "custom-view:0"].map((id) => {
        const group = { id, provider, resources: [] };
        group.resources = names.map((name) => ({
          resourceGroup: group,
          sourceUri: {
            path: `${root}/${name}`,
            query: id === parent ? `jj-rev=${parent}` : "",
          },
        }));
        return group;
      });
      provider.groups = view.groups;
      nodes = new Map();
      nodes.set(undefined, {
        children: view.groups.map((group) => {
          const node = {
            element: group,
            collapsible: true,
            collapsed: false,
            children: group.resources.map((file) => {
              const fileNode = {
                element: file,
                collapsible: false,
                collapsed: false,
                children: [],
              };
              nodes.set(file, fileNode);
              return fileNode;
            }),
          };
          nodes.set(group, node);
          return node;
        }),
      });
      view.tree.setSelection([]);
      view.tree.setFocus([]);
    },
    tree: {
      getNode: (element) => nodes.get(element),
      isCollapsed: (element) => nodes.get(element).collapsed,
      collapse: (element) => {
        nodes.get(element).collapsed = true;
      },
      expand: async (element) => {
        nodes.get(element).collapsed = false;
      },
      updateChildren: async (replace) => {
        replace();
      },
      getSelection: () => selected,
      getFocus: () => focused,
      setSelection(elements, browserEvent) {
        selected = elements;
        for (const listener of selectionListeners)
          listener({ elements, browserEvent });
      },
      setFocus(elements, browserEvent) {
        focused = elements;
        for (const listener of focusListeners)
          listener({ elements, browserEvent });
      },
      onDidChangeSelection: (listener) => {
        selectionListeners.push(listener);
      },
      onDidChangeFocus: (listener) => {
        focusListeners.push(listener);
      },
    },
  };
  return view;
}
