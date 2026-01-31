# Bujo for Obsidian

Automate your bullet journal workflow in Obsidian with powerful task migration markers and automated review generation.

> **Note:** This plugin was created independently by a fan of the Bullet Journal method and is not affiliated with or endorsed by the official Bullet Journal system. To learn about and support the original creator and methodology, please visit: [bulletjournal.com](https://bulletjournal.com/pages/book)

## Overview

This plugin implements a complete bullet journal migration system for Obsidian, allowing you to:
- **Migrate tasks** between daily, weekly, and monthly notes using simple markers
- **Generate reviews** automatically from incomplete tasks
- **Schedule tasks** to specific days, weeks, or months
- **Track task types** (events, appointments, information points)
- **Prioritize tasks** with descriptors (P1, P2, P3, Blocked, InProgress, Highlight)

## Required Folder Structure

The plugin expects the following folder structure in your vault:

```
Journal/
├── 001 Daily Notes/        # Daily notes (YYYY-MM-DD.md)
├── 002 Weekly Notes/       # Weekly notes (YYYY-Www.md)
├── 003 Monthly Notes/      # Monthly notes (YYYY-MM.md)
├── 004 Future Log/         # Future log (Future.md)
├── 005 Weekly Reviews/     # Generated weekly reviews
├── 006 Monthly Reviews/    # Generated monthly reviews
└── 007 Global Reviews/     # Generated global reviews
```

## Migration Markers

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
| `[>w1]`, `[>w2]`, `[>w3]`, `[>w4]` | 1-4 weeks from now |
| `[>m3w]` | 3rd week of next month |

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

### Process Daily Note
**Command:** `Process Daily Note`

Processes the currently open daily note, migrating all tasks with migration markers to their destinations.

### Generate Weekly Review
**Command:** `Generate Weekly Review`

Creates a weekly review document with all incomplete tasks from the current week's daily notes and the weekly note.

### Process Weekly Review
**Command:** `Process Weekly Review`

Processes the currently open weekly review, migrating all marked tasks.

### Schedule Weekly Plan
**Command:** `Schedule Weekly Plan`

Processes a weekly plan note, scheduling tasks to specific days of the week.

### Generate Monthly Review
**Command:** `Generate Monthly Review`

Creates a monthly review document with all incomplete tasks from the current month's daily notes, weekly notes, and the monthly note.

### Process Monthly Review
**Command:** `Process Monthly Review`

Processes the currently open monthly review, migrating all marked tasks.

### Schedule Monthly Plan
**Command:** `Schedule Monthly Plan`

Processes a monthly plan note, scheduling tasks to specific weeks or days.

### Generate Global Review
**Command:** `Generate Global Review`

Creates a comprehensive global review with incomplete tasks from all periods.

### Process Global Review
**Command:** `Process Global Review`

Processes the global review, migrating all marked tasks.

## Workflow Examples

### Daily Workflow

1. Open today's daily note
2. Add migration markers as checkboxes for incomplete tasks:
   ```markdown
   - [>mon] Call dentist
   - [>>] Review presentation
   - [>m{o}] Plan vacation event
   ```
3. Run "Process Daily Note" command
4. Tasks are automatically migrated to their destinations

### Weekly Review Workflow

1. Run "Generate Weekly Review" command
2. Review the generated list of incomplete tasks
3. Add migration markers as checkboxes:
   ```markdown
   - [>w{a}] Finish project proposal appointment
   - [>fut] Read article
   - [<] Update documentation
   ```
4. Run "Process Weekly Review" command
5. Tasks are migrated accordingly

### Monthly Planning Workflow

1. Run "Generate Monthly Review" command
2. Review all incomplete tasks from the month
3. Add markers to schedule tasks for next month
4. Run "Process Monthly Review" command

## Task Migration Behavior

- **Completed tasks** (`[x]`): Ignored, stay in source, not migrated
- **Cancelled tasks** (`[-]`): Ignored, stay in source, not migrated
- **Tasks with migration markers**: Migrated to destination and marked as `[>]` or `[<]` in source
- **Child tasks**: Only **incomplete** children automatically migrate with parent
  - Completed children (`[x]`) stay in source
  - Cancelled children (`[-]`) stay in source
  - Children can override parent's destination with their own marker
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
3. Enter: `lwshaban/obsidian-bujo-migration`
4. Enable the plugin in Settings → Community Plugins

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release
2. Create a folder in your vault: `.obsidian/plugins/obsidian-bujo-migration/`
3. Copy the downloaded files into this folder
4. Enable the plugin in Settings → Community Plugins

## Development Setup

```bash
# Clone the repository
git clone https://github.com/lwshaban/obsidian-bujo-migration.git

# Install dependencies
npm install

# Build the plugin
npm run build

# Set up symlinks for development
npm run setup
# (Edit dev-setup.sh first to set your vault path)

# Start development with auto-rebuild
npm run dev
```

## Support

If you find this plugin helpful, consider:
- ⭐ Starring the repository
- 🐛 Reporting bugs via GitHub issues
- 💡 Suggesting features

## License

MIT License - see LICENSE file for details

## Author

Lawrence Shaban ([@lwshaban](https://github.com/lwshaban))
