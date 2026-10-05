import * as assert from "assert";
import { readWorkbenchState } from "./workbenchState";

interface ExplorerState {
  selected: string[];
  editorFocused: boolean;
  visible: boolean;
}

// Observe the real workbench selection, rather than duplicating its URI matching.
export async function readExplorerState(): Promise<ExplorerState> {
  return readWorkbenchState<ExplorerState>(`(() => {
              const tree = document.querySelector('.explorer-folders-view');
              return {
                selected: [...(tree?.querySelectorAll('.monaco-list-row.selected .label-name') ?? [])].map(label => label.textContent),
                editorFocused: !!document.activeElement?.closest('.monaco-editor'),
                visible: !!tree?.getBoundingClientRect().width,
              };
            })()`);
}

export async function assertExplorerSelection(fileName: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await readExplorerState();
    if (
      state.selected.length === 1 &&
      state.selected[0] === fileName &&
      state.editorFocused
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const state = await readExplorerState();
  assert.deepStrictEqual(state.selected, [fileName], JSON.stringify(state));
  assert.ok(
    state.editorFocused,
    "Revealing a historical file must preserve editor focus",
  );
}
