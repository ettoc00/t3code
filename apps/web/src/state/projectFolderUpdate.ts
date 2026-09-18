import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const pendingUpdates = new Map<string, Promise<void>>();
type StoredProjectFolderPreferenceHandoff = ProjectFolderPreferenceHandoff<unknown> & {
  readonly cancel: () => void;
};

const pendingPreferenceHandoffs = new Map<string, StoredProjectFolderPreferenceHandoff>();

function projectFolderUpdateKey(ref: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}): string {
  return JSON.stringify([ref.environmentId, ref.projectId]);
}

export interface ProjectFolderPreferenceHandoff<TPrevious> {
  readonly key: string;
  readonly id: symbol;
  readonly previous: TPrevious;
  readonly signal: AbortSignal;
}

/** Replace a delayed handoff while retaining the last project whose preferences were migrated. */
export function beginProjectFolderPreferenceHandoff<TPrevious>(
  ref: { environmentId: EnvironmentId; projectId: ProjectId },
  previous: TPrevious,
): ProjectFolderPreferenceHandoff<TPrevious> {
  const key = projectFolderUpdateKey(ref);
  const pending = pendingPreferenceHandoffs.get(key);
  const abortController = new AbortController();
  const handoff = {
    key,
    id: Symbol(key),
    previous: (pending?.previous as TPrevious | undefined) ?? previous,
    signal: abortController.signal,
    cancel: () => abortController.abort(),
  };
  pending?.cancel();
  pendingPreferenceHandoffs.set(key, handoff);
  return handoff;
}

/** Apply only the newest delayed handoff for a checkout. */
export async function applyProjectFolderPreferenceHandoff<TPrevious, TProject>(
  handoff: ProjectFolderPreferenceHandoff<TPrevious>,
  project: TProject,
  apply: (previous: TPrevious, project: TProject) => Promise<void>,
): Promise<boolean> {
  if (pendingPreferenceHandoffs.get(handoff.key)?.id !== handoff.id) return false;
  await apply(handoff.previous, project);
  if (pendingPreferenceHandoffs.get(handoff.key)?.id === handoff.id) {
    pendingPreferenceHandoffs.delete(handoff.key);
  }
  return true;
}

/** Keep a checkout's update and preference handoff together across palette replacements. */
export function serializeProjectFolderUpdate<T>(
  ref: { environmentId: EnvironmentId; projectId: ProjectId },
  update: () => Promise<T>,
): Promise<T> {
  const key = projectFolderUpdateKey(ref);
  const result = (pendingUpdates.get(key) ?? Promise.resolve()).then(update);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  pendingUpdates.set(key, settled);
  void settled.then(() => {
    if (pendingUpdates.get(key) === settled) pendingUpdates.delete(key);
  });
  return result;
}
