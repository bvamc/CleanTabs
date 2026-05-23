# CleanTabs Architecture

## Service Worker Lifecycle
- Listen to `chrome.tabs.onCreated` and `chrome.tabs.onRemoved`
- Synchronize tab state using debounced chrome storage writes
