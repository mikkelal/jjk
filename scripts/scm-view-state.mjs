// Keep this function self-contained: the companion evaluates its source in the workbench.
export function installScmViewState(view) {
  const tree = view?.tree;
  if (!tree || tree.__jjkViewStateInstalled) {
    return;
  }

  const groupKeys = new WeakMap();
  const collapsed = new Map();
  let selection = [];
  let focus = [];
  let updating = false;

  remember();
  const updateChildren = tree.updateChildren;
  tree.updateChildren = async function (...args) {
    remember();
    updating = true;
    try {
      const result = await updateChildren.apply(this, args);
      await restoreCollapseState();
      restoreSelection();
      return result;
    } finally {
      updating = false;
    }
  };
  view.disposables.add(
    tree.onDidChangeSelection((event) => {
      if (event.browserEvent || (!updating && event.elements.length > 0)) {
        selection = event.elements.map(elementKey).filter(Boolean);
      }
    }),
  );
  view.disposables.add(
    tree.onDidChangeFocus((event) => {
      if (event.browserEvent || (!updating && event.elements.length > 0)) {
        focus = event.elements.map(elementKey).filter(Boolean);
      }
    }),
  );
  tree.__jjkViewStateInstalled = true;

  function remember() {
    for (const node of nodes()) {
      const key = elementKey(node.element);
      if (key && node.collapsible) {
        collapsed.set(key, node.collapsed);
      }
    }
    if (tree.getSelection().length > 0) {
      selection = tree.getSelection().map(elementKey).filter(Boolean);
    }
    if (tree.getFocus().length > 0) {
      focus = tree.getFocus().map(elementKey).filter(Boolean);
    }
  }

  async function restoreCollapseState(parent) {
    for (const node of tree.getNode(parent).children) {
      const key = elementKey(node.element);
      if (node.collapsible && collapsed.has(key)) {
        if (collapsed.get(key)) {
          tree.collapse(node.element);
        } else {
          await tree.expand(node.element);
        }
      }
      if (!tree.isCollapsed(node.element)) {
        await restoreCollapseState(node.element);
      }
    }
  }

  function restoreSelection() {
    const elements = new Map(
      nodes().map((node) => [elementKey(node.element), node.element]),
    );
    const selected = selection.map((key) => elements.get(key)).filter(Boolean);
    const focused = focus.map((key) => elements.get(key)).filter(Boolean);
    if (selected.length > 0) {
      tree.setSelection(selected);
    }
    if (focused.length > 0) {
      tree.setFocus(focused);
    }
  }

  function nodes(parent) {
    return [...tree.getNode(parent).children].flatMap((node) => [
      node,
      ...nodes(node.element),
    ]);
  }

  function elementKey(element) {
    const group = element?.resourceGroup ?? element?.context ?? element;
    if (
      group?.provider?.providerId !== "jj" ||
      !Array.isArray(group.resources)
    ) {
      return undefined;
    }
    let key = groupKeys.get(group);
    if (!key) {
      let id = group.id;
      if (id !== "@" && !id.startsWith("custom-view:")) {
        const parents = group.provider.groups.filter(
          (candidate) =>
            candidate.id !== "@" && !candidate.id.startsWith("custom-view:"),
        );
        const index = parents.indexOf(group);
        if (index < 0) {
          return undefined;
        }
        id = `parent:${index}`;
      }
      key = JSON.stringify([group.provider.rootUri?.toString(), id]);
      groupKeys.set(group, key);
    }
    if (element === group) {
      return `${key}/group`;
    }
    const uri = element.sourceUri ?? element.uri;
    return uri
      ? `${key}/${element.sourceUri ? "file" : "folder"}/${uri.path}`
      : undefined;
  }
}
