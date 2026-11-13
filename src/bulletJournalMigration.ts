// Bullet Journal Migration System
// Provides weekly and monthly review generation and processing

import { App, TFile, moment, Editor } from 'obsidian';
import { MigrationMarker, MigrationResult, TaskType, PeriodType, ChildTask, DestinationDate, TaskInclusion } from './types';
import {
	normalizeText,
	isIncompleteTask,
	isCompletedTask,
	isDeletedTask,
	isScheduledTask,
	isBulletItem,
	isConsumedTask,
	getTaskText,
	getBulletMarker,
	getIndentLevel,
	removeMetadata,
	collectChildTasks,
	sanitizeAncestorContext,
	clampIndent,} from './utils';
import { locateTaskLine, descendantLines, ancestorLines } from './locate';
import { resolveRelativeMarker } from './markers';
import { computeRecurrence, RecurUnit } from './recurrence';
import { BujoPaths } from './paths';
import { BujoPluginSettings } from './settings';
import { log } from './log';
import * as reviews from './reviews';
import * as taskCommands from './task-commands';

/**
 * What a destination write actually did.
 *
 * `duplicate` means nothing was written because an equivalent *live* item is
 * already in the destination — the migration is satisfied, but no new line
 * exists. Anything that cannot be confirmed throws instead of returning, so a
 * caller can never mistake a silent no-op for a successful write.
 */
export interface AppendResult {
	status: 'appended' | 'nested' | 'duplicate';
	path: string;
}

/**
 * Longest line a review will list.
 *
 * A journal entry is a sentence or two. A line past this is pasted content — an
 * embedded data URI, a transcript — and putting one in a review makes the whole
 * note unusable: CodeMirror re-tokenizes a line on every keystroke, so a single
 * 240KB bullet costs seconds per character typed.
 *
 * Held back rather than shortened: processing locates a task by matching its
 * text, so a truncated copy could never be acted on, and silently rewriting
 * someone's note content is worse than omitting it.
 */
export const MAX_REVIEW_LINE = 1000;

/**
 * A base64 data URI — a pasted image stored inline as text rather than as a
 * file. One screenshot is a few hundred kilobytes on a single line, which is
 * the usual reason an entry is too big to put in a review.
 */
const EMBEDDED_DATA = /data:[^;,\s]*;base64,/i;

/** What a collection pass held back, for the review to report. */
export interface CollectStats {
	oversized: number;
	/** Of those, how many were oversized because of an embedded image. */
	embedded: number;
}

/**
 * A note's body, with YAML frontmatter removed.
 *
 * Frontmatter list items are bullets too — `  - BulletJournal` under `tags:` —
 * so anything that collects every bullet in a file collects the note's tags as
 * if they were journal entries. Only a `---` on the very first line opens
 * frontmatter, and only a matching `---` closes it; an unterminated one is not
 * frontmatter at all, so the whole file stays body.
 */
export function bodyLines(content: string): string[] {
	const lines = content.split('\n');
	if (lines.length === 0 || lines[0]?.trim() !== '---') return lines;

	const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	return end === -1 ? lines : lines.slice(end + 1);
}

/** The slice of Templater's plugin instance this code calls into. */
interface TemplaterPlugin {
	templater: {
		overwrite_file_commands(file: TFile): Promise<void>;
	};
}

/** `App.plugins` is undocumented but stable; typed here rather than cast inline. */
type AppWithPlugins = App & {
	plugins?: { plugins?: Record<string, unknown> };
};

export class BulletJournalMigration {
	app: App;

	/**
	 * Settings are read through a getter so edits in the settings tab take
	 * effect immediately, without reloading the plugin.
	 */
	constructor(app: App, private getSettings: () => BujoPluginSettings) {
		this.app = app;
	}

	get paths(): BujoPaths {
		return new BujoPaths(this.getSettings());
	}

	/**
	 * Templater, when the user has it installed. `App.plugins` is not part of
	 * the public API, so the shape is asserted narrowly and guarded at runtime.
	 */
	getTemplater(): TemplaterPlugin | null {
		const plugins = (this.app as AppWithPlugins).plugins?.plugins;
		const templater = plugins?.['templater-obsidian'];
		if (templater && typeof templater === 'object' && 'templater' in templater) {
			return templater as TemplaterPlugin;
		}
		return null;
	}

	/** Resolve a vault path to a markdown file, or null if missing or a folder. */
	getFile(path: string): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	/**
	 * Move a file to the vault trash, honouring the user's "Deleted files"
	 * preference. Never use vault.delete() for user content — it is permanent.
	 */
	async trashFile(file: TFile): Promise<void> {
		await this.app.fileManager.trashFile(file);
	}

    // =================================================================
    // MIGRATION UTILS
    // =================================================================

