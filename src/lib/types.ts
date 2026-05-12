export type SnapshotSource = "manual" | "auto-before-close";

export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  favIconUrl?: string;
  active: boolean;
  pinned: boolean;
  lastAccessed?: number;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
  groupCollapsed?: boolean;
}

export interface WindowSnapshot {
  windowId: number;
  focused: boolean;
  tabs: TabInfo[];
}

export interface TabSnapshot {
  id: string;
  name: string;
  createdAt: number;
  source: SnapshotSource;
  windows: WindowSnapshot[];
}

export interface TabCluster {
  id: string;
  label: string;
  confidence: number;
  explanation: string;
  tabIds: number[];
  domains: string[];
  keywords: string[];
}

export type CleanupSuggestionType =
  | "duplicate"
  | "stale"
  | "same-domain-pile"
  | "likely-reference";

export interface CleanupSuggestion {
  id: string;
  type: CleanupSuggestionType;
  title: string;
  reason: string;
  tabIds: number[];
}

export interface TabStats {
  totalTabs: number;
  totalWindows: number;
  duplicateTabs: number;
  staleTabs: number;
  largestClusterSize: number;
}

export interface TabAnalysis {
  clusters: TabCluster[];
  suggestions: CleanupSuggestion[];
  stats: TabStats;
}
