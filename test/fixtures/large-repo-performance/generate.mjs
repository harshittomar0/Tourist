#!/usr/bin/env node
// Generates a synthetic large-repo fixture on demand (never checked into
// git) for Phase 4's activation/scan-performance and watcher-overhead
// benchmarks. See README.md. Skeleton: produces the tree + a git repo +
// MANIFEST.json; the benchmark harness that consumes it is Phase 4's job.
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function parseArgs(argv) {
  const args = { out: "/tmp/tourist-large-repo-fixture", files: 10000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--files") args.files = Number(argv[++i]);
  }
  return args;
}

// Roughly mirrors a real monorepo's shape: most files are real tracked
// source, a meaningful minority live under paths the default exclusion
// predicate must reject before ever watching them (RESEARCH1.md's
// exclusion-filter requirement).
const BUCKETS = [
  { dir: "src", ext: ".ts", tracked: true, weight: 0.55 },
  { dir: "test", ext: ".test.ts", tracked: true, weight: 0.15 },
  { dir: "node_modules/some-dep/dist", ext: ".js", tracked: false, weight: 0.2 },
  { dir: "dist", ext: ".js", tracked: false, weight: 0.1 },
];

function main() {
  const { out, files } = parseArgs(process.argv.slice(2));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const manifest = { totalFiles: files, buckets: {} };
  let remaining = files;
  BUCKETS.forEach((bucket, i) => {
    const isLast = i === BUCKETS.length - 1;
    const count = isLast ? remaining : Math.round(files * bucket.weight);
    remaining -= count;
    const bucketDir = path.join(out, bucket.dir);
    mkdirSync(bucketDir, { recursive: true });
    for (let n = 0; n < count; n++) {
      const sub = path.join(bucketDir, `g${n % 200}`);
      mkdirSync(sub, { recursive: true });
      writeFileSync(path.join(sub, `file${n}${bucket.ext}`), `// synthetic fixture file ${n}\nexport const value${n} = ${n};\n`);
    }
    manifest.buckets[bucket.dir] = { count, tracked: bucket.tracked };
  });

  writeFileSync(path.join(out, ".gitignore"), "node_modules/\ndist/\n");
  writeFileSync(path.join(out, "MANIFEST.json"), JSON.stringify(manifest, null, 2));

  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: out });
  execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: out });
  execFileSync("git", ["config", "user.name", "Fixture"], { cwd: out });
  execFileSync("git", ["add", "-A"], { cwd: out });
  execFileSync("git", ["commit", "-q", "-m", "synthetic large-repo fixture"], { cwd: out });

  console.log(`generated ${files} files under ${out}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
