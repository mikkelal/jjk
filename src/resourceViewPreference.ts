import * as vscode from "vscode";

export type DefaultResourceView = "diff" | "file";

const workspaceStateKey = "defaultResourceView";
const contextKey = "jj.resourceView.default";

let workspaceState: vscode.Memento | undefined;
let defaultResourceView: DefaultResourceView = "diff";

export async function initializeResourceViewPreference(
  context: vscode.ExtensionContext,
): Promise<void> {
  workspaceState = context.workspaceState;
  defaultResourceView =
    workspaceState.get<DefaultResourceView>(workspaceStateKey) ?? "diff";
  await vscode.commands.executeCommand(
    "setContext",
    contextKey,
    defaultResourceView,
  );
}

export function getDefaultResourceView(): DefaultResourceView {
  return defaultResourceView;
}

export async function setDefaultResourceView(
  view: DefaultResourceView,
): Promise<void> {
  defaultResourceView = view;
  await workspaceState?.update(workspaceStateKey, view);
  await vscode.commands.executeCommand("setContext", contextKey, view);
}
