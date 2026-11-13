// Review documents: generating them from the journal, and processing the
// user's marked-up copy back into it.
//
// These are commands rather than engine internals — each one is a whole
// user-visible operation built on BulletJournalMigration's task primitives.
// They take the migration instance explicitly instead of living on it, which
// keeps the engine file down to marker parsing and task manipulation.
//
// A review is described by two things: which notes it covers (a week, a month,
// a date range, the whole journal) and which task states it lists. Everything
// below is parameterised on those two, so there is one collector, one renderer
// and one processor rather than a copy per period.

import { Notice, moment } from 'obsidian';
import type { BulletJournalMigration } from './bulletJournalMigration';
import { TaskInclusion, OUTSTANDING_ONLY } from './types';
import { CollectStats, MAX_REVIEW_LINE } from './bulletJournalMigration';
import { ReviewKind, BujoPaths } from './paths';
import { log } from './log';

// ── What a review covers ──────────────────────────────────────────────────────

export type ReviewScope =
	/** One ISO week: its daily notes plus the weekly note. */
	| { kind: 'weekly'; week: string }
	/** One calendar month: daily notes, overlapping weekly notes, the monthly note. */
	| { kind: 'monthly'; month: string }
	/** Arbitrary from→to dates, inclusive: daily, weekly and monthly notes touched. */
	| { kind: 'range'; from: string; to: string }
	/** Every journal note before today, grouped by period. */
	| { kind: 'global' };

export interface ReviewRequest {
	scope: ReviewScope;
	include: TaskInclusion;
}

/** Longest range we will sweep; past this it is a global review, not a range. */
export const MAX_RANGE_DAYS = 1000;

function isDefaultInclusion(include: TaskInclusion): boolean {
	return (Object.keys(OUTSTANDING_ONLY) as (keyof TaskInclusion)[])
		.every(key => include[key] === OUTSTANDING_ONLY[key]);
}

/** "already filed, completed" — the extras beyond a plain open-task review. */
function describeExtras(include: TaskInclusion): string {
	const labels: Partial<Record<keyof TaskInclusion, string>> = {
		timebound: 'events',
		migrated: 'already filed',
		completed: 'completed',
		cancelled: 'cancelled',
	};
	const extras = (Object.keys(labels) as (keyof TaskInclusion)[])
		.filter(key => include[key])
		.map(key => labels[key] as string);
	if (!include.outstanding) extras.unshift('no open work');
	return extras.join(', ');
}

// ── Which notes a scope covers ────────────────────────────────────────────────

/**
 * Note paths a date range touches, in reading order: every daily note in the
 * range, then the weekly notes whose week overlaps it, then the monthly notes.
 *
 * Weeks and months are walked as dates rather than numbers: in January and
 * December a month spans two ISO week-years, where the first week number is
 * larger than the last and a numeric loop collapses.
 */
export function rangeNotePaths(
	paths: BujoPaths,
	from: moment.Moment,
	to: moment.Moment,
	kinds: { daily?: boolean; weekly?: boolean; monthly?: boolean } = {},
): string[] {
	const { daily = true, weekly = true, monthly = true } = kinds;
	const out: string[] = [];

	if (daily) {
		const day = from.clone();
		while (day.isSameOrBefore(to, 'day')) {
			out.push(paths.dailyNote(day.format('YYYY-MM-DD')));
			day.add(1, 'day');
		}
	}

	if (weekly) {
		const week = from.clone().startOf('isoWeek');
		const lastWeek = to.clone().startOf('isoWeek');
		while (week.isSameOrBefore(lastWeek, 'day')) {
			out.push(paths.weeklyNoteByName(week.format('GGGG-[W]WW')));
			week.add(1, 'week');
		}
	}

	if (monthly) {
		const month = from.clone().startOf('month');
		const lastMonth = to.clone().startOf('month');
		while (month.isSameOrBefore(lastMonth, 'day')) {
			out.push(paths.monthlyNote(month.format('YYYY-MM')));
			month.add(1, 'month');
		}
	}

	return [...new Set(out)];
}

