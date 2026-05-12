import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArchiveRestore,
  CheckCircle2,
  Copy,
  Layers3,
  RefreshCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2
} from "lucide-react";
import { analyzeTabs } from "../lib/analyzeTabs";
import { closeSelectedTabsWithBackup } from "../lib/cleanup";
import {
  closeTabs,
  getCurrentTabs,
  getCurrentWindowSnapshots,
  restoreSnapshotTabs
} from "../lib/chromeTabs";
import { createSnapshot, deleteSnapshot, listSnapshots } from "../lib/snapshots";
import type {
  CleanupSuggestion,
  CleanupSuggestionType,
  TabAnalysis,
  TabCluster,
  TabInfo,
  TabSnapshot
} from "../lib/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { AlertDialog } from "./components/ui/dialog";

interface PendingRestore {
  snapshot: TabSnapshot;
  target: "new-window" | "current-window";
}

export function App() {
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [snapshots, setSnapshots] = useState<TabSnapshot[]>([]);
  const [selectedTabIds, setSelectedTabIds] = useState<Set<number>>(new Set());
  const [snapshotName, setSnapshotName] = useState("");
  const [pendingClose, setPendingClose] = useState(false);
  const [pendingRestore, setPendingRestore] = useState<PendingRestore | null>(null);
  const [status, setStatus] = useState("Loading...");
  const [error, setError] = useState<string | null>(null);

  const hasChromeApi = Boolean(globalThis.chrome?.tabs && globalThis.chrome?.storage);
  const analysis = useMemo<TabAnalysis>(() => analyzeTabs(tabs), [tabs]);
  const selectedCount = selectedTabIds.size;

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    if (!hasChromeApi) {
      setStatus("Load dist/ as a Chrome extension.");
      setTabs([]);
      setSnapshots([]);
      return;
    }

    try {
      setError(null);
      const [currentTabs, currentSnapshots] = await Promise.all([
        getCurrentTabs(),
        listSnapshots()
      ]);
      setTabs(currentTabs);
      setSnapshots(currentSnapshots);
      setSelectedTabIds(new Set());
      setStatus("Ready");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to read tabs.");
      setStatus("Blocked");
    }
  }

  async function saveManualSnapshot() {
    try {
      const windows = await getCurrentWindowSnapshots();
      const snapshot = await createSnapshot(snapshotName, "manual", windows);
      setSnapshotName("");
      setSnapshots(await listSnapshots());
      setStatus(`Saved ${snapshot.name}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save snapshot.");
    }
  }

  async function confirmCloseSelected() {
    if (selectedTabIds.size === 0) return;

    try {
      await closeSelectedTabsWithBackup({
        tabIds: Array.from(selectedTabIds),
        getWindows: getCurrentWindowSnapshots,
        saveSnapshot: createSnapshot,
        closeTabs
      });
      setPendingClose(false);
      setStatus(`Closed ${selectedTabIds.size} tabs`);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to close selected tabs.");
      setPendingClose(false);
    }
  }

  async function confirmRestore() {
    if (!pendingRestore) return;

    try {
      await restoreSnapshotTabs(pendingRestore.snapshot.windows, pendingRestore.target);
      setStatus(`Restored ${pendingRestore.snapshot.name}`);
      setPendingRestore(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to restore snapshot.");
    }
  }

  function toggleTab(tabId: number, checked: boolean) {
    setSelectedTabIds((current) => {
      const next = new Set(current);
      if (checked) next.add(tabId);
      else next.delete(tabId);
      return next;
    });
  }

  function toggleTabs(tabIds: number[], checked: boolean) {
    setSelectedTabIds((current) => {
      const next = new Set(current);
      for (const tabId of tabIds) {
        if (checked) next.add(tabId);
        else next.delete(tabId);
      }
      return next;
    });
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <ShieldCheck aria-hidden="true" />
          <div>
            <h1>CleanTab</h1>
            <p>{status}</p>
          </div>
        </div>
        <Button aria-label="Refresh tabs" size="icon" variant="ghost" onClick={refresh}>
          <RefreshCcw data-icon="inline-start" />
        </Button>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="summary">
        <Stat label="tabs" value={analysis.stats.totalTabs} />
        <Stat label="windows" value={analysis.stats.totalWindows} />
        <Stat label="dupes" value={analysis.stats.duplicateTabs} />
        <Stat label="largest" value={analysis.stats.largestClusterSize} />
      </section>

      <section className="snapshot-bar">
        <input
          aria-label="Snapshot name"
          disabled={!hasChromeApi}
          placeholder="Snapshot name"
          value={snapshotName}
          onChange={(event) => setSnapshotName(event.target.value)}
        />
        <Button disabled={!hasChromeApi} onClick={saveManualSnapshot}>
          <Save data-icon="inline-start" />
          Snapshot
        </Button>
      </section>

      <SuggestionList
        suggestions={analysis.suggestions}
        tabs={tabs}
        selectedTabIds={selectedTabIds}
        onToggleSuggestion={toggleTabs}
        onToggleTab={toggleTab}
      />

      <GroupList
        analysis={analysis}
        selectedTabIds={selectedTabIds}
        tabs={tabs}
        onToggleGroup={toggleTabs}
        onToggleTab={toggleTab}
      />

      <SnapshotList
        snapshots={snapshots}
        onDelete={async (id) => {
          await deleteSnapshot(id);
          setSnapshots(await listSnapshots());
        }}
        onRestore={(snapshot, target) => setPendingRestore({ snapshot, target })}
      />

      <div className="action-bar">
        <span>
          <strong>{selectedCount}</strong> selected
        </span>
        <Button disabled={selectedCount === 0 || !hasChromeApi} variant="destructive" onClick={() => setPendingClose(true)}>
          <Trash2 data-icon="inline-start" />
          Close
        </Button>
      </div>

      <AlertDialog
        destructive
        confirmLabel={`Back up and close ${selectedCount}`}
        description="CleanTab will save an automatic restore snapshot first, then close only the selected tabs."
        open={pendingClose}
        title="Close selected tabs?"
        onCancel={() => setPendingClose(false)}
        onConfirm={confirmCloseSelected}
      />

      <AlertDialog
        confirmLabel="Restore"
        description={
          pendingRestore
            ? `Open ${countSnapshotTabs(pendingRestore.snapshot)} saved tabs.`
            : ""
        }
        open={Boolean(pendingRestore)}
        title="Restore snapshot?"
        onCancel={() => setPendingRestore(null)}
        onConfirm={confirmRestore}
      />
    </main>
  );
}

function SuggestionList({
  suggestions,
  tabs,
  selectedTabIds,
  onToggleSuggestion,
  onToggleTab
}: {
  suggestions: CleanupSuggestion[];
  tabs: TabInfo[];
  selectedTabIds: Set<number>;
  onToggleSuggestion: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
}) {
  const buckets = buildSuggestionBuckets(suggestions);
  const duplicateBucket = buckets.find((bucket) => bucket.type === "duplicate");

  return (
    <section className="section priority-section">
      <div className="section-heading">
        <div>
          <h2>Quick clean</h2>
          <small>{duplicateBucket ? "Duplicates are the safest place to start." : "Inspect before selecting."}</small>
        </div>
        {duplicateBucket ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => onToggleSuggestion(duplicateBucket.tabIds, true)}
          >
            Select duplicates
          </Button>
        ) : (
          <Badge variant="secondary">0</Badge>
        )}
      </div>
      {buckets.length === 0 ? (
        <EmptyState
          icon={<CheckCircle2 aria-hidden="true" />}
          title="Nothing obvious"
          description="Review big piles below."
        />
      ) : (
        <div className="suggestion-list">
          {buckets.map((bucket) => {
            const allSelected = bucket.tabIds.every((id) => selectedTabIds.has(id));
            return (
              <details className="suggestion-bucket" key={bucket.type}>
                <summary>
                <Checkbox
                  checked={allSelected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onToggleSuggestion(bucket.tabIds, event.target.checked)}
                />
                  <SuggestionIcon type={bucket.type} />
                <span className="suggestion-copy">
                    <strong>{bucket.title}</strong>
                    <small>{bucket.reason}</small>
                </span>
                  <Badge variant={bucket.type === "duplicate" ? "secondary" : "outline"}>
                    {bucket.type === "duplicate" ? "safe-ish" : `${bucket.tabIds.length} tabs`}
                  </Badge>
                </summary>
                <div className="bucket-detail actionable-detail">
                  <p>{bucketDetailCopy(bucket.type)}</p>
                  {bucket.type === "duplicate" ? (
                    <div className="micro-list">
                      {bucket.items.slice(0, 4).map((suggestion) => (
                        <span key={suggestion.id}>
                          {suggestion.title} · {suggestion.tabIds.length} closable
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="tab-list compact-tab-list">
                      {tabsForBucket(bucket, tabs).slice(0, 6).map((tab) => (
                        <TabRow
                          checked={selectedTabIds.has(tab.id)}
                          key={tab.id}
                          tab={tab}
                          onCheckedChange={(checked) => onToggleTab(tab.id, checked)}
                        />
                      ))}
                      {bucket.tabIds.length > 6 ? (
                        <small>{bucket.tabIds.length - 6} more hidden. Select individual tabs after reviewing.</small>
                      ) : null}
                    </div>
                  )}
                  {bucket.type !== "duplicate" ? (
                    <Button size="sm" variant="outline" onClick={() => onToggleSuggestion(bucket.tabIds, true)}>
                      Select all {bucket.tabIds.length}
                    </Button>
                  ) : null}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}

function GroupList({
  analysis,
  selectedTabIds,
  tabs,
  onToggleGroup,
  onToggleTab
}: {
  analysis: TabAnalysis;
  selectedTabIds: Set<number>;
  tabs: TabInfo[];
  onToggleGroup: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
}) {
  const bigGroups = analysis.clusters.filter((cluster) => cluster.tabIds.length >= 3);
  const visibleGroups = bigGroups.slice(0, 6);
  const hiddenGroups = bigGroups.slice(6);

  return (
    <section className="section">
      <div className="section-heading">
        <div>
          <h2>Big piles</h2>
          <small>Review these, don&apos;t blindly close them.</small>
        </div>
        <Badge variant="secondary">{bigGroups.length}</Badge>
      </div>
      {bigGroups.length === 0 ? (
        <EmptyState
          icon={<Layers3 aria-hidden="true" />}
          title="No big piles"
          description="Smaller groups are hidden by default."
        />
      ) : (
        <div className="group-list">
          {visibleGroups.map((cluster) => (
            <GroupRow
              cluster={cluster}
              key={cluster.id}
              selectedTabIds={selectedTabIds}
              tabs={tabs}
              onToggleGroup={onToggleGroup}
              onToggleTab={onToggleTab}
            />
          ))}
          {hiddenGroups.length > 0 ? (
            <details className="more-groups">
              <summary>
                <span>
                  <strong>{hiddenGroups.length} smaller piles</strong>
                  <small>Collapsed to keep the cleanup view readable.</small>
                </span>
                  <Badge variant="outline">{hiddenGroups.reduce((sum, group) => sum + group.tabIds.length, 0)} tabs</Badge>
              </summary>
              <div className="group-list nested-groups">
                {hiddenGroups.map((cluster) => (
                  <GroupRow
                    cluster={cluster}
                    key={cluster.id}
                    selectedTabIds={selectedTabIds}
                    tabs={tabs}
                    onToggleGroup={onToggleGroup}
                    onToggleTab={onToggleTab}
                  />
                ))}
              </div>
            </details>
          ) : null}
        </div>
      )}
    </section>
  );
}

function GroupRow({
  cluster,
  selectedTabIds,
  tabs,
  onToggleGroup,
  onToggleTab
}: {
  cluster: TabCluster;
  selectedTabIds: Set<number>;
  tabs: TabInfo[];
  onToggleGroup: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
}) {
            const clusterTabs = tabs.filter((tab) => cluster.tabIds.includes(tab.id));
            const allSelected = cluster.tabIds.every((id) => selectedTabIds.has(id));
            return (
              <details className="group" key={cluster.id}>
                <summary>
                  <Checkbox
                    checked={allSelected}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => onToggleGroup(cluster.tabIds, event.target.checked)}
                  />
                  <span>
                    <strong>{cluster.label}</strong>
                    <small>{cluster.tabIds.length} tabs · same-site pile</small>
                  </span>
                  <Badge variant="outline">{cluster.tabIds.length} tabs</Badge>
                </summary>
                <div className="tab-list">
                  {clusterTabs.map((tab) => (
                    <TabRow
                      checked={selectedTabIds.has(tab.id)}
                      key={tab.id}
                      tab={tab}
                      onCheckedChange={(checked) => onToggleTab(tab.id, checked)}
                    />
                  ))}
                </div>
              </details>
            );
}

function SnapshotList({
  snapshots,
  onDelete,
  onRestore
}: {
  snapshots: TabSnapshot[];
  onDelete: (id: string) => void;
  onRestore: (snapshot: TabSnapshot, target: "new-window" | "current-window") => void;
}) {
  return (
    <section className="section compact-section">
      <details>
        <summary className="section-heading snapshots-heading">
          <h2>Snapshots</h2>
          <Badge variant="secondary">{snapshots.length}</Badge>
        </summary>
        {snapshots.length === 0 ? (
          <EmptyState
            icon={<ArchiveRestore aria-hidden="true" />}
            title="No snapshots"
            description="Take one before cleaning."
          />
        ) : (
          <div className="snapshot-list">
            {snapshots.map((snapshot) => (
              <div className="snapshot" key={snapshot.id}>
                <span>
                  <strong>{snapshot.name}</strong>
                  <small>{countSnapshotTabs(snapshot)} tabs · {new Date(snapshot.createdAt).toLocaleString()}</small>
                </span>
                <div className="snapshot-actions">
                  <Button size="sm" variant="outline" onClick={() => onRestore(snapshot, "new-window")}>
                    New
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onRestore(snapshot, "current-window")}>
                    Current
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(snapshot.id)}>
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </details>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function TabRow({
  checked,
  tab,
  onCheckedChange
}: {
  checked: boolean;
  tab: TabInfo;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="tab-row">
      <Checkbox checked={checked} onChange={(event) => onCheckedChange(event.target.checked)} />
      <span className="favicon" aria-hidden="true">
        {tab.favIconUrl ? <img alt="" src={tab.favIconUrl} /> : <Sparkles />}
      </span>
      <span className="tab-copy">
        <strong>{tab.title}</strong>
        <small>{tab.url}</small>
      </span>
      {tab.pinned ? <Badge variant="outline">Pinned</Badge> : null}
    </label>
  );
}

function SuggestionIcon({ type }: { type: CleanupSuggestion["type"] }) {
  if (type === "duplicate") return <Copy aria-hidden="true" />;
  if (type === "same-domain-pile") return <Layers3 aria-hidden="true" />;
  if (type === "likely-reference") return <ArchiveRestore aria-hidden="true" />;
  return <Trash2 aria-hidden="true" />;
}

interface SuggestionBucket {
  type: CleanupSuggestionType;
  title: string;
  reason: string;
  tabIds: number[];
  items: CleanupSuggestion[];
}

function buildSuggestionBuckets(suggestions: CleanupSuggestion[]): SuggestionBucket[] {
  const order: CleanupSuggestionType[] = [
    "duplicate",
    "stale",
    "same-domain-pile",
    "likely-reference"
  ];

  return order
    .map((type) => {
      const items = suggestions.filter((suggestion) => suggestion.type === type);
      const tabIds = Array.from(new Set(items.flatMap((suggestion) => suggestion.tabIds)));
      return {
        type,
        title: bucketTitle(type, tabIds.length),
        reason: bucketReason(type),
        tabIds,
        items
      };
    })
    .filter((bucket) => bucket.tabIds.length > 0);
}

function bucketTitle(type: CleanupSuggestionType, count: number): string {
  if (type === "duplicate") return `${count} duplicate tabs`;
  if (type === "stale") return `${count} stale tabs`;
  if (type === "same-domain-pile") return `${count} tabs in large piles`;
  return `${count} reference tabs`;
}

function bucketReason(type: CleanupSuggestionType): string {
  if (type === "duplicate") return "Same URLs. Usually safest to close.";
  if (type === "stale") return "Old inactive tabs. Inspect before closing.";
  if (type === "same-domain-pile") return "Large same-site clusters. Pick what to keep.";
  return "Docs/code/Q&A. Good snapshot candidates.";
}

function sumBucketTabs(buckets: SuggestionBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.tabIds.length, 0);
}

function bucketDetailCopy(type: CleanupSuggestionType): string {
  if (type === "duplicate") {
    return "CleanTab keeps one copy and selects the extra duplicates.";
  }
  if (type === "stale") {
    return "Stale only means not recently focused. Check the examples before selecting all.";
  }
  if (type === "same-domain-pile") {
    return "These are concentration warnings, not close recommendations.";
  }
  return "Reference tabs are often important. Snapshot first, then choose manually.";
}

function tabsForBucket(bucket: SuggestionBucket, tabs: TabInfo[]): TabInfo[] {
  const ids = new Set(bucket.tabIds);
  return tabs.filter((tab) => ids.has(tab.id));
}

function EmptyState({
  description,
  icon,
  title
}: {
  description: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <small>{description}</small>
    </div>
  );
}

function countSnapshotTabs(snapshot: TabSnapshot): number {
  return snapshot.windows.reduce((count, window) => count + window.tabs.length, 0);
}
