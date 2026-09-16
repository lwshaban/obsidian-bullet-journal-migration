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

Migrated tasks are inserted under a `## Plan` heading in weekly and monthly
notes, `## Notes` in daily notes, and under the matching month heading (or
`## General`) in the future log. Without those headings the task is appended to
the end of the note.

## Quick Entry (Autocomplete)

You don't have to memorize the marker codes below. In any task line, start typing the checkbox marker `[>` and an autocomplete appears:

- **Tomorrow**, **Next week**, **Next month** — with their resolved dates shown
- **Pick a date…** — opens a calendar where clicking a **day** targets the daily note, a **week number** the weekly note, and the **month title** the monthly note
- Type a code directly (e.g. `[>w2`, `[>fri`, `[>m3w`) and the popup previews the exact resulting date

Markers resolve **relative to the note they're in**: `[>w]` in a `2026-W31` weekly note means W32, not "next week from today". This keeps migrations correct when you process past notes during a review.

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
| `[>w1]`, `[>w2]`, `[>w3]`, `[>w4]` | 1-4 weeks on from the note's own date |
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

### Migrate tasks
**Command:** `Migrate tasks`

Processes the current note, migrating all marked tasks to their destinations. Auto-detects the note type (daily, weekly, monthly, or a generated review) — this is the one command you run to "process" whatever note you're in.

### Migrate selected tasks
**Command:** `Migrate selected tasks`

Same as **Migrate tasks**, but only processes the lines you have selected. Useful in review documents where you want to migrate a few items at a time.

### Schedule tasks / Schedule selected tasks
**Commands:** `Schedule tasks`, `Schedule selected tasks`

Like the migrate commands, but mark the source with `[s]` (scheduled) instead of `[>]` (migrated) — for planning notes where the task is being placed onto a future date rather than moved out.

### Schedule recurring task
**Command:** `Schedule recurring task`

Lays down every occurrence of the current task from now until a date you choose, stepping by a customisable interval. See [Recurring Tasks](#recurring-tasks).

### Generate weekly / monthly / global review
**Commands:** `Generate weekly review`, `Generate monthly review`, `Generate global review`

Create a review document collecting all incomplete tasks for the period (the week's/month's daily notes and higher-level notes; the global review spans all periods). Add markers to the review, then run **Migrate tasks** on it to send everything to its destination.

Once every task in a review has been dealt with, the review file is moved to the
vault trash. If anything failed to migrate, the review is **kept** so you can see
what is outstanding and run it again — the notice tells you how many failed.

## Settings

**Settings → Bujo** configures where the plugin reads and writes:

- **Folders** — the seven paths listed under [Folder Structure](#folder-structure). Clearing a box restores its default.
- **Debug logging** — off by default. Turn it on to trace migrations in the developer console (**Ctrl/Cmd + Shift + I**) when a task ends up somewhere unexpected. Warnings and errors are always logged.

## Recurring Tasks

Run **Schedule recurring task** on a task line to open a small dialog:

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
- **Deduplication**: Tasks with identical text (normalized) are not added if they already exist in the destination
  - Prevents duplicate entries when migrating the same task multiple times
  - Comparison is case-insensitive and ignores extra whitespace
  - Example: Migrating "Call dentist" to Friday on Monday, Tuesday, and Wednesday results in only one entry in Friday's note

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

**Note:** Deduplication uses normalized text comparison (case-insensitive, ignores extra whitespace and wiki link brackets). Tasks with different wording are treated as separate tasks.

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
