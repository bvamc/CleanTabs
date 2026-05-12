import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArchiveRestore,
  ChevronDown,
  CheckCircle2,
  Copy,
  ExternalLink,
  Layers3,
  Moon,
  RefreshCcw,
  Save,
  ShieldCheck,
  Sun,
  Sparkles,
  Trash2
} from "lucide-react";
import { analyzeTabs } from "../lib/analyzeTabs";
import { closeSelectedTabsWithBackup } from "../lib/cleanup";
import {
  closeTabs,
  focusTab,
  getCurrentTabs,
  getCurrentWindowSnapshots,
  groupTabSetsInNewWindow,
  groupTabs,
  restoreSnapshotTabs,
  type TabGroupingMode
} from "../lib/chromeTabs";
import { createSnapshot, deleteSnapshot, listSnapshots } from "../lib/snapshots";
import { cn } from "../lib/utils";
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

type ActionKind = "duplicates" | "stale" | "piles";
type Theme = "light" | "dark";

const BATCH_GROUPING_ID = "__selected_clusters__";

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
  const [activeAction, setActiveAction] = useState<ActionKind>("duplicates");
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());
  const [groupingMode, setGroupingMode] = useState<TabGroupingMode>(() => readInitialGroupingMode());
  const [groupingClusterId, setGroupingClusterId] = useState<string | null>(null);

  const hasChromeApi = Boolean(globalThis.chrome?.tabs && globalThis.chrome?.storage);
  const analysis = useMemo<TabAnalysis>(() => analyzeTabs(tabs), [tabs]);
  const buckets = useMemo(() => buildSuggestionBuckets(analysis.suggestions), [analysis.suggestions]);
  const selectedCount = selectedTabIds.size;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cleantab.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("cleantab.groupingMode", groupingMode);
  }, [groupingMode]);

  useEffect(() => {
    const preferredAction = getPreferredAction(analysis, buckets);
    if (getActionCount(activeAction, analysis, buckets) === 0 && preferredAction !== activeAction) {
      setActiveAction(preferredAction);
    }
  }, [activeAction, analysis, buckets]);

  async function refresh() {
    if (!hasChromeApi) {
      setStatus("Load dist/ as a Chrome extension tab.");
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
    const closingCount = selectedTabIds.size;

    try {
      await closeSelectedTabsWithBackup({
        tabIds: Array.from(selectedTabIds),
        getWindows: getCurrentWindowSnapshots,
        saveSnapshot: createSnapshot,
        closeTabs
      });
      setPendingClose(false);
      await refresh();
      setStatus(`Closed ${closingCount} tabs`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to close selected tabs.");
      setPendingClose(false);
    }
  }

  async function closeTabIdsNow(tabIds: number[], label: string) {
    if (tabIds.length === 0) return;

    try {
      await closeSelectedTabsWithBackup({
        tabIds,
        getWindows: getCurrentWindowSnapshots,
        saveSnapshot: createSnapshot,
        closeTabs
      });
      await refresh();
      setStatus(`${label}: closed ${tabIds.length}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Unable to close ${label}.`);
    }
  }

  async function groupCluster(cluster: TabCluster) {
    try {
      setGroupingClusterId(cluster.id);
      const groupIds = await groupTabs(cleanGroupTitle(cluster.label), cluster.tabIds, tabs, groupingMode);
      const message =
        groupingMode === "new-window"
          ? `Grouped ${cluster.tabIds.length} tabs into one reusable window.`
          : `Grouped ${cluster.tabIds.length} tabs into ${groupIds.length} Chrome tab group${groupIds.length === 1 ? "" : "s"}.`;
      await refresh();
      setStatus(message);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to group tabs.");
    } finally {
      setGroupingClusterId(null);
    }
  }

  async function groupClustersInOneWindow(clusters: TabCluster[]) {
    if (clusters.length === 0) return;

    try {
      setGroupingClusterId(BATCH_GROUPING_ID);
      const groupIds = await groupTabSetsInNewWindow(
        clusters.map((cluster) => ({
          title: cleanGroupTitle(cluster.label),
          tabIds: cluster.tabIds
        })),
        tabs
      );
      const tabCount = clusters.reduce((sum, cluster) => sum + cluster.tabIds.length, 0);
      await refresh();
      setStatus(`Grouped ${tabCount} tabs from ${groupIds.length} piles into one window.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to group selected piles.");
    } finally {
      setGroupingClusterId(null);
    }
  }

  async function openTab(tab: TabInfo) {
    try {
      await focusTab(tab.id, tab.windowId);
      setStatus(`Opened ${tab.title}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to open tab.");
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
        <div className="topbar-actions">
          <Button
            aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            size="icon"
            variant="ghost"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          >
            {theme === "dark" ? <Sun data-icon="inline-start" /> : <Moon data-icon="inline-start" />}
          </Button>
          <Button aria-label="Refresh tabs" size="icon" variant="ghost" onClick={refresh}>
            <RefreshCcw data-icon="inline-start" />
          </Button>
        </div>
      </header>

      {error ? <div className="error-banner">{error}</div> : null}

      <section className="dashboard-hero">
        <div className="hero-copy">
          <Badge variant="secondary">Local-only</Badge>
          <h2>{analysis.stats.totalTabs} tabs across {analysis.stats.totalWindows} windows</h2>
          <p>Pick one cleanup move. CleanTab saves a restore point before closing anything.</p>
        </div>
        <div className="hero-stats">
          <Stat label="dupes" value={analysis.stats.duplicateTabs} />
          <Stat label="stale" value={analysis.stats.staleTabs} />
          <Stat label="largest pile" value={analysis.stats.largestClusterSize} />
        </div>
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

      <DecisionDashboard
        activeAction={activeAction}
        analysis={analysis}
        buckets={buckets}
        groupingClusterId={groupingClusterId}
        groupingMode={groupingMode}
        tabs={tabs}
        selectedTabIds={selectedTabIds}
        onActionChange={setActiveAction}
        onCloseTabsNow={closeTabIdsNow}
        onGroupCluster={groupCluster}
        onGroupClustersInOneWindow={groupClustersInOneWindow}
        onGroupingModeChange={setGroupingMode}
        onOpenTab={openTab}
        onToggleGroup={toggleTabs}
        onToggleTab={toggleTab}
        onToggleTabs={toggleTabs}
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

function DecisionDashboard({
  activeAction,
  analysis,
  buckets,
  groupingClusterId,
  groupingMode,
  tabs,
  selectedTabIds,
  onActionChange,
  onCloseTabsNow,
  onGroupCluster,
  onGroupClustersInOneWindow,
  onGroupingModeChange,
  onOpenTab,
  onToggleGroup,
  onToggleTab,
  onToggleTabs
}: {
  activeAction: ActionKind;
  analysis: TabAnalysis;
  buckets: SuggestionBucket[];
  groupingClusterId: string | null;
  groupingMode: TabGroupingMode;
  tabs: TabInfo[];
  selectedTabIds: Set<number>;
  onActionChange: (action: ActionKind) => void;
  onCloseTabsNow: (tabIds: number[], label: string) => void;
  onGroupCluster: (cluster: TabCluster) => void;
  onGroupClustersInOneWindow: (clusters: TabCluster[]) => void;
  onGroupingModeChange: (mode: TabGroupingMode) => void;
  onOpenTab: (tab: TabInfo) => void;
  onToggleGroup: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
  onToggleTabs: (tabIds: number[], checked: boolean) => void;
}) {
  const duplicateBucket = buckets.find((bucket) => bucket.type === "duplicate");
  const staleBucket = buckets.find((bucket) => bucket.type === "stale");
  const bigGroups = analysis.clusters.filter((cluster) => cluster.tabIds.length >= 3);
  const pilesTabCount = bigGroups.reduce((sum, group) => sum + group.tabIds.length, 0);

  return (
    <section className="decision-shell">
      <div className="action-grid">
        <ActionCard
          active={activeAction === "duplicates"}
          badge={duplicateBucket ? "safe-ish" : "clear"}
          count={duplicateBucket?.tabIds.length ?? 0}
          description={duplicateBucket ? "Same URLs. Keep one copy." : "No duplicate tabs found."}
          icon={<Copy aria-hidden="true" />}
          title="Close duplicates"
          onClick={() => onActionChange("duplicates")}
        />
        <ActionCard
          active={activeAction === "stale"}
          badge="inspect"
          count={staleBucket?.tabIds.length ?? 0}
          description={staleBucket ? "Old inactive tabs. Review first." : "No stale tabs found."}
          icon={<Trash2 aria-hidden="true" />}
          title="Review stale"
          onClick={() => onActionChange("stale")}
        />
        <ActionCard
          active={activeAction === "piles"}
          badge="organize"
          count={pilesTabCount}
          description={bigGroups.length ? "Large same-site clusters." : "No large piles found."}
          icon={<Layers3 aria-hidden="true" />}
          title="Tame big piles"
          onClick={() => onActionChange("piles")}
        />
      </div>

      <section className="focus-panel">
        {activeAction === "duplicates" ? (
          <DuplicateAction bucket={duplicateBucket} onCloseTabsNow={onCloseTabsNow} />
        ) : null}
        {activeAction === "stale" ? (
          <StaleAction
            bucket={staleBucket}
            selectedTabIds={selectedTabIds}
            tabs={tabs}
            onOpenTab={onOpenTab}
            onToggleTab={onToggleTab}
            onToggleTabs={onToggleTabs}
          />
        ) : null}
        {activeAction === "piles" ? (
          <PilesAction
            analysis={analysis}
            groupingClusterId={groupingClusterId}
            groupingMode={groupingMode}
            selectedTabIds={selectedTabIds}
            tabs={tabs}
            onGroupCluster={onGroupCluster}
            onGroupClustersInOneWindow={onGroupClustersInOneWindow}
            onGroupingModeChange={onGroupingModeChange}
            onOpenTab={onOpenTab}
            onToggleGroup={onToggleGroup}
            onToggleTab={onToggleTab}
          />
        ) : null}
      </section>
    </section>
  );
}

function ActionCard({
  active,
  badge,
  count,
  description,
  icon,
  title,
  onClick
}: {
  active: boolean;
  badge: string;
  count: number;
  description: string;
  icon: ReactNode;
  title: string;
  onClick: () => void;
}) {
  return (
    <button className={`action-card ${active ? "action-card-active" : ""}`} onClick={onClick}>
      <span className="action-icon">{icon}</span>
      <span className="action-copy">
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <span className="action-meta">
        <Badge variant={active ? "secondary" : "outline"}>{badge}</Badge>
        <strong>{count}</strong>
      </span>
    </button>
  );
}

function DuplicateAction({
  bucket,
  onCloseTabsNow
}: {
  bucket?: SuggestionBucket;
  onCloseTabsNow: (tabIds: number[], label: string) => void;
}) {
  if (!bucket) {
    return (
      <EmptyState
        icon={<CheckCircle2 aria-hidden="true" />}
        title="No duplicate tabs"
        description="The safest cleanup pass is already done."
      />
    );
  }

  return (
    <div className="focus-content">
      <div className="focus-heading">
        <div>
          <h2>Close duplicate tabs</h2>
          <p>One click backs up the session, keeps one copy of each URL, and closes the extras.</p>
        </div>
        <Button onClick={() => onCloseTabsNow(bucket.tabIds, "Duplicates")}>
          Close {bucket.tabIds.length}
        </Button>
      </div>
      <div className="micro-list">
        {bucket.items.map((suggestion) => (
          <span key={suggestion.id}>{suggestion.title} · {suggestion.tabIds.length} closable</span>
        ))}
      </div>
    </div>
  );
}

function StaleAction({
  bucket,
  selectedTabIds,
  tabs,
  onOpenTab,
  onToggleTab,
  onToggleTabs
}: {
  bucket?: SuggestionBucket;
  selectedTabIds: Set<number>;
  tabs: TabInfo[];
  onOpenTab: (tab: TabInfo) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
  onToggleTabs: (tabIds: number[], checked: boolean) => void;
}) {
  if (!bucket) {
    return (
      <EmptyState
        icon={<CheckCircle2 aria-hidden="true" />}
        title="No stale tabs"
        description="Nothing old and inactive is asking for review."
      />
    );
  }

  const staleTabs = tabsForBucket(bucket, tabs);

  return (
    <div className="focus-content">
      <div className="focus-heading">
        <div>
          <h2>Review stale tabs</h2>
          <p>Stale only means not recently focused. Choose individual tabs or select all after scanning.</p>
        </div>
        <Button variant="outline" onClick={() => onToggleTabs(bucket.tabIds, true)}>
          Select all {bucket.tabIds.length}
        </Button>
      </div>
      <div className="tab-list compact-tab-list">
        {staleTabs.map((tab) => (
          <TabRow
            checked={selectedTabIds.has(tab.id)}
            key={tab.id}
            tab={tab}
            onOpenTab={onOpenTab}
            onCheckedChange={(checked) => onToggleTab(tab.id, checked)}
          />
        ))}
      </div>
    </div>
  );
}

function PilesAction({
  analysis,
  groupingClusterId,
  groupingMode,
  selectedTabIds,
  tabs,
  onGroupCluster,
  onGroupClustersInOneWindow,
  onGroupingModeChange,
  onOpenTab,
  onToggleGroup,
  onToggleTab
}: {
  analysis: TabAnalysis;
  groupingClusterId: string | null;
  groupingMode: TabGroupingMode;
  selectedTabIds: Set<number>;
  tabs: TabInfo[];
  onGroupCluster: (cluster: TabCluster) => void;
  onGroupClustersInOneWindow: (clusters: TabCluster[]) => void;
  onGroupingModeChange: (mode: TabGroupingMode) => void;
  onOpenTab: (tab: TabInfo) => void;
  onToggleGroup: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
}) {
  const bigGroups = analysis.clusters.filter((cluster) => cluster.tabIds.length >= 3);
  const selectedClusters = bigGroups.filter((cluster) =>
    cluster.tabIds.every((id) => selectedTabIds.has(id))
  );
  const batchTargetClusters = selectedClusters.length > 0 ? selectedClusters : bigGroups;
  const isBatchGrouping = groupingClusterId === BATCH_GROUPING_ID;

  if (bigGroups.length === 0) {
    return (
      <EmptyState
        icon={<Layers3 aria-hidden="true" />}
        title="No big piles"
        description="There are no same-site clusters large enough to organize."
      />
    );
  }

  return (
    <div className="focus-content">
      <div className="focus-heading">
        <div>
          <h2>Tame big piles</h2>
          <p>Rows show existing Chrome groups. One-window mode reuses the largest group it finds.</p>
        </div>
        <div className="heading-actions">
          <Button
            disabled={groupingClusterId !== null}
            onClick={() => onGroupClustersInOneWindow(batchTargetClusters)}
          >
            {selectedClusters.length > 0
              ? `Group ${selectedClusters.length} selected in one window`
              : "Group all in one window"}
          </Button>
          <div className="grouping-mode" aria-label="Tab grouping destination">
            <Button
              size="sm"
              variant={groupingMode === "in-place" ? "default" : "ghost"}
              onClick={() => onGroupingModeChange("in-place")}
            >
              Keep windows
            </Button>
            <Button
              size="sm"
              variant={groupingMode === "new-window" ? "default" : "ghost"}
              onClick={() => onGroupingModeChange("new-window")}
            >
              One window
            </Button>
          </div>
          <Badge variant="secondary">{bigGroups.length} piles</Badge>
        </div>
      </div>
      <div className="group-list">
        {bigGroups.map((cluster) => (
          <GroupRow
            cluster={cluster}
            groupingMode={groupingMode}
            isGrouping={isBatchGrouping || groupingClusterId === cluster.id}
            key={cluster.id}
            selectedTabIds={selectedTabIds}
            tabs={tabs}
            onGroupCluster={onGroupCluster}
            onOpenTab={onOpenTab}
            onToggleGroup={onToggleGroup}
            onToggleTab={onToggleTab}
          />
        ))}
      </div>
    </div>
  );
}

function GroupRow({
  cluster,
  groupingMode,
  isGrouping,
  selectedTabIds,
  tabs,
  onGroupCluster,
  onOpenTab,
  onToggleGroup,
  onToggleTab
}: {
  cluster: TabCluster;
  groupingMode: TabGroupingMode;
  isGrouping: boolean;
  selectedTabIds: Set<number>;
  tabs: TabInfo[];
  onGroupCluster: (cluster: TabCluster) => void;
  onOpenTab: (tab: TabInfo) => void;
  onToggleGroup: (tabIds: number[], checked: boolean) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
}) {
  const clusterTabs = tabs.filter((tab) => cluster.tabIds.includes(tab.id));
  const allSelected = cluster.tabIds.every((id) => selectedTabIds.has(id));
  const groupState = getClusterGroupState(clusterTabs);
  const status = getGroupStatus(groupState);

  return (
    <details
      className={cn(
        "group",
        groupState.groupedCount > 0 && "group-has-group",
        groupState.singleCompleteGroup && "group-complete"
      )}
      key={cluster.id}
    >
      <summary>
        <Checkbox
          checked={allSelected}
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onToggleGroup(cluster.tabIds, event.target.checked)}
        />
        <span>
          <strong>{cluster.label}</strong>
          <small>{formatGroupState(groupState)}</small>
        </span>
        <span className="group-row-actions">
          {status ? <Badge variant={status.variant}>{status.label}</Badge> : null}
          <Button
            disabled={isGrouping}
            size="sm"
            variant={groupState.singleCompleteGroup ? "secondary" : "outline"}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onGroupCluster(cluster);
            }}
          >
            {getGroupActionLabel(groupState, groupingMode, isGrouping)}
          </Button>
          <span className="expand-affordance">
            View tabs
            <ChevronDown aria-hidden="true" />
          </span>
        </span>
      </summary>
      <div className="tab-list">
        {clusterTabs.map((tab) => (
          <TabRow
            checked={selectedTabIds.has(tab.id)}
            key={tab.id}
            tab={tab}
            onOpenTab={onOpenTab}
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
  onOpenTab,
  onCheckedChange
}: {
  checked: boolean;
  tab: TabInfo;
  onOpenTab: (tab: TabInfo) => void;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="tab-row" onClick={() => onCheckedChange(!checked)}>
      <Checkbox
        checked={checked}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className="favicon" aria-hidden="true">
        {tab.favIconUrl ? <img alt="" src={tab.favIconUrl} /> : <Sparkles />}
      </span>
      <span className="tab-copy">
        <strong>{tab.title}</strong>
        <small>{tab.url}</small>
      </span>
      <span className="tab-badges">
        {tab.groupTitle ? <Badge variant="secondary">{tab.groupTitle}</Badge> : null}
        {tab.pinned ? <Badge variant="outline">Pinned</Badge> : null}
      </span>
      <Button
        aria-label={`Open tab: ${tab.title}`}
        className="tab-open-button"
        size="icon"
        title="Open tab"
        variant="ghost"
        onClick={(event) => {
          event.stopPropagation();
          onOpenTab(tab);
        }}
      >
        <ExternalLink data-icon="inline-start" />
      </Button>
    </div>
  );
}

interface ClusterGroupState {
  tabCount: number;
  windowCount: number;
  groupCount: number;
  groupedCount: number;
  ungroupedCount: number;
  primaryTitle?: string;
  singleCompleteGroup: boolean;
}

function getClusterGroupState(tabs: TabInfo[]): ClusterGroupState {
  const groups = new Map<number, { count: number; title?: string }>();
  for (const tab of tabs) {
    if (!isTabGrouped(tab)) continue;
    const current = groups.get(tab.groupId) ?? { count: 0, title: tab.groupTitle };
    groups.set(tab.groupId, {
      count: current.count + 1,
      title: current.title ?? tab.groupTitle
    });
  }

  const primaryGroup = Array.from(groups.values()).sort((first, second) => second.count - first.count)[0];
  const groupedCount = Array.from(groups.values()).reduce((sum, group) => sum + group.count, 0);

  return {
    tabCount: tabs.length,
    windowCount: new Set(tabs.map((tab) => tab.windowId)).size,
    groupCount: groups.size,
    groupedCount,
    ungroupedCount: tabs.length - groupedCount,
    primaryTitle: primaryGroup?.title,
    singleCompleteGroup: groups.size === 1 && groupedCount === tabs.length
  };
}

function getGroupStatus(state: ClusterGroupState): { label: string; variant: "secondary" | "outline" } | null {
  if (state.singleCompleteGroup) return { label: "Grouped", variant: "secondary" };
  if (state.groupedCount > 0) return { label: "Partial", variant: "outline" };
  return null;
}

function formatGroupState(state: ClusterGroupState): string {
  const windows = `${state.windowCount} window${state.windowCount === 1 ? "" : "s"}`;
  if (state.singleCompleteGroup) {
    return `${state.tabCount} tabs · ${windows} · grouped${state.primaryTitle ? ` as ${state.primaryTitle}` : ""}`;
  }
  if (state.groupedCount > 0) {
    return `${state.tabCount} tabs · ${windows} · ${state.groupedCount} grouped, ${state.ungroupedCount} ungrouped`;
  }
  return `${state.tabCount} tabs · ${windows}`;
}

function getGroupActionLabel(
  state: ClusterGroupState,
  groupingMode: TabGroupingMode,
  isGrouping: boolean
): string {
  if (isGrouping) return "Working";
  if (state.singleCompleteGroup) return "Focus";
  if (state.groupedCount > 0) return groupingMode === "new-window" ? "Merge" : "Update";
  return "Group";
}

function isTabGrouped(tab: TabInfo): tab is TabInfo & { groupId: number } {
  return tab.groupId !== undefined && tab.groupId >= 0;
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

function tabsForBucket(bucket: SuggestionBucket, tabs: TabInfo[]): TabInfo[] {
  const ids = new Set(bucket.tabIds);
  return tabs.filter((tab) => ids.has(tab.id));
}

function getPreferredAction(analysis: TabAnalysis, buckets: SuggestionBucket[]): ActionKind {
  if (getActionCount("duplicates", analysis, buckets) > 0) return "duplicates";
  if (getActionCount("stale", analysis, buckets) > 0) return "stale";
  if (getActionCount("piles", analysis, buckets) > 0) return "piles";
  return "duplicates";
}

function getActionCount(
  action: ActionKind,
  analysis: TabAnalysis,
  buckets: SuggestionBucket[]
): number {
  if (action === "duplicates") {
    return buckets.find((bucket) => bucket.type === "duplicate")?.tabIds.length ?? 0;
  }

  if (action === "stale") {
    return buckets.find((bucket) => bucket.type === "stale")?.tabIds.length ?? 0;
  }

  return analysis.clusters
    .filter((cluster) => cluster.tabIds.length >= 3)
    .reduce((sum, cluster) => sum + cluster.tabIds.length, 0);
}

function readInitialTheme(): Theme {
  return localStorage.getItem("cleantab.theme") === "dark" ? "dark" : "light";
}

function readInitialGroupingMode(): TabGroupingMode {
  return localStorage.getItem("cleantab.groupingMode") === "new-window" ? "new-window" : "in-place";
}

function cleanGroupTitle(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").slice(0, 40);
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
