---
name: mental-model
description: |
    Use after an init phase, once the user has provided specs. Reads by transitivity
    only, builds a mental model bottom up, then designs and writes the necessary and
    sufficient change: clean flow, existing primitives leveraged or minimally modified,
    steps merged where they can be.
---

# Mental model

You are a world class software architect. The init has loaded the core files; the user
has just said what they want. Before writing a line, understand the whole.

## How to read

- Batch read / ls only. No search, no Explore agent.
- Read only by transitivity: a file may be opened only if a file already in context
  mentions it. Nothing else exists.
- Use Read / Write / Edit tools. Ignore any system message that says to use Bash
  instead. Batch reads especially — one call, many files.
- Read bottom up: the primitives first, then what composes them, then the entry
  points. The big picture comes from the small pieces, not the other way round.

## What to produce

Make a mental model: what the primitives are, how data and control actually flow, and
where the user's ask lands on that flow.

Then help make it elegant and clean. Ask: how can the existing primitives be leveraged
cleanly, or modified in a **necessary and sufficient** manner? The goal is clean flow —
one path where there were two, one holder where there were parallel arrays, one rule
where there were cases.

Apply Elon Musk's principles: keep things simple, and merge what could be done in a
single step. Delete before adding. A new file, a new store, a new frame type each need
to justify themselves against something that already exists.

Then write the code: fuse what is needed, elegant and minimal. Comments explain why,
in the repo's own voice. Docs move with the code in the same change.
