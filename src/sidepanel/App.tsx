import { useEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent, type ReactNode } from "react";
import {
  ArchiveRestore,
  BarChart3,
  CheckCircle2,
  Copy,
  Check,
  Pencil,
  X,
  ExternalLink,
  FolderKanban,
  History,
  Layers3,
  ListChecks,
  Moon,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  Sun,
  Sparkles,
  Trash2,
  WandSparkles,
  Zap
} from "lucide-react";
import { analyzeTabs } from "../lib/analyzeTabs";
import { closeSelectedTabsWithBackup } from "../lib/cleanup";
import {
  closeEmptyWindows,
  closeTabs,
  focusTab,
  getCurrentTabs,
  getCurrentWindowSnapshots,
  groupTabSetsInNewWindow,
  restoreSnapshotTabs
} from "../lib/chromeTabs";
import {
  clearSmartNameCaches,
  generateSmartClusterNames,
  generateSmartTabClusters,
  getSmartNameAvailability,
  type SmartNameMap,
  type SmartNameStatus
} from "../lib/smartNames";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "./components/ui/card";
import { Checkbox } from "./components/ui/checkbox";
import { AlertDialog } from "./components/ui/dialog";

type ActionKind = "duplicates" | "stale" | "piles";
type AppTab = "overview" | "cleanup" | "groups" | "snapshots" | "settings";
type Theme = "light" | "dark";

const BATCH_GROUPING_ID = "__selected_clusters__";
const LOOSE_GROUP_ID = "__loose_tabs__";
const SMART_REFRESH_MS = 5 * 60 * 1000;
const DRAFT_BOARD_CACHE_PREFIX = "cleantab.draftBoard.v1:";
const BUBBLE_WIDTH = 320;
const BUBBLE_MIN_HEIGHT = 160;
const BUBBLE_GAP = 24;
const BUBBLE_COLUMNS = 3;

interface PendingRestore {
  snapshot: TabSnapshot;
  target: "new-window" | "current-window";
}

