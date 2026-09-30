import * as vscode from "vscode";
import path from "path";
import { toJJUri } from "./uri";
import { getFileStatusIcon, getFileStatusTooltip } from "./decorationProvider";
import type {
  Change,
  CustomViewState,
  FileStatus,
  ResourceViewCommandArgs,
} from "./types";
import type { RepoState } from "./services/RepoState";

export interface RenderData {
  workingCopy: Change;
  workingCopyFileStatuses: FileStatus[];
  parentChanges: { change: Change; fileStatuses: FileStatus[] }[];
  customViews: CustomViewState[];
  totalFileCount: number;
}

export function computeRenderData(state: RepoState): RenderData | null {
  if (!state.status?.workingCopy) {
    return null;
  }

  const parentChanges = state.status.parentChanges.map((parentChange) => {
    const show = state.parentShowResults.get(parentChange.changeId);
    return {
      change: parentChange,
      fileStatuses: show ? show.fileStatuses : [],
    };
  });

  return {
    workingCopy: state.status.workingCopy,
    workingCopyFileStatuses: state.status.fileStatuses,
    parentChanges,
    customViews: state.customViews,
    totalFileCount: state.status.fileStatuses.length,
  };
}

function getLabel(prefix: string, change: Change) {
  return `${prefix} [${change.changeId}]${
    change.description ? ` • ${change.description}` : ""
  }${change.isEmpty ? " (empty)" : ""}${
    change.isConflict ? " (conflict)" : ""
  }${change.description ? "" : " (no description)"}`;
}

function getResourceStateCommand(
  fileStatus: FileStatus,
  beforeUri: vscode.Uri,
  afterUri: vscode.Uri,
  diffTitleSuffix: string,
): vscode.Command {
  if (fileStatus.type === "A") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [
        afterUri,
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
      ],
    };
  } else if (fileStatus.type === "D") {
    return {
      title: "Open",
      command: "vscode.open",
      arguments: [
        beforeUri,
        { preserveFocus: true } satisfies vscode.TextDocumentShowOptions,
        `${fileStatus.file} (Deleted)`,
      ],
    };
  }
  return {
    title: "Open",
    command: "jj.openResourceView",
    arguments: [
      {
        beforeUri,
        afterUri,
        title:
          (fileStatus.renamedFrom ? `${fileStatus.renamedFrom} => ` : "") +
          `${fileStatus.file} ${diffTitleSuffix}`,
      } satisfies ResourceViewCommandArgs,
    ],
  };
}

export function applyRenderData(
  renderData: RenderData,
  sourceControl: vscode.SourceControl,
  workingCopyGroup: vscode.SourceControlResourceGroup,
  parentGroups: vscode.SourceControlResourceGroup[],
): vscode.SourceControlResourceGroup[] {
  // Update working copy
  workingCopyGroup.label = getLabel("Working Copy", renderData.workingCopy);
  workingCopyGroup.resourceStates = renderData.workingCopyFileStatuses.map(
    (fileStatus) => ({
      resourceUri: vscode.Uri.file(fileStatus.path),
      decorations: {
        strikeThrough: fileStatus.type === "D",
        tooltip: getFileStatusTooltip(fileStatus),
      },
      command: getResourceStateCommand(
        fileStatus,
        toJJUri(vscode.Uri.file(`${fileStatus.path}`), {
          diffOriginalRev: "@",
        }),
        vscode.Uri.file(fileStatus.path),
        "(Working Copy)",
      ),
    }),
  );
  sourceControl.count = renderData.totalFileCount;

  // Update parent groups: dispose stale ones
  const updatedGroups: vscode.SourceControlResourceGroup[] = [];
  for (const group of parentGroups) {
    const parentChange = renderData.parentChanges.find(
      (p) => p.change.changeId === group.id,
    );
    if (!parentChange) {
      group.dispose();
    } else {
      group.label = getLabel("Parent Commit", parentChange.change);
      updatedGroups.push(group);
    }
  }

  // Create new groups or update existing
  for (const {
    change: parentChange,
    fileStatuses,
  } of renderData.parentChanges) {
    let parentChangeResourceGroup: vscode.SourceControlResourceGroup;

    const existingGroup = updatedGroups.find(
      (group) => group.id === parentChange.changeId,
    );
    if (!existingGroup) {
      parentChangeResourceGroup = sourceControl.createResourceGroup(
        parentChange.changeId,
        getLabel("Parent Commit", parentChange),
      );
      updatedGroups.push(parentChangeResourceGroup);
    } else {
      parentChangeResourceGroup = existingGroup;
    }

    parentChangeResourceGroup.resourceStates = fileStatuses.map(
      (parentStatus) => ({
        resourceUri: toJJUri(vscode.Uri.file(parentStatus.path), {
          rev: parentChange.changeId,
        }),
        decorations: {
          strikeThrough: parentStatus.type === "D",
          tooltip: getFileStatusTooltip(parentStatus),
        },
        command: getResourceStateCommand(
          parentStatus,
          toJJUri(vscode.Uri.file(parentStatus.path), {
            diffOriginalRev: parentChange.changeId,
          }),
          toJJUri(vscode.Uri.file(parentStatus.path), {
            rev: parentChange.changeId,
          }),
          `(${parentChange.changeId})`,
        ),
      }),
    );
  }

  return updatedGroups;
}

export function applyCustomViewRenderData(
  customViews: readonly CustomViewState[],
  sourceControl: vscode.SourceControl,
  customViewGroups: vscode.SourceControlResourceGroup[],
): vscode.SourceControlResourceGroup[] {
  const updatedGroups: vscode.SourceControlResourceGroup[] = [];

  for (let index = 0; index < customViews.length; index++) {
    const view = customViews[index];
    const id = `custom-view:${index}`;
    const label = `View: ${view.config.name}${view.error ? " (error)" : ""}`;
    const existingGroup = customViewGroups.find((group) => group.id === id);
    const group = existingGroup ?? sourceControl.createResourceGroup(id, label);

    group.label = label;
    group.hideWhenEmpty = false;
    group.resourceStates = view.fileStatuses.map((fileStatus) => {
      const beforePath = fileStatus.renamedFrom ?? fileStatus.file;
      const beforeUri = toJJUri(
        vscode.Uri.file(
          path.join(sourceControl.rootUri?.fsPath ?? "", beforePath),
        ),
        { rev: view.config.from },
      );
      const afterUri =
        view.config.to === "@"
          ? vscode.Uri.file(fileStatus.path)
          : toJJUri(vscode.Uri.file(fileStatus.path), {
              rev: view.config.to,
            });

      return {
        // Match the editor URI so SCM auto-reveal keeps the clicked row selected.
        resourceUri: fileStatus.type === "D" ? beforeUri : afterUri,
        contextValue: id,
        decorations: {
          strikeThrough: fileStatus.type === "D",
          tooltip: getFileStatusTooltip(fileStatus),
          // A file's aggregate status can differ from its working-copy status.
          light: { iconPath: getFileStatusIcon(fileStatus.type, "light") },
          dark: { iconPath: getFileStatusIcon(fileStatus.type, "dark") },
        },
        command: getResourceStateCommand(
          fileStatus,
          beforeUri,
          afterUri,
          `(${view.config.name})`,
        ),
      };
    });
    updatedGroups.push(group);
  }

  for (const group of customViewGroups) {
    if (!updatedGroups.includes(group)) {
      group.dispose();
    }
  }

  return updatedGroups;
}
