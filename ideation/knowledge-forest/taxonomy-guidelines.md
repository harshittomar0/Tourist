# Knowledge forest — taxonomy guidelines

Scope: defines what belongs in each of the three forests (`knowledge-forest.html`), how to tell them apart when a signal is ambiguous, and what "proficiency" means differently in each. This is the spec the future ingestion/LLM pipeline should be built against — the UI already implements the representation described here.

## The one-question sort

Before anything else, run a new signal through this in order. First match wins — don't let a signal land in two buckets.

1. **Is it a fact about a specific tool, library, framework, or platform?**
   → **Tech Stack.** ("Uses Django's ORM", "wrote a Dockerfile", "knows Redux")
2. **Is it a transferable concept that would still be true if the person switched languages/frameworks tomorrow?**
   → **CS Fundamentals.** ("understands why a hashmap is O(1) average case", "knows what a race condition is")
3. **Is it a habit or outcome evidenced by *process* artifacts (PRs, reviews, tickets, incidents) rather than by code content itself?**
   → **Engineering Practice.** ("PRs are small and well-described", "gets flagged for the same review comment repeatedly")

If a signal seems to answer yes to more than one, it's usually two *separate* nodes in two *separate* forests that should cross-reference each other (see "Cross-linking," below) — not one node that tries to live in both places.

---

## 1. Tech Stacks

**Definition:** capability with a specific, named tool. If you'd put it on a resume's "Skills" line or find it in a `package.json`/`requirements.txt`, it's here.

**In scope:** languages, frameworks, libraries, SDKs, platforms, build/CI tooling, specific product APIs (Stripe API, AWS S3, etc).

**Out of scope:**
- The *theory* behind why the tool works (→ CS Fundamentals). "Knows Redux" is Tech Stack; "understands the reducer/immutability pattern generally" is Architecture & Design (CS Fundamentals).
- Whether they use the tool *well* in a process sense (→ Engineering Practice). "Writes tests" is Tech Stack only in the sense of "knows the pytest API" — whether they *actually consistently write good tests* is Testing Discipline (Practice).

**Taxonomy depth:**
- **Root** = a stack grouping, usually domain + primary language/platform (`"Backend — Python"`, `"Infra — Docker/K8s"`). One root per coherent stack, not one root per language if several stacks share a language.
- **Branch** = a framework or major library within that stack (`Django`, `Hooks`).
- **Leaf** = a specific feature/sub-capability of that framework (`ORM & migrations`, `Celery / async tasks`).

**Evidence sources (for the future pipeline):** commit history (file types, import statements), dependency manifests, PR/commit messages naming tools, CI/build config files, actual usage complexity (basic CRUD vs. advanced features of the same library).

