// Bullet Journal Migration System
// Provides weekly and monthly review generation and processing

import { App, TFile, moment, Editor } from 'obsidian';
import { MigrationMarker, MigrationResult, TaskType, PeriodType, ChildTask, DestinationDate } from './types';
import {
	normalizeText,
	isIncompleteTask,
	isCompletedTask,
	isDeletedTask,
	isScheduledTask,
	isBulletItem,
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
    calculateDestinationDate(marker: string, sourceDate: string, periodType: PeriodType = 'daily'): DestinationDate | null {
        const sourceMoment = moment(sourceDate, 'YYYY-MM-DD');
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
        // are anchored on the note's own date, not today: [>w] in a 2026-W31
        // note resolves to W32. Shared with the editor suggester's preview so
        // the popup and "Process" never disagree.
        const anchor = sourceMoment.isValid() ? sourceMoment.clone().startOf('day') : today.clone();
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
     * Get all incomplete tasks from a file (includes scheduled tasks [s] or [<])
     * Also includes items with migration markers (for non-task items like events, information, etc.)
     */
    async getIncompleteTasks(filePath: string): Promise<string[]> {
        log.debug(`*** getIncompleteTasks called for: ${filePath}`);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return [];

        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        log.debug(`*** Processing ${lines.length} lines from ${filePath}`);
        return lines.filter(line => {
            const trimmed = line.trim();
            
            // Explicitly exclude already-processed tasks - these shouldn't be in reviews
            // [-] = cancelled, [x] = completed, [>] = migrated, [<] = scheduled elsewhere, [+] = new task created
            // Note: Check trimmed line since tasks may have leading whitespace
            if (/^-\s*\[(-|x|>|<|\+)\]/i.test(trimmed)) {
                log.debug(`Excluding already-processed task from review: "${trimmed.substring(0, 50)}"`);
                return false;
            }
            
            // Include incomplete tasks and [s] scheduled tasks (scheduled in plan, not yet migrated)
            if (this.isIncompleteTask(trimmed) || this.isScheduledTask(trimmed)) {
                return true;
            }
            
            // Include any bullet item with a migration marker (for events, information, etc.)
            if (this.isBulletItem(trimmed) && this.hasMigrationMarker(trimmed)) {
                return true;
            }
            return false;
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
     * Append task(s) to file (creates from template if doesn't exist)
     * Can accept a single task line or an array of lines (parent + children)
     */
    async appendToFile(filePath: string, taskLineOrLines: string | string[], monthName: string | null = null): Promise<void> {
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
                    return;
                }
            } else {
                log.debug(`No template found, creating file: ${filePath}`);
                try {
                    await this.app.vault.create(filePath, taskLines.join('\n') + '\n');
                    return;
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

        // A batch may lead with plain-bullet context parents (e.g. a migrated
        // subtask carrying its parent). The "real" task to dedup on is the first
        // line with a checkbox, not the context header. Anchor the checkbox to
        // the dash so wikilink brackets in a header aren't mistaken for one.
        const isTaskLine = (l: string) => /^\s*-\s*\[[^\]]+\]/.test(l);
        const primaryIndex = taskLines.findIndex(isTaskLine);
        const contextCount = primaryIndex > 0 ? primaryIndex : 0;
        const primaryLine = taskLines[primaryIndex >= 0 ? primaryIndex : 0] ?? taskLine;

        // Deduplication: skip if the actual task already exists anywhere here
        const normalizedNewText = this.normalizeText(this.getTaskText(primaryLine));
        const existingTaskIndex = lines.findIndex(line => {
            if (!this.isBulletItem(line)) return false;
            return this.normalizeText(this.getTaskText(line)) === normalizedNewText;
        });

        if (existingTaskIndex !== -1) {
            log.debug(`Task already exists in ${filePath}, skipping duplicate: "${this.getTaskText(primaryLine)}"`);
            return content; // Skip adding duplicate task
        }

        // Find-or-create the context parent: if the immediate parent already
        // exists at the destination (e.g. a sibling subtask migrated earlier),
        // nest the task + children under it instead of adding a second header.
        if (contextCount > 0) {
            const immediateParent = taskLines[contextCount - 1];
            const parentText = immediateParent ? this.normalizeText(this.getTaskText(immediateParent)) : '';
            const existingParentIndex = parentText
                ? lines.findIndex(l => this.isBulletItem(l) && this.normalizeText(this.getTaskText(l)) === parentText)
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
                return lines.join('\n');
            }
        }

        // Not a duplicate and no existing parent - append the whole batch
        lines.splice(insertIndex, 0, ...taskLines);
        log.debug(`Appended ${taskLines.length} line(s) to ${filePath}: ${taskLine}`);
        return lines.join('\n');
        });
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
        for (const date of dates) {
            const path = this.getTargetFilePath(date, targetType);
            await this.appendToFile(path, `- [ ] ${clean}`);
        }
        return { created: dates.length, capped, targetType };
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
    ): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const cache = this.app.metadataCache.getFileCache(sourceFile);
            let found = false;

            await this.app.vault.process(sourceFile, (content) => {
                const lines = content.split('\n');
                const idx = locateTaskLine(lines, cleanTaskLine, cache, filterFn);
                if (idx === -1) return content;
                const line = lines[idx];
                if (line === undefined) return content;
                lines[idx] = line.replace(pattern, replacement);
                found = true;
                return lines.join('\n');
            });

            if (!found) {
                log.error(`Task not found to ${verb}: "${this.getTaskText(cleanTaskLine)}" in ${sourceFilePath}`);
                return { success: false, error: 'Task not found' };
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
            (l) => this.isIncompleteTask(l),
        );
    }

    /**
     * Mark task as cancelled in source file (marks with [-])
     */
    async cancelTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        return this.replaceCheckbox(
            taskLine, sourceFilePath,
            /^(\s*-\s*)\[\s\]/, '$1[-]', 'cancel',
            (l) => this.isIncompleteTask(l),
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
            // Any task, except ones already marked [>-] or [<]
            (l) => /^\s*-\s*\[[^\]]+\]/.test(l) && !l.includes('[>-]') && !l.includes('[<]'),
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
                let childrenMarkedCount = 0;

                log.debug(`Looking for task to mark as ${marker}: "${taskText.trim()}" in ${sourceFilePath}`);

                // Mark parent and its incomplete children in one atomic pass
                await this.app.vault.process(sourceFile, (content) => {
                    const lines = content.split('\n');
                    const parentIndex = locateTaskLine(lines, cleanTaskLine, cache, (l) => this.isIncompleteTask(l));
                    if (parentIndex === -1) return content;
                    const parentLine = lines[parentIndex];
                    if (parentLine === undefined) return content;
                    foundParent = true;

                    const parentIndent = this.getIndentLevel(parentLine);
                    lines[parentIndex] = parentLine.replace(/^(\s*-\s*)\[\s\]/, `$1${targetMarker}`);

                    for (const child of this.collectChildTasks(lines, parentIndex, parentIndent)) {
                        if (this.isIncompleteTask(child.line)) {
                            lines[child.index] = child.line.replace(/^(\s*-\s*)\[\s\]/, `$1${targetMarker}`);
                            childrenMarkedCount++;
                        }
                    }
                    return lines.join('\n');
                });

                if (!foundParent) {
                    log.error(`Task not found to mark as ${marker}: "${taskText.trim()}" in ${sourceFilePath}`);
                    return { success: false, error: 'Task not found' };
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

            try {
                await this.appendToFile(targetFilePath, allDestLines, destination.monthName);
                const migratedChildrenCount = destChildLines.length;
                if (migratedChildrenCount > 0) {
                    log.debug(`Successfully appended ${allDestLines.length} line(s) (parent + ${migratedChildrenCount} migrated children) to ${targetFilePath}`);
                } else {
                    log.debug(`Successfully appended parent task to ${targetFilePath} (${childTasks.length} children without markers stayed in source)`);
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

            return { success: true, sourceFile: sourceFilePath, destFile: targetFilePath };
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

            try {
                await this.appendToFile(targetFilePath, allDestLines, destination.monthName || null);
                if (destChildLines.length > 0) {
                    log.debug(`Successfully appended task with ${destChildLines.length} children to ${targetFilePath}`);
                } else {
                    log.debug(`Successfully appended task to ${targetFilePath}`);
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

            return { success: true, sourceFile: sourceFilePath, destFile: targetFilePath, childrenMarked: childUpdates.length };
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

    async generateWeeklyReview(weekString: string | null = null): Promise<void> {
        return reviews.generateWeeklyReview(this, weekString);
    }

    async migrateWeeklyReview(): Promise<void> {
        return reviews.migrateWeeklyReview(this);
    }

    async generateMonthlyReview(monthString: string | null = null): Promise<void> {
        return reviews.generateMonthlyReview(this, monthString);
    }

    async migrateMonthlyReview(): Promise<void> {
        return reviews.migrateMonthlyReview(this);
    }

    async generateGlobalReview(): Promise<void> {
        return reviews.generateGlobalReview(this);
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
