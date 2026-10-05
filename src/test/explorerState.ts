import * as assert from "assert";

interface ExplorerState {
  selected: string[];
  editorFocused: boolean;
  visible: boolean;
}

// Observe the real workbench selection, rather than duplicating its URI matching.
export async function readExplorerState(): Promise<ExplorerState> {
  const port = process.env.JJK_TEST_DEBUG_PORT;
  assert.ok(port, "Run with npm run test:diff-history");
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await response.json()) as {
    url: string;
    webSocketDebuggerUrl: string;
  }[];
  const target = targets.find((target) =>
    /\/workbench[^/]*\.html/.test(target.url),
  );
  assert.ok(target, "Expected an isolated VS Code workbench");
  const WebSocket = Reflect.get(
    globalThis,
    "WebSocket",
  ) as typeof import("undici-types").WebSocket;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<ExplorerState>((resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error("Workbench inspection timed out")),
        5000,
      );
      socket.onerror = () =>
        reject(new Error("Cannot inspect the test workbench"));
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            id: 1,
            method: "Runtime.evaluate",
            params: {
              expression: `(() => {
              const tree = document.querySelector('.explorer-folders-view');
              return {
                selected: [...(tree?.querySelectorAll('.monaco-list-row.selected .label-name') ?? [])].map(label => label.textContent),
                editorFocused: !!document.activeElement?.closest('.monaco-editor'),
                visible: !!tree?.getBoundingClientRect().width,
              };
            })()`,
              returnByValue: true,
            },
          }),
        );
      };
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data)) as {
          id?: number;
          result?: { result?: { value?: ExplorerState } };
        };
        if (message.id === 1) {
          const state = message.result?.result?.value;
          if (state) {
            resolve(state);
          } else {
            reject(new Error("Workbench did not return Explorer state"));
          }
        }
      };
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
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