interface DraftGroup {
  id: string;
  label: string;
  explanation: string;
  tabIds: number[];
  sourceClusterId?: string;
  selected?: boolean;
  x?: number;
  y?: number;
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
  const [activeTab, setActiveTab] = useState<AppTab>("overview");
  const [activeAction, setActiveAction] = useState<ActionKind>("duplicates");
  const [searchQuery, setSearchQuery] = useState("");
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());
  const [smartNamesEnabled, setSmartNamesEnabled] = useState(() => readInitialSmartNamesEnabled());
  const [smartNames, setSmartNames] = useState<SmartNameMap>({});
  const [smartClusters, setSmartClusters] = useState<TabCluster[]>([]);
  const [smartNameStatus, setSmartNameStatus] = useState<SmartNameStatus>(
    smartNamesEnabled ? "loading" : "disabled"
  );
  const [draftGroups, setDraftGroups] = useState<DraftGroup[]>([]);
  const [draftSourceKey, setDraftSourceKey] = useState("");
  const [groupingClusterId, setGroupingClusterId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const hasChromeApi = Boolean(globalThis.chrome?.tabs && globalThis.chrome?.storage);
  const analysis = useMemo<TabAnalysis>(() => analyzeTabs(tabs), [tabs]);
  const insightClusters = useMemo(
    () => buildInsightClusters(tabs, smartClusters, analysis.clusters),
    [analysis.clusters, smartClusters, tabs]
  );
  const insightAnalysis = useMemo<TabAnalysis>(
    () => ({
      ...analysis,
      clusters: insightClusters,
      stats: {
        ...analysis.stats,
        largestClusterSize: insightClusters[0]?.tabIds.length ?? 0
      }
    }),
    [analysis, insightClusters]
  );
  const buckets = useMemo(() => buildSuggestionBuckets(analysis.suggestions), [analysis.suggestions]);
  const visibleTabs = useMemo(() => filterTabs(tabs, searchQuery), [searchQuery, tabs]);
  const duplicateBucket = buckets.find((bucket) => bucket.type === "duplicate");
  const selectedCount = selectedTabIds.size;

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement;

      if ((event.key === "/" && !isTyping) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }

      if (event.key === "Escape") {
        setSearchQuery("");
        setSelectedTabIds(new Set());
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("cleantab.theme", theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem("cleantab.smartNames", smartNamesEnabled ? "enabled" : "disabled");
    if (globalThis.chrome?.storage?.local) {
      void chrome.storage.local.set({ "cleantab.smartNames.enabled": smartNamesEnabled });
    }
  }, [smartNamesEnabled]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: number | undefined;

    async function loadSmartNames(showLoading: boolean) {
      if (!smartNamesEnabled) {
        setSmartNames({});
        setSmartClusters([]);
        setSmartNameStatus("disabled");
        return;
      }

      if (!hasChromeApi || analysis.clusters.length === 0) {
        setSmartNames({});
        setSmartClusters([]);
        setSmartNameStatus("unavailable");
        return;
      }

      if (showLoading) {
        setSmartNameStatus((current) => (current === "ready" ? "ready" : "loading"));
      }
      const [names, clusters] = await Promise.all([
        generateSmartClusterNames(analysis.clusters, tabs),
        generateSmartTabClusters(tabs)
      ]);
      if (cancelled) return;
      const availability = await getSmartNameAvailability();
      if (cancelled) return;
      setSmartNames(names);
      setSmartClusters(clusters);
      setSmartNameStatus(getSmartNameStatusAfterLoad(names, clusters, availability));
    }

    loadSmartNames(true).catch(() => {
      if (!cancelled) {
        setSmartNames({});
        setSmartClusters([]);
        setSmartNameStatus("error");
      }
    });
    intervalId = window.setInterval(() => {
      loadSmartNames(false).catch(() => {
        if (!cancelled) setSmartNameStatus("error");
      });
    }, SMART_REFRESH_MS);

    return () => {
      cancelled = true;
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
  }, [analysis.clusters, hasChromeApi, smartNamesEnabled, tabs]);

  useEffect(() => {
    const preferredAction = getPreferredAction(analysis, buckets);
    if (getActionCount(activeAction, analysis, buckets) === 0 && preferredAction !== activeAction) {
      setActiveAction(preferredAction);
    }
  }, [activeAction, analysis, buckets]);

  useEffect(() => {
    const nextSourceKey = groupDraftSourceKey(insightClusters, tabs, smartNames);
    if (nextSourceKey === draftSourceKey) return;
    setDraftGroups(readSavedDraftGroups(nextSourceKey) ?? buildDraftGroups(insightClusters, tabs, smartNames));
    setDraftSourceKey(nextSourceKey);
  }, [draftSourceKey, insightClusters, smartNames, tabs]);

  useEffect(() => {
    if (!draftSourceKey || draftGroups.length === 0) return;
    writeSavedDraftGroups(draftSourceKey, draftGroups);
  }, [draftGroups, draftSourceKey]);

  async function refresh() {
    if (!hasChromeApi) {
      setStatus("Load dist/ as a Chrome extension tab.");
      setTabs([]);
      setSnapshots([]);
      return;
    }

    try {
      setError(null);
      await closeEmptyWindows();
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

  async function applyDraftGroupsInOneWindow(sourceGroups = draftGroups) {
    const groupsToApply = sourceGroups.filter(
      (group) => group.id !== LOOSE_GROUP_ID && group.selected !== false && group.tabIds.length > 0
    );
    if (groupsToApply.length === 0) return;

    try {
      setGroupingClusterId(BATCH_GROUPING_ID);
      const windows = await getCurrentWindowSnapshots();
      await createSnapshot("Before grouping", "auto-before-organize", windows);
      const groupIds = await groupTabSetsInNewWindow(
        groupsToApply.map((group) => ({
          title: cleanGroupTitle(group.label),
          tabIds: group.tabIds
        })),
        tabs
      );
      const tabCount = groupsToApply.reduce((sum, group) => sum + group.tabIds.length, 0);
      await refresh();
      setStatus(`Applied ${groupIds.length} groups to ${tabCount} tabs.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to apply group board.");
    } finally {
      setGroupingClusterId(null);
    }
  }

  function moveDraftTab(tabId: number, targetGroupId: string) {
    setDraftGroups((current) => arrangeDraftGroups(moveTabBetweenDraftGroups(current, tabId, targetGroupId)));
  }

  function mergeDraftGroups(sourceGroupId: string, targetGroupId: string) {
    setDraftGroups((current) => arrangeDraftGroups(mergeDraftGroupIntoTarget(current, sourceGroupId, targetGroupId), targetGroupId));
  }

  function createDraftGroupFromTab(tabId: number, position?: { x: number; y: number }) {
    const tab = tabs.find((currentTab) => currentTab.id === tabId);
    setDraftGroups((current) => {
      const next = createDraftGroupWithTab(current, tabId, tab, position);
      const manualGroup = next.find((group) => group.tabIds.includes(tabId) && group.explanation === "Created manually in CleanTab.");
      return arrangeDraftGroups(next, manualGroup?.id);
    });
  }

  function moveDraftGroup(groupId: string, position: { x: number; y: number }, settle = true) {
    setDraftGroups((current) =>
      settle
        ? arrangeDraftGroups(
            current.map((group) => (group.id === groupId ? { ...group, ...position } : group)),
            groupId
          )
        : current.map((group) => (group.id === groupId ? { ...group, ...position } : group))
    );
  }

  function renameDraftGroup(groupId: string, label: string) {
    setDraftGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? { ...group, label: label.trim() || group.label, explanation: "Renamed manually in CleanTab." }
          : group
      )
    );
  }

  function toggleDraftGroupSelected(groupId: string, selected: boolean) {
    setDraftGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, selected } : group))
    );
  }

  function resetDraftGroups() {
    setDraftGroups(buildDraftGroups(insightClusters, tabs, smartNames));
    setDraftSourceKey(groupDraftSourceKey(insightClusters, tabs, smartNames));
  }

  function autoArrangeDraftGroups() {
    setDraftGroups((current) => arrangeDraftGroups(current));
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
    <main className="app-frame">
      <aside className="sidebar">
        <div className="brand sidebar-brand">
          <ShieldCheck aria-hidden="true" />
          <div>
            <h1>CleanTab</h1>
            <p>{smartClusters.length > 0 ? "AI cockpit" : "Local cockpit"}</p>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="CleanTab sections">
          <SidebarButton active={activeTab === "overview"} icon={<BarChart3 />} label="Overview" onClick={() => setActiveTab("overview")} />
          <SidebarButton active={activeTab === "cleanup"} icon={<ListChecks />} label="Cleanup" onClick={() => setActiveTab("cleanup")} />
          <SidebarButton active={activeTab === "groups"} icon={<FolderKanban />} label="Groups" onClick={() => setActiveTab("groups")} />
          <SidebarButton active={activeTab === "snapshots"} icon={<History />} label="Snapshots" onClick={() => setActiveTab("snapshots")} />
          <SidebarButton active={activeTab === "settings"} icon={<WandSparkles />} label="Settings" onClick={() => setActiveTab("settings")} />
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <h2>{titleForAppTab(activeTab)}</h2>
            <p>{status}</p>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search aria-hidden="true" />
              <input
                aria-label="Search tabs"
                placeholder="Search tabs..."
                ref={searchInputRef}
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
              />
              {searchQuery ? (
                <button
                  aria-label="Clear search"
                  className="search-clear"
                  onClick={() => setSearchQuery("")}
                >
                  <X aria-hidden="true" />
                </button>
              ) : null}
            </label>
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
            {duplicateBucket ? (
              <Button disabled={!hasChromeApi} onClick={() => closeTabIdsNow(duplicateBucket.tabIds, "Duplicates")}>
                <Copy data-icon="inline-start" />
                Close {duplicateBucket.tabIds.length} dupes
              </Button>
            ) : null}
            <Button disabled={!hasChromeApi} onClick={() => setActiveTab("cleanup")}>
              <Zap data-icon="inline-start" />
              Cleanup
            </Button>
          </div>
        </header>

        {error ? <div className="error-banner">{error}</div> : null}

        {activeTab === "overview" ? (
          <OverviewPanel
            analysis={insightAnalysis}
            buckets={buckets}
            hasSmartClusters={smartClusters.length > 0}
            smartNameStatus={smartNameStatus}
            tabs={visibleTabs}
            onCloseTabsNow={closeTabIdsNow}
            onGoToCleanup={(action) => {
              setActiveAction(action);
              setActiveTab("cleanup");
            }}
            onGoToGroups={() => setActiveTab("groups")}
          />
        ) : null}

        {activeTab === "cleanup" ? (
          <DecisionDashboard
              activeAction={activeAction}
              analysis={insightAnalysis}
              buckets={buckets}
              tabs={visibleTabs}
              selectedTabIds={selectedTabIds}
              onActionChange={setActiveAction}
              onCloseTabsNow={closeTabIdsNow}
              onGoToGroups={() => setActiveTab("groups")}
              onOpenTab={openTab}
              onToggleTab={toggleTab}
              onToggleTabs={toggleTabs}
            />
        ) : null}

        {activeTab === "groups" ? (
          <GroupBubbleBoard
            draftGroups={filterDraftGroups(draftGroups, visibleTabs)}
            isApplying={groupingClusterId === BATCH_GROUPING_ID}
            tabs={visibleTabs}
            onApply={applyDraftGroupsInOneWindow}
            onCreateGroupFromTab={createDraftGroupFromTab}
            onMergeGroups={mergeDraftGroups}
            onMoveGroup={moveDraftGroup}
            onMoveTab={moveDraftTab}
            onOpenTab={openTab}
            onCloseTab={(tabId) => closeTabIdsNow([tabId], "Bubble Board")}
            onAutoArrange={autoArrangeDraftGroups}
            onRenameGroup={renameDraftGroup}
            onReset={resetDraftGroups}
            onToggleSelected={toggleDraftGroupSelected}
          />
        ) : null}

        {activeTab === "snapshots" ? (
          <SnapshotList
            canCreate={hasChromeApi}
            snapshotName={snapshotName}
            snapshots={snapshots}
            onCreate={saveManualSnapshot}
            onDelete={async (id) => {
              await deleteSnapshot(id);
              setSnapshots(await listSnapshots());
            }}
            onSnapshotNameChange={setSnapshotName}
            onRestore={(snapshot, target) => setPendingRestore({ snapshot, target })}
          />
        ) : null}

        {activeTab === "settings" ? (
          <SettingsPanel
            smartNamesEnabled={smartNamesEnabled}
            smartNameStatus={smartNameStatus}
            onSmartNamesChange={setSmartNamesEnabled}
            onClearSmartCache={() => {
              clearSmartNameCaches();
              setSmartNames({});
              setSmartClusters([]);
              setSmartNameStatus(smartNamesEnabled ? "loading" : "disabled");
            }}
          />
        ) : null}

        {selectedCount > 0 ? (
          <div className="action-bar">
            <span>
              <strong>{selectedCount}</strong> selected
            </span>
            <Button disabled={!hasChromeApi} variant="destructive" onClick={() => setPendingClose(true)}>
              <Trash2 data-icon="inline-start" />
              Close
            </Button>
          </div>
        ) : null}

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
      </section>
    </main>
  );
}

function SidebarButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button aria-pressed={active} className={cn("sidebar-button", active && "sidebar-button-active")} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function OverviewPanel({
  analysis,
  buckets,
  hasSmartClusters,
  smartNameStatus,
  tabs,
  onCloseTabsNow,
  onGoToCleanup,
  onGoToGroups
}: {
  analysis: TabAnalysis;
  buckets: SuggestionBucket[];
  hasSmartClusters: boolean;
  smartNameStatus: SmartNameStatus;
  tabs: TabInfo[];
  onCloseTabsNow: (tabIds: number[], label: string) => void;
  onGoToCleanup: (action: ActionKind) => void;
  onGoToGroups: () => void;
}) {
  const duplicateBucket = buckets.find((bucket) => bucket.type === "duplicate");
  const staleBucket = buckets.find((bucket) => bucket.type === "stale");
  const referenceBucket = buckets.find((bucket) => bucket.type === "likely-reference");
  const bigGroups = analysis.clusters.filter((cluster) => cluster.tabIds.length >= 2);

  const memoryMB = tabs.length * 85;
  const memoryFormatted = memoryMB > 1024 ? `${(memoryMB / 1024).toFixed(1)} GB` : `${memoryMB} MB`;
  const activeCount = tabs.filter((t) => t.active).length;
  const idleCount = staleBucket?.tabIds.length ?? 0;

  return (
    <div className="overview-grid">
      <div className="dashboard-insights" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "1.5rem" }}>
        <Card>
          <CardHeader style={{ paddingBottom: "0.5rem" }}>
            <CardTitle style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ink-muted)" }}>Est. Memory Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{memoryFormatted}</div>
            <p style={{ fontSize: "0.75rem", color: "var(--ink-muted)" }}>Based on ~85MB per tab</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader style={{ paddingBottom: "0.5rem" }}>
            <CardTitle style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ink-muted)" }}>Idle Tabs</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{idleCount}</div>
            <p style={{ fontSize: "0.75rem", color: "var(--ink-muted)" }}>Stale and consuming resources</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader style={{ paddingBottom: "0.5rem" }}>
            <CardTitle style={{ fontSize: "0.875rem", fontWeight: 500, color: "var(--ink-muted)" }}>Active Workflow</CardTitle>
          </CardHeader>
          <CardContent>
            <div style={{ fontSize: "1.5rem", fontWeight: "bold" }}>{activeCount}</div>
            <p style={{ fontSize: "0.75rem", color: "var(--ink-muted)" }}>Currently in-use windows</p>
          </CardContent>
        </Card>
      </div>

      <div className="insight-cards">
        <Card>
          <CardHeader>
            <CardTitle>Cleanup suggestions</CardTitle>
            <CardDescription>Fast passes that reduce tab count without guessing.</CardDescription>
          </CardHeader>
          <CardContent className="insight-list">
            <InsightRow
              badge={duplicateBucket ? `${duplicateBucket.tabIds.length}` : "0"}
              description={duplicateBucket ? "Same URL copies. CleanTab keeps one copy." : "No exact duplicates found."}
              icon={<Copy />}
              title="Close duplicates"
              action={
                duplicateBucket ? (
                  <Button size="sm" onClick={() => onCloseTabsNow(duplicateBucket.tabIds, "Duplicates")}>
                    Close
                  </Button>
                ) : null
              }
            />
            <InsightRow
              badge={staleBucket ? `${staleBucket.tabIds.length}` : "0"}
              description={staleBucket ? "Inactive, unpinned tabs worth reviewing." : "No stale tabs right now."}
              icon={<Trash2 />}
              title="Review stale"
              action={<Button size="sm" variant="outline" onClick={() => onGoToCleanup("stale")}>Review</Button>}
            />
            <InsightRow
              badge={referenceBucket ? `${referenceBucket.tabIds.length}` : "0"}
              description={referenceBucket ? "Docs and code tabs to snapshot before cleanup." : "No reference pile detected."}
              icon={<ArchiveRestore />}
              title="Reference tabs"
              action={<Button size="sm" variant="outline" onClick={() => onGoToCleanup("stale")}>Inspect</Button>}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Grouping suggestions</CardTitle>
            <CardDescription>{hasSmartClusters ? "Generated locally by the small model." : smartNameStatus === "loading" ? "Heuristic groups until local AI is ready. Warming up..." : "Heuristic fallback groups."}</CardDescription>
          </CardHeader>
          <CardContent className="insight-list">
            {bigGroups.slice(0, 4).map((cluster) => (
              <InsightRow
                badge={`${cluster.tabIds.length}`}
                description={cluster.explanation}
                icon={<FolderKanban />}
                key={cluster.id}
                title={cluster.label}
                action={<Button size="sm" variant="outline" onClick={onGoToGroups}>Open</Button>}
              />
            ))}
            {bigGroups.length === 0 ? (
              <EmptyState icon={<CheckCircle2 />} title="No groups yet" description="Open more related tabs and refresh CleanTab." />
            ) : (
              <Button onClick={onGoToGroups}>
                Open group board
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>One cleanup pass, one grouping pass, snapshots before destructive actions.</CardDescription>
        </CardHeader>
        <CardContent className="plan-strip">
          <Badge variant={duplicateBucket ? "secondary" : "outline"}>{duplicateBucket ? "Duplicates ready" : "No duplicates"}</Badge>
          <Badge variant={staleBucket ? "outline" : "secondary"}>{staleBucket ? "Stale needs review" : "Stale clear"}</Badge>
          <Badge variant={bigGroups.length ? "secondary" : "outline"}>{bigGroups.length} group drafts</Badge>
          <Badge variant="outline">Local only</Badge>
        </CardContent>
      </Card>
    </div>
  );
}

function InsightRow({
  action,
  badge,
  description,
  icon,
  title
}: {
  action?: ReactNode;
  badge: string;
  description: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <div className="insight-row">
      <span className="action-icon">{icon}</span>
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <Badge variant="outline">{badge}</Badge>
      {action}
    </div>
  );
}

function DecisionDashboard({
  activeAction,
  analysis,
  buckets,
  tabs,
  selectedTabIds,
  onActionChange,
  onCloseTabsNow,
  onGoToGroups,
  onOpenTab,
  onToggleTab,
  onToggleTabs
}: {
  activeAction: ActionKind;
  analysis: TabAnalysis;
  buckets: SuggestionBucket[];
  tabs: TabInfo[];
  selectedTabIds: Set<number>;
  onActionChange: (action: ActionKind) => void;
  onCloseTabsNow: (tabIds: number[], label: string) => void;
  onGoToGroups: () => void;
  onOpenTab: (tab: TabInfo) => void;
  onToggleTab: (tabId: number, checked: boolean) => void;
  onToggleTabs: (tabIds: number[], checked: boolean) => void;
}) {
  const duplicateBucket = buckets.find((bucket) => bucket.type === "duplicate");
  const staleBucket = buckets.find((bucket) => bucket.type === "stale");
  const bigGroups = analysis.clusters.filter((cluster) => cluster.tabIds.length >= 2);
  const pilesTabCount = bigGroups.reduce((sum, group) => sum + group.tabIds.length, 0);

  return (
    <section className="decision-shell">
      <div className="action-grid">
        <ActionCard
          active={activeAction === "duplicates"}
          badge={duplicateBucket ? "backup first" : "clear"}
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
          description={bigGroups.length ? "Use the drag bubble board." : "No group draft yet."}
          icon={<Layers3 aria-hidden="true" />}
          title="Organize groups"
          onClick={onGoToGroups}
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
        {activeAction === "piles" ? <GroupBoardTeaser onGoToGroups={onGoToGroups} /> : null}
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
    <button aria-pressed={active} className={cn("action-card", active && "action-card-active")} onClick={onClick}>
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

function GroupBoardTeaser({ onGoToGroups }: { onGoToGroups: () => void }) {
  return (
    <div className="focus-content group-teaser">
      <div className="empty-icon">
        <FolderKanban aria-hidden="true" />
      </div>
      <div>
        <h2>Use the group board</h2>
        <p>Groups are edited in one place now. Drag tabs into bubbles, merge bubbles, rename groups, then apply.</p>
      </div>
      <Button onClick={onGoToGroups}>
        Open group board
      </Button>
    </div>
  );
}

function SettingsPanel({
  smartNamesEnabled,
  smartNameStatus,
  onClearSmartCache,
  onSmartNamesChange
}: {
  smartNamesEnabled: boolean;
  smartNameStatus: SmartNameStatus;
  onClearSmartCache: () => void;
  onSmartNamesChange: (enabled: boolean) => void;
}) {
  return (
    <Card className="settings-card">
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>Local-first controls for features that change how CleanTab interprets your tabs.</CardDescription>
      </CardHeader>
      <CardContent>
        <label className="setting-row">
          <span>
            <strong>Smart local names</strong>
            <small>Use an on-device small model for cluster and workspace names when available.</small>
          </span>
          <input
            aria-label="Smart local names"
            checked={smartNamesEnabled}
            className="switch"
            role="switch"
            type="checkbox"
            onChange={(event) => onSmartNamesChange(event.target.checked)}
          />
        </label>
        <div className="setting-note">
          <Badge variant={smartNameStatus === "ready" ? "secondary" : "outline"}>
            {formatSmartNameStatus(smartNameStatus)}
          </Badge>
          <small>Names stay local. Chrome periodically warms the on-device model when available.</small>
        </div>
        <div className="setting-actions">
          <Button variant="outline" onClick={onClearSmartCache}>
            <RefreshCcw data-icon="inline-start" />
            Reset AI cache
          </Button>
        </div>
      </CardContent>
    </Card>
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

function GroupBubbleBoard({
  draftGroups,
  isApplying,
  tabs,
  onApply,
  onCreateGroupFromTab,
  onMergeGroups,
  onMoveGroup,
  onMoveTab,
  onOpenTab,
  onCloseTab,
  onAutoArrange,
  onRenameGroup,
  onReset,
  onToggleSelected
}: {
  draftGroups: DraftGroup[];
  isApplying: boolean;
  tabs: TabInfo[];
  onApply: (groups: DraftGroup[]) => void;
  onCreateGroupFromTab: (tabId: number, position?: { x: number; y: number }) => void;
  onMergeGroups: (sourceGroupId: string, targetGroupId: string) => void;
  onMoveGroup: (groupId: string, position: { x: number; y: number }, settle?: boolean) => void;
  onMoveTab: (tabId: number, targetGroupId: string) => void;
  onOpenTab: (tab: TabInfo) => void;
  onCloseTab: (tabId: number) => void;
  onAutoArrange: () => void;
  onRenameGroup: (groupId: string, label: string) => void;
  onReset: () => void;
  onToggleSelected: (groupId: string, selected: boolean) => void;
}) {
  const [activeDropGroupId, setActiveDropGroupId] = useState<string | null>(null);
  const [isBoardDropActive, setIsBoardDropActive] = useState(false);
  const [pointerDrag, setPointerDrag] = useState<{
    groupId: string;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const applyCount = draftGroups.filter(
    (group) => group.id !== LOOSE_GROUP_ID && group.selected !== false && group.tabIds.length > 0
  ).length;
  const groupedTabCount = draftGroups
    .filter((group) => group.id !== LOOSE_GROUP_ID && group.selected !== false)
    .reduce((sum, group) => sum + group.tabIds.length, 0);
  const boardHeight = Math.max(
    680,
    ...draftGroups.map((group) => (group.y ?? 0) + estimatedBubbleHeight(group) + BUBBLE_GAP * 2)
  );

  if (draftGroups.length === 0) {
    return (
      <EmptyState
        icon={<FolderKanban aria-hidden="true" />}
        title="No grouping draft"
        description="Open related tabs, refresh CleanTab, or clear the search filter."
      />
    );
  }

  return (
    <section className="bubble-workspace">
      <div className="focus-heading bubble-heading">
        <div>
          <h2>Group bubbles</h2>
          <p>Shape the draft, then apply every named bubble into one Chrome window.</p>
        </div>
        <div className="heading-actions">
          <Badge variant="secondary">{groupedTabCount} selected</Badge>
          <Button variant="ghost" onClick={onAutoArrange}>Auto-arrange</Button>
          <Button variant="outline" onClick={onReset}>Reset draft</Button>
          <Button disabled={isApplying || applyCount === 0} onClick={() => onApply(draftGroups)}>
            {isApplying ? "Applying" : `Apply ${applyCount} groups`}
          </Button>
        </div>
      </div>

      <div
        className={cn("bubble-board", isBoardDropActive && "bubble-board-active")}
        style={{ minHeight: `${boardHeight}px` }}
        onDragEnter={() => setIsBoardDropActive(true)}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setIsBoardDropActive(false);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsBoardDropActive(false);
          setActiveDropGroupId(null);
          const dragData = readDragData(event);
          if (!dragData) return;
          const position = canvasPositionFromDrop(event);
          if (dragData.type === "tab") onCreateGroupFromTab(dragData.tabId, position);
          if (dragData.type === "group") onMoveGroup(dragData.groupId, position, true);
        }}
      >
        <div className="bubble-masonry-layout">
          {draftGroups
            .filter((g) => g.id !== LOOSE_GROUP_ID)
            .map((group) => {
              const groupTabs = group.tabIds.map((id) => tabById.get(id)).filter((tab): tab is TabInfo => Boolean(tab));
              if (groupTabs.length === 0) return null;

              return (
                <section
                  className={cn(
                    "bubble-card",
                    "bubble-card-movable",
                    group.selected === false && "bubble-card-skipped",
                    pointerDrag?.groupId === group.id && "bubble-card-dragging",
                    activeDropGroupId === group.id && "bubble-card-drop-active"
                  )}
                  data-group-id={group.id}
                  key={group.id}
                  style={
                    pointerDrag?.groupId === group.id
                      ? {
                          transform: `translate(${group.x ?? 0}px, ${group.y ?? 0}px)`,
                          zIndex: 100
                        }
                      : undefined
                  }
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setActiveDropGroupId(group.id);
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                      setActiveDropGroupId((current) => (current === group.id ? null : current));
                    }
                  }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }}
                  onPointerDown={(event) => {
                    if (isInteractiveDragTarget(event.target)) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setPointerDrag({
                      groupId: group.id,
                      originX: 0,
                      originY: 0,
                      startX: event.clientX,
                      startY: event.clientY
                    });
                  }}
                  onPointerMove={(event) => {
                    if (!pointerDrag || pointerDrag.groupId !== group.id) return;
                    event.preventDefault();
                    onMoveGroup(
                      group.id,
                      {
                        x: event.clientX - pointerDrag.startX,
                        y: event.clientY - pointerDrag.startY
                      },
                      false
                    );
                  }}
                  onPointerUp={(event) => {
                    if (!pointerDrag || pointerDrag.groupId !== group.id) return;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    const targetGroupId = groupIdFromPoint(event.clientX, event.clientY, group.id);
                    setPointerDrag(null);
                    if (targetGroupId && targetGroupId !== group.id) {
                      onMergeGroups(group.id, targetGroupId);
                    } else {
                      onMoveGroup(group.id, { x: 0, y: 0 }, true);
                    }
                  }}
                  onPointerCancel={(event) => {
                    if (!pointerDrag || pointerDrag.groupId !== group.id) return;
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    setPointerDrag(null);
                    onMoveGroup(group.id, { x: 0, y: 0 }, true);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                setActiveDropGroupId(null);
                setIsBoardDropActive(false);
                const dragData = readDragData(event);
                if (!dragData) return;
                if (dragData.type === "tab") onMoveTab(dragData.tabId, group.id);
                if (dragData.type === "group") onMergeGroups(dragData.groupId, group.id);
              }}
                  >
                    <BubbleHeader
                      group={group}
                      isLoose={false}
                      tabCount={groupTabs.length}
                      onRenameGroup={onRenameGroup}
                      onToggleSelected={onToggleSelected}
                    />
                    <div className="bubble-tabs">
                      {groupTabs.map((tab) => (
                        <BubbleTabWithPopup
                          key={tab.id}
                          tab={tab}
                          onOpenTab={onOpenTab}
                          onCloseTab={onCloseTab}
                        />
                      ))}
                    </div>
                </section>
              );
            })}
        </div>
        {draftGroups
          .filter((g) => g.id === LOOSE_GROUP_ID)
          .map((group) => {
            const groupTabs = group.tabIds.map((id) => tabById.get(id)).filter((tab): tab is TabInfo => Boolean(tab));
            if (groupTabs.length === 0) return null;

            return (
              <section
                className="bubble-card bubble-card-loose"
                data-group-id={group.id}
                key={group.id}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setActiveDropGroupId(group.id);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setActiveDropGroupId((current) => (current === group.id ? null : current));
                  }
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveDropGroupId(null);
                  setIsBoardDropActive(false);
                  const dragData = readDragData(event);
                  if (!dragData) return;
                  if (dragData.type === "tab") onMoveTab(dragData.tabId, group.id);
                  if (dragData.type === "group") onMergeGroups(dragData.groupId, group.id);
                }}
              >
                <BubbleHeader
                  group={group}
                  isLoose={true}
                  tabCount={groupTabs.length}
                  onRenameGroup={onRenameGroup}
                  onToggleSelected={onToggleSelected}
                />
                <div className="bubble-tabs">
                  {groupTabs.map((tab) => (
                    <BubbleTabWithPopup
                      key={tab.id}
                      tab={tab}
                      onOpenTab={onOpenTab}
                      onCloseTab={onCloseTab}
                    />
                  ))}
                </div>
              </section>
            );
          })}
      </div>
    </section>
  );
}

function BubbleTabWithPopup({ tab, onOpenTab, onCloseTab }: { tab: TabInfo; onOpenTab: (tab: TabInfo) => void; onCloseTab: (id: number) => void }) {
  const [popupRect, setPopupRect] = useState<DOMRect | null>(null);
  const timeoutRef = useRef<number | undefined>(undefined);

  return (
    <div
      className="bubble-tab"
      draggable
      onDragStart={(event) => {
        event.stopPropagation();
        event.dataTransfer.setData("application/x-cleantab-drag", JSON.stringify({ type: "tab", tabId: tab.id }));
        setPopupRect(null);
      }}
      onMouseEnter={(e) => {
        window.clearTimeout(timeoutRef.current);
        setPopupRect(e.currentTarget.getBoundingClientRect());
      }}
      onMouseLeave={() => {
        timeoutRef.current = window.setTimeout(() => setPopupRect(null), 150);
      }}
    >
      <button
        className="bubble-tab-main-btn"
        onClick={() => onOpenTab(tab)}
        style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', border: 'none', background: 'transparent', padding: 0, margin: 0, font: 'inherit', color: 'inherit', cursor: 'grab', width: '100%', textAlign: 'left' }}
      >
        <span className="favicon" aria-hidden="true">
          {tab.favIconUrl ? <img alt="" src={tab.favIconUrl} /> : <Sparkles />}
        </span>
        <span className="bubble-tab-title">{tab.title}</span>
        <ExternalLink aria-hidden="true" className="bubble-tab-open-icon" />
      </button>

      {popupRect && (
        <div
          className="tab-hover-popup"
          onMouseEnter={() => window.clearTimeout(timeoutRef.current)}
          onMouseLeave={() => {
            timeoutRef.current = window.setTimeout(() => setPopupRect(null), 150);
          }}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: 'fixed',
            top: popupRect.bottom + 8,
            left: Math.min(popupRect.left, window.innerWidth - 340),
            zIndex: 99999,
            width: '20rem',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '0.5rem',
            padding: '1rem',
            boxShadow: 'var(--shadow-soft)',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.75rem',
            cursor: 'default',
            color: 'var(--ink-muted)'
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{tab.title}</div>
          <div style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{tab.url}</div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem' }}>
            <Button size="sm" variant="outline" style={{ flex: 1 }} onClick={() => { setPopupRect(null); onOpenTab(tab); }}>
              Open Tab
            </Button>
            <Button size="sm" variant="destructive" style={{ flex: 1 }} onClick={() => { setPopupRect(null); onCloseTab(tab.id); }}>
              Close Tab
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function BubbleHeader({
  group,
  isLoose,
  tabCount,
  onRenameGroup,
  onToggleSelected
}: {
  group: DraftGroup;
  isLoose: boolean;
  tabCount: number;
  onRenameGroup: (groupId: string, label: string) => void;
  onToggleSelected: (groupId: string, selected: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(group.label);

  useEffect(() => {
    setLabel(group.label);
  }, [group.label]);

  if (editing && !isLoose) {
    return (
      <header className="bubble-header bubble-header-editing">
        <input
          aria-label="Group name"
          autoFocus
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              onRenameGroup(group.id, label);
              setEditing(false);
            }
            if (event.key === "Escape") {
              setLabel(group.label);
              setEditing(false);
            }
          }}
        />
        <span className="bubble-edit-actions">
          <Button
            aria-label="Save group name"
            size="icon"
            variant="ghost"
            onClick={() => {
              onRenameGroup(group.id, label);
              setEditing(false);
            }}
          >
            <Check data-icon="inline-start" />
          </Button>
          <Button
            aria-label="Cancel edit"
            size="icon"
            variant="ghost"
            onClick={() => {
              setLabel(group.label);
              setEditing(false);
            }}
          >
            <X data-icon="inline-start" />
          </Button>
        </span>
      </header>
    );
  }

  return (
    <header className="bubble-header">
      <span>
        <strong>{group.label}</strong>
        <small>{tabCount} tabs · {isLoose ? "not applied" : group.explanation}</small>
      </span>
      <span className="bubble-header-actions">
        {!isLoose ? (
          <Checkbox
            aria-label={`Include ${group.label} when applying groups`}
            checked={group.selected !== false}
            onClick={(event) => event.stopPropagation()}
            onChange={(event) => onToggleSelected(group.id, event.target.checked)}
          />
        ) : null}
        {!isLoose ? (
          <Button
            aria-label={`Edit group name: ${group.label}`}
            size="icon"
            title="Edit group name"
            variant="ghost"
            onClick={() => setEditing(true)}
          >
            <Pencil data-icon="inline-start" />
          </Button>
        ) : null}
        <Badge variant={isLoose || group.selected === false ? "outline" : "secondary"}>
          {isLoose ? "Unsorted" : group.selected === false ? "Skipped" : "Selected"}
        </Badge>
      </span>
    </header>
  );
}

function SnapshotList({
  canCreate,
  snapshotName,
  snapshots,
  onCreate,
  onDelete,
  onSnapshotNameChange,
  onRestore
}: {
  canCreate: boolean;
  snapshotName: string;
  snapshots: TabSnapshot[];
  onCreate: () => void;
  onDelete: (id: string) => void;
  onSnapshotNameChange: (name: string) => void;
  onRestore: (snapshot: TabSnapshot, target: "new-window" | "current-window") => void;
}) {
  return (
    <section className="section compact-section">
      <details open>
        <summary className="section-heading snapshots-heading">
          <h2>Snapshots</h2>
          <Badge variant="secondary">{snapshots.length}</Badge>
        </summary>
        <div className="snapshot-create">
          <input
            aria-label="Snapshot name"
            disabled={!canCreate}
            placeholder="Snapshot name"
            value={snapshotName}
            onChange={(event) => onSnapshotNameChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onCreate();
            }}
          />
          <Button disabled={!canCreate} onClick={onCreate}>
            <Save data-icon="inline-start" />
            Save snapshot
          </Button>
        </div>
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
                  <Badge variant="outline">{snapshotSourceLabel(snapshot.source)}</Badge>
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

function isTabGrouped(tab: TabInfo): tab is TabInfo & { groupId: number } {
  return tab.groupId !== undefined && tab.groupId >= 0;
}

type DragData =
  | { type: "tab"; tabId: number }
  | { type: "group"; groupId: string };

function readDragData(event: DragEvent): DragData | null {
  try {
    const parsed = JSON.parse(event.dataTransfer.getData("application/x-cleantab-drag"));
    if (parsed?.type === "tab" && typeof parsed.tabId === "number") return parsed;
    if (parsed?.type === "group" && typeof parsed.groupId === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function canvasPositionFromDrop(event: DragEvent): { x: number; y: number } {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.max(16, event.clientX - rect.left - 160),
    y: Math.max(16, event.clientY - rect.top - 48)
  };
}

function isInteractiveDragTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("button, input, .bubble-tab"));
}

function groupIdFromPoint(x: number, y: number, ignoredGroupId: string): string | null {
  for (const target of document.elementsFromPoint(x, y)) {
    if (!(target instanceof HTMLElement)) continue;
    const groupId = target.closest<HTMLElement>("[data-group-id]")?.dataset.groupId;
    if (groupId && groupId !== ignoredGroupId) return groupId;
  }
  return null;
}

function readSavedDraftGroups(sourceKey: string): DraftGroup[] | null {
  if (!sourceKey) return null;

  try {
    const raw = localStorage.getItem(`${DRAFT_BOARD_CACHE_PREFIX}${hashForDraft(sourceKey)}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const groups = parsed.filter(isDraftGroup);
    if (groups.length !== parsed.length) return null;
    return arrangeDraftGroups(groups);
  } catch {
    return null;
  }
}

function writeSavedDraftGroups(sourceKey: string, groups: DraftGroup[]) {
  try {
    localStorage.setItem(
      `${DRAFT_BOARD_CACHE_PREFIX}${hashForDraft(sourceKey)}`,
      JSON.stringify(arrangeDraftGroups(groups))
    );
    trimDraftBoardCache();
  } catch {
    // Local storage can be unavailable or full. The board still works without persisted positions.
  }
}

function trimDraftBoardCache() {
  const keys = Object.keys(localStorage).filter((key) => key.startsWith(DRAFT_BOARD_CACHE_PREFIX));
  if (keys.length <= 8) return;

  for (const key of keys.slice(0, keys.length - 8)) {
    localStorage.removeItem(key);
  }
}

function isDraftGroup(value: unknown): value is DraftGroup {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DraftGroup>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.explanation === "string" &&
    Array.isArray(candidate.tabIds) &&
    candidate.tabIds.every((id) => typeof id === "number") &&
    (candidate.sourceClusterId === undefined || typeof candidate.sourceClusterId === "string") &&
    (candidate.selected === undefined || typeof candidate.selected === "boolean") &&
    (candidate.x === undefined || typeof candidate.x === "number") &&
    (candidate.y === undefined || typeof candidate.y === "number")
  );
}

function hashForDraft(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
  }
  return Math.abs(hash).toString(36);
}

function arrangeDraftGroups(groups: DraftGroup[], priorityGroupId?: string): DraftGroup[] {
  const sortedNormalGroups = groups
    .filter((g) => g.id !== LOOSE_GROUP_ID)
    .sort((a, b) => b.tabIds.length - a.tabIds.length);

  const looseGroup = groups.find((g) => g.id === LOOSE_GROUP_ID);
  return looseGroup ? [...sortedNormalGroups, looseGroup] : sortedNormalGroups;
}

function bubblesOverlap(first: DraftGroup, second: DraftGroup): boolean {
  const firstRect = bubbleRect(first);
  const secondRect = bubbleRect(second);
  return (
    firstRect.left < secondRect.right + BUBBLE_GAP &&
    firstRect.right + BUBBLE_GAP > secondRect.left &&
    firstRect.top < secondRect.bottom + BUBBLE_GAP &&
    firstRect.bottom + BUBBLE_GAP > secondRect.top
  );
}

function bubbleRect(group: DraftGroup) {
  const left = group.x ?? BUBBLE_GAP;
  const top = group.y ?? BUBBLE_GAP;
  return {
    bottom: top + estimatedBubbleHeight(group),
    left,
    right: left + BUBBLE_WIDTH,
    top
  };
}

function estimatedBubbleHeight(group: DraftGroup): number {
  const tabRows = Math.max(1, group.tabIds.length);
  return Math.max(BUBBLE_MIN_HEIGHT, 108 + tabRows * 34);
}



function moveTabBetweenDraftGroups(groups: DraftGroup[], tabId: number, targetGroupId: string): DraftGroup[] {
  return groups
    .map((group) => {
      const withoutTab = group.tabIds.filter((id) => id !== tabId);
      if (group.id !== targetGroupId) return { ...group, tabIds: withoutTab };
      return { ...group, tabIds: Array.from(new Set([...withoutTab, tabId])) };
    })
    .filter((group) => group.id === LOOSE_GROUP_ID || group.tabIds.length > 0);
}

function mergeDraftGroupIntoTarget(groups: DraftGroup[], sourceGroupId: string, targetGroupId: string): DraftGroup[] {
  if (sourceGroupId === targetGroupId || sourceGroupId === LOOSE_GROUP_ID) return groups;
  const source = groups.find((group) => group.id === sourceGroupId);
  if (!source) return groups;

  return groups
    .filter((group) => group.id !== sourceGroupId)
    .map((group) => {
      if (group.id !== targetGroupId) return group;
      return {
        ...group,
        explanation: "Merged manually in CleanTab.",
        tabIds: Array.from(new Set([...group.tabIds, ...source.tabIds]))
      };
    });
}

function createDraftGroupWithTab(
  groups: DraftGroup[],
  tabId: number,
  tab?: TabInfo,
  position?: { x: number; y: number }
): DraftGroup[] {
  const existingNewGroup = groups.find(
    (group) => group.label === suggestedGroupLabel(tab) && group.explanation === "Created manually in CleanTab."
  );
  const cleanedGroups = groups
    .map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => id !== tabId)
    }))
    .filter((group) => group.id === LOOSE_GROUP_ID || group.tabIds.length > 0);

  if (existingNewGroup) {
    return cleanedGroups.map((group) =>
      group.id === existingNewGroup.id
        ? {
            ...group,
            ...(position ?? {}),
            tabIds: Array.from(new Set([...group.tabIds, tabId]))
          }
        : group
    );
  }

  return [
    ...cleanedGroups,
    {
      id: `manual:${tabId}:${Date.now()}`,
      label: suggestedGroupLabel(tab),
      explanation: "Created manually in CleanTab.",
      selected: true,
      tabIds: [tabId],
      x: position?.x ?? 24,
      y: position?.y ?? 24
    }
  ];
}

