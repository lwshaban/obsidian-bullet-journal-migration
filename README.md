# Bujo for Obsidian

Automate your bullet journal workflow in Obsidian with powerful task migration markers and automated review generation.

> **Note:** This plugin was created independently by a fan of the Bullet Journal method and is not affiliated with or endorsed by the official Bullet Journal system. To learn about and support the original creator and methodology, please visit: [bulletjournal.com](https://bulletjournal.com/pages/book)

## Overview

This plugin implements a complete bullet journal migration system for Obsidian, allowing you to:
- **Migrate tasks** between daily, weekly, and monthly notes using simple markers
- **Pick destinations without memorizing markers** — type `[>` in a task for an autocomplete of dates and a calendar picker
- **Generate reviews** automatically from incomplete tasks
- **Schedule tasks** to specific days, weeks, or months
- **Carry subtasks with their parent** as context when migrating
- **Schedule recurring tasks** ("every 3 weeks until the end of the year")
- **Track task types** (events, appointments, information points)

> **Reliability:** task lookups use Obsidian's metadata cache and all edits are written atomically, so migrations locate the right task and won't clobber concurrent edits (e.g. from Sync).

## Folder Structure

Out of the box the plugin looks for this layout:

```
Journal/
├── 001 Daily Notes/        # Daily notes (YYYY-MM-DD.md)
├── 002 Weekly Notes/       # Weekly notes (YYYY-Www.md)
├── 003 Monthly Notes/      # Monthly notes (YYYY-MM.md)
├── 004 Yearly Notes/       # Yearly notes (YYYY.md)
├── 006 Future Log/         # Future log (YYYY - Future Log.md)
└── Bujo Reviews/           # Generated reviews
    ├── Weekly/             #   YYYY-Www-Review.md
    ├── Monthly/            #   YYYY-MM-Review.md
    ├── Range/              #   YYYY-MM-DD_YYYY-MM-DD-Review.md
    └── Global/             #   Global-Review-YYYY-MM-DD-HHmm.md
```

**The file names matter; the folder names don't.** Every folder above is
configurable in **Settings → Bujo**, so point them wherever your vault already
keeps these notes:

| Setting | Default |
|---------|---------|
| Daily notes folder | `Journal/001 Daily Notes` |
| Weekly notes folder | `Journal/002 Weekly Notes` |
| Monthly notes folder | `Journal/003 Monthly Notes` |
| Yearly notes folder | `Journal/004 Yearly Notes` |
| Future log folder | `Journal/006 Future Log` |
| Reviews folder | `Journal/Bujo Reviews` |
| Templates folder | `Obsidian/Templator/Journal` |

Notes are named by date — `2026-01-15.md`, `2026-W03.md`, `2026-01.md`,
`2026.md` — and weekly notes use the **ISO week-year**, so a week spanning New
Year belongs to the year that owns most of it (2024-12-30 lives in
`2025-W01.md`).

### Templates

When a migration needs a note that doesn't exist yet, the plugin creates it from
a template in the configured templates folder:

| Note type | Template file |
|-----------|---------------|
| Daily | `Daily-Template.md` |
| Weekly | `Weekly-Template.md` |
| Monthly | `Monthly-Template.md` |
| Future log | `Future-Log-Template.md` |

[Templater](https://github.com/SilentVoid13/Templater) is used to expand the
template if you have it installed. With no matching template the note is simply
created with the task in it, so templates are optional.

Migrated tasks are added under a `## Plan` heading in weekly and monthly notes,
`## Notes` in daily notes, and under the matching month heading (or
`## General`) in the future log. Without those headings the task is appended to
the end of the note.

They go at the **end** of that section, so a batch arrives in the order you
marked it up and joins any list already there.

## Quick Entry (Autocomplete)

You don't have to memorize the marker codes below. In any task line, start typing the checkbox marker `[>` and an autocomplete appears:

- **Tomorrow**, **Next week**, **Next month** — with their resolved dates shown
- **Pick a date…** — opens a calendar where clicking a **day** targets the daily note, a **week number** the weekly note, and the **month title** the monthly note
- Type a code directly (e.g. `[>w2`, `[>fri`, `[>m3w`) and the popup previews the exact resulting date

Relative markers resolve **from today**, not from the note they're written in: `[>w]` means the week after this one, wherever you typed it. Reviews are processed days or weeks after the notes were written, and anchoring on the note meant `[>>]` in last Tuesday's note migrated a task into last Wednesday — the past, where you'd never see it again. Explicit destinations (`[>2026-12-15]`, `[>2026-W32]`, `[>2026-12]`) always mean exactly what they say.

The `[+>` (new task) and `[->` (information point) prefixes get the same autocomplete.

## Migration Markers

The markers below are what the autocomplete writes for you — you can also type them by hand.

### Basic Migration Markers

Add these markers as the checkbox in your task notes:

| Marker | Description | Example |
|--------|-------------|---------|
| `[>w]` | Migrate to next week | `- [>w] Task` |
| `[>m]` | Migrate to next month | `- [>m] Task` |
| `[>>]` | Migrate to tomorrow | `- [>>] Task` |
| `[>fut]` | Migrate to future log | `- [>fut] Task` |
| `[<w]` | Migrate to current week | `- [<w] Task` |
| `[>:]` or `[>\|]` | Migrate to today | `- [>:] Task` |

### Specific Day/Week Markers

| Marker | Description |
|--------|-------------|
| `[>mon]`, `[>tue]`, `[>wed]`, `[>thu]`, `[>fri]`, `[>sat]`, `[>sun]` | Next occurrence of that day |
| `[>w1]`, `[>w2]`, `[>w3]`, `[>w4]` | 1-4 weeks on from today |
| `[>m1w]` … `[>m4w]` | Nth week of the month, rolling into next month if that week has already started |

### Specific Month Markers

| Marker | Description |
|--------|-------------|
| `[>jan]`, `[>feb]`, `[>mar]`, etc. | Next occurrence of that month |

### Task Type Markers (Source & Destination Checkboxes)

Control what checkbox type appears in the source note (after migration) and destination note independently:

- **`(...)`** - Source checkbox: What the task becomes in the original note after migration
- **`{...}`** - Destination checkbox: What the task becomes in the target note

| Syntax | Description | Source After | Destination |
|--------|-------------|--------------|-------------|
| `[>w]` | Default migration | `[>]` | `[ ]` |
| `[>w{o}]` | Event at destination | `[>]` | `[o]` |
| `[>w(/)]` | Preserve in-progress in source | `[/]` | `[ ]` |
| `[>w(/){o}]` | In-progress source, event destination | `[/]` | `[o]` |
| `[>w(/){/}]` | Preserve in-progress in both | `[/]` | `[/]` |
| `[>fri{a}]` | Appointment on Friday | `[>]` | `[a]` |
| `[>w{.}]` | Information point (plain list) | `- Task` | `- Task` |

#### Examples

**Partially completed task - preserve state:**
```markdown
- [>w(/)] Research project
```
- Source becomes: `- [/] Research project` (stays in-progress)
- Destination becomes: `- [ ] Research project`

**Different states for source and destination:**
```markdown
- [>fri(/){=}] Design review
```
- Source becomes: `- [/] Design review` (marked in-progress)
- Destination becomes: `- [=] Design review` (custom checkbox)

### Mark Without Migrating

| Marker | Description |
|--------|-------------|
| `[>skip]` or `[>x]` | Mark as migrated without actually migrating |
| `[<]` | Mark as already scheduled |
| `[>-]` | Mark as migrated without migrating |

### New Task Markers

Create new tasks that don't require a source:

| Marker | Description |
|--------|-------------|
| `[+>w]` | Create new task for next week |
| `[+>m]` | Create new task for next month |
| `[+>tue]` | Create new task for next Tuesday |
| `[+>fri{o}]` | Create event for Friday |

### Information Point Markers

Migrate items as plain list items (no checkboxes):

| Marker | Description |
|--------|-------------|
| `[->w]` | Migrate as info point to next week |
| `[->m]` | Migrate as info point to next month |
| `[->fri]` | Migrate as info point to Friday |

## Commands

Nine commands, in two groups. The three you run on a note are prefixed `Run:`,
so typing `bujo run` in the palette narrows to exactly those; the cursor-level
ones keep plain names and are usually bound to keys rather than searched for.
(Obsidian's **Command palette** core plugin can also pin commands to the top of
the list, which works without any naming convention.)

### Generate review
**Command:** `Run: Generate review`

Opens a short list — pick one and it generates:

| Row | What it does |
|---|---|
| **Week** | last week, or the week of the note you're in |
| **Month** | last month, or the month of the note you're in |
| **Global** | every journal note whose period has passed |
| **Between dates…** | any from→to range, up to 1000 days |
| **More options…** | the full form: period *and* which entries to list |

The form adds one more choice — **Include**:

| Toggle | Entries | Use |
|---|---|---|
| Open work | `[ ]` `[s]` `[/]`, and anything already carrying a marker | the normal review; on by default |
| Events and the like | `[o]` `[a]` `[i]` `[?]` and other types | reading a period back |
| Already filed | `[>]` `[<]` `[+]` | recovery — see below |
| Completed | `[x]` | a retrospective: what actually got done |
| Cancelled | `[-]` | what you dropped |

**Open work means what can still move** — a task, something scheduled, something
in progress. An event or an appointment belongs to the day it happened:
"migrate to next week" means nothing for a dinner that was on the 3rd, so those
are left where they are unless you ask for them.

Marking one overrides that. `- [>fri] Dentist` is an explicit instruction to
move it, so it appears in the review whatever type it is.

**Plain bullets are not entries.** A bare `- note to self` is context: it travels
with whatever task it sits under rather than appearing as its own line. To move
one deliberately, give it a marker — `- [->w] note` migrates it and keeps it a
plain bullet at the destination.

Also left out:

- **Frontmatter.** A note's `tags:` and `aliases:` are YAML list items — bullets,
  as far as a text scan is concerned — so they are skipped rather than listed as
  things to triage.
- **Entries over 5000 characters** (about 800 words), which are held back with a
  note in the review saying how many and why. Almost always this is an image pasted straight into a
  note: Obsidian stores it inline as base64, so one bullet becomes a few hundred
  kilobytes of text, and a single line that long makes the review unusable to
  type in — the editor re-renders it on every keystroke. The entry stays
  untouched in its own note.

**Already filed** is the way back to a task whose migration didn't land where you
expected: a normal review treats `[>]` as settled and will never show it again.
Replace the `[>]` with a destination marker (e.g. `[>m]`) to migrate it again;
leave it as `[>]` to ignore it.

Completed and cancelled entries are listed for reference — leaving an `[x]` or
`[-]` line alone changes nothing in the source.

Anything beyond outstanding entries is written to a separate `…-Review-all`
note, so a review you have already marked up is never overwritten. Date-range
reviews land in `Bujo Reviews/Range/`.

Once every entry in a review has been dealt with, the review file is moved to
the vault trash. If anything failed, the review is **kept** so you can see what
is outstanding and run it again — the notice tells you how many failed.

### Migrate tasks
**Command:** `Run: Migrate tasks`

Processes the current note, migrating all marked tasks to their destinations.
Auto-detects the note type (daily, weekly, monthly, or a generated review) — this
is the one command you run to "process" whatever note you're in. **With text
selected it processes only the selection**, which is how you work through a long
review a few items at a time.

### Schedule tasks
**Command:** `Run: Schedule tasks`

Like **Run: Migrate tasks** — including the selection rule — but marks the source
`[s]` (scheduled) instead of `[>]` (migrated), for planning notes where the task
is being placed onto a future date rather than moved out.

### Task commands

| Command | Does |
|---|---|
| `Mark task for migration` | opens the checkbox and the destination picker on the current line |
| `Complete task` / `Cancel task` | set `[x]` / `[-]`, advancing to the next task if **Auto-advance** is on |
| `Go to next task` / `Go to previous task` | walk the note's tasks |
| `Go to next unfinished task` | skip anything already dealt with |

Recurring tasks have no command of their own: **Repeating…** is a row in the
destination picker (`Alt+R`). See [Recurring Tasks](#recurring-tasks).

## Settings

**Settings → Bujo** configures where the plugin reads and writes:

- **Folders** — the seven paths listed under [Folder Structure](#folder-structure). Clearing a box restores its default.
- **Debug logging** — off by default. Turn it on to trace migrations in the developer console (**Ctrl/Cmd + Shift + I**) when a task ends up somewhere unexpected. Warnings and errors are always logged.

## Recurring Tasks

Open the destination picker on a task line — type `[>` or run
**Mark task for migration** — and choose **Repeating…** (or press `Alt+R`).
Unlike every other row it writes no marker, because recurrence isn't one
destination; it opens a small dialog:

- **Every** N **days / weeks / months** — the unit picks where occurrences land, matching the markers: days → daily notes, weeks → weekly notes, months → monthly notes.
- **Until** a date (defaults to the end of the year).

Every occurrence is created as a plain `- [ ]` task in the matching note, up to a safety limit of 100. The source task is left as-is, and re-running is safe (duplicates are skipped). For example, "every 3 weeks until the end of the year" for *Call grandma* seeds `- [ ] Call grandma` into each third weekly note.

## Workflow Examples

### Daily Workflow

1. Open today's daily note
2. Add migration markers as checkboxes for incomplete tasks:
   ```markdown
   - [>mon] Call dentist
   - [>>] Review presentation
   - [>m{o}] Plan vacation event
   ```
3. Run "Migrate tasks" command
4. Tasks are automatically migrated to their destinations

### Weekly Review Workflow

1. Run "Generate weekly review" command
2. Review the generated list of incomplete tasks
3. Add migration markers as checkboxes:
   ```markdown
   - [>w{a}] Finish project proposal appointment
   - [>fut] Read article
   - [<] Update documentation
   ```
4. Run "Migrate tasks" command (on the review document)
5. Tasks are migrated accordingly

### Monthly Planning Workflow

1. Run "Generate monthly review" command
2. Review all incomplete tasks from the month
3. Add markers to schedule tasks for next month
4. Run "Migrate tasks" command (on the review document)

## Task Migration Behavior

- **Completed tasks** (`[x]`): Ignored, stay in source, not migrated
- **Cancelled tasks** (`[-]`): Ignored, stay in source, not migrated
- **Tasks with migration markers**: Migrated to destination and marked as `[>]` or `[<]` in source
- **Child tasks**: Only **incomplete** children automatically migrate with parent
  - Completed children (`[x]`) stay in source
  - Cancelled children (`[-]`) stay in source
  - Children can override parent's destination with their own marker
- **Migrating a subtask alone**: its parent is carried along as a plain-bullet **context** line (not a duplicate task) so the subtask doesn't arrive orphaned; if that parent already exists at the destination, the subtask nests under it
- **Information points**: Created as plain list items without checkboxes
- **Deduplication**: Tasks with identical text (normalized) are not added if an **open** copy already exists in the destination
  - Prevents duplicate entries when migrating the same task multiple times
  - Comparison is case-insensitive and ignores extra whitespace
  - Example: Migrating "Call dentist" to Friday on Monday, Tuesday, and Wednesday results in only one entry in Friday's note
  - A copy there that has already been dealt with (`[x]`, `[-]`, `[>]`, `[<]`, `[+]`) is a record of a past cycle, not a place for the task to land, so a fresh open copy is written
  - `[s]` is **not** dealt with. Scheduled means the task has a date, not a resolution: it still counts as a copy at the destination, it shows up in reviews, and a marker in a review overrides it

### Nothing is marked migrated until it has landed

A source task is only crossed out once the item has been **read back** from its
destination note. The destination is written first and verified; the source is
touched after. So:

- If the destination write fails or silently does nothing, the task keeps its
  marker, the migration is reported as an error, and the review is kept for
  another pass. A task is never marked `[>]` with nowhere to go.
- A marker that resolves to the note the task is already in (e.g. `[>:m]` inside
  this month's note) is refused with an error rather than crossing the task out
  in place.
- The worst case is a duplicate at the destination, which the next run dedups
  away — never a lost task.
- When the destination already held an open copy, the migration counts but the
  notice says so: `• n already open at destination (merged)`.
- A marker in a review overrides whatever **open** state the task is in — `[ ]`,
  `[s]`, `[o]`, `[/]` — not just an empty checkbox. Marking a scheduled task
  `[<]` in a review rewrites the source, and carries its open children with it.
- States are never walked backwards: completing a task that is already `[x]`,
  or scheduling one that is already `[<]`, leaves it as it is and reports a skip
  instead of failing the whole review. Finished work (`[x]`, `[-]`) is never
  overridden.

### Child Task Migration Example

**Before migration:**
```markdown
- [>w] Plan vacation
  - [ ] Research destinations
  - [x] Book time off work
  - [ ] Check passport expiration
  - [>m] Book flights (has own marker)
```

**After migration:**
- **Source file** shows:
```markdown
- [>] Plan vacation
  - [>] Research destinations
  - [x] Book time off work (stayed in source - completed)
  - [>] Check passport expiration
  - [>] Book flights
```

- **Next week's file** shows:
```markdown
- [ ] Plan vacation
  - [ ] Research destinations
  - [ ] Check passport expiration
```

- **Next month's file** shows:
```markdown
- [ ] Book flights
```

### Complex Example: All Child Types

**Before migration:**
```markdown
- [>w] Active project
  - [ ] Review documentation
  - [x] Initial setup (completed)
  - Meeting notes from yesterday (plain info point)
  - [>mon] Follow-up call (child with own marker)
  - [-] Old approach (cancelled)

- [x] Completed project (no migration marker possible)
  - [ ] Outstanding task
  - Final notes
```

**After migration:**
- **Source file** shows:
```markdown
- [>] Active project
  - [>] Review documentation
  - [x] Initial setup (stayed - completed)
  - Meeting notes from yesterday (stayed - reference material)
  - [>] Follow-up call
  - [-] Old approach (stayed - cancelled)

- [x] Completed project (unchanged - no migration)
  - [ ] Outstanding task (stayed with completed parent)
  - Final notes (stayed with completed parent)
```

- **Next week's file** shows:
```markdown
- [ ] Active project
  - [ ] Review documentation
  - Meeting notes from yesterday (duplicated as reference)
```

- **Next Monday's file** shows:
```markdown
- [ ] Follow-up call
```

### Deduplication Example

**Monday's note:**
```markdown
- [>fri] Call dentist
```

**Tuesday's note:**
```markdown
- [>fri] Call dentist
```

**Wednesday's note:**
```markdown
- [>fri] Call dentist
```

**Result: Friday's note only has ONE entry:**
```markdown
- [ ] Call dentist
```

The plugin detected that "Call dentist" already exists in Friday's note, so it skipped the duplicate migrations from Tuesday and Wednesday.

**Note:** Deduplication uses normalized text comparison (case-insensitive, ignores extra whitespace and wiki link brackets). Tasks with different wording are treated as separate tasks. Only **open** items count as duplicates — if Friday's note already has `- [>] Call dentist` from an earlier cycle, a new `- [ ] Call dentist` is still written.

## Installation

### Via BRAT (Beta Reviewers Auto-update Tester)

1. Install the BRAT plugin from Obsidian Community Plugins
2. Open command palette and run "BRAT: Add a beta plugin for testing"
3. Enter: `lwshaban/obsidian-bullet-journal-migration`
4. Enable the plugin in Settings → Community Plugins

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder in your vault: `.obsidian/plugins/obsidian-bujo-migration/`
3. Copy the downloaded files into this folder
4. Enable the plugin in Settings → Community Plugins

## Development Setup

```bash
# Clone the repository
git clone https://github.com/lwshaban/obsidian-bullet-journal-migration.git

# Install dependencies
npm install

# Build the plugin
npm run build

# Run the unit tests (marker resolution, recurrence, path handling)
npm test

# Lint against the Obsidian plugin guidelines
npm run lint

# Set up symlinks for development
npm run setup
# (Edit dev-setup.sh first to set your vault path)

# Start development with auto-rebuild
npm run dev
```

Tests run outside Obsidian: `tests/run.mjs` bundles them with esbuild, swapping
the `obsidian` import for a stub, and hands the result to node's built-in test
runner. Only the pure modules are covered — marker resolution, recurrence, path
building, and line parsing.

## Support

If you find this plugin helpful, consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs via GitHub issues
- 💡 Suggesting features

## License

MIT License - see LICENSE file for details

## Author

Lawrence Shaban ([@lwshaban](https://github.com/lwshaban))
