import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  attributionLogPath,
  loadAttributionLog,
  partitionLinesByAuthor,
  sha1
} from "../src/sources/attributionSource.js";

let tmpConfigDir: string;

beforeEach(() => {
  tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "kf-attribution-test-"));
});

afterEach(() => {
  fs.rmSync(tmpConfigDir, { recursive: true, force: true });
});

function writeLog(configDir: string, records: object[]): void {
  const dir = path.join(configDir, "tourist-attribution");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ai-edits.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("attributionLogPath", () => {
  it("points inside tourist-attribution under the given config dir", () => {
    expect(attributionLogPath("/tmp/fake-claude")).toBe(path.join("/tmp/fake-claude", "tourist-attribution", "ai-edits.jsonl"));
  });
});

describe("loadAttributionLog", () => {
  it("returns an empty array when no log file exists", () => {
    expect(loadAttributionLog(tmpConfigDir)).toEqual([]);
  });

  it("parses valid JSONL records and skips malformed lines", () => {
    const dir = path.join(tmpConfigDir, "tourist-attribution");
    fs.mkdirSync(dir, { recursive: true });
    const goodRecord = { ts: 1, cwd: "/x", file: "/x/a.ts", tool: "Edit", contentHash: "abc", aiRanges: [{ start: 0, end: 1 }] };
    fs.writeFileSync(path.join(dir, "ai-edits.jsonl"), `${JSON.stringify(goodRecord)}\nnot json\n\n`, "utf8");

    const records = loadAttributionLog(tmpConfigDir);

    expect(records).toHaveLength(1);
    expect(records[0].file).toBe("/x/a.ts");
  });
});

describe("partitionLinesByAuthor", () => {
  it("splits lines by the matching record's aiRanges when content hash matches exactly", () => {
    const filePath = "/repo/src/thing.ts";
    const content = "line0\nline1\nline2\nline3";
    writeLog(tmpConfigDir, [
      { ts: 1, cwd: "/repo", file: filePath, tool: "Edit", contentHash: sha1(content), aiRanges: [{ start: 1, end: 2 }] }
    ]);

    const records = loadAttributionLog(tmpConfigDir);
    const result = partitionLinesByAuthor(records, filePath, content);

    expect(result.matched).toBe(true);
    expect(result.aiLines).toEqual(["line1", "line2"]);
    expect(result.humanLines).toEqual(["line0", "line3"]);
  });

  it("falls back to treating everything as human when no record matches", () => {
    const filePath = "/repo/src/other.ts";
    const content = "a\nb\nc";
    writeLog(tmpConfigDir, [
      { ts: 1, cwd: "/repo", file: filePath, tool: "Edit", contentHash: "totally-different-hash", aiRanges: [{ start: 0, end: 0 }] }
    ]);

    const records = loadAttributionLog(tmpConfigDir);
    const result = partitionLinesByAuthor(records, filePath, content);

    expect(result.matched).toBe(false);
    expect(result.humanLines).toEqual(["a", "b", "c"]);
    expect(result.aiLines).toEqual([]);
  });
});
