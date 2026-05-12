import type { SnapshotSource, TabSnapshot, WindowSnapshot } from "./types";

const SNAPSHOTS_KEY = "cleantab.snapshots";
const MAX_AUTO_SNAPSHOTS = 20;

export async function listSnapshots(): Promise<TabSnapshot[]> {
  const stored = await chrome.storage.local.get(SNAPSHOTS_KEY);
  const snapshots = stored[SNAPSHOTS_KEY];
  if (!Array.isArray(snapshots)) return [];
  return snapshots
    .filter(isSnapshot)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function createSnapshot(
  name: string,
  source: SnapshotSource,
  windows: WindowSnapshot[]
): Promise<TabSnapshot> {
  const snapshot: TabSnapshot = {
    id: crypto.randomUUID(),
    name: name.trim() || defaultSnapshotName(source),
    createdAt: Date.now(),
    source,
    windows
  };

  const current = await listSnapshots();
  const next = pruneSnapshots([snapshot, ...current]);
  await chrome.storage.local.set({ [SNAPSHOTS_KEY]: next });
  return snapshot;
}

export async function deleteSnapshot(id: string): Promise<void> {
  const next = (await listSnapshots()).filter((snapshot) => snapshot.id !== id);
  await chrome.storage.local.set({ [SNAPSHOTS_KEY]: next });
}

export function pruneSnapshots(snapshots: TabSnapshot[]): TabSnapshot[] {
  const manual = snapshots.filter((snapshot) => snapshot.source === "manual");
  const automatic = snapshots
    .filter((snapshot) => snapshot.source === "auto-before-close")
    .slice(0, MAX_AUTO_SNAPSHOTS);
  return [...manual, ...automatic].sort((a, b) => b.createdAt - a.createdAt);
}

function defaultSnapshotName(source: SnapshotSource): string {
  const date = new Date().toLocaleString();
  return source === "manual" ? `Workspace ${date}` : `Before cleanup ${date}`;
}

function isSnapshot(value: unknown): value is TabSnapshot {
  if (!value || typeof value !== "object") return false;
  const candidate = value as TabSnapshot;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.createdAt === "number" &&
    Array.isArray(candidate.windows) &&
    (candidate.source === "manual" || candidate.source === "auto-before-close")
  );
}
