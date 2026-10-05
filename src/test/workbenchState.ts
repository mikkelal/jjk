import * as assert from "assert";

// Read-only observation of the isolated integration-test workbench.
export async function readWorkbenchState<T>(expression: string): Promise<T> {
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
    return await new Promise<T>((resolve, reject) => {
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
              expression,
              returnByValue: true,
            },
          }),
        );
      };
      socket.onmessage = ({ data }) => {
        const message = JSON.parse(String(data)) as {
          id?: number;
          result?: { result?: { value?: T } };
        };
        if (message.id === 1) {
          const state = message.result?.result?.value;
          if (state !== undefined) {
            resolve(state);
          } else {
            reject(new Error("Workbench did not return the requested state"));
          }
        }
      };
    });
  } finally {
    clearTimeout(timeout);
    socket.close();
  }
}
