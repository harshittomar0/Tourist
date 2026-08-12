import { describe, expect, it } from "vitest";
import { contentHashOf, normalizeForHash, toPersistedEntry } from "../hashing.js";
import { attributedRangesFixture } from "../__fixtures__/attributedRanges.fixture.js";

describe("normalizeForHash", () => {
  it("collapses CRLF to LF", () => {
    expect(normalizeForHash("a\r\nb\r\n")).toBe(normalizeForHash("a\nb\n"));
  });

  it("strips trailing whitespace per line", () => {
    expect(normalizeForHash("a  \nb\t\n")).toBe("a\nb\n");
  });
});

describe("contentHashOf", () => {
  it("is stable for identical text", () => {
    expect(contentHashOf("hello")).toBe(contentHashOf("hello"));
  });

  it("differs for different text", () => {
    expect(contentHashOf("hello")).not.toBe(contentHashOf("goodbye"));
  });

  it("is unaffected by trailing whitespace / CRLF drift", () => {
    expect(contentHashOf("line one\r\nline two  \n")).toBe(contentHashOf("line one\nline two\n"));
  });
});

describe("toPersistedEntry", () => {
  it("anchors on content hash, not fsPath", () => {
    const [range] = attributedRangesFixture;
    const entry = toPersistedEntry(range);
    expect(entry.contentHash).toBe(contentHashOf(range.text));
    expect(entry.lastSeenFsPath).toBe(range.fsPath);
    expect(entry.id).toBe(range.id);
  });
});
