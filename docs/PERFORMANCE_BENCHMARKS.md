# Performance & Memory Benchmarks

## Extension Memory Footprint
- Background Service Worker: < 35MB active, < 5MB dormant
- Cockpit Popup UI: < 25MB initial render

## Sync Benchmarks
- Tab event debouncing: 250ms threshold
- Session batching: max 100 tab records per transaction
