export { NodeLockFileWatcherAdapter, type LockFileWatcherOptions } from "./lock-file-watcher.ts";
export { VscodeShellIntegrationBridgeAdapter } from "./shell-integration-bridge.ts";
export {
  PsListProcessScanFallbackAdapter,
  type ProcessScanFallbackOptions,
} from "./process-scan-fallback.ts";
export { FileHookLogReaderAdapter } from "./hook-log-reader.ts";
export {
  WorkspaceWatcherAdapter,
  createVscodeRawWatcher,
  type RawWatcher,
  type WorkspaceWatcherDeps,
} from "./workspace-watcher.ts";