/** Collect the requested states from each note, keeping only notes with hits. */
async function collectBySource(
	bujo: BulletJournalMigration,
	notePaths: string[],
	include: TaskInclusion,
	stats: CollectStats,
): Promise<Record<string, string[]>> {
	const bySource: Record<string, string[]> = {};
	for (const path of notePaths) {
		const tasks = await bujo.collectTasks(path, include, stats);
		if (tasks.length === 0) continue;
		(bySource[path] ??= []).push(...tasks);
	}
	return bySource;
}

/**
 * A line about what was held back, or nothing. Said out loud in the review
 * rather than only in the console: an entry that silently never appears is
 * the same failure as a task that silently never migrates.
 */
function oversizedNote(stats: CollectStats): string[] {
	if (stats.oversized === 0) return [];
	const n = stats.oversized;
	const it = n === 1 ? 'It' : 'They';
	const cause = stats.embedded === n
		? `${it} ${n === 1 ? 'contains' : 'contain'} an image pasted inline, which is stored as text —`
			+ ' often a few hundred kilobytes on one line.'
		: `${it} ${n === 1 ? 'is' : 'are'} over ${MAX_REVIEW_LINE} characters`
			+ `${stats.embedded > 0 ? `, and ${stats.embedded} of them hold an inline image` : ''}.`;

	return [
		'',
		`> [!warning] ${n} ${n === 1 ? 'entry was' : 'entries were'} too big to list`,
		`> ${cause}`,
		`> ${it} ${n === 1 ? 'has' : 'have'} been left untouched in ${n === 1 ? 'its' : 'their'} own note: a line that long`,
		'> makes a review unusable to type in, so it is held back rather than copied here.',
	];
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Heading for a source note: the date identifier where there is one, so the
 * review reads as dates rather than paths. Both forms resolve back to the note
 * when the review is processed (see BujoPaths.headingToSourcePath).
 */
function sourceHeading(source: string, level: '##' | '###' = '##'): string {
	const dateMatch = source.match(/(\d{4}-(?:W)?\d{2}(?:-\d{2})?)\.md$/);
	return dateMatch ? `${level} [[${dateMatch[1]}]]` : `${level} [[${source}]]`;
}

/** Shared trailer: how to mark the review up, plus notes for the extra states. */
function instructionLines(include: TaskInclusion): string[] {
	const lines = [
		'---',
		'**Instructions:**',
		'- Add migration markers in brackets: [>>], [>w], [>m], [>{day}], [>{month}], [>fut]',
		'- Optionally specify item type: [>mon{o}] for event, [>fri{a}] for appointment',
		'- Mark completed tasks as [x]',
		'- Mark cancelled tasks as [-]',
		'- Delete tasks entirely with [d] (removes from source file)',
		'- Mark as migrated without migrating: [>skip] or [<] or [>-]',
		'- Add new tasks with [+> marker: [+>w], [+>m], [+>tue], etc. (creates new task, doesn\'t look for source)',
		'- Run "Migrate tasks" on this note when done',
	];
	if (include.migrated) {
		lines.push(
			'',
			'**Items already marked [>], [<] or [+] are listed** so a task whose',
			'migration never landed can be recovered. Replace the [>] with a destination',
			'marker (e.g. [>m]) to migrate it again; leave it as [>] to ignore it.',
		);
	}
	if (include.completed || include.cancelled) {
		lines.push(
			'',
			'**Finished items are listed for reference.** Leaving an [x] or [-] line alone',
			'changes nothing in the source — they are here to read, not to process.',
		);
	}
	return lines;
}

/** A flat review: one section per source note, states mixed in file order. */
function renderGrouped(
	title: string,
	bySource: Record<string, string[]>,
	include: TaskInclusion,
	emptyNote: string,
	stats: CollectStats,
): string {
	const lines = [title, ''];

	if (Object.keys(bySource).length === 0) {
		lines.push(emptyNote, '');
	} else {
		Object.entries(bySource).sort().forEach(([source, tasks]) => {
			lines.push(sourceHeading(source));
			tasks.forEach(task => lines.push(task));
			lines.push('');
		});
	}

	lines.push(...oversizedNote(stats));
	lines.push(...instructionLines(include));
	return lines.join('\n');
}

/** Create or overwrite the review note, then open it. */
async function writeReview(bujo: BulletJournalMigration, kind: ReviewKind, reviewPath: string, content: string): Promise<void> {
	const existing = bujo.getFile(reviewPath);
	if (existing) {
		await bujo.app.vault.modify(existing, content);
	} else {
		const folderPath = bujo.paths.reviewFolder(kind);
		if (!bujo.app.vault.getAbstractFileByPath(folderPath)) {
			await bujo.app.vault.createFolder(folderPath);
		}
		await bujo.app.vault.create(reviewPath, content);
	}

	const file = bujo.getFile(reviewPath);
	if (file) await bujo.app.workspace.getLeaf().openFile(file);
}

// ── Generation ────────────────────────────────────────────────────────────────

/**
 * Generate a review for any scope and set of states. The one place that knows
 * how a review document is built; the per-period commands below are presets.
 *
 * A review that asks for anything beyond open tasks is written to a separate
 * "-all" note, so re-running it can never overwrite a review you have already
 * marked up.
 */
export async function generateReview(bujo: BulletJournalMigration, request: ReviewRequest): Promise<void> {
	const { scope, include } = request;
	try {
		if (!Object.values(include).some(Boolean)) {
			new Notice('Pick at least one kind of entry to include.');
			return;
		}

		const paths = bujo.paths;
		const suffix = isDefaultInclusion(include) ? '-Review' : '-Review-all';
		const extras = describeExtras(include);
		const titleSuffix = extras ? ` (incl. ${extras})` : '';

		let kind: ReviewKind;
		let reviewPath: string;
		let title: string;
		let notePaths: string[];
		let emptyNote: string;

		if (scope.kind === 'weekly') {
			const week = moment(scope.week, 'GGGG-[W]WW');
			if (!week.isValid()) {
				new Notice(`Not a week: "${scope.week}" (expected e.g. 2026-W41)`);
				return;
			}
			// GGGG, not YYYY — see BujoPaths.targetFilePath
			const weekStr = week.format('GGGG-[W]WW');
			kind = 'Weekly';
			reviewPath = paths.reviewNote(kind, `${weekStr}${suffix}`);
			title = `# Weekly Review - ${weekStr}${titleSuffix}`;
			emptyNote = 'No tasks found for this week.';
			notePaths = rangeNotePaths(
				paths,
				week.clone().startOf('isoWeek'),
				week.clone().endOf('isoWeek'),
				{ monthly: false },
			);
		} else if (scope.kind === 'monthly') {
			const month = moment(scope.month, 'YYYY-MM');
			if (!month.isValid()) {
				new Notice(`Not a month: "${scope.month}" (expected e.g. 2026-10)`);
				return;
			}
			const yearMonth = month.format('YYYY-MM');
			kind = 'Monthly';
			reviewPath = paths.reviewNote(kind, `${yearMonth}${suffix}`);
			title = `# Monthly Review - ${yearMonth}${titleSuffix}`;
			emptyNote = 'No tasks found for this month.';
			notePaths = rangeNotePaths(paths, month.clone().startOf('month'), month.clone().endOf('month'));
		} else if (scope.kind === 'range') {
			let from = moment(scope.from, 'YYYY-MM-DD', true);
			let to = moment(scope.to, 'YYYY-MM-DD', true);
			if (!from.isValid() || !to.isValid()) {
				new Notice('Enter both dates, e.g. 2026-10-01.');
				return;
			}
			if (to.isBefore(from, 'day')) [from, to] = [to, from];
			if (to.diff(from, 'days') + 1 > MAX_RANGE_DAYS) {
				new Notice(`That range is longer than ${MAX_RANGE_DAYS} days — use the global review instead.`);
				return;
			}
			const fromStr = from.format('YYYY-MM-DD');
			const toStr = to.format('YYYY-MM-DD');
			kind = 'Range';
			reviewPath = paths.reviewNote(kind, `${fromStr}_${toStr}${suffix}`);
			title = `# Review - ${fromStr} → ${toStr}${titleSuffix}`;
			emptyNote = 'No tasks found in this range.';
			notePaths = rangeNotePaths(paths, from, to);
		} else {
			return generateGlobalReview(bujo, include);
		}

		new Notice('Generating review...');
		const stats: CollectStats = { oversized: 0, embedded: 0 };
		const bySource = await collectBySource(bujo, notePaths, include, stats);
		await writeReview(bujo, kind, reviewPath, renderGrouped(title, bySource, include, emptyNote, stats));

		const total = Object.values(bySource).reduce((sum, tasks) => sum + tasks.length, 0);
		new Notice(`Review created: ${reviewPath} (${total} item${total === 1 ? '' : 's'})`
			+ (stats.oversized > 0 ? `\n• ${stats.oversized} too long to list` : ''));
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		new Notice(`Error: ${errorMessage}`);
		log.error('Review generation error:', error);
	}
}

/**
 * Generate Global Review - every journal note before today
 *
 * Keeps its own layout: grouped by period (Daily/Weekly/Monthly Notes) rather
 * than as one flat list, because it can span years.
 */
export async function generateGlobalReview(bujo: BulletJournalMigration, include: TaskInclusion): Promise<void> {
	try {
		new Notice('Generating global review...');

		const paths = bujo.paths;
		const stamp = moment().format('YYYY-MM-DD-HHmm');
		const tag = isDefaultInclusion(include) ? '' : '-all';
		const reviewPath = paths.reviewNote('Global', `Global-Review${tag}-${stamp}`);

		// Only notes whose period has passed: a review is for settling what is
		// behind you, not for raiding the note you are working in today.
		const today = moment().startOf('day');
		const isPast = (path: string): boolean => {
			const kind = paths.classify(path);
			if (kind === 'daily') {
				const match = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
				return !!match && moment(match[1], 'YYYY-MM-DD').isBefore(today);
			}
			if (kind === 'weekly') {
				const match = path.match(/(\d{4})-W(\d{2})\.md$/);
				if (!match || !match[1] || !match[2]) return false;
				const fileWeek = moment().isoWeekYear(parseInt(match[1], 10)).isoWeek(parseInt(match[2], 10)).startOf('isoWeek');
				return fileWeek.isBefore(moment().startOf('isoWeek'));
			}
			if (kind === 'monthly') {
				const match = path.match(/(\d{4}-\d{2})\.md$/);
				return !!match && moment(match[1], 'YYYY-MM').startOf('month').isBefore(moment().startOf('month'));
			}
			return false;
		};

		const journalFiles = bujo.app.vault.getFiles()
			.filter(file => isPast(file.path))
			.sort((a, b) => a.path.localeCompare(b.path));

		const sectionNames: Record<string, string> = {
			daily: 'Daily Notes',
			weekly: 'Weekly Notes',
			monthly: 'Monthly Notes',
		};
		const sections: Record<string, { path: string; tasks: string[] }[]> = {
			'Daily Notes': [], 'Weekly Notes': [], 'Monthly Notes': [],
		};
		const stats: CollectStats = { oversized: 0, embedded: 0 };
		let total = 0;

		for (const file of journalFiles) {
			const tasks = await bujo.collectTasks(file.path, include, stats);
			if (tasks.length === 0) continue;
			const kind = paths.classify(file.path);
			const section = (kind && sectionNames[kind]) || '';
			(sections[section] ??= []).push({ path: file.path, tasks });
			total += tasks.length;
		}

		const extras = describeExtras(include);
		const lines = [`# Global Review - ${moment().format('YYYY-MM-DD HH:mm')}${extras ? ` (incl. ${extras})` : ''}`, ''];

		if (total === 0) {
			lines.push('No tasks found in journal.', '');
		} else {
			for (const [sectionName, items] of Object.entries(sections)) {
				if (items.length === 0) continue;
				lines.push(`## ${sectionName}`, '');
				items.forEach(item => {
					lines.push(sourceHeading(item.path, '###'));
					item.tasks.forEach(task => lines.push(task));
					lines.push('');
				});
			}
			lines.push('---', `**Total: ${total} item${total === 1 ? '' : 's'}**`, '');
		}

		lines.push(...oversizedNote(stats));
		lines.push(...instructionLines(include));

		await writeReview(bujo, 'Global', reviewPath, lines.join('\n'));
		new Notice(`Global review created: ${reviewPath}`);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		new Notice(`Error: ${errorMessage}`);
		log.error('Global review error:', error);
	}
}

// ── Processing ────────────────────────────────────────────────────────────────

/**
 * The review date handed to new-task creation. Reviews are named after the
 * period they cover, so it is read back off the path. Relative markers resolve
 * from today rather than from this (see calculateDestinationDate), so it only
 * matters as a fallback.
 */
function reviewDateFromPath(reviewPath: string): string | null {
	const weekMatch = reviewPath.match(/(\d{4})-W(\d{2})/);
	if (weekMatch && weekMatch[1] && weekMatch[2]) {
		return moment()
			.isoWeekYear(parseInt(weekMatch[1], 10))
			.isoWeek(parseInt(weekMatch[2], 10))
			.startOf('isoWeek')
			.format('YYYY-MM-DD');
	}
	const dayMatch = reviewPath.match(/(\d{4}-\d{2}-\d{2})/);
	if (dayMatch && dayMatch[1]) return dayMatch[1];
	const monthMatch = reviewPath.match(/(\d{4}-\d{2})/);
	if (monthMatch && monthMatch[1]) return `${monthMatch[1]}-01`;
	return null;
}

/**
 * Process a marked-up review back into the journal: migrate what carries a
 * marker, complete/cancel/delete what is marked that way, and file the review
 * away once everything in it has landed.
 *
 * One implementation for every review kind. These used to be three copies of
 * the same loop, which is how the global review ended up missing the
 * child-handling the other two had.
 */
async function processReview(bujo: BulletJournalMigration, kind: ReviewKind, label: string): Promise<void> {
	try {
		new Notice(`Processing ${label.toLowerCase()}...`);

		const activeFile = bujo.app.workspace.getActiveFile();
		const paths = bujo.paths;
		if (!activeFile || !paths.isReview(activeFile.path, kind)) {
			new Notice(`Please open a ${label.toLowerCase()} note`);
			return;
		}

		const reviewFile = activeFile;
		const reviewPath = activeFile.path;
		const content = await bujo.app.vault.read(reviewFile);
		const lines = content.split('\n');
		const reviewDate = reviewDateFromPath(reviewPath) ?? moment().format('YYYY-MM-DD');

		let migratedCount = 0;
		let newTaskCount = 0;
		let completedCount = 0;
		let deletedCount = 0;
		let blankCount = 0;
		// Migrations that found a live copy already at the destination: the
		// task is there, but two items were merged into one.
		let dedupedCount = 0;
		const errors: string[] = [];
		let currentSourcePath: string | null = null;
		// Lines already dealt with as a child of a parent task above them
		const processedLines = new Set<number>();

		for (let i = 0; i < lines.length; i++) {
			if (processedLines.has(i)) continue;

			const line = lines[i];
			if (!line) continue;
			const trimmedLine = line.trim();

			// A heading naming a source note switches which note we act on
			const headingPath = paths.tryParseHeadingPath(trimmedLine);
			if (headingPath) {
				currentSourcePath = headingPath;
				log.debug(`Set source path: ${currentSourcePath}`);
				continue;
			}

			// Any other heading is a section header ("## Daily Notes"), which
			// must not be mistaken for a source
			if (trimmedLine.startsWith('#')) continue;

			if (!bujo.isBulletItem(trimmedLine)) continue;

			// A marker with nothing after it (a stray "- [d]") has no task to
			// act on. Skipping beats failing: one abandoned line should not
			// keep an otherwise-complete review from being filed away.
			if (!bujo.getTaskText(trimmedLine)) {
				if (bujo.hasMigrationMarker(trimmedLine)) {
					log.warn(`Skipping empty marker line in ${reviewPath}: "${trimmedLine}"`);
					blankCount++;
				}
				continue;
			}

			const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
			const sourcePath = bujo.extractSourcePath(trimmedLine, lines.slice(Math.max(0, i - 10), i)) || currentSourcePath;

			// New tasks: the [+> marker, or any marked line with no source note
			if (!sourcePath || parsedMarker?.isNewTask) {
				if (bujo.hasMigrationMarker(trimmedLine)) {
					const result = await bujo.createNewTask(line, reviewDate);
					if (result.success) {
						newTaskCount++;
						migratedCount++;
					} else {
						errors.push(`New task creation failed: ${result.error}`);
					}
				}
				continue;
			}

			const taskText = bujo.getTaskText(trimmedLine);

			if (bujo.isCompletedTask(trimmedLine)) {
				const result = await bujo.completeTask(line, sourcePath);
				if (result.success) {
					if (!result.skipped) completedCount++;
				} else {
					errors.push(`Task "${taskText}": Complete failed - ${result.error}`);
					log.error(`Complete failed for task: "${taskText}"`, result.error);
				}
				continue;
			}

			if (bujo.isDeletedTask(trimmedLine)) {
				const result = await bujo.cancelTask(line, sourcePath);
				if (result.success) {
					if (!result.skipped) deletedCount++;
				} else {
					errors.push(`Task "${taskText}": Cancel failed - ${result.error}`);
					log.error(`Cancel failed for task: "${taskText}"`, result.error);
				}
				continue;
			}

			// [d] removes the task and its children from the source note
			if (parsedMarker?.marker === 'delete') {
				const result = await bujo.deleteTask(line, sourcePath);
				if (result.success) {
					deletedCount++;
					log.debug(`Deleted task from ${sourcePath}: "${taskText}"`);
				} else {
					errors.push(`Delete failed: ${result.error}`);
					log.error(`Failed to delete task from ${sourcePath}: ${result.error}`);
				}
				continue;
			}

			if (!bujo.hasMigrationMarker(trimmedLine)) continue;

			const sourceDate = bujo.getDateFromFilePath(sourcePath);
			const periodType = bujo.detectPeriodType(sourcePath);
			log.debug(`Attempting to migrate task: "${taskText}" from ${sourcePath} (date: ${sourceDate}, period: ${periodType})`);

			if (!sourceDate) {
				const errorMsg = `Task "${taskText}": Could not determine date from: ${sourcePath}`;
				errors.push(errorMsg);
				log.error(errorMsg);
				continue;
			}

			// Children come from the SOURCE note, which holds the real
			// hierarchy; their lines in the review are then skipped so they
			// aren't migrated a second time on their own.
			const childTasks = await bujo.collectChildrenFromSource(sourcePath, taskText);
			if (childTasks.length > 0) {
				bujo.collectChildTasks(lines, i, bujo.getIndentLevel(line))
					.forEach(child => processedLines.add(child.index));
			}

			const result = await bujo.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
			if (result.success && !result.skipped) {
				migratedCount++;
				if (result.deduped) dedupedCount++;
				log.debug(`Migrated "${taskText}"${childTasks.length ? ` with ${childTasks.length} children` : ''} to ${result.destFile}`);
			} else if (result.success && result.skipped) {
				log.debug(`Task marked but not migrated: "${taskText}"`);
			} else {
				errors.push(`Task "${taskText}": Migration failed - ${result.error}`);
				log.error(`Migration failed for task: "${taskText}" from ${sourcePath}`, result.error);
			}
		}

		// Only discard the review once everything in it landed. If any task
		// failed, the review is the user's only record of what is outstanding.
		if (errors.length === 0) {
			await bujo.trashFile(reviewFile);
		} else {
			log.warn(`Keeping ${reviewPath}: ${errors.length} task(s) could not be migrated`);
		}

		const message = `${label} processed!`
			+ `\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}`
			+ `\n✓ ${completedCount} tasks completed`
			+ `\n✓ ${deletedCount} tasks deleted`
			+ `${dedupedCount > 0 ? `\n• ${dedupedCount} already open at destination (merged)` : ''}`
			+ `${blankCount > 0 ? `\n• ${blankCount} blank marker line(s) skipped` : ''}`
			+ `${errors.length > 0 ? `\n⚠ ${errors.length} errors — review kept for retry` : ''}`;
		new Notice(message, 5000);

		if (errors.length > 0) {
			log.error('Processing errors:', errors);
			log.error('Full error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		new Notice(`Error: ${errorMessage}`);
		log.error(`Process ${label.toLowerCase()} error:`, error);
	}
}

export async function migrateWeeklyReview(bujo: BulletJournalMigration): Promise<void> {
	return processReview(bujo, 'Weekly', 'Weekly review');
}

export async function migrateMonthlyReview(bujo: BulletJournalMigration): Promise<void> {
	return processReview(bujo, 'Monthly', 'Monthly review');
}

export async function migrateGlobalReview(bujo: BulletJournalMigration): Promise<void> {
	return processReview(bujo, 'Global', 'Global review');
}

export async function migrateRangeReview(bujo: BulletJournalMigration): Promise<void> {
	return processReview(bujo, 'Range', 'Review');
}
