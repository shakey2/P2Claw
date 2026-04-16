# When to split `DESIGN.md` (and related docs)

Companion note for [DESIGN.md](../DESIGN.md) §2.9. Keep this file updated if the splitting guidance itself evolves.

---

## When is it “too big”?

There is no universal line count, but these **signals** mean you should **outline or split** soon:

| Signal | Meaning |
|--------|---------|
| **~800–1200+ lines** in a single markdown file | Often a good time to **plan a split** — many teams feel pain around here. |
| **Multiple “books” in one file** | e.g. philosophy + API tables + module map + roadmap + decision log + extension tiers — readers need **jump targets**, not one endless scroll. |
| **You hesitate to add a section** because it makes the doc harder to load | Practical “too big” — the doc is fighting you. |
| **Tools / humans only need a slice** most of the time | If most edits only need §2 + §4 but you always attach the whole file, prefer **thin core + deep dives**. |

**Bottom line:** You do not need to split at ~350 lines. Plan to **refactor the doc like code** when you cross roughly **~800 lines**, or **sooner** if the table of contents becomes unwieldy or you add large new pillars (optional modules, memory/RAG tiers, long roadmaps).

---

## Practical pattern (minimize context pain)

1. **Keep `DESIGN.md` lean**: vision, non-negotiables, short architecture map, **links** to depth elsewhere.
2. **Move depth out**: e.g. `docs/player2-details.md`, `docs/memory-and-rag.md`, long API tables, extended roadmap — as they grow.
3. **Decision log**: can stay at the bottom of `DESIGN.md` until noisy; then move to `docs/decisions.md` (or similar) and link from `DESIGN.md`.
4. **TOC at the top** of `DESIGN.md` is cheap insurance while the file is still single-file.

**Cursor / AI tip:** Prefer **one job per file**; reference `DESIGN.md` for global rules and a focused doc (e.g. memory) when working in that area, instead of one megadoc for every task.

---

*Derived from project discussion, 2026-04-15.*
