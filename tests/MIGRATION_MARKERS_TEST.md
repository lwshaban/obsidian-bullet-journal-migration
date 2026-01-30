# Migration Markers Test Suite

This file contains examples of all supported migration markers for testing purposes.

## Basic Migration Markers

### Relative Time Migration
- [>>] Migrate to tomorrow
- [>w] Migrate to next week
- [>m] Migrate to next month
- [>fut] Migrate to future log
- [>:] Migrate to today (colon syntax - recommended)
- [>|] Migrate to today (pipe syntax)

### Current Period Migration (Both Syntaxes Supported)
- [>:w] Migrate to current week (colon syntax - recommended)
- [<w] Migrate to current week (legacy syntax)
- [>:m] Migrate to current month (colon syntax - recommended)
- [<m] Migrate to current month (legacy syntax)
- [>:y] Migrate to current year (colon syntax - recommended)
- [<y] Migrate to current year (legacy syntax)

### Day-Specific Migration (Next Occurrence)
- [>mon] Migrate to Monday
- [>tue] Migrate to Tuesday
- [>wed] Migrate to Wednesday
- [>thu] Migrate to Thursday
- [>fri] Migrate to Friday
- [>sat] Migrate to Saturday
- [>sun] Migrate to Sunday

### Week-Specific Migration (Weeks from Now)
- [>w1] Migrate to 1 week from now
- [>w2] Migrate to 2 weeks from now
- [>w3] Migrate to 3 weeks from now
- [>w4] Migrate to 4 weeks from now

### Month Week Migration
- [>m3w] Migrate to 3rd week of next month

### Month-Specific Migration (Next Occurrence)
- [>jan] Migrate to January
- [>feb] Migrate to February
- [>mar] Migrate to March
- [>apr] Migrate to April
- [>may] Migrate to May
- [>jun] Migrate to June
- [>jul] Migrate to July
- [>aug] Migrate to August
- [>sep] Migrate to September
- [>oct] Migrate to October
- [>nov] Migrate to November
- [>dec] Migrate to December

## Task Type Markers (Checkbox Content)

The content in `{...}` becomes the destination checkbox.

### Events (one-time occurrence)
- [>fri{o}] Event for next Friday
- [>w{o}] Event for next week
- [>m{o}] Event for next month

### Appointments (scheduled time)
- [>mon{a}] Appointment on Monday
- [>w{a}] Appointment next week
- [>>{a}] Appointment tomorrow

### Information Points (no checkbox at destination)
- [>w{.}] Information point for next week
- [>fri{.}] Information point for Friday

### Custom Checkbox Types
- [>w{=}] Custom checkbox type example
- [>mon{!}] Another custom checkbox type
- [>w{?}] Question checkbox type

## Special Markers

### Skip/Mark Without Migrating
- [>skip] Skip migration but mark as done
- [>x] Skip with x marker
- [>-] Mark as migrated without migrating

### Already Scheduled
- [<] Already scheduled elsewhere

### Delete Task
- [d] Delete task and its children entirely from the file (removes the line completely)

## New Task Markers (Create Without Source)

### Basic New Tasks
- [+>w] Create new task for next week
- [+>m] Create new task for next month
- [+>tue] Create new task for Tuesday

### New Tasks with Types
- [+>fri{o}] New event for Friday
- [+>w{a}] New appointment for next week
- [+>mon{=}] New task with custom checkbox

## Information Point Markers (Plain List Items)

### Migrate as Info Points (no checkbox)
- [->w] Info point to next week
- [->m] Info point to next month
- [->fri] Info point to Friday

## Child Task Examples

### Parent with Children (Only Incomplete Children Migrate)
- [>w] Parent task with migration marker
	- [ ] Incomplete child (migrates with parent)
	- [x] Completed child (stays in source - not migrated)
	- [ ] Another incomplete child (migrates with parent)
	- [>fri] Child with own marker (migrates to Friday)
		- [ ] Nested child (inherits immediate parent's migration)

### Parent as Event with Children
- [>fri{o}] Parent event
	- [ ] Incomplete child (migrates as event)
	- [x] Completed child (stays in source)
	- [-] Cancelled child (stays in source)

### Parent with Information Point Children
- [>w] Task with notes
	- [ ] Subtask (migrates)
	- Reference link to documentation (no checkbox - duplicates to both source and destination)
	- Important context note (no checkbox - appears in both places)

## Complex Combinations

### Multiple Marker Types
- [>mon{o}] Event on Monday
- [>w2{a}] Appointment 2 weeks from now
- [>m{.}] Information point for next month
- [>m3w{=}] Custom task to 3rd week of next month

## Edge Cases

### Already Migrated (Should be ignored)
- [>] This task was already migrated
- [<] This task was already scheduled

### Completed/Cancelled Parent Tasks (Should not migrate, children stay with parent)
- [x] Completed parent task
	- [ ] Incomplete child (stays with completed parent)
	- Reference note (stays with completed parent)
	- [x] Completed child (stays with completed parent)
- [-] Cancelled parent task
	- [ ] Incomplete child (stays with cancelled parent)
	- Context note (stays with cancelled parent)

### Completed Tasks Cannot Have Migration Markers
These are impossible in the new format (marker IS the checkbox):
- [x] Completed task [>w] ← Old format (no longer valid)
- [>w] Task is what makes it incomplete and migratable

## Deduplication Examples

### Same Task Migrated Multiple Times (Should deduplicate)
**Monday's note:**
- [>fri] Call dentist

**Tuesday's note:**
- [>fri] Call dentist

**Wednesday's note:**
- [>fri] Call dentist

**Expected result in Friday's note (only one entry):**
- [ ] Call dentist

### Similar But Different Tasks (Should NOT deduplicate)
**Monday:**
- [>fri] Call dentist office

**Tuesday:**
- [>fri] Call dentist for appointment

**Expected result in Friday's note (two separate entries):**
- [ ] Call dentist office
- [ ] Call dentist for appointment

## Notes for Testing

1. Process this file with "Process Daily Note" command
2. Check that tasks migrate to correct destinations
3. Verify child tasks follow parent migration
4. Validate custom checkbox types work correctly
5. Confirm edge cases are handled properly

## Expected Behavior

**After migration:**
- Source tasks show: `- [>] Task` (or `- [<] Task` for scheduled)
- Destination shows: `- [ ] Task` (standard), `- [o] Task` (event), `- [a] Task` (appointment), or custom checkbox types
- Information points: plain list items without checkboxes
- Completed/cancelled tasks remain unchanged
