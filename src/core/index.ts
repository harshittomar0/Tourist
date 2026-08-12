export type {
  Disposable,
  Origin,
  Tier,
  AttributedRange,
  NormalizedChange,
  ChangeReason,
  NormalizedChangeBatch,
  WholeFileDiffInput,
} from "./types.ts";

export { PieceTable, type RangeEdit } from "./piece-table.ts";
export { computeLineDiffHunks, lineStartOffsets, type Hunk } from "./line-diff.ts";
export { hashContent } from "./hash.ts";

export {
  CorroborationStore,
  snapshotKeyFor,
  type CorroborationSource,
  type CorroborationSignal,
  type CorroborationEntry,
  type CorroborationSnapshot,
} from "./corroboration-store.ts";

export { classifyLiveChange, classifyWholeFileDiffSpan, type Classification } from "./tier-classifier.ts";

export { createExclusionPredicate, DEFAULT_EXCLUDES, type ExclusionPredicate } from "./exclusion.ts";

export { createSnapshotStore, type SnapshotStore } from "./snapshot-store.ts";

export { AttributionEngine, type EngineDeps } from "./engine.ts";

export type {
  LockFileWatcherAdapter,
  ShellIntegrationBridgeAdapter,
  ProcessScanFallbackAdapter,
  HookLogReaderAdapter,
} from "./adapter-interfaces.ts";
