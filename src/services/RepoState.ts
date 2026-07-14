import { Context, Effect, Ref } from "effect";
import path from "path";
import type {
  FileStatus,
  RepositoryConfig,
  RepositoryStatus,
  Show,
  JJCliError,
  JJImmutableError,
  RepositoryDataError,
  CustomViewState,
  CustomViewConfig,
} from "../types";
import { JJCli } from "./JJCli";
import type { ExtensionResources } from "./ExtensionResources";
import type { JjWatchmanRegisterSnapshotTriggerRef } from "./JjWatchmanSnapshotTriggerRef";
import type { Vscode } from "./Vscode";
import {
  getLatestOperationId,
  getStatus,
  getFileList,
  getShow,
  getCustomViewFileStatuses,
} from "./Repository";
import { getFolderConfigurationValue } from "./Vscode";

export interface RepoState {
  operationId: string | undefined;
  status: RepositoryStatus | undefined;
  fileStatusesByChange: Map<string, FileStatus[]>;
  conflictedFilesByChange: Map<string, Set<string>>;
  trackedFiles: Set<string>;
  parentShowResults: Map<string, Show>;
  customViews: CustomViewState[];
}

export class RepoStateRef extends Context.Tag("RepoStateRef")<
  RepoStateRef,
  Ref.Ref<RepoState>
>() {}

export const emptyRepoState: RepoState = {
  operationId: undefined,
  status: undefined,
  fileStatusesByChange: new Map(),
  conflictedFilesByChange: new Map(),
  trackedFiles: new Set(),
  parentShowResults: new Map(),
  customViews: [],
};

export function computeNewState(
  operationId: string,
  status: RepositoryStatus,
  trackedFilesList: string[],
  parentShowResults: { changeId: string; show: Show }[],
  customViews: CustomViewState[],
  repositoryRoot: string,
): RepoState {
  const newTrackedFiles = new Set<string>();
  const newParentShowResultsMap = new Map<string, Show>();
  const newFileStatusesByChange = new Map<string, FileStatus[]>([
    ["@", status.fileStatuses],
  ]);
  const newConflictedFilesByChange = new Map<string, Set<string>>([
    ["@", status.conflictedFiles],
  ]);

  for (const t of trackedFilesList) {
    const pathParts = t.split(path.sep);
    let currentPath = repositoryRoot + path.sep;
    for (const p of pathParts) {
      currentPath += p;
      newTrackedFiles.add(currentPath);
      currentPath += path.sep;
    }
  }

  for (const { changeId, show } of parentShowResults) {
    newParentShowResultsMap.set(changeId, show);
    newFileStatusesByChange.set(changeId, show.fileStatuses);
    newConflictedFilesByChange.set(changeId, show.conflictedFiles);
  }

  return {
    operationId,
    status,
    fileStatusesByChange: newFileStatusesByChange,
    conflictedFilesByChange: newConflictedFilesByChange,
    trackedFiles: newTrackedFiles,
    parentShowResults: newParentShowResultsMap,
    customViews,
  };
}

const getCustomViewConfigs = (
  repositoryRoot: string,
): Effect.Effect<CustomViewConfig[], never, Vscode> =>
  Effect.map(
    getFolderConfigurationValue<unknown>("jjk", "customViews", repositoryRoot),
    (configured) => {
      const views: unknown[] = Array.isArray(configured) ? configured : [];
      return views
        .filter(
          (view): view is { name: string; from: string; to?: string } =>
            typeof view === "object" &&
            view !== null &&
            "name" in view &&
            "from" in view &&
            typeof view.name === "string" &&
            view.name.trim() !== "" &&
            typeof view.from === "string" &&
            view.from.trim() !== "" &&
            (!("to" in view) ||
              view.to === undefined ||
              typeof view.to === "string"),
        )
        .map((view) => ({
          name: view.name.trim(),
          from: view.from.trim(),
          to: view.to?.trim() || "@",
        }));
    },
  );

const customViewConfigsEqual = (
  current: readonly CustomViewState[],
  configured: readonly CustomViewConfig[],
): boolean =>
  current.length === configured.length &&
  current.every((view, index) => {
    const other = configured[index];
    return (
      other !== undefined &&
      view.config.name === other.name &&
      view.config.from === other.from &&
      view.config.to === other.to
    );
  });

export const checkForUpdates = (
  config: RepositoryConfig,
): Effect.Effect<
  RepoState | null,
  JJCliError | JJImmutableError | RepositoryDataError,
  | JJCli
  | RepoStateRef
  | Vscode
  | ExtensionResources
  | JjWatchmanRegisterSnapshotTriggerRef
> =>
  Effect.gen(function* () {
    const stateRef = yield* RepoStateRef;
    const customViewConfigs = yield* getCustomViewConfigs(
      config.repositoryRoot,
    );
    const latestOpId = yield* getLatestOperationId(config);
    const current = yield* Ref.get(stateRef);
    if (
      current.operationId === latestOpId &&
      customViewConfigsEqual(current.customViews, customViewConfigs)
    ) {
      return null;
    }

    const status = yield* getStatus(config);
    const fileList = yield* getFileList(config);
    const parentShows = yield* Effect.all(
      status.parentChanges.map((p) =>
        getShow(config, p.changeId).pipe(
          Effect.map((show) => ({ changeId: p.changeId, show })),
        ),
      ),
      { concurrency: "unbounded" },
    );
    const customViews = yield* Effect.all(
      customViewConfigs.map((view) =>
        Effect.either(getCustomViewFileStatuses(config, view)).pipe(
          Effect.map(
            (result): CustomViewState =>
              result._tag === "Right"
                ? { config: view, fileStatuses: result.right }
                : {
                    config: view,
                    fileStatuses: [],
                    error: result.left.message,
                  },
          ),
        ),
      ),
      { concurrency: "unbounded" },
    );

    const newState = computeNewState(
      latestOpId,
      status,
      fileList,
      parentShows,
      customViews,
      config.repositoryRoot,
    );
    yield* Ref.set(stateRef, newState);
    return newState;
  });