    /**
     * Parse a migration marker from a task line
     */
    parseMigrationMarker(line: string): MigrationMarker | null {
        // Check for information point marker [-> (migrates as plain list item, no [>] marker)
        // Syntax: - [->w], - [->m], - [->fri], etc. (dash before arrow, in checkbox position)
        const infoPointMatch = line.match(/^\s*-\s*\[->(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut|\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-\d{2})\s*\]/i);
        if (infoPointMatch && infoPointMatch[1]) {
            return {
                marker: infoPointMatch[1].toLowerCase(),
                type: '.', // Information point
                descriptor: null,
                originalMarker: infoPointMatch[0],
                isInfoPoint: true,
            };
        }

        // Check for new task marker [+> (creates new task, doesn't look for source)
        // Support numbered weeks: w1, w2, w3, w4 (weeks from now)
        // Support month week: m3w (3rd week of month)
        // Support today marker: [>:] or [>|]
        // Support current period markers: [>:w]/[>|w], [>:m]/[>|m], [>:y]/[>|y] OR legacy [<w], [<m], [<y]
        // Support destination checkbox: {o}, {a}, {.}, {=}, etc. - becomes destination checkbox
        // Note: (...) for source is ignored for new tasks (no source to update)
        // Note: w\d* matches both 'w' (next week) and 'w1', 'w2', etc. (numbered weeks)
        const newTaskMatch = line.match(/^\s*-\s*\[\+>(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut|\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-\d{2})(?:\(([^)]+)\))?(?:\{([^}]+)\})?\s*\]/i);
        if (newTaskMatch && newTaskMatch[1]) {
            const destCheckboxContent = newTaskMatch[3] || null;  // {...} for destination
            return {
                marker: newTaskMatch[1].toLowerCase(),
                type: destCheckboxContent,
                sourceType: null,  // New tasks don't have source
                descriptor: null,
                originalMarker: newTaskMatch[0],
                isNewTask: true,
            };
        }

        // Check for delete marker (remove from source, don't migrate)
        const deleteMatch = line.match(/^\s*-\s*\[d\s*\]/i);
        if (deleteMatch) {
            return {
                marker: 'delete',
                type: null,
                originalMarker: deleteMatch[0],
            };
        }

        // Check for skip marker (mark as migrated without migrating)
        const skipMatch = line.match(/^\s*-\s*\[>(skip|x)\s*\]/i);
        if (skipMatch) {
            return {
                marker: 'skip',
                type: null,
                originalMarker: skipMatch[0],
            };
        }

        // Check for current time period markers (must come before [<] check)
        // New syntax: [>:w], [>|w], [>:m], [>|m], [>:y], [>|y]
        // Legacy syntax: [<w], [<m], [<y]
        const currentPeriodMatch = line.match(/^\s*-\s*\[(?:>(:|\|)(w|m|y)|<(w|m|y))\s*\]/i);
        if (currentPeriodMatch) {
            // Check which syntax was used
            if (currentPeriodMatch[1] && currentPeriodMatch[2]) {
                // New syntax: [>:w] or [>|w] - preserve the exact marker
                const separator = currentPeriodMatch[1];
                const periodChar = currentPeriodMatch[2].toLowerCase();
                return {
                    marker: `${separator}${periodChar}`,
                    type: null,
                    originalMarker: currentPeriodMatch[0],
                };
            } else if (currentPeriodMatch[3]) {
                // Legacy syntax: [<w], [<m], [<y] - preserve as <w, <m, <y
                const periodChar = currentPeriodMatch[3].toLowerCase();
                return {
                    marker: `<${periodChar}`,
                    type: null,
                    originalMarker: currentPeriodMatch[0],
                };
            }
        }

        // Check for already-scheduled marker [<] (for marking as scheduled without migrating)
        const scheduledMatch = line.match(/^\s*-\s*\[<\s*\]/);
        if (scheduledMatch) {
            return {
                marker: 'scheduled',
                type: null,
                originalMarker: scheduledMatch[0],
            };
        }

        // Check for [>-] marker (mark as migrated without migrating, like [>skip])
        const markWithoutMigrateMatch = line.match(/^\s*-\s*\[>-\s*\]/);
        if (markWithoutMigrateMatch) {
            return {
                marker: 'skip',
                type: null,
                originalMarker: markWithoutMigrateMatch[0],
            };
        }

        // Check for [>] marker - ignore it (don't process, leave as-is)
        const ignoreMatch = line.match(/^\s*-\s*\[>\s*\]/);
        if (ignoreMatch) {
            return null; // Return null so it's not processed
        }

        // Support numbered weeks: w1, w2, w3, w4 (weeks from now)
        // Support month week: m3w (3rd week of month)
        // Support today marker: [>:] or [>|]
        // Support current period markers: [>:w]/[>|w], [>:m]/[>|m], [>:y]/[>|y] OR legacy [<w], [<m], [<y]
        // Support source checkbox: (/), (=), etc. - becomes source checkbox after migration
        // Support destination checkbox: {o}, {a}, {.}, {=}, etc. - becomes destination checkbox
        // Example: [>w(/){=}] - source becomes [/], destination becomes [=]
        // Note: w\d* matches both 'w' (next week) and 'w1', 'w2', etc. (numbered weeks)
        const markerRegex = /^\s*-\s*\[>(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut|\d{4}-\d{2}-\d{2}|\d{4}-W\d{2}|\d{4}-\d{2})(?:\(([^)]+)\))?(?:\{([^}]+)\})?\s*\]/i;
        const match = line.match(markerRegex);

        if (!match || !match[1]) {
            return null;
        }

        const sourceCheckboxContent = match[2] || null;  // (...) for source
        const destCheckboxContent = match[3] || null;    // {...} for destination

        return {
            marker: match[1].toLowerCase(),
            type: destCheckboxContent,
            sourceType: sourceCheckboxContent,
            descriptor: null,
            originalMarker: match[0],
        };
    }

    /**
     * Check if marker uses [<] (scheduled) vs [>] (migrated)
     */
    isScheduledMarker(marker: string): boolean {
        const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        return months.includes(marker) || marker === 'fut';
    }

    /**
     * Get checkbox marker for original task after migration
     * Includes icon for events/appointments: :BujoEvent: or :BujoAppointment:
     */
    getOriginalMarker(marker: string, type: TaskType = null, sourceType: TaskType = null): string {
        // Return just the checkbox content (not full brackets)
        // Used for replacing checkbox: [>mon] → [>] or [<]

        // If sourceType is specified via (...), use that for source marker
        // Example: [>w(/)] - source becomes [/]
        if (sourceType && sourceType !== '.' && sourceType.trim() !== '') {
            return sourceType;
        }
        return this.isScheduledMarker(marker) ? '<' : '>';
    }

    /**
     * Get checkbox marker for destination task
     * Returns the full checkbox with content from migration marker
     * Example: {o} → [o], {=} → [=], null → [ ]
     * For information points (.), returns empty string (plain list item)
     */
    getDestinationMarker(checkboxContent: TaskType): string {
        if (!checkboxContent || checkboxContent.trim() === '') {
            return '[ ]'; // Default checkbox
        }
        if (checkboxContent === '.') {
            return ''; // Information points are plain list items, no brackets
        }
        return `[${checkboxContent}]`; // Whatever was in {}: {o}→[o], {=}→[=], etc.
    }

    /**
     * Calculate destination date for migration marker
     */
    calculateDestinationDate(marker: string, _sourceDate: string, periodType: PeriodType = 'daily'): DestinationDate | null {
        // sourceDate is kept in the signature for callers, but no longer steers
        // resolution: every marker now resolves from today. See the anchor
        // comment below.
        const today = moment().startOf('day');

        // Explicit destinations (from the date picker or typed directly)
        // [>2026-07-30] → daily, [>2026-W32] → weekly, [>2026-08] → monthly
        // Note: marker arrives lowercased, so the week form is e.g. "2026-w32"
        if (/^\d{4}-\d{2}-\d{2}$/.test(marker)) {
            const explicitDay = moment(marker, 'YYYY-MM-DD', true);
            return explicitDay.isValid()
                ? { date: marker, targetType: 'daily' }
                : null;
        }
        const explicitWeekMatch = marker.match(/^(\d{4})-w(\d{2})$/);
        if (explicitWeekMatch && explicitWeekMatch[1] && explicitWeekMatch[2]) {
            const explicitWeek = moment()
                .year(parseInt(explicitWeekMatch[1], 10))
                .isoWeek(parseInt(explicitWeekMatch[2], 10))
                .startOf('isoWeek');
            return explicitWeek.isValid()
                ? { date: explicitWeek.format('YYYY-MM-DD'), targetType: 'weekly' }
                : null;
        }
        if (/^\d{4}-\d{2}$/.test(marker)) {
            const explicitMonth = moment(`${marker}-01`, 'YYYY-MM-DD', true);
            return explicitMonth.isValid()
                ? { date: `${marker}-01`, targetType: 'monthly' }
                : null;
        }

        // Migrate to today [>:] or [>|]
        if (marker === ':' || marker === '|') {
            return {
                date: today.format('YYYY-MM-DD'),
                targetType: 'daily',
            };
        }

        // Migrate to current week [<w] or [>:w] or [>|w]
        if (marker === '<w' || marker === ':w' || marker === '|w') {
            const currentWeekMonday = today.clone().startOf('isoWeek');
            return {
                date: currentWeekMonday.format('YYYY-MM-DD'),
                targetType: 'weekly',
            };
        }

        // Migrate to current month [<m] or [>:m] or [>|m]
        if (marker === '<m' || marker === ':m' || marker === '|m') {
            const currentMonthStart = today.clone().startOf('month');
            return {
                date: currentMonthStart.format('YYYY-MM-DD'),
                targetType: 'monthly',
            };
        }

        // Migrate to current year [<y] or [>:y] or [>|y]
        if (marker === '<y' || marker === ':y' || marker === '|y') {
            const currentYearStart = today.clone().startOf('year');
            return {
                date: currentYearStart.format('YYYY-MM-DD'),
                targetType: 'yearly',
            };
        }

        // Forward/relative markers (>>, w, wN, m, mNw, weekdays, months, fut)
        // resolve from today, not from the note they were written in.
        //
        // These markers are applied during review, where the source note is
        // usually days or weeks old. Anchoring on the note meant "[>>]" in a
        // note from last Tuesday resolved to last Wednesday — migrating a task
        // into the past, where it would never be seen again. "Next week" has
        // to mean the week after the one you are sitting in.
        //
        // Shared with the editor suggester's preview so the popup and
        // "Process" can never disagree.
        const anchor = today.clone();
        const relative = resolveRelativeMarker(marker, anchor);
        if (relative) {
            return relative;
        }

        throw new Error(`Unknown migration marker: ${marker}`);
    }

    /**
     * Get file path for target
     */
    getTargetFilePath(date: string | null, targetType: string): string {
        return this.paths.targetFilePath(date, targetType);
    }

    /**
     * Extract source path from heading or metadata (supports multiple formats)
     */
    extractSourcePath(line: string, previousLines: string[] = []): string | null {
        // Check for source path in heading above (## or ### path format)
        for (let i = previousLines.length - 1; i >= 0; i--) {
            const prevLine = previousLines[i];
            if (!prevLine) continue;
            const trimmedLine = prevLine.trim();
            // Look for ### heading with source path
            if (trimmedLine.startsWith('### ')) {
                const sourcePath = trimmedLine.substring(4).trim();
                // Validate it looks like a file path
                if (sourcePath.includes('/') && sourcePath.endsWith('.md')) {
                    return sourcePath;
                }
            }
            // Look for ## heading with source path
            if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                const sourcePath = trimmedLine.substring(3).trim();
                // Validate it looks like a file path
                if (sourcePath.includes('/') && sourcePath.endsWith('.md')) {
                    return sourcePath;
                }
            }
            // Stop if we hit a higher level heading (#)
            if (trimmedLine.startsWith('#') && !trimmedLine.startsWith('##')) {
                break;
            }
        }
        
        // Fall back to HTML comment format
        if (previousLines.length > 0) {
            const lastLine = previousLines[previousLines.length - 1];
            if (lastLine) {
                const commentMatch = lastLine.match(/<!--\s*from:\s*([^>]+)\s*-->/);
                if (commentMatch && commentMatch[1]) {
                    return commentMatch[1].trim();
                }
            }
        }

        // Fall back to inline format for backward compatibility
        const match = line.match(/\(from:\s*([^)]+)\)/);
        return (match && match[1]) ? match[1].trim() : null;
    }

    /**
     * Check if line has migration marker
     */
    hasMigrationMarker(line: string): boolean {
        return this.parseMigrationMarker(line) !== null;
    }

    // ── These are thin wrappers around utils functions for internal use ──────
    // (Methods below like migrateTask still reference `this.isBulletItem()` etc.
    //  so we keep the method interface but delegate to utils.)

    isIncompleteTask = isIncompleteTask;
    isCompletedTask = isCompletedTask;
    isDeletedTask = isDeletedTask;
    isScheduledTask = isScheduledTask;
    isBulletItem = isBulletItem;
    getTaskText = getTaskText;
    getBulletMarker = getBulletMarker;
    getIndentLevel = getIndentLevel;
    removeMetadata = removeMetadata;
    collectChildTasks = collectChildTasks;

    /**
     * Detect period type from file path
     */
    detectPeriodType(filePath: string): PeriodType {
        return this.paths.detectPeriodType(filePath);
    }

    /**
     * Get date from file path
     */
    getDateFromFilePath(filePath: string): string | null {
        const dailyMatch = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
        if (dailyMatch && dailyMatch[1]) return dailyMatch[1];

        const weeklyMatch = filePath.match(/(\d{4})-W(\d{2})\.md$/);
        if (weeklyMatch && weeklyMatch[1] && weeklyMatch[2]) {
            const year = parseInt(weeklyMatch[1], 10);
            const week = parseInt(weeklyMatch[2], 10);
            return moment().isoWeekYear(year).isoWeek(week).startOf('isoWeek').format('YYYY-MM-DD');
        }

        const monthlyMatch = filePath.match(/(\d{4}-\d{2})\.md$/);
        if (monthlyMatch && monthlyMatch[1]) return `${monthlyMatch[1]}-01`;

        return null;
    }

    /**
     * Get template path based on file type
     */
    getTemplatePath(filePath: string): string | null {
        return this.paths.templateFor(filePath);
    }

    // =================================================================
    // FILE OPERATIONS
    // =================================================================

    /**
     * Which inclusion group a line belongs to, or null when it isn't an entry
     * a review can list (headings, prose, separators, empty bullets).
     *
     * Everything that isn't finished or filed is outstanding — events `[o]`,
     * appointments `[a]`, in-progress `[/]`, scheduled `[s]` and plain
     * information bullets included. Listing only `[ ]` meant a review silently
     * dropped most of what a bullet journal page actually holds.
     *
     * Order matters: finished states are checked first, and the bare
     * `[>]`/`[<]`/`[+]` test is anchored to the closing bracket so a pending
     * instruction like `[>mon]` or `[>-]` still reads as outstanding.
     */
    classifyTaskState(line: string): keyof TaskInclusion | null {
        const trimmed = line.trim();
        if (!this.isBulletItem(trimmed)) return null;

        // An entry needs something to say: this filters out "---" rules and
        // empty checkboxes. getTaskText alone won't do it — for "- [ ]" it
        // falls through to its plain-bullet branch and reads the empty
        // checkbox itself as the text.
        const checkbox = trimmed.match(/^-\s*\[[^\]]+\]\s*(.*)$/);
        const text = checkbox ? (checkbox[1] ?? '').trim() : this.getTaskText(trimmed);
        if (!text) return null;

        if (this.isCompletedTask(trimmed)) return 'completed';
        if (this.isDeletedTask(trimmed)) return 'cancelled';
        if (/^-\s*\[(>|<|\+)\]/i.test(trimmed)) return 'migrated';

        return 'outstanding';
    }

    /**
     * Lines from a note that a review should list, given the states asked for.
     * Returns the original lines, indentation and all, in file order.
     *
     * Oversized entries are held back and counted in `stats` — see
     * MAX_REVIEW_LINE.
     */
    async collectTasks(filePath: string, include: TaskInclusion, stats?: CollectStats): Promise<string[]> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return [];

        const content = await this.app.vault.read(file);
        return bodyLines(content).filter(line => {
            const group = this.classifyTaskState(line);
            if (group === null || !include[group]) return false;

            if (line.length > MAX_REVIEW_LINE) {
                const embedded = EMBEDDED_DATA.test(line);
                log.warn(`Held a ${line.length}-character entry out of the review`
                    + `${embedded ? ' (embedded image)' : ''}: ${filePath}`);
                if (stats) {
                    stats.oversized++;
                    if (embedded) stats.embedded++;
                }
                return false;
            }
            return true;
        });
    }

    /**
     * Create note from template
     */
    async createFromTemplate(filePath: string, templatePath: string): Promise<void> {
        const templateFile = this.app.vault.getAbstractFileByPath(templatePath);

        if (!templateFile || !(templateFile instanceof TFile)) {
            log.warn(`Template not found: ${templatePath}, creating empty file: ${filePath}`);
            await this.app.vault.create(filePath, '');
            return;
        }

        log.debug(`Creating ${filePath} from template ${templatePath}`);
        let templateContent = await this.app.vault.read(templateFile);

        // Try to use Templater if available
        const templater = this.getTemplater();
        if (templater) {
            try {
                const newFile = await this.app.vault.create(filePath, templateContent);
                await templater.templater.overwrite_file_commands(newFile);
                log.debug(`Successfully created ${filePath} from template with Templater`);
                return;
            } catch (error) {
                log.warn(`Templater processing failed for ${filePath}:`, error);
            }
        }

        await this.app.vault.create(filePath, templateContent);
        log.debug(`Successfully created ${filePath} from template`);
    }

    /**
     * The line in a batch that the migration is really about. A batch may lead
     * with plain-bullet context parents (e.g. a migrated subtask carrying its
     * parent chain), so the item to dedup and verify on is the first line with
     * a checkbox, not the context header. The checkbox is anchored to the dash
     * so wikilink brackets in a header aren't mistaken for one.
     */
    private primaryLineOf(taskLines: string[]): { line: string; contextCount: number } {
        const isTaskLine = (l: string) => /^\s*-\s*\[[^\]]+\]/.test(l);
        const primaryIndex = taskLines.findIndex(isTaskLine);
        const line = taskLines[primaryIndex >= 0 ? primaryIndex : 0] ?? '';
        return { line, contextCount: primaryIndex > 0 ? primaryIndex : 0 };
    }

    /**
     * Read the destination back and prove the item is actually there, in a
     * state that can still be acted on, before any caller is allowed to mark a
     * source task migrated.
     *
     * Without this, a write that silently did nothing — a dedup hit against a
     * crossed-out line from a previous cycle, a process callback that bailed,
     * a destination that resolved to the source note itself — reported success
     * and the source task was then marked `[>]`. The task existed nowhere.
     */
    private async confirmWritten(
        filePath: string,
        primaryLine: string,
        status: AppendResult['status'],
    ): Promise<AppendResult> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) {
            throw new Error(`Destination file missing after write: ${filePath}`);
        }

        const wanted = this.normalizeText(this.getTaskText(primaryLine));
        if (!wanted) throw new Error(`Nothing to confirm in ${filePath}: empty task text`);

        // A line counts as landed if it can still be worked, or if it carries
        // exactly the state we were asked to write — a destination checkbox
        // like {s} or {<} is deliberate, not a stale carcass.
        const intended = this.getBulletMarker(primaryLine);
        const content = await this.app.vault.read(file);
        const landed = content.split('\n').some(line =>
            this.isBulletItem(line)
            && (!isConsumedTask(line) || (intended !== null && this.getBulletMarker(line) === intended))
            && this.normalizeText(this.getTaskText(line)) === wanted);

        if (!landed) {
            throw new Error(`Destination write not confirmed in ${filePath}: "${wanted.substring(0, 60)}"`);
        }
        return { status, path: filePath };
    }

    /**
     * Append task(s) to file (creates from template if doesn't exist)
     * Can accept a single task line or an array of lines (parent + children)
     *
     * Resolves only once the item has been read back from the destination;
     * every other outcome throws. Callers must not touch the source until this
     * resolves — see confirmWritten.
     */
    async appendToFile(filePath: string, taskLineOrLines: string | string[], monthName: string | null = null): Promise<AppendResult> {
        // Normalize to array - if single line, wrap in array
        const requested = Array.isArray(taskLineOrLines) ? taskLineOrLines : [taskLineOrLines];
        // Every write funnels through here, so this is the one place that can
        // guarantee we never commit pathological nesting to a note.
        const taskLines = clampIndent(requested);
        if (taskLines.some((l, i) => l !== requested[i])) {
            log.warn(`Clamped over-indented line(s) before writing to ${filePath}`);
        }
        const taskLine = taskLines[0];
        if (!taskLine) {
            throw new Error('No task line provided to append');
        }
        const { line: primaryLine, contextCount } = this.primaryLineOf(taskLines);
        const kind = this.paths.classify(filePath);
        let file = this.app.vault.getAbstractFileByPath(filePath);

        if (!file || !(file instanceof TFile)) {
            // Ensure parent folder exists (tolerate races with sync/other plugins)
            const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
            if (folderPath && !this.app.vault.getAbstractFileByPath(folderPath)) {
                try {
                    await this.app.vault.createFolder(folderPath);
                } catch (error) {
                    log.warn(`createFolder raced for ${folderPath} (already exists?):`, error);
                }
            }

            const templatePath = this.getTemplatePath(filePath);
            if (templatePath) {
                log.debug(`Creating file from template: ${filePath} using ${templatePath}`);
                await this.createFromTemplate(filePath, templatePath);
                file = this.app.vault.getAbstractFileByPath(filePath);
                if (!file || !(file instanceof TFile)) {
                    log.warn(`Template creation failed, creating empty file: ${filePath}`);
                    await this.app.vault.create(filePath, taskLines.join('\n') + '\n');
                    return this.confirmWritten(filePath, primaryLine, 'appended');
                }
            } else {
                log.debug(`No template found, creating file: ${filePath}`);
                try {
                    await this.app.vault.create(filePath, taskLines.join('\n') + '\n');
                    return this.confirmWritten(filePath, primaryLine, 'appended');
                } catch (error) {
                    // Race: something else created the file between the existence
                    // check and create — fall through and append to it instead
                    file = this.app.vault.getAbstractFileByPath(filePath);
                    if (!file || !(file instanceof TFile)) throw error;
                }
            }
        }

        // File exists (either already existed or was just created from template)
        // Append atomically so concurrent edits (sync, other plugins) aren't clobbered
        let status: AppendResult['status'] = 'appended';
        await this.app.vault.process(file, (content) => {
        const lines = content.split('\n');
        let insertIndex = lines.length;

        // Handle future log format - find the correct section
        if (kind === 'future') {
            // Use "General" section if no month specified, otherwise use month section
            const sectionHeading = monthName ? `## ${monthName}` : '## General';
            const sectionIndex = lines.findIndex(line => line.trim() === sectionHeading);

            if (sectionIndex !== -1) {
                // Find the next separator (---) or next section heading or end of file
                let sectionEnd = lines.length;
                for (let i = sectionIndex + 1; i < lines.length; i++) {
                    const currentLine = lines[i];
                    if (currentLine && (currentLine.trim() === '---' || currentLine.trim().startsWith('## '))) {
                        sectionEnd = i;
                        break;
                    }
                }

                // Find the last task in this section (or insert after heading if empty)
                let lastTaskIndex = sectionIndex;
                for (let i = sectionIndex + 1; i < sectionEnd; i++) {
                    const currentLine = lines[i];
                    if (currentLine && currentLine.trim().startsWith('- ')) {
                        lastTaskIndex = i;
                    }
                }

                insertIndex = lastTaskIndex + 1;
                log.debug(`Found ${sectionHeading} section, inserting task at line ${insertIndex}`);
            } else {
                log.debug(`Section ${sectionHeading} not found in future log, appending to end`);
            }
        } else {
            // Determine which section to use based on file type
            let sectionName = '## Notes'; // Default for daily notes
            if (kind === 'weekly' || kind === 'monthly') {
                sectionName = '## Plan';
            }

            // Look for the appropriate section (Plan for weekly/monthly, Notes for daily)
            const sectionIndex = lines.findIndex(line => line.trim() === sectionName);
            if (sectionIndex !== -1) {
                // Insert right after the section heading (at the top of the section)
                insertIndex = sectionIndex + 1;
                log.debug(`Found ${sectionName} section at line ${sectionIndex}, inserting at ${insertIndex}`);
            } else {
                log.debug(`${sectionName} section not found, appending to end of file`);
            }
        }

        // Deduplication: skip only if a *live* copy of the task is already
        // here. A crossed-out one ([x], [-], [>], [<]) is a record of a past
        // cycle, not somewhere a task can land — treating it as a duplicate is
        // what silently dropped migrations while marking their sources [>].
        const normalizedNewText = this.normalizeText(this.getTaskText(primaryLine));
        const existingTaskIndex = lines.findIndex(line => {
            if (!this.isBulletItem(line) || isConsumedTask(line)) return false;
            return this.normalizeText(this.getTaskText(line)) === normalizedNewText;
        });

        if (existingTaskIndex !== -1) {
            log.debug(`Live copy already in ${filePath}, skipping duplicate: "${this.getTaskText(primaryLine)}"`);
            status = 'duplicate';
            return content; // Skip adding duplicate task
        }

        // Find-or-create the context parent: if the immediate parent already
        // exists at the destination (e.g. a sibling subtask migrated earlier),
        // nest the task + children under it instead of adding a second header.
        if (contextCount > 0) {
            const immediateParent = taskLines[contextCount - 1];
            const parentText = immediateParent ? this.normalizeText(this.getTaskText(immediateParent)) : '';
            // A crossed-out parent is not somewhere to nest live work either.
            const existingParentIndex = parentText
                ? lines.findIndex(l => this.isBulletItem(l) && !isConsumedTask(l)
                    && this.normalizeText(this.getTaskText(l)) === parentText)
                : -1;

            if (existingParentIndex !== -1) {
                const parentLine = lines[existingParentIndex] ?? '';
                const parentIndent = this.getIndentLevel(parentLine);

                // Walk to the end of the parent's existing subtree
                let subtreeEnd = existingParentIndex + 1;
                while (subtreeEnd < lines.length) {
                    const l = lines[subtreeEnd];
                    if (l === undefined) break;
                    if (l.trim() === '') { subtreeEnd++; continue; }
                    if (this.getIndentLevel(l) <= parentIndent) break;
                    subtreeEnd++;
                }

                // Rebase the task + children under the existing parent's indent
                const body = taskLines.slice(contextCount);
                const bodyBase = body[0]?.match(/^(\s*)/)?.[0] ?? '';
                const targetBase = (parentLine.match(/^(\s*)/)?.[0] ?? '') + '\t';
                const rebased = body.map(l => l.startsWith(bodyBase) ? targetBase + l.slice(bodyBase.length) : l);

                lines.splice(subtreeEnd, 0, ...rebased);
                log.debug(`Nested ${rebased.length} line(s) under existing parent "${this.getTaskText(parentLine)}" in ${filePath}`);
                status = 'nested';
                return lines.join('\n');
            }
        }

        // Not a duplicate and no existing parent - append the whole batch
        lines.splice(insertIndex, 0, ...taskLines);
        log.debug(`Appended ${taskLines.length} line(s) to ${filePath}: ${taskLine}`);
        return lines.join('\n');
        });

        return this.confirmWritten(filePath, primaryLine, status);
    }

    /**
     * Schedule a task to recur: create a plain [ ] occurrence in every note
     * from now until `untilISO`, stepping by the interval. The unit sets the
     * note granularity (days→daily, weeks→weekly, months→monthly). The source
     * task is left untouched, and re-running is safe because appendToFile
     * dedups by task text.
     */
    async scheduleRecurring(
        taskText: string,
        everyN: number,
        unit: RecurUnit,
        untilISO: string,
    ): Promise<{ created: number; capped: boolean; targetType: string }> {
        const clean = this.removeMetadata(taskText).trim();
        if (!clean) return { created: 0, capped: false, targetType: '' };

        const { dates, targetType, capped } = computeRecurrence(everyN, unit, untilISO);
        let created = 0;
        for (const date of dates) {
            const path = this.getTargetFilePath(date, targetType);
            const result = await this.appendToFile(path, `- [ ] ${clean}`);
            if (result.status !== 'duplicate') created++;
        }
        return { created, capped, targetType };
    }

    /**
     * Update task in file. Atomic via vault.process; located through the
     * metadata cache (exact match, then normalized text). No fuzzy matching —
     * throws if the task cannot be found so callers fail loudly.
     */
    async updateTaskInFile(filePath: string, oldLine: string, newLine: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);

        const cache = this.app.metadataCache.getFileCache(file);
        const newLineTrimmed = newLine.trim();
        const isTask = (l: string) => /^\s*-\s*\[[^\]]+\]/.test(l);
        let found = false;

        await this.app.vault.process(file, (content) => {
            const lines = content.split('\n');
            const idx = locateTaskLine(lines, oldLine, cache, isTask);
            if (idx === -1) return content;
            const line = lines[idx];
            if (line === undefined) return content;
            found = true;

            // Re-run safety: if the located line already carries the target
            // checkbox, leave it untouched
            const targetMarker = newLineTrimmed.match(/^-\s*\[([^\]]+)\]/);
            const currentMarker = line.match(/^\s*-\s*\[([^\]]+)\]/);
            if (targetMarker && currentMarker && targetMarker[1] === currentMarker[1]) {
                log.debug(`Task already in target state [${targetMarker[1]}], skipping update`);
                return content;
            }

            // Preserve the original line's indentation
            const indentMatch = line.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
            lines[idx] = indent + newLineTrimmed;
            return lines.join('\n');
        });

        if (!found) {
            const oldTaskTextClean = this.removeMetadata(this.getTaskText(oldLine)).trim();
            log.error(`Task not found in file: ${filePath}`);
            log.error(`Looking for: "${oldTaskTextClean}"`);
            log.error(`Original line: "${oldLine.substring(0, 100)}"`);
            throw new Error(`Task not found: "${oldTaskTextClean.substring(0, 50)}..." in ${filePath}`);
        }
    }

    /**
     * Shared atomic checkbox replacement: locates the task via the metadata
     * cache (exact, then normalized text — no fuzzy matching) and rewrites its
     * checkbox inside a single vault.process pass.
     */
    private async replaceCheckbox(
        taskLine: string,
        sourceFilePath: string,
        pattern: RegExp,
        replacement: string,
        verb: string,
        filterFn: (line: string) => boolean,
        leaveAlone?: (line: string) => boolean,
    ): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const cache = this.app.metadataCache.getFileCache(sourceFile);
            let found = false;
            let preserved = false;

            await this.app.vault.process(sourceFile, (content) => {
                const lines = content.split('\n');
                const idx = locateTaskLine(lines, cleanTaskLine, cache, filterFn);
                if (idx === -1) return content;
                const line = lines[idx];
                if (line === undefined) return content;
                found = true;
                // A state we must not overwrite (already finished, or already
                // further along than this verb would take it). Found, left as
                // it is — not an error, or one stale line would keep a whole
                // review from being filed away.
                if (leaveAlone?.(line)) {
                    preserved = true;
                    return content;
                }
                lines[idx] = line.replace(pattern, replacement);
                return lines.join('\n');
            });

            if (!found) {
                log.error(`Task not found to ${verb}: "${this.getTaskText(cleanTaskLine)}" in ${sourceFilePath}`);
                return { success: false, error: 'Task not found' };
            }
            if (preserved) {
                log.debug(`Left existing state alone instead of ${verb}: "${this.getTaskText(cleanTaskLine)}" in ${sourceFilePath}`);
                return { success: true, skipped: true };
            }
            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Mark task as completed in source file
     */
    async completeTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        return this.replaceCheckbox(
            taskLine, sourceFilePath,
            /^(\s*-\s*)\[\s\]/, '$1[x]', 'complete',
            // Already [x] counts as located: a task ticked in the source
            // between generating a review and processing it is not an error.
            (l) => this.isIncompleteTask(l) || this.isCompletedTask(l),
            (l) => this.isCompletedTask(l),
        );
    }

    /**
     * Mark task as cancelled in source file (marks with [-])
     */
    async cancelTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        return this.replaceCheckbox(
            taskLine, sourceFilePath,
            /^(\s*-\s*)\[\s\]/, '$1[-]', 'cancel',
            (l) => this.isIncompleteTask(l) || this.isDeletedTask(l),
            (l) => this.isDeletedTask(l),
        );
    }

    /**
     * Delete task and its children entirely from source file (for [d] marker)
     */
    async deleteTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const cache = this.app.metadataCache.getFileCache(sourceFile);
            let removedCount = 0;

            await this.app.vault.process(sourceFile, (content) => {
                const lines = content.split('\n');
                const isTask = (l: string) => /^\s*-\s*\[[^\]]+\]/.test(l);
                const parentIndex = locateTaskLine(lines, cleanTaskLine, cache, isTask);
                if (parentIndex === -1) return content;
                const parentLine = lines[parentIndex];
                if (parentLine === undefined) return content;
                const parentIndent = this.getIndentLevel(parentLine);

                // Parent plus every more-indented line following it (children and
                // continuation lines); blank lines don't end the block
                const toRemove = new Set<number>([parentIndex]);
                for (let i = parentIndex + 1; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line || line.trim() === '') continue;
                    if (this.getIndentLevel(line) > parentIndent) {
                        toRemove.add(i);
                    } else {
                        break;
                    }
                }

                removedCount = toRemove.size;
                return lines.filter((_, index) => !toRemove.has(index)).join('\n');
            });

            if (removedCount === 0) {
                log.error(`Task not found to remove: "${this.getTaskText(cleanTaskLine)}" in ${sourceFilePath}`);
                return { success: false, error: 'Task not found' };
            }

            log.debug(`Removed task and ${removedCount - 1} children from ${sourceFilePath}`);
            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`Error removing task:`, error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Mark task as scheduled in source file (uses [s] marker)
     */
    async markAsScheduled(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        return this.replaceCheckbox(
            taskLine, sourceFilePath,
            /^(\s*-\s*)\[([^\]]+)\]/, '$1[s]', 'mark as scheduled',
            (l) => /^\s*-\s*\[[^\]]+\]/.test(l),
            // Never walk a task backwards into [s]: finished work stays
            // finished, and [>-]/[<] are further along than "scheduled".
            // Already [s] is nothing to do.
            (l) => this.isCompletedTask(l) || this.isDeletedTask(l) || this.isScheduledTask(l)
                || l.includes('[>-]') || l.includes('[<]'),
        );
    }

    /**
     * Mark task as migrated in source file without creating destination task
     */
    async markAsMigrated(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        return this.replaceCheckbox(
            taskLine, sourceFilePath,
            /^(\s*-\s*)\[([^\]]+)\]/, '$1[>]', 'mark as migrated',
            (l) => /^\s*-\s*\[[^\]]+\]/.test(l),
            // Finished work stays finished, and an already-[>] line is done.
            (l) => this.isCompletedTask(l) || this.isDeletedTask(l) || /^\s*-\s*\[>\]/.test(l),
        );
    }

    /**
     * Create a new task in destination (for tasks without source file)
     */
    async createNewTask(taskLine: string, reviewDate: string | null = null): Promise<MigrationResult> {
        try {
            const parsed = this.parseMigrationMarker(taskLine);
            if (!parsed) return { success: false, error: 'No migration marker found' };

            const { marker, type, descriptor } = parsed;

            // For skip/migrated/delete markers, silently ignore (no destination to create)
            if (marker === 'skip' || marker === 'scheduled' || marker === 'migrated' || marker === 'delete') {
                return { success: false, error: 'Skip/migrated/delete markers not applicable for new tasks' };
            }

            // Use current date if no review date provided
            const sourceDate = reviewDate || moment().format('YYYY-MM-DD');
            log.debug(`Creating new task with marker: ${marker}, type: ${type}, descriptor: ${descriptor}, sourceDate: ${sourceDate}`);
            
            const destination = this.calculateDestinationDate(marker, sourceDate, 'daily');
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            log.debug(`New task destination:`, destination);

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType);
            log.debug(`New task target file: ${targetFilePath}`);

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            log.debug(`New task text: "${taskText}", cleaned: "${cleanTaskText}"`);

            // Preserve indentation from original line
            const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
            // For new tasks, preserve original bullet type if it's not a task marker
            const originalBulletMarker = this.getBulletMarker(taskLine);
            let destMarker;
            if (type) {
                // Type specified in migration marker (e.g., {o} or {a}), with optional descriptor
                destMarker = this.getDestinationMarker(type);
            } else if (originalBulletMarker) {
                const origMarker = originalBulletMarker.trim();
                // Preserve original marker if it's not a task/migration marker
                if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) && 
                    !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                    destMarker = `[${origMarker}]`;
                } else {
                    destMarker = this.getDestinationMarker(type);
                }
            } else {
                destMarker = this.getDestinationMarker(type);
            }
            // For information points (type === '.'), destMarker is empty, so format is: - Information text
            // For other types, format is: - [marker] text
            const destTaskLine = type === '.'
                ? `${indent}- ${cleanTaskText}`
                : `${indent}- ${destMarker} ${cleanTaskText}`;
            log.debug(`New task line: ${destTaskLine}`);

            try {
                await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                log.debug(`Successfully created new task in ${targetFilePath}`);
                return { success: true, destFile: targetFilePath };
            } catch (error) {
                log.error(`Failed to create new task in ${targetFilePath}:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { success: false, error: `Failed to create task: ${errorMessage}` };
            }
        } catch (error) {
            log.error(`Create new task error:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Collect children from source file (not review file)
     * This ensures we get the actual parent-child relationships
     */
    async collectChildrenFromSource(sourceFilePath: string, parentTaskText: string): Promise<ChildTask[]> {
        if (!sourceFilePath) return [];
        
        try {
            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                log.debug(`Source file not found: ${sourceFilePath}`);
                return [];
            }
            
            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            const cache = this.app.metadataCache.getFileCache(sourceFile);

            // Locate the parent (exact, then normalized text — no fuzzy matching)
            const parentIndex = locateTaskLine(lines, `- ${parentTaskText}`, cache, (l) => this.isBulletItem(l));
            if (parentIndex === -1) {
                log.debug(`Parent task not found in source file: ${sourceFilePath}, looking for: "${parentTaskText}"`);
                return [];
            }
            const parentLine = lines[parentIndex];
            if (parentLine === undefined) return [];
            const parentIndent = this.getIndentLevel(parentLine);

            // Prefer the cache's parent pointers for the hierarchy; each hit is
            // validated against current content, with an indent-walk fallback
            // for when the cache is missing or stale
            const cachedDescendants = descendantLines(cache, parentIndex);
            if (cachedDescendants) {
                const children: { line: string; index: number; indent: number }[] = [];
                for (const n of cachedDescendants) {
                    if (n <= parentIndex) continue;
                    const line = lines[n];
                    if (line === undefined || !this.isBulletItem(line)) continue;
                    const indent = this.getIndentLevel(line);
                    if (indent <= parentIndent) continue;
                    children.push({ line, index: n, indent });
                }
                if (children.length > 0) {
                    log.debug(`Found ${children.length} child task(s) via metadata cache for parent at line ${parentIndex + 1}`);
                    return children;
                }
            }

            const childTasks = this.collectChildTasks(lines, parentIndex, parentIndent);
            log.debug(`Found ${childTasks.length} child task(s) for parent in source file at line ${parentIndex + 1}`);
            return childTasks;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`Error collecting children from source: ${errorMessage}`);
            return [];
        }
    }

    normalizeText = normalizeText;

    /**
     * Collect the parent chain of a task as plain context text (outermost
     * first), so a migrated subtask can carry its parents to the destination
     * as non-task context bullets. Uses the metadata cache's parent pointers,
     * with an indent-walk fallback. Returns [] for top-level tasks.
     */
    async collectAncestorContext(sourceFilePath: string, taskLine: string): Promise<string[]> {
        if (!sourceFilePath) return [];
        try {
            const file = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!file || !(file instanceof TFile)) return [];

            const content = await this.app.vault.read(file);
            const lines = content.split('\n');
            const cache = this.app.metadataCache.getFileCache(file);

            const idx = locateTaskLine(lines, taskLine, cache, (l) => this.isBulletItem(l));
            if (idx === -1) return [];

            // Prefer cache parent pointers; fall back to an indent walk upward
            let ancestorIdx = ancestorLines(cache, idx);
            if (ancestorIdx === null) {
                ancestorIdx = [];
                const taskIndent = this.getIndentLevel(lines[idx] ?? '');
                let needIndent = taskIndent;
                for (let i = idx - 1; i >= 0 && needIndent > 0; i--) {
                    const line = lines[i];
                    if (!line || !line.trim() || !this.isBulletItem(line)) continue;
                    const lineIndent = this.getIndentLevel(line);
                    if (lineIndent < needIndent) {
                        ancestorIdx.unshift(i);
                        needIndent = lineIndent;
                    }
                }
            }

            const texts = ancestorIdx
                .map(n => lines[n])
                .filter((l): l is string => l !== undefined && this.isBulletItem(l))
                .map(l => this.removeMetadata(this.getTaskText(l)).trim())
                .filter(text => text.length > 0);

            // Never hand back a chain that would nest the task under itself or
            // repeat a parent — those write a staircase that grows every run.
            const ownText = this.removeMetadata(this.getTaskText(taskLine));
            const safe = sanitizeAncestorContext(texts, ownText);
            if (safe.length !== texts.length) {
                log.warn(`Discarded ${texts.length - safe.length} unusable ancestor(s) for "${ownText.substring(0, 50)}" in ${sourceFilePath}`);
            }
            return safe;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            log.error(`Error collecting ancestor context: ${errorMessage}`);
            return [];
        }
    }

    /**
     * Migrate a single task (and optionally its children)
     * If childTasks is empty, automatically collects children from source file
     */
    async migrateTask(taskLine: string, sourceFilePath: string, sourceDate: string, periodType: PeriodType = 'daily', childTasks: ChildTask[] = []): Promise<MigrationResult> {
        try {
            const parsed = this.parseMigrationMarker(taskLine);
            if (!parsed) return { success: false, error: 'No migration marker found' };

            const { marker, type, sourceType, isNewTask = false, isInfoPoint = false } = parsed;

            // Auto-collect children from source file if none provided
            if (childTasks.length === 0 && !isNewTask) {
                const taskText = this.getTaskText(taskLine);
                childTasks = await this.collectChildrenFromSource(sourceFilePath, taskText);
                if (childTasks.length > 0) {
                    log.debug(`Auto-collected ${childTasks.length} children for task: "${taskText.substring(0, 40)}"`);
                }
            }

            // Handle new task marker [+> - don't update source, just create destination
            if (isNewTask) {
            const destination = this.calculateDestinationDate(marker, sourceDate, periodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType);

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);

                // Preserve indentation from original line
                const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
                // Preserve original bullet type if no type specified
                const originalBulletMarker = this.getBulletMarker(taskLine);
                let destMarker;
                if (type) {
                    destMarker = this.getDestinationMarker(type as TaskType);
                } else if (originalBulletMarker) {
                    const origMarker = originalBulletMarker.trim();
                    if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) && 
                        !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                        destMarker = `[${origMarker}]`;
                    } else {
                        destMarker = this.getDestinationMarker(type);
                    }
                } else {
                    destMarker = this.getDestinationMarker(type);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;

                log.debug(`Creating new task (no source update): "${cleanTaskText}" -> ${targetFilePath}`);

                try {
                    await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                    log.debug(`Successfully created new task in ${targetFilePath}`);
                    return { success: true, sourceFile: null, destFile: targetFilePath, isNewTask: true };
                } catch (error) {
                    log.error(`Failed to create new task in ${targetFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to create task: ${errorMessage}` };
                }
            }

            // Handle delete marker - remove task and children from source
            if (marker === 'delete') {
                const result = await this.deleteTask(taskLine, sourceFilePath);
                return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
            }

            // Handle skip marker - just mark as migrated in source
            if (marker === 'skip') {
                const result = await this.markAsMigrated(taskLine, sourceFilePath);
                return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
            }

            // Handle already-migrated markers - just update source (and children)
            if (marker === 'scheduled' || marker === 'migrated') {
                const cleanTaskLine = this.removeMetadata(taskLine);
                const taskText = this.getTaskText(cleanTaskLine);
                const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
                if (!sourceFile || !(sourceFile instanceof TFile)) {
                    return { success: false, error: `Source file not found: ${sourceFilePath}` };
                }

                const cache = this.app.metadataCache.getFileCache(sourceFile);
                // Determine the marker to use: [<] for scheduled, [>-] for migrated
                const targetMarker = marker === 'scheduled' ? '[<]' : '[>-]';
                let foundParent = false;
                let alreadyMarked = false;
                let childrenMarkedCount = 0;

                log.debug(`Looking for task to mark as ${marker}: "${taskText.trim()}" in ${sourceFilePath}`);

                // Mark the parent and its outstanding children in one atomic
                // pass.
                //
                // "Outstanding" is any state that isn't finished — [ ], [s],
                // [o], [/] and so on. Matching and rewriting only [ ] meant a
                // scheduled task marked [<] in a review was either reported as
                // not found or, once found, left exactly as it was: the review
                // said the task had been dealt with and the source never
                // changed. A marker in a review is an instruction, so it
                // overrides whatever open state the task is in.
                //
                // A line already in the target state counts as found: a
                // recovery review (TaskInclusion's `migrated`) is
                // full of [<] lines the user left alone, and re-asserting
                // their state is not an error. So is finished work, which is
                // preserved rather than walked backwards.
                const anyCheckbox = /^(\s*-\s*)\[[^\]]+\]/;
                const finished = (l: string) => this.isCompletedTask(l) || this.isDeletedTask(l);
                await this.app.vault.process(sourceFile, (content) => {
                    const lines = content.split('\n');
                    const markable = (l: string) => anyCheckbox.test(l) && !finished(l);
                    const parentIndex = locateTaskLine(lines, cleanTaskLine, cache, markable);
                    if (parentIndex === -1) {
                        // Nothing outstanding under that text. Either the task
                        // has since been finished — leave it, and don't fail
                        // the review over it — or it really isn't here.
                        if (locateTaskLine(lines, cleanTaskLine, cache, (l) => anyCheckbox.test(l)) !== -1) {
                            foundParent = true;
                            alreadyMarked = true;
                        }
                        return content;
                    }
                    const parentLine = lines[parentIndex];
                    if (parentLine === undefined) return content;
                    foundParent = true;

                    if (parentLine.includes(targetMarker)) {
                        alreadyMarked = true;
                        return content;
                    }

                    const parentIndent = this.getIndentLevel(parentLine);
                    lines[parentIndex] = parentLine.replace(anyCheckbox, `$1${targetMarker}`);

                    for (const child of this.collectChildTasks(lines, parentIndex, parentIndent)) {
                        if (!anyCheckbox.test(child.line) || finished(child.line)) continue;
                        if (child.line.includes(targetMarker)) continue;
                        lines[child.index] = child.line.replace(anyCheckbox, `$1${targetMarker}`);
                        childrenMarkedCount++;
                    }
                    return lines.join('\n');
                });

                if (!foundParent) {
                    log.error(`Task not found to mark as ${marker}: "${taskText.trim()}" in ${sourceFilePath}`);
                    return { success: false, error: 'Task not found' };
                }

                if (alreadyMarked) {
                    log.debug(`Task already ${targetMarker} in ${sourceFilePath}, nothing to do`);
                    return { success: true, sourceFile: sourceFilePath, destFile: null, skipped: true };
                }

                log.debug(`Marked parent and ${childrenMarkedCount} child task(s) as ${marker}`);
                return { success: true, sourceFile: sourceFilePath, destFile: null, skipped: true, childrenMarked: childrenMarkedCount };
            }

            const destination = this.calculateDestinationDate(marker, sourceDate, periodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            log.debug(`Migration destination calculated:`, { marker, sourceDate, periodType, destination });

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType);
            log.debug(`Target file path: ${targetFilePath}`);

            // A marker that resolves to the note the task already lives in has
            // nowhere to move it: the append would dedup against the task
            // itself and the source update would then cross it out. Fail so the
            // task keeps its marker and the review is kept for another pass.
            if (sourceFilePath && targetFilePath === sourceFilePath) {
                log.error(`Marker [>${marker}] resolves to the task's own note: ${targetFilePath}`);
                return {
                    success: false,
                    error: `[>${marker}] resolves to this note itself (${targetFilePath}) — pick a different destination`,
                };
            }

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            log.debug(`Task text: "${taskText}", cleaned: "${cleanTaskText}"`);

            // Preserve original bullet type if no type specified, otherwise use destination marker
            const originalBulletMarker = this.getBulletMarker(taskLine);
            let destMarker;
            if (type) {
                // Type specified in migration marker (e.g., {o}, {a}, or {.})
                destMarker = this.getDestinationMarker(type as TaskType);
            } else if (originalBulletMarker) {
                const origMarker = originalBulletMarker.trim();
                // Preserve original marker if it's not a task/migration marker (e.g., 'o' for event, 'a' for appointment)
                // But exclude task states and migration markers
                if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) && 
                    !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                    // Preserve original marker (e.g., 'o', 'a')
                    destMarker = `[${origMarker}]`;
                } else {
                    // Default to task marker
                    destMarker = this.getDestinationMarker(type);
                }
            } else {
                // No original marker - could be plain list item (information point)
                // If no type specified, preserve as plain list item, otherwise use destination marker
                destMarker = this.getDestinationMarker(type);
            }
            
            // Preserve source indentation for computing relative child depth
            const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';

            // If this is a subtask, carry its parent chain to the destination as
            // plain-bullet context so it doesn't arrive orphaned. Parents render
            // as bullets (not tasks) at increasing depth; the task nests beneath.
            const contextParents = isNewTask || type === '.' || isInfoPoint
                ? []
                : await this.collectAncestorContext(sourceFilePath, taskLine);
            const taskBaseIndent = '\t'.repeat(contextParents.length);
            const contextLines = contextParents.map((text, i) => `${'\t'.repeat(i)}- ${text}`);

            // For information points (type === '.'), destMarker is empty, so format is: - Information text
            // For other types, format is: - [marker] text
            const destTaskLine = type === '.'
                ? `${taskBaseIndent}- ${cleanTaskText}`
                : `${taskBaseIndent}- ${destMarker} ${cleanTaskText}`;
            log.debug(`Destination task line: ${destTaskLine}`);

            // Process child tasks - Only incomplete children migrate with parent to preserve hierarchy
            const destChildLines = [];
            const updatedChildLines = [];
            const childIndicesToUpdate = [];
            for (const child of childTasks) {
                // Skip completed and cancelled children - they stay in source
                if (this.isCompletedTask(child.line) || this.isDeletedTask(child.line)) {
                    log.debug(`Skipping completed/cancelled child: "${this.getTaskText(child.line)}"`);
                    continue;
                }

                const childParsed = this.parseMigrationMarker(child.line);
                const childIndentMatch = child.line.match(/^(\s*)/);
                const childIndent = childIndentMatch ? childIndentMatch[0] : '';

                // Calculate indent from parent (maintain hierarchy). Preserve
                // original indentation style (tabs vs spaces) for the relative
                // portion, then rebase onto the task's destination indent so
                // children stay nested when the task itself was re-indented
                // (e.g. a subtask carrying parent context).
                const parentIndentLength = indent.length;
                const relativeChildIndent = parentIndentLength < childIndent.length
                    ? childIndent.substring(parentIndentLength)
                    : '\t'; // Default to tab if child was at same level (shouldn't happen normally)
                const destChildIndent = `${taskBaseIndent}${relativeChildIndent}`;

                // Determine child type and descriptor (from migration marker if present, otherwise preserve original)
                const childType = childParsed ? childParsed.type : null;

                const childText = this.getTaskText(child.line);
                const childCleanText = this.removeMetadata(childText);

                // Determine destination marker for child
                const childOriginalBulletMarker = this.getBulletMarker(child.line);
                let childDestMarker;
                if (childType) {
                    // Child has explicit type in migration marker
                    childDestMarker = this.getDestinationMarker(childType);
                } else if (childOriginalBulletMarker) {
                    // Preserve original bullet marker type
                    const childOrigMarker = childOriginalBulletMarker.trim();
                    if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(childOrigMarker) &&
                        !childOrigMarker.startsWith('>') && !childOrigMarker.startsWith('<') && !childOrigMarker.startsWith('+>')) {
                        childDestMarker = `[${childOrigMarker}]`;
                    } else {
                        childDestMarker = this.getDestinationMarker(null);
                    }
                } else {
                    // Default to preserving as-is (plain list item or task)
                    childDestMarker = this.isBulletItem(child.line) && child.line.includes('[ ]')
                        ? this.getDestinationMarker(null)
                        : '';
                }

                const childDestLine = (childType === '.' || (childParsed && childParsed.isInfoPoint))
                    ? `${destChildIndent}- ${childCleanText}`
                    : childDestMarker
                        ? `${destChildIndent}- ${childDestMarker} ${childCleanText}`
                        : `${destChildIndent}- ${childCleanText}`;
                destChildLines.push(childDestLine);

                // Update source line for child
                if (childParsed && this.hasMigrationMarker(child.line)) {
                    // Child has migration marker - mark it as migrated in source
                    if (childType === '.' || childParsed.isInfoPoint) {
                        updatedChildLines.push(`${childIndent}- ${childCleanText}`);
                    } else {
                        const childMarker = childParsed.marker;
                        // If child has sourceType specified via (...), use that for source marker
                        const childSourceType = childParsed.sourceType || null;
                        const childOrigMarker = this.getOriginalMarker(childMarker, childType, childSourceType);
                        // Replace checkbox content for child: [>mon] → [>] or [<] (or preserved state)
                        const updatedChildLine = child.line.replace(/^(\s*-\s*)\[[^\]]+\]/, `$1[${childOrigMarker}]`);
                        updatedChildLines.push(updatedChildLine);
                    }
                    childIndicesToUpdate.push(child);
                } else {
                    // Child doesn't have migration marker - handle based on type
                    const hasCheckbox = /^(\s*-\s*)\[/.test(child.line);

                    if (!hasCheckbox) {
                        // Plain information point (no checkbox) - keep in source AND migrate to destination
                        // Don't add to updatedChildLines or childIndicesToUpdate - leave source unchanged
                        log.debug(`Plain info point child stays in source: "${childCleanText}"`);
                        continue;
                    }

                    // Has checkbox - mark it as migrated with parent's marker type
                    // If parent has sourceType specified via (...), use that for children too
                    const parentOrigMarker = this.getOriginalMarker(marker, type, sourceType);
                    if (this.isIncompleteTask(child.line)) {
                        // Mark incomplete task children with parent's marker: [ ] → [>] or [<]
                        updatedChildLines.push(child.line.replace(/^(\s*-\s*)\[\s\]/, `$1[${parentOrigMarker}]`));
                        childIndicesToUpdate.push(child);
                    } else if (!this.isCompletedTask(child.line) && !this.isDeletedTask(child.line)) {
                        // For non-task children (events [o], appointments [a], etc.), replace checkbox with parent's marker
                        // But NOT completed [x] or cancelled [-] tasks - those stay unchanged
                        const childLineWithMarker = child.line.replace(/^(\s*-\s*)\[[^\]]+\]/, `$1[${parentOrigMarker}]`);
                        updatedChildLines.push(childLineWithMarker);
                        childIndicesToUpdate.push(child);
                    } else {
                        // Completed/cancelled task reached this point - skip it (safety fallback)
                        log.debug(`Skipping completed/cancelled child in fallback: "${this.getTaskText(child.line)}"`);
                    }
                }
            }
            
            // Combine context parents, task, and children for the destination
            const allDestLines = [...contextLines, destTaskLine, ...destChildLines];

            // For information points ([-] notation), don't add migration marker - just remove the migration marker
            let updatedSourceLine;
            if (type === '.' || isInfoPoint) {
                // Information points: remove migration marker, keep as plain list item
                const indentMatch = taskLine.match(/^(\s*)/);
                const indent = indentMatch ? indentMatch[0] : '';
                const text = this.getTaskText(taskLine);
                updatedSourceLine = `${indent}- ${text}`;
            } else {
                // Replace checkbox content: [>mon] → [>] or [<]
                // If type is specified (e.g., {/}), preserve that state in source
                const origMarker = this.getOriginalMarker(marker, type, sourceType);
                updatedSourceLine = taskLine.replace(/^(\s*-\s*)\[[^\]]+\]/, `$1[${origMarker}]`);
            }
            log.debug(`Updated source line: ${updatedSourceLine}`);

            // Commit order matters: the destination write is confirmed first,
            // and the source is only marked once it has. The worst case is a
            // duplicate at the destination (which the next run dedups away);
            // the alternative is a task marked migrated into thin air.
            let appended: AppendResult;
            try {
                appended = await this.appendToFile(targetFilePath, allDestLines, destination.monthName);
                const migratedChildrenCount = destChildLines.length;
                if (migratedChildrenCount > 0) {
                    log.debug(`Confirmed ${allDestLines.length} line(s) (parent + ${migratedChildrenCount} migrated children) in ${targetFilePath} [${appended.status}]`);
                } else {
                    log.debug(`Confirmed parent task in ${targetFilePath} [${appended.status}] (${childTasks.length} children without markers stayed in source)`);
                }
                if (appended.status === 'duplicate') {
                    log.warn(`"${cleanTaskText.substring(0, 60)}" was already open in ${targetFilePath}; source marked migrated without a second copy`);
                }
            } catch (error) {
                log.error(`Failed to append task to ${targetFilePath}:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { success: false, error: `Failed to append to destination: ${errorMessage}` };
            }

            // Only update source if it's not a new task marker and source path is provided
            if (!isNewTask && sourceFilePath) {
                try {
                    // Update parent task
                    await this.updateTaskInFile(sourceFilePath, taskLine, updatedSourceLine);
                    
                    // Update child tasks that were migrated (only those with migration markers)
                    let childUpdateErrors = 0;
                    for (let i = 0; i < childIndicesToUpdate.length; i++) {
                        const child = childIndicesToUpdate[i];
                        const updatedChildLine = updatedChildLines[i];
                        if (child && updatedChildLine) {
                            try {
                                await this.updateTaskInFile(sourceFilePath, child.line, updatedChildLine);
                            } catch (childError) {
                                childUpdateErrors++;
                                const childTaskText = this.getTaskText(child.line);
                                log.error(`Failed to update child task "${childTaskText.substring(0, 50)}" in ${sourceFilePath}:`, childError);
                                // Continue processing other children instead of failing completely
                            }
                        }
                    }
                    
                    const migratedChildrenCount = childIndicesToUpdate.length;
                    const successfulChildUpdates = migratedChildrenCount - childUpdateErrors;
                    if (migratedChildrenCount > 0) {
                        log.debug(`Successfully updated source file ${sourceFilePath} (parent + ${successfulChildUpdates}/${migratedChildrenCount} migrated children${childUpdateErrors > 0 ? `, ${childUpdateErrors} child updates failed` : ''})`);
                    } else {
                        log.debug(`Successfully updated source file ${sourceFilePath} (parent only, ${childTasks.length - migratedChildrenCount} children without markers stayed)`);
                    }
                } catch (error) {
                    log.error(`Failed to update parent task in source file ${sourceFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to update source: ${errorMessage}` };
                }
            } else if (isNewTask) {
                log.debug(`Skipping source update for new task marker [+>`);
            }

            return {
                success: true,
                sourceFile: sourceFilePath,
                destFile: targetFilePath,
                deduped: appended.status === 'duplicate',
            };
        } catch (error) {
            log.error(`Migration error:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Migrate a single task for planning (uses [s] marker instead of [>])
     * If childTasks is empty, automatically collects children from source file
     */
    async migrateTaskForPlan(taskLine: string, sourceFilePath: string, sourceDate: string, periodType: PeriodType = 'daily', childTasks: ChildTask[] = []): Promise<MigrationResult> {
        try {
            const parsed = this.parseMigrationMarker(taskLine);
            if (!parsed) return { success: false, error: 'No migration marker found' };

            const { marker, type, originalMarker, isNewTask = false } = parsed;

            // Auto-collect children from source file if none provided
            if (childTasks.length === 0 && !isNewTask) {
                const taskText = this.getTaskText(taskLine);
                childTasks = await this.collectChildrenFromSource(sourceFilePath, taskText);
                if (childTasks.length > 0) {
                    log.debug(`Auto-collected ${childTasks.length} children for scheduling: "${taskText.substring(0, 40)}"`);
                }
            }

            // Handle new task marker [+> - don't update source, just create destination
            if (isNewTask) {
                const destination = this.calculateDestinationDate(marker, sourceDate, periodType);
                if (!destination) {
                    return { success: false, error: `Invalid destination marker: ${marker}` };
                }
                const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType);

                const taskText = this.getTaskText(taskLine);
                const cleanTaskText = this.removeMetadata(taskText);

                // Preserve indentation from original line
                const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
                // Preserve original bullet type if no type specified
                const originalBulletMarker = this.getBulletMarker(taskLine);
                let destMarker;
                if (type) {
                    destMarker = this.getDestinationMarker(type as TaskType);
                } else if (originalBulletMarker) {
                    const origMarker = originalBulletMarker.trim();
                    if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) && 
                        !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                        destMarker = `[${origMarker}]`;
                    } else {
                        destMarker = this.getDestinationMarker(type);
                    }
                } else {
                    destMarker = this.getDestinationMarker(type);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;

                log.debug(`Creating new task (no source update): "${cleanTaskText}" -> ${targetFilePath}`);

                try {
                    await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                    log.debug(`Successfully created new task in ${targetFilePath}`);
                    return { success: true, sourceFile: null, destFile: targetFilePath, isNewTask: true };
                } catch (error) {
                    log.error(`Failed to create new task in ${targetFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to create task: ${errorMessage}` };
                }
            }

            // Handle delete marker - remove task and children from source
            if (marker === 'delete') {
                const result = await this.deleteTask(taskLine, sourceFilePath);
                return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
            }

            // Handle skip marker - mark as [>] if [>-], otherwise mark as [s] for planning
            if (marker === 'skip') {
                // If original marker was [>-], mark as [>], otherwise mark as [s].
                // originalMarker holds the whole matched prefix ("  - [>-]"),
                // never the bare checkbox, so this has to be a substring test.
                if (originalMarker.includes('[>-]')) {
                    const result = await this.markAsMigrated(taskLine, sourceFilePath);
                    return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
                } else {
                    const result = await this.markAsScheduled(taskLine, sourceFilePath);
                    return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
                }
            }

            // Handle already-migrated markers - just update source to [s]
            if (marker === 'scheduled' || marker === 'migrated') {
                const result = await this.markAsScheduled(taskLine, sourceFilePath);
                return { success: result.success, sourceFile: sourceFilePath, destFile: null, skipped: true };
            }

            const destination = this.calculateDestinationDate(marker, sourceDate, periodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            log.debug(`Planning migration destination calculated:`, { marker, sourceDate, periodType, destination });

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType);
            log.debug(`Target file path: ${targetFilePath}`);

            // Same guard as migrateTask: scheduling a task into the note it is
            // already in would mark it [s] with no scheduled copy anywhere.
            if (sourceFilePath && targetFilePath === sourceFilePath) {
                log.error(`Marker [>${marker}] resolves to the task's own note: ${targetFilePath}`);
                return {
                    success: false,
                    error: `[>${marker}] resolves to this note itself (${targetFilePath}) — pick a different destination`,
                };
            }

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            log.debug(`Task text: "${taskText}", cleaned: "${cleanTaskText}"`);

            // Preserve indentation from original line for nested tasks
            const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
            // Preserve original bullet type if no type specified
            const originalBulletMarker = this.getBulletMarker(taskLine);
            let destMarker;
            if (type) {
                destMarker = this.getDestinationMarker(type as TaskType);
            } else if (originalBulletMarker) {
                const origMarker = originalBulletMarker.trim();
                if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) && 
                    !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                    destMarker = `[${origMarker}]`;
                } else {
                    destMarker = this.getDestinationMarker(type);
                }
                } else {
                    destMarker = this.getDestinationMarker(type);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;
            log.debug(`Destination task line: ${destTaskLine}`);

            // Process child tasks - only incomplete children go to destination
            const destChildLines: string[] = [];
            const childUpdates: { original: string; updated: string }[] = [];

            for (const child of childTasks) {
                // Skip completed and cancelled children - they stay in source unchanged
                if (this.isCompletedTask(child.line) || this.isDeletedTask(child.line)) {
                    log.debug(`Skipping completed/cancelled child: "${this.getTaskText(child.line)}"`);
                    continue;
                }

                const childIndentMatch = child.line.match(/^(\s*)/);
                const childIndent = childIndentMatch ? childIndentMatch[0] : '';
                const childText = this.getTaskText(child.line);
                const childCleanText = this.removeMetadata(childText);

                // Calculate relative indent from parent (maintain hierarchy)
                // Preserve original indentation style (tabs vs spaces)
                const parentIndentLength = indent.length;
                const destChildIndent = parentIndentLength < childIndent.length
                    ? childIndent.substring(parentIndentLength)
                    : '\t'; // Default to tab if child was at same level

                // Determine child destination marker
                const childOriginalMarker = this.getBulletMarker(child.line);
                let childDestMarker;
                if (childOriginalMarker) {
                    const origMarker = childOriginalMarker.trim();
                    if (![' ', 'x', '-', 's', '>', '<', '>-', '>skip', '>x'].includes(origMarker) &&
                        !origMarker.startsWith('>') && !origMarker.startsWith('<') && !origMarker.startsWith('+>')) {
                        childDestMarker = `[${origMarker}]`;
                    } else {
                        childDestMarker = '[ ]';
                    }
                } else {
                    childDestMarker = '[ ]';
                }

                const childDestLine = `${destChildIndent}- ${childDestMarker} ${childCleanText}`;
                destChildLines.push(childDestLine);

                // Prepare source update for child
                const updatedChildLine = child.line.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[s]');
                childUpdates.push({ original: child.line, updated: updatedChildLine });
            }

            // Combine parent and children for destination
            const allDestLines = [destTaskLine, ...destChildLines];

            // Use [s] instead of [>] for planning - replace checkbox content
            const updatedSourceLine = taskLine.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[s]');
            log.debug(`Updated source line (scheduled): ${updatedSourceLine}`);

            // Destination first, confirmed, before the source is marked [s].
            let appended: AppendResult;
            try {
                appended = await this.appendToFile(targetFilePath, allDestLines, destination.monthName || null);
                if (destChildLines.length > 0) {
                    log.debug(`Confirmed task with ${destChildLines.length} children in ${targetFilePath} [${appended.status}]`);
                } else {
                    log.debug(`Confirmed task in ${targetFilePath} [${appended.status}]`);
                }
            } catch (error) {
                log.error(`Failed to append task to ${targetFilePath}:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { success: false, error: `Failed to append to destination: ${errorMessage}` };
            }

            // Only update source if it's not a new task marker and source path is provided
            if (!isNewTask && sourceFilePath) {
                try {
                    // Update parent task
                    await this.updateTaskInFile(sourceFilePath, taskLine, updatedSourceLine);

                    // Update child tasks
                    let childUpdateErrors = 0;
                    for (const childUpdate of childUpdates) {
                        try {
                            await this.updateTaskInFile(sourceFilePath, childUpdate.original, childUpdate.updated);
                        } catch (childError) {
                            childUpdateErrors++;
                            const childTaskText = this.getTaskText(childUpdate.original);
                            log.error(`Failed to update child task "${childTaskText.substring(0, 50)}" in ${sourceFilePath}:`, childError);
                            // Continue processing other children instead of failing completely
                        }
                    }

                    const successfulChildUpdates = childUpdates.length - childUpdateErrors;
                    if (childUpdates.length > 0) {
                        log.debug(`Successfully updated source file ${sourceFilePath} with [s] marker (parent + ${successfulChildUpdates}/${childUpdates.length} children${childUpdateErrors > 0 ? `, ${childUpdateErrors} child updates failed` : ''})`);
                    } else {
                        log.debug(`Successfully updated source file ${sourceFilePath} with [s] marker`);
                    }
                } catch (error) {
                    log.error(`Failed to update parent task in source file ${sourceFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to update source: ${errorMessage}` };
                }
            } else if (isNewTask) {
                log.debug(`Skipping source update for new task marker [+>`);
            }

            return {
                success: true,
                sourceFile: sourceFilePath,
                destFile: targetFilePath,
                childrenMarked: childUpdates.length,
                deduped: appended.status === 'duplicate',
            };
        } catch (error) {
            log.error(`Planning migration error:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    // =================================================================
    // COMMANDS
    //
    // Thin delegators. The implementations live in reviews.ts and
    // task-commands.ts, which take this instance as their first argument;
    // keeping the methods here means command IDs, call sites and `this.`
    // recursion inside the engine all keep working unchanged.
    // =================================================================

    async migrateWeeklyReview(): Promise<void> {
        return reviews.migrateWeeklyReview(this);
    }

    async migrateMonthlyReview(): Promise<void> {
        return reviews.migrateMonthlyReview(this);
    }

    /** Any scope, any set of task states — what the "Generate review" modal calls. */
    async generateReview(request: reviews.ReviewRequest): Promise<void> {
        return reviews.generateReview(this, request);
    }

    async migrateRangeReview(): Promise<void> {
        return reviews.migrateRangeReview(this);
    }

    async migrateGlobalReview(): Promise<void> {
        return reviews.migrateGlobalReview(this);
    }

    async schedulePlan(periodType: PeriodType): Promise<void> {
        return taskCommands.schedulePlan(this, periodType);
    }

    async migrateSelectedTasks(editor: Editor): Promise<void> {
        return taskCommands.migrateSelectedTasks(this, editor);
    }

    async scheduleSelectedTasks(editor: Editor): Promise<void> {
        return taskCommands.scheduleSelectedTasks(this, editor);
    }

    async migrateTasks(): Promise<void> {
        return taskCommands.migrateTasks(this);
    }

    async migrateJournalNote(periodType: PeriodType | 'future'): Promise<void> {
        return taskCommands.migrateJournalNote(this, periodType);
    }

    async scheduleTasks(): Promise<void> {
        return taskCommands.scheduleTasks(this);
    }
}