function suggestedGroupLabel(tab?: TabInfo): string {
  if (!tab) return "New group";
  try {
    const domain = new URL(tab.url).hostname.replace(/^www\./, "");
    const firstPart = domain.split(".")[0];
    return firstPart ? titleCase(firstPart) : "New group";
  } catch {
    return "New group";
  }
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
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

function filterTabs(tabs: TabInfo[], query: string): TabInfo[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tabs;
  return tabs.filter((tab) =>
    `${tab.title} ${tab.url} ${tab.groupTitle ?? ""}`.toLowerCase().includes(normalized)
  );
}

function titleForAppTab(tab: AppTab): string {
  if (tab === "cleanup") return "Cleanup";
  if (tab === "groups") return "Grouping suggestions";
  if (tab === "snapshots") return "Workspace snapshots";
  if (tab === "settings") return "Settings";
  return "Dashboard overview";
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
    .filter((cluster) => cluster.tabIds.length >= 2)
    .reduce((sum, cluster) => sum + cluster.tabIds.length, 0);
}

function readInitialTheme(): Theme {
  return localStorage.getItem("cleantab.theme") === "dark" ? "dark" : "light";
}

function readInitialSmartNamesEnabled(): boolean {
  return localStorage.getItem("cleantab.smartNames") !== "disabled";
}

function displayLabelForCluster(cluster: TabCluster, smartNames: SmartNameMap): string {
  return smartNames[cluster.id]?.label ?? cluster.label;
}

function buildDraftGroups(
  clusters: TabCluster[],
  tabs: TabInfo[],
  smartNames: SmartNameMap
): DraftGroup[] {
  const clusteredIds = new Set(clusters.flatMap((cluster) => cluster.tabIds));
  const groups: DraftGroup[] = clusters
    .filter((cluster) => cluster.tabIds.length >= 2)
    .map((cluster) => ({
      id: `draft:${cluster.id}`,
      label: displayLabelForCluster(cluster, smartNames),
      explanation: cluster.explanation,
      tabIds: cluster.tabIds,
      selected: true,
      sourceClusterId: cluster.id
    }));
  const looseTabs = tabs
    .filter((tab) => !clusteredIds.has(tab.id) && tab.url)
    .map((tab) => tab.id);

  if (looseTabs.length > 0) {
    groups.push({
      id: LOOSE_GROUP_ID,
      label: "Unsorted tabs",
      explanation: "Drag these into a bubble if they belong somewhere.",
      tabIds: looseTabs,
      selected: false
    });
  }

  return arrangeDraftGroups(groups);
}

function groupDraftSourceKey(
  clusters: TabCluster[],
  tabs: TabInfo[],
  smartNames: SmartNameMap
): string {
  return JSON.stringify({
    clusters: clusters.map((cluster) => [
      cluster.id,
      displayLabelForCluster(cluster, smartNames),
      cluster.tabIds
    ]),
    tabs: tabs.map((tab) => [tab.id, tab.groupId, tab.groupTitle])
  });
}

function filterDraftGroups(groups: DraftGroup[], visibleTabs: TabInfo[]): DraftGroup[] {
  const visibleIds = new Set(visibleTabs.map((tab) => tab.id));
  return groups
    .map((group) => ({
      ...group,
      tabIds: group.tabIds.filter((id) => visibleIds.has(id))
    }))
    .filter((group) => group.tabIds.length > 0);
}

function buildInsightClusters(
  tabs: TabInfo[],
  smartClusters: TabCluster[],
  heuristicClusters: TabCluster[]
): TabCluster[] {
  const preservedGroups = buildExistingGroupClusters(tabs);
  const preservedIds = new Set(preservedGroups.flatMap((cluster) => cluster.tabIds));
  const smartUngrouped = smartClusters
    .map((cluster) => ({
      ...cluster,
      tabIds: cluster.tabIds.filter((id) => !preservedIds.has(id)),
      explanation: cluster.explanation || "Grouped locally by AI from ungrouped tabs."
    }))
    .filter((cluster) => cluster.tabIds.length >= 2);

  if (smartUngrouped.length === 0) return heuristicClusters;

  const usedIds = new Set([...preservedIds, ...smartUngrouped.flatMap((cluster) => cluster.tabIds)]);
  const remainingHeuristic = heuristicClusters
    .map((cluster) => ({
      ...cluster,
      tabIds: cluster.tabIds.filter((id) => !usedIds.has(id))
    }))
    .filter((cluster) => cluster.tabIds.length >= 2);

  return [...preservedGroups, ...smartUngrouped, ...remainingHeuristic].sort(
    (first, second) => second.tabIds.length - first.tabIds.length || first.label.localeCompare(second.label)
  );
}

function buildExistingGroupClusters(tabs: TabInfo[]): TabCluster[] {
  const byGroup = new Map<number, TabInfo[]>();
  for (const tab of tabs) {
    if (!isTabGrouped(tab)) continue;
    byGroup.set(tab.groupId, [...(byGroup.get(tab.groupId) ?? []), tab]);
  }

  return Array.from(byGroup.entries()).map(([groupId, groupTabs]) => ({
    id: `existing-group:${groupId}`,
    label: groupTabs[0]?.groupTitle || "Existing group",
    confidence: 1,
    explanation: "Preserved from your existing Chrome tab group.",
    tabIds: groupTabs.map((tab) => tab.id),
    domains: Array.from(new Set(groupTabs.map((tab) => domainForDisplay(tab.url)))),
    keywords: []
  }));
}

function domainForDisplay(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function formatSmartNameStatus(status: SmartNameStatus): string {
  if (status === "ready") return "Smart names on";
  if (status === "loading") return "Heuristic (AI warming up...)";
  if (status === "unavailable") return "Model unavailable";
  if (status === "error") return "Using fallback";
  return "Off";
}

function getSmartNameStatusAfterLoad(
  names: SmartNameMap,
  clusters: TabCluster[],
  availability: Awaited<ReturnType<typeof getSmartNameAvailability>>
): SmartNameStatus {
  if (Object.keys(names).length > 0 || clusters.length > 0) return "ready";
  if (availability === "downloading" || availability === "downloadable") return "loading";
  return "unavailable";
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

function snapshotSourceLabel(source: TabSnapshot["source"]): string {
  if (source === "manual") return "Manual";
  if (source === "auto-before-organize") return "Before grouping";
  return "Before cleanup";
}
