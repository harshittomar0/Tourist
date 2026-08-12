import { createHash } from "node:crypto";

/** Content-hash used for undo/redo history keys and hook-log cross-checks. */
export function hashContent(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}