**Proficiency (0–5) means:** *fluency with the tool's surface area* — how much of the tool's feature set they've exercised, and how recently. It is NOT a judgment of code quality (that's Practice) or of whether they understand *why* the tool is designed that way (that's CS Fundamentals).

**Node-breaking rule (latent → branch):** break a leaf into a branch once there's evidence of at least 2 distinguishable sub-capabilities of that leaf being used differently (e.g. "Async / asyncio" breaks into "Concurrency patterns" + "Race-condition debugging" once both show up in separate commits/PRs).

---

## 2. CS Fundamentals

**Definition:** knowledge that survives a tech-stack change. Would still be true and relevant if the person moved from Python to Go to Rust.

**In scope:** algorithmic complexity/Big-O, data structure tradeoffs, concurrency *theory* (not a specific async API), distributed systems concepts, design patterns as abstract shapes, SOLID/architecture principles, security *principles* (not a specific scanning tool).

**Out of scope:**
- Naming a specific tool that implements the concept (→ Tech Stack). "Uses a mutex" implies the concept; "knows `threading.Lock()` in Python" is the tech-stack expression of it. Track the concept here, the API usage there — cross-link.
- Whether they document or communicate the concept well to others (→ Engineering Practice).

**Taxonomy depth:**
- **Root** = a CS domain (`Algorithms & Complexity`, `Data Structures`, `Concurrency & Systems`, `Architecture & Design`, `Security Fundamentals`).
- **Branch** = a sub-area within that domain (`Graph algorithms`).
- **Leaf** = a specific concept or technique (`Big-O / asymptotic analysis`, `NP-completeness & reductions`).

**Evidence sources (harder than Tech Stack — repo-scanning alone under-detects this):**
- Deliberate algorithmic choices visible in code (chose a hashmap over a linear scan — weak but real signal).
- Explanatory comments, design docs, or PR descriptions that *reason about* the concept rather than just using it.
- Incident postmortems that trace a bug back to a theoretical misunderstanding (e.g. "root cause: assumed operations were idempotent") — this is actually the **strongest** signal available for this forest, stronger than code-pattern inference.
- Direct probing (quiz/interview-style questions) is likely necessary here as a supplement — passive signal is weak for this forest specifically. Flag this as a known gap in the inference plan, not something to solve by better repo scanning.

**Proficiency (0–5) means:** *depth of understanding*, not frequency of use. Someone can score high here having used the concept only once, if the usage or explanation shows real understanding — this is the opposite weighting from Tech Stack, where repetition matters more than any single demonstration.

**Node-breaking rule:** break when a general concept shows evidence of being differentiated into named sub-techniques (e.g. "Graph algorithms" breaks into "Advanced graph (Dijkstra, A*)" once shortest-path-specific reasoning shows up, distinct from generic BFS/DFS).

---

## 3. Engineering Practice

**Definition:** a habit or outcome, evidenced by *what happened around the code* (reviews, tickets, incidents, delivery) rather than by the code's content or the tools it uses.

**In scope:** code review behavior (given and received), PR/commit hygiene, testing *discipline* (as opposed to testing *API knowledge*, which is Tech Stack), bug/defect patterns, debugging ability, documentation habits, estimation accuracy, incident ownership, mentoring.

**Out of scope:**
- Knowing *how* to write a test in a given framework (→ Tech Stack).
- Understanding *why* a given testing strategy works theoretically (→ CS Fundamentals, if it ever comes up — usually doesn't need its own node).

**Taxonomy depth:**
- **Root** = a practice domain (`Code Quality & Craft`, `Testing Discipline`, `Review & Collaboration`, `Delivery & Ownership`).
- **Branch** = a sub-practice (`Async communication`).
- **Leaf** = a specific measurable habit (`PR / commit hygiene`, `Responsiveness to feedback (received)`).

**Evidence sources:** PR metadata (size, description quality, revert rate), review-comment history (given vs. received, and whether the same category recurs), issue-tracker data (estimate vs. actual time), incident/postmortem involvement, documentation contributions, churn/rewrite frequency on the same files.

**Proficiency (0–5) means:** *consistency of the behavior over time*, not capability. This is the forest most sensitive to recency and sample size — a single well-written PR doesn't establish "good PR hygiene" the way a single correct use of a hashmap can still count for CS Fundamentals. Weight this forest's confidence more conservatively than the other two until there's a real sample size (a dozen+ data points, not one or two).

**Node-breaking rule:** break when a general habit shows evidence of splitting into distinguishable sub-behaviors (e.g. "Async communication" breaks into "Documentation habits" + "Mentoring / knowledge sharing" once both show up as separately observable).

---

## Cross-cutting rules (apply to all three forests)

- **Provenance (`confirmed` / `ai` / `gap`) means the same thing everywhere:** `confirmed` = the person has verified it (via a dot-click or explicit confirm), `ai` = inferred, awaiting review, `gap` = explicitly declared absent (either self-declared or demoted from a rejected AI guess). Don't reinterpret provenance per-forest — only the *evidence that produces it* differs per forest, per the "Evidence sources" sections above.
- **A whole root can be `ai` or `gap`**, not just leaves — this is deliberate and signals "we have almost no signal about this entire domain" (e.g. `Infra — Docker/K8s`, `Security Fundamentals`, `Delivery & Ownership` in the current mock data). Don't force a root to `confirmed` just because it's a root.
- **Cross-linking, not duplication:** when a signal is genuinely relevant to two forests (e.g. "uses `asyncio`" → Tech Stack; "understands concurrency" → CS Fundamentals), create two separate nodes, one per forest, and (future UI work) let one reference the other. Never let one node try to represent both a tool-fact and a theory-fact at once — it breaks the proficiency-scale semantics described above, since each forest scores proficiency on a different axis (fluency vs. depth vs. consistency).
- **When genuinely unsure which bucket:** default to Tech Stack if a specific tool is named anywhere in the signal, even loosely — it's the easiest bucket to source evidence for and the safest default. Reclassify later if a CS or Practice angle turns out to dominate.

## Worked examples (borderline cases)

| Signal | Bucket | Why |
|---|---|---|
| "Wrote a Redux reducer" | Tech Stack (React branch) | Names a specific library |
| "Understands unidirectional data flow" | CS Fundamentals (Architecture & Design) | Transfers to Vuex, Redux, or a hand-rolled store equally |
| "PR reverted twice for the same bug category" | Engineering Practice (Delivery & Ownership) | Evidenced by process history, not code content |
| "Uses a hashmap instead of nested loops" | CS Fundamentals (Algorithms & Complexity), weak signal | Algorithmic choice, but passive/inferred — flag low-confidence `ai` |
| "Writes docstrings on every function" | Engineering Practice (Code Quality & Craft) | Habit, evidenced by consistency across many files |
| "Knows pytest fixtures" | Tech Stack (Testing (pytest) leaf) | Names the specific tool/API |
| "Tests are shallow / don't catch real bugs" | Engineering Practice (Testing Discipline) | Judgment about outcome/habit, not tool knowledge |
| "Race condition caused a production incident" | Both — CS Fundamentals leaf gets a strong `ai`→review signal from the postmortem; Delivery & Ownership gets an incident-ownership data point | Same event, two distinct nodes, cross-linked |
