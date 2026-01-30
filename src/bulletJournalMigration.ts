// Bullet Journal Migration System
// Provides weekly and monthly review generation and processing

import { App, Notice, TFile, TFolder, moment, Editor } from 'obsidian';
import { MigrationMarker, MigrationResult, TaskType, PeriodType, ChildTask, DestinationDate } from './types';
// @ts-nocheck
// CustomJS Script: Bullet Journal Migration System
// Provides weekly and monthly review generation and processing

export class BulletJournalMigration {
	app: App;

	constructor(app: App) {
		this.app = app;
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
        const infoPointMatch = line.match(/^\s*-\s*\[->(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut)\]/i);
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
        // Support checkbox content: {o}, {a}, {.}, {=}, etc. - becomes destination checkbox
        // Note: w\d* matches both 'w' (next week) and 'w1', 'w2', etc. (numbered weeks)
        const newTaskMatch = line.match(/^\s*-\s*\[\+>(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut)(?:\{([^}]+)\})?\]/i);
        if (newTaskMatch && newTaskMatch[1]) {
            const checkboxContent = newTaskMatch[2] || null;
            return {
                marker: newTaskMatch[1].toLowerCase(),
                type: checkboxContent,
                descriptor: null,
                originalMarker: newTaskMatch[0],
                isNewTask: true,
            };
        }

        // Check for delete marker (remove from source, don't migrate)
        const deleteMatch = line.match(/^\s*-\s*\[d\]/i);
        if (deleteMatch) {
            return {
                marker: 'delete',
                type: null,
                originalMarker: deleteMatch[0],
            };
        }

        // Check for skip marker (mark as migrated without migrating)
        const skipMatch = line.match(/^\s*-\s*\[>(skip|x)\]/i);
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
        const currentPeriodMatch = line.match(/^\s*-\s*\[(?:>(:|\|)(w|m|y)|<(w|m|y))\]/i);
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
        const scheduledMatch = line.match(/^\s*-\s*\[<\]/);
        if (scheduledMatch) {
            return {
                marker: 'scheduled',
                type: null,
                originalMarker: scheduledMatch[0],
            };
        }

        // Check for [>-] marker (mark as migrated without migrating, like [>skip])
        const markWithoutMigrateMatch = line.match(/^\s*-\s*\[>-\]/);
        if (markWithoutMigrateMatch) {
            return {
                marker: 'skip',
                type: null,
                originalMarker: markWithoutMigrateMatch[0],
            };
        }

        // Check for [>] marker - ignore it (don't process, leave as-is)
        const ignoreMatch = line.match(/^\s*-\s*\[>\]/);
        if (ignoreMatch) {
            return null; // Return null so it's not processed
        }

        // Support numbered weeks: w1, w2, w3, w4 (weeks from now)
        // Support month week: m3w (3rd week of month)
        // Support today marker: [>:] or [>|]
        // Support current period markers: [>:w]/[>|w], [>:m]/[>|m], [>:y]/[>|y] OR legacy [<w], [<m], [<y]
        // Support checkbox content: {o}, {a}, {.}, {=}, etc. - becomes destination checkbox
        // Note: w\d* matches both 'w' (next week) and 'w1', 'w2', etc. (numbered weeks)
        const markerRegex = /^\s*-\s*\[>(>|:|\||:w|\|w|:m|\|m|:y|\|y|w\d*|m\d+w|m|<w|<m|<y|mon|tue|tues|wed|thu|thurs|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|fut)(?:\{([^}]+)\})?\]/i;
        const match = line.match(markerRegex);

        if (!match || !match[1]) {
            return null;
        }

        const checkboxContent = match[2] || null;

        return {
            marker: match[1].toLowerCase(),
            type: checkboxContent,
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
    getOriginalMarker(marker: string, type: TaskType = null): string {
        // Return just the checkbox content (not full brackets)
        // Used for replacing checkbox: [>mon] → [>] or [<]
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

        // Tomorrow [>>] - always relative to today
        if (marker === '>') {
            return {
                date: today.clone().add(1, 'day').format('YYYY-MM-DD'),
                targetType: 'daily',
            };
        }

        // Numbered weeks from now (w1 = 1 week, w2 = 2 weeks, etc.) - relative to today
        const weekNumberMatch = marker.match(/^w(\d+)$/);
        if (weekNumberMatch && weekNumberMatch[1]) {
            const weekNum = parseInt(weekNumberMatch[1], 10);
            if (weekNum >= 1) {
                const targetMoment = today.clone().add(weekNum, 'weeks').startOf('isoWeek');
                return {
                    date: targetMoment.format('YYYY-MM-DD'),
                    targetType: 'weekly',
                };
            }
        }

        // Nth week of the month (m3w = 3rd week of month) - relative to today
        const monthWeekMatch = marker.match(/^m(\d+)w$/);
        if (monthWeekMatch && monthWeekMatch[1]) {
            const weekNum = parseInt(monthWeekMatch[1], 10);
            if (weekNum >= 1 && weekNum <= 4) {
                const weekDayMap: { [key: number]: number } = { 1: 4, 2: 11, 3: 18, 4: 25 };
                const targetDay = weekDayMap[weekNum];

                if (targetDay === undefined) {
                    return null;
                }

                // Try current month first
                const currentMonth = today.clone().startOf('month');
                const targetDateCurrent = currentMonth.clone().date(targetDay);
                const mondayOfWeekCurrent = targetDateCurrent.clone().startOf('isoWeek');

                // If the week has already passed, use next month
                if (mondayOfWeekCurrent.isBefore(today, 'day')) {
                    const nextMonth = currentMonth.clone().add(1, 'month');
                    const targetDateNext = nextMonth.clone().date(targetDay);
                    const mondayOfWeekNext = targetDateNext.clone().startOf('isoWeek');

                    return {
                        date: mondayOfWeekNext.format('YYYY-MM-DD'),
                        targetType: 'weekly',
                    };
                }

                return {
                    date: mondayOfWeekCurrent.format('YYYY-MM-DD'),
                    targetType: 'weekly',
                };
            }
        }

        // Next week [>w] - relative to today
        if (marker === 'w') {
            return {
                date: today.clone().add(1, 'week').startOf('isoWeek').format('YYYY-MM-DD'),
                targetType: 'weekly',
            };
        }

        // Next month [>m] - relative to today
        if (marker === 'm') {
            return {
                date: today.clone().add(1, 'month').startOf('month').format('YYYY-MM-DD'),
                targetType: 'monthly',
            };
        }

        // Specific days of week [>mon], [>tue], etc. - next occurrence from today
        const daysOfWeek: { [key: string]: number } = {
            'mon': 1, 'tue': 2, 'tues': 2, 'wed': 3,
            'thu': 4, 'thurs': 4, 'fri': 5, 'sat': 6, 'sun': 7
        };

        if (daysOfWeek.hasOwnProperty(marker)) {
            const targetDay = daysOfWeek[marker];
            if (targetDay === undefined) {
                return null;
            }
            const currentDay = today.isoWeekday();
            let daysToAdd = targetDay - currentDay;
            if (daysToAdd <= 0) daysToAdd += 7;

            const targetMoment = today.clone().add(daysToAdd, 'days');
            return {
                date: targetMoment.format('YYYY-MM-DD'),
                targetType: 'daily',
            };
        }

        // Specific months [>jan], [>feb], etc. - next occurrence from today
        const months: { [key: string]: number } = {
            'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4,
            'may': 5, 'jun': 6, 'jul': 7, 'aug': 8,
            'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
        };

        if (months.hasOwnProperty(marker)) {
            const targetMonth = months[marker];
            if (targetMonth === undefined) {
                return null;
            }
            const currentMonth = today.month() + 1;
            const currentYear = today.year();
            let targetYear = currentYear;
            if (targetMonth <= currentMonth) targetYear += 1;

            const targetDate = moment(`${targetYear}-${String(targetMonth).padStart(2, '0')}-01`);
            const nextMonth = today.clone().add(1, 'month').startOf('month');

            // If target month is beyond next month, use future log
            if (targetDate.isAfter(nextMonth, 'month')) {
                const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                                  'July', 'August', 'September', 'October', 'November', 'December'];
                return {
                    date: targetDate.format('YYYY-MM-DD'),
                    targetType: 'future',
                    monthName: monthNames[targetMonth - 1],
                };
            }

            return {
                date: targetDate.format('YYYY-MM-DD'),
                targetType: 'monthly',
            };
        }

        // Future log
        if (marker === 'fut') {
            return { date: null, targetType: 'future' };
        }

        throw new Error(`Unknown migration marker: ${marker}`);
    }

    /**
     * Get file path for target
     */
    getTargetFilePath(date: string | null, targetType: string, monthName: string | null = null): string {
        if (targetType === 'future') {
            // Extract year from date if provided, otherwise use current year
            let year = moment().year();
            if (date) {
                const dateMoment = moment(date, 'YYYY-MM-DD');
                if (dateMoment.isValid()) {
                    year = dateMoment.year();
                }
            }
            return `Journal/006 Future Log/${year} - Future Log.md`;
        }

        if (!date) {
            throw new Error(`Date is required for target type: ${targetType}`);
        }

        const dateMoment = moment(date, 'YYYY-MM-DD');

        if (targetType === 'daily') {
            return `Journal/001 Daily Notes/${date}.md`;
        } else if (targetType === 'weekly') {
            const weekNumber = dateMoment.isoWeek();
            const year = dateMoment.year();
            return `Journal/002 Weekly Notes/${year}-W${String(weekNumber).padStart(2, '0')}.md`;
        } else if (targetType === 'monthly') {
            return `Journal/003 Monthly Notes/${dateMoment.format('YYYY-MM')}.md`;
        } else if (targetType === 'yearly') {
            const year = dateMoment.year();
            return `Journal/004 Yearly Notes/${year}.md`;
        }

        throw new Error(`Unknown target type: ${targetType}`);
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
     * Remove metadata from task line
     */
    removeMetadata(line: string): string {
        return line.replace(/\s*\(from:\s*[^)]+\)/, '');
    }

    /**
     * Check if line has migration marker
     */
    hasMigrationMarker(line: string): boolean {
        return this.parseMigrationMarker(line) !== null;
    }

    /**
     * Check if line is incomplete task
     */
    isIncompleteTask(line: string): boolean {
        return /^-\s*\[\s\]/.test(line.trim());
    }

    /**
     * Check if line is completed task
     */
    isCompletedTask(line: string): boolean {
        return /^-\s*\[x\]/i.test(line.trim());
    }

    /**
     * Check if line is deleted/cancelled task
     */
    isDeletedTask(line: string): boolean {
        return /^-\s*\[-\]/.test(line.trim());
    }

    /**
     * Check if line is scheduled task ([s])
     */
    isScheduledTask(line: string): boolean {
        return /^-\s*\[s\]/.test(line.trim());
    }

    /**
     * Check if line is a bullet item (task, event, information, etc.)
     */
    isBulletItem(line: string): boolean {
        // Matches any bullet item: - [ ], - [x], - [o], - [a], - [-], - [s], - [>marker], etc.
        // Also matches plain list items: - Information text (no brackets)
        const trimmed = line.trim();
        return /^\s*-\s*(\[[^\]]+\]|.+)/.test(trimmed) || /^\s*-\s+/.test(trimmed);
    }

    /**
     * Get task text without checkbox (handles indented/nested tasks and plain list items)
     */
    getTaskText(line: string): string {
        // Match task with optional leading whitespace (for nested tasks)
        const taskMatch = line.match(/^\s*-\s*\[[^\]]+\]\s*(.+)$/);
        if (taskMatch && taskMatch[1]) return taskMatch[1].trim();

        // Match plain list item (information point): - Information text
        const plainMatch = line.match(/^\s*-\s+(.+)$/);
        if (plainMatch && plainMatch[1]) return plainMatch[1].trim();

        return '';
    }

    /**
     * Get bullet marker from line (e.g., ' ', 'x', 'o', 'a', '-', 's', '>w', etc.)
     */
    getBulletMarker(line: string): string | null {
        const match = line.match(/^\s*-\s*\[([^\]]+)\]/);
        return (match && match[1]) ? match[1].trim() : null;
    }

    /**
     * Get indentation level of a line (number of spaces or tabs)
     */
    getIndentLevel(line: string): number {
        const match = line.match(/^(\s*)/);
        return (match && match[1]) ? match[1].length : 0;
    }

    /**
     * Collect child tasks (nested tasks with more indentation) following a parent task
     */
    collectChildTasks(lines: string[], parentIndex: number, parentIndent: number): Array<{ line: string; index: number; indent: number }> {
        const children: Array<{ line: string; index: number; indent: number }> = [];
        for (let i = parentIndex + 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const lineIndent = this.getIndentLevel(line);
            
            // If line has same or less indentation, we've reached the end of children
            if (lineIndent <= parentIndent) {
                break;
            }
            
            // If line is empty or not a bullet item, skip it
            if (!line.trim() || !this.isBulletItem(line)) {
                continue;
            }
            
            // This is a child task
            children.push({ line, index: i, indent: lineIndent });
        }
        return children;
    }

    /**
     * Detect period type from file path
     */
    detectPeriodType(filePath: string): PeriodType {
        if (filePath.includes('Daily Notes')) return 'daily';
        if (filePath.includes('Weekly Notes')) return 'weekly';
        if (filePath.includes('Monthly Notes')) return 'monthly';
        return 'daily';
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
            return moment().year(year).isoWeek(week).startOf('isoWeek').format('YYYY-MM-DD');
        }

        const monthlyMatch = filePath.match(/(\d{4}-\d{2})\.md$/);
        if (monthlyMatch && monthlyMatch[1]) return `${monthlyMatch[1]}-01`;

        return null;
    }

    /**
     * Get template path based on file type
     */
    getTemplatePath(filePath: string): string | null {
        if (filePath.includes('Daily Notes')) return 'Obsidian/Templator/Journal/Daily-Template.md';
        if (filePath.includes('Weekly Notes')) return 'Obsidian/Templator/Journal/Weekly-Template.md';
        if (filePath.includes('Monthly Notes')) return 'Obsidian/Templator/Journal/Monthly-Template.md';
        if (filePath.includes('Future Log')) return 'Obsidian/Templator/Journal/Future-Log-Template.md';
        return null;
    }

    // =================================================================
    // FILE OPERATIONS
    // =================================================================

    /**
     * Get all incomplete tasks from a file (includes scheduled tasks [s] or [<])
     * Also includes items with migration markers (for non-task items like events, information, etc.)
     */
    async getIncompleteTasks(filePath: string): Promise<string[]> {
        console.log(`[BuJo] *** getIncompleteTasks called for: ${filePath}`);
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) return [];

        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        console.log(`[BuJo] *** Processing ${lines.length} lines from ${filePath}`);
        return lines.filter(line => {
            const trimmed = line.trim();
            
            // Explicitly exclude already-processed tasks - these shouldn't be in reviews
            // [-] = cancelled, [x] = completed, [>] = migrated, [<] = scheduled elsewhere, [+] = new task created
            // Note: Check trimmed line since tasks may have leading whitespace
            if (/^-\s*\[(-|x|>|<|\+)\]/i.test(trimmed)) {
                console.log(`[BuJo] Excluding already-processed task from review: "${trimmed.substring(0, 50)}"`);
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
            console.warn(`[BuJo] Template not found: ${templatePath}, creating empty file: ${filePath}`);
            await this.app.vault.create(filePath, '');
            return;
        }

        console.log(`[BuJo] Creating ${filePath} from template ${templatePath}`);
        let templateContent = await this.app.vault.read(templateFile);

        // Try to use Templater if available
        const templater = (this.app as any).plugins?.plugins?.['templater-obsidian'];
        if (templater) {
            try {
                const newFile = await this.app.vault.create(filePath, templateContent);
                await templater.templater.overwrite_file_commands(newFile);
                console.log(`[BuJo] Successfully created ${filePath} from template with Templater`);
                return;
            } catch (error) {
                console.warn(`[BuJo] Templater processing failed for ${filePath}:`, error);
            }
        }

        await this.app.vault.create(filePath, templateContent);
        console.log(`[BuJo] Successfully created ${filePath} from template`);
    }

    /**
     * Append task(s) to file (creates from template if doesn't exist)
     * Can accept a single task line or an array of lines (parent + children)
     */
    async appendToFile(filePath: string, taskLineOrLines: string | string[], monthName: string | null = null): Promise<void> {
        // Normalize to array - if single line, wrap in array
        const taskLines = Array.isArray(taskLineOrLines) ? taskLineOrLines : [taskLineOrLines];
        const taskLine = taskLines[0];
        if (!taskLine) {
            throw new Error('No task line provided to append');
        }
        let file = this.app.vault.getAbstractFileByPath(filePath);

        if (!file || !(file instanceof TFile)) {
            // Ensure parent folder exists
            const folderPath = filePath.substring(0, filePath.lastIndexOf('/'));
            const folder = this.app.vault.getAbstractFileByPath(folderPath);
            if (!folder) {
                await this.app.vault.createFolder(folderPath);
            }

            const templatePath = this.getTemplatePath(filePath);
            if (templatePath) {
                console.log(`[BuJo] Creating file from template: ${filePath} using ${templatePath}`);
                await this.createFromTemplate(filePath, templatePath);
                file = this.app.vault.getAbstractFileByPath(filePath);
                if (!file || !(file instanceof TFile)) {
                    console.warn(`[BuJo] Template creation failed, creating empty file: ${filePath}`);
                    await this.app.vault.create(filePath, taskLines.join('\n') + '\n');
                    return;
                }
            } else {
                console.log(`[BuJo] No template found, creating empty file: ${filePath}`);
                await this.app.vault.create(filePath, taskLines.join('\n') + '\n');
                return;
            }
        }

        // File exists (either already existed or was just created from template)
        // Now append the task
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let insertIndex = lines.length;

        // Handle future log format - find the correct section
        if (filePath.includes('Future Log')) {
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
                console.log(`[BuJo] Found ${sectionHeading} section, inserting task at line ${insertIndex}`);
            } else {
                console.log(`[BuJo] Section ${sectionHeading} not found in future log, appending to end`);
            }
        } else {
            // Determine which section to use based on file type
            let sectionName = '## Notes'; // Default for daily notes
            if (filePath.includes('Weekly Notes') || filePath.includes('Monthly Notes')) {
                sectionName = '## Plan';
            }

            // Look for the appropriate section (Plan for weekly/monthly, Notes for daily)
            const sectionIndex = lines.findIndex(line => line.trim() === sectionName);
            if (sectionIndex !== -1) {
                // Insert right after the section heading (at the top of the section)
                insertIndex = sectionIndex + 1;
                console.log(`[BuJo] Found ${sectionName} section at line ${sectionIndex}, inserting at ${insertIndex}`);
            } else {
                console.log(`[BuJo] ${sectionName} section not found, appending to end of file`);
            }
        }

        // Deduplication: Check if task already exists in destination
        const newTaskText = this.getTaskText(taskLine);
        const normalizedNewText = this.normalizeText(newTaskText);

        // Search for duplicate task in the destination file
        const existingTaskIndex = lines.findIndex(line => {
            if (!this.isBulletItem(line)) return false;
            const existingText = this.getTaskText(line);
            const normalizedExisting = this.normalizeText(existingText);
            return normalizedExisting === normalizedNewText;
        });

        if (existingTaskIndex !== -1) {
            // Task already exists - skip duplicate
            console.log(`[BuJo] Task already exists in ${filePath}, skipping duplicate: "${newTaskText}"`);
            return; // Skip adding duplicate task
        }

        // Not a duplicate - append task(s) to file
        lines.splice(insertIndex, 0, ...taskLines);
        await this.app.vault.modify(file, lines.join('\n'));
        console.log(`[BuJo] Appended ${taskLines.length} line(s) to ${filePath}: ${taskLine}`);
    }

    /**
     * Update task in file
     */
    async updateTaskInFile(filePath: string, oldLine: string, newLine: string): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(filePath);
        if (!file || !(file instanceof TFile)) throw new Error(`File not found: ${filePath}`);

        const content = await this.app.vault.read(file);
        const lines = content.split('\n');
        let found = false;

        // Extract the indentation from newLine to preserve it
        const newLineIndentMatch = newLine.match(/^(\s*)/);
        const newLineIndent = newLineIndentMatch ? newLineIndentMatch[0] : '';
        const newLineTrimmed = newLine.trim();

        const updatedLines = lines.map(line => {
            if (!found && line.trim() === oldLine.trim()) {
                found = true;
                // Preserve the original line's indentation
                const indentMatch = line.match(/^(\s*)/);
                const indent = indentMatch ? indentMatch[0] : '';
                return indent + newLineTrimmed;
            }
            return line;
        });

        if (!found) {
            const oldTaskText = this.getTaskText(oldLine);
            const oldTaskTextClean = this.removeMetadata(oldTaskText).trim();  // Remove (from: ...) metadata and trim
            console.log(`[BuJo] Looking for task with text: "${oldTaskTextClean}" in ${filePath}`);
            
            // Normalize text for better matching (remove extra spaces, normalize wiki links)
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')  // Normalize whitespace
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')  // Remove wiki link brackets
                    .trim();
            };
            const normalizedOldText = normalizeText(oldTaskTextClean);
            
            const updatedLinesLenient = lines.map(line => {
                // Match any task (incomplete, completed, deleted, or with migration markers)
                const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);

                if (!found && isTask) {
                    const lineTaskText = this.getTaskText(line);
                    const lineTaskTextClean = this.removeMetadata(lineTaskText).trim();
                    const normalizedLineText = normalizeText(lineTaskTextClean);
                    
                    // Compare task text (normalized, case-insensitive)
                    if (normalizedLineText === normalizedOldText) {
                        console.log(`[BuJo] Found matching task: "${lineTaskTextClean}" (original: "${oldTaskTextClean}")`);
                        found = true;
                        // Preserve the original line's indentation
                        const indentMatch = line.match(/^(\s*)/);
                    const indent = indentMatch ? indentMatch[0] : '';
                        return indent + newLineTrimmed;
                    }
                }
                return line;
            });

            if (found) {
                await this.app.vault.modify(file, updatedLinesLenient.join('\n'));
                return;
            }
            
            // Try fuzzy matching - check if any task contains most of the words
            if (!found) {
                const oldWords = normalizedOldText.split(/\s+/).filter((w: string) => w.length > 2); // Words longer than 2 chars
                let bestMatch: { line: string; lineTaskTextClean: string; normalizedLineText: string } | null = null;
                let bestScore = 0;

                lines.forEach(line => {
                    if (/^\s*-\s*\[[^\]]+\]/.test(line)) {
                        const lineTaskText = this.getTaskText(line);
                        const lineTaskTextClean = this.removeMetadata(lineTaskText).trim();
                        const normalizedLineText = normalizeText(lineTaskTextClean);
                        const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);
                        
                        // Count matching words
                        const matchingWords = oldWords.filter(w => lineWords.includes(w)).length;
                        const score = matchingWords / Math.max(oldWords.length, lineWords.length);
                        
                        if (score > bestScore && score > 0.7) { // At least 70% word match
                            bestScore = score;
                            bestMatch = { line, lineTaskTextClean, normalizedLineText };
                        }
                    }
                });

                if (bestMatch !== null) {
                    const { line: matchedLine, lineTaskTextClean: matchedTaskTextClean } = bestMatch;
                    if (!matchedLine || !matchedTaskTextClean) {
                        console.error('[BuJo] Best match missing required properties');
                    } else {
                        const line = matchedLine as string;
                        const taskTextClean = matchedTaskTextClean as string;
                        console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%): "${taskTextClean}" for "${oldTaskTextClean}"`);

                    // Check if task is already in the target state
                    const targetMarker = newLineTrimmed.match(/\[([^\]]+)\]/);
                    const currentMarker = line.match(/\[([^\]]+)\]/);
                    if (targetMarker && currentMarker && targetMarker[1] && currentMarker[1] && targetMarker[1] === currentMarker[1]) {
                        console.log(`[BuJo] Task already in target state [${targetMarker[1]}], skipping update`);
                        return; // Task already in desired state
                    }

                    const indentMatch = line.match(/^(\s*)/);
                    const indent = indentMatch ? indentMatch[0] : '';
                    const updatedLines = lines.map(l => l === line ? indent + newLineTrimmed : l);
                    await this.app.vault.modify(file, updatedLines.join('\n'));
                    return;
                    }
                }
            }
            
            // Check if task might already be completed or migrated
            const targetMarker = newLineTrimmed.match(/\[([^\]]+)\]/);
            if (targetMarker) {
                const marker = targetMarker[1];
                const alreadyInState = lines.some(line => {
                    if (!/^\s*-\s*\[/.test(line)) return false;
                    const lineText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(this.removeMetadata(lineText));
                    return normalizedLineText === normalizedOldText && line.includes(`[${marker}]`);
                });
                
                if (alreadyInState) {
                    console.log(`[BuJo] Task already in target state [${marker}], skipping update`);
                    return; // Task already in desired state
                }
            }
            
            console.error(`[BuJo] Task not found in file: ${filePath}`);
            console.error(`[BuJo] Looking for: "${oldTaskTextClean}"`);
            console.error(`[BuJo] Original line: "${oldLine.substring(0, 100)}"`);
            console.error(`[BuJo] Available tasks in file:`, lines.filter(l => /^\s*-\s*\[/.test(l)).slice(0, 10).map(l => `  "${this.getTaskText(l)}"`).join('\n'));
            throw new Error(`Task not found: "${oldTaskTextClean.substring(0, 50)}..." in ${filePath}`);
        }

        await this.app.vault.modify(file, updatedLines.join('\n'));
    }

    /**
     * Mark task as completed in source file
     */
    async completeTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);
            const taskText = this.getTaskText(cleanTaskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            let found = false;

            const taskTextClean = taskText.trim();
            console.log(`[BuJo] Looking for task to complete: "${taskTextClean}" in ${sourceFilePath}`);

            // Normalize text for better matching
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedTaskText = normalizeText(taskTextClean);

            const updatedLines = lines.map(line => {
                if (!found && this.isIncompleteTask(line)) {
                    const lineTaskText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(lineTaskText);
                    
                    // Compare task text (normalized, case-insensitive)
                    if (normalizedLineText === normalizedTaskText) {
                        console.log(`[BuJo] Found matching task to complete: "${lineTaskText}"`);
                        found = true;
                        // Preserve indentation when replacing
                        return line.replace(/^(\s*-\s*)\[\s\]/, '$1[x]');
                    }
                }
                return line;
            });

            // Try fuzzy matching if exact match not found
            if (!found) {
                const taskWords = normalizedTaskText.split(/\s+/).filter((w: string) => w.length > 2);
                let bestMatch: string | null = null;
                let bestScore = 0;
                
                lines.forEach(line => {
                    if (this.isIncompleteTask(line)) {
                        const lineTaskText = this.getTaskText(line).trim();
                        const normalizedLineText = normalizeText(lineTaskText);
                        const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);
                        
                        const matchingWords = taskWords.filter(w => lineWords.includes(w)).length;
                        const score = matchingWords / Math.max(taskWords.length, lineWords.length);
                        
                        if (score > bestScore && score > 0.7) {
                            bestScore = score;
                            bestMatch = line;
                        }
                    }
                });
                
                if (bestMatch) {
                    console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%) to complete: "${this.getTaskText(bestMatch)}"`);
                    const updatedLinesFuzzy = lines.map(l => l === bestMatch ? l.replace(/^(\s*-\s*)\[\s\]/, '$1[x]') : l);
                    await this.app.vault.modify(sourceFile, updatedLinesFuzzy.join('\n'));
                    return { success: true };
                }
            }

            if (found) {
                await this.app.vault.modify(sourceFile, updatedLines.join('\n'));
                return { success: true };
            }
            
            console.error(`[BuJo] Task not found for completion: "${taskTextClean}" in ${sourceFilePath}`);
            return { success: false, error: 'Task not found' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Mark task as cancelled in source file (marks with [-])
     */
    async cancelTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);
            const taskText = this.getTaskText(cleanTaskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            let found = false;

            const taskTextClean = taskText.trim();
            console.log(`[BuJo] Looking for task to cancel: "${taskTextClean}" in ${sourceFilePath}`);

            // Normalize text for better matching
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedTaskText = normalizeText(taskTextClean);

            const updatedLines = lines.map(line => {
                if (!found && this.isIncompleteTask(line)) {
                    const lineTaskText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(lineTaskText);
                    
                    // Compare task text (normalized, case-insensitive)
                    if (normalizedLineText === normalizedTaskText) {
                        console.log(`[BuJo] Found matching task to cancel: "${lineTaskText}"`);
                        found = true;
                        // Preserve indentation when replacing
                        return line.replace(/^(\s*-\s*)\[\s\]/, '$1[-]');
                    }
                }
                return line;
            });

            // Try fuzzy matching if exact match not found
            if (!found) {
                const taskWords = normalizedTaskText.split(/\s+/).filter((w: string) => w.length > 2);
                let bestMatch: string | null = null;
                let bestScore = 0;
                
                lines.forEach(line => {
                    if (this.isIncompleteTask(line)) {
                        const lineTaskText = this.getTaskText(line).trim();
                        const normalizedLineText = normalizeText(lineTaskText);
                        const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);
                        
                        const matchingWords = taskWords.filter(w => lineWords.includes(w)).length;
                        const score = matchingWords / Math.max(taskWords.length, lineWords.length);
                        
                        if (score > bestScore && score > 0.7) {
                            bestScore = score;
                            bestMatch = line;
                        }
                    }
                });
                
                if (bestMatch) {
                    console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%) to cancel: "${this.getTaskText(bestMatch)}"`);
                    const updatedLinesFuzzy = lines.map(l => l === bestMatch ? l.replace(/^(\s*-\s*)\[\s\]/, '$1[-]') : l);
                    await this.app.vault.modify(sourceFile, updatedLinesFuzzy.join('\n'));
                    return { success: true };
                }
            }

            if (found) {
                await this.app.vault.modify(sourceFile, updatedLines.join('\n'));
                return { success: true };
            }
            
            console.error(`[BuJo] Task not found to cancel: "${taskTextClean}" in ${sourceFilePath}`);
            return { success: false, error: 'Task not found' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Delete task and its children entirely from source file (for [d] marker)
     */
    async deleteTask(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);
            const taskText = this.getTaskText(cleanTaskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            let parentIndex = -1;
            let parentIndent = 0;

            const taskTextClean = taskText.trim();
            console.log(`[BuJo] Looking for task to remove: "${taskTextClean}" in ${sourceFilePath}`);

            // Normalize text for better matching
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedTaskText = normalizeText(taskTextClean);

            // Find the parent task
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);
                if (isTask) {
                    const lineTaskText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(lineTaskText);
                    
                    if (normalizedLineText === normalizedTaskText) {
                        console.log(`[BuJo] Found matching task to remove: "${lineTaskText}"`);
                        parentIndex = i;
                        const indentMatch = line.match(/^(\s*)/);
                        parentIndent = indentMatch && indentMatch[1] ? indentMatch[1].length : 0;
                        break;
                    }
                }
            }

            if (parentIndex === -1) {
                console.error(`[BuJo] Task not found to remove: "${taskTextClean}" in ${sourceFilePath}`);
                return { success: false, error: 'Task not found' };
            }

            // Find all children (lines with greater indentation immediately following parent)
            const linesToRemove = [parentIndex];
            for (let i = parentIndex + 1; i < lines.length; i++) {
                const line = lines[i];
                if (!line || line.trim() === '') {
                    // Skip empty lines but don't stop
                    continue;
                }
                const indentMatch = line.match(/^(\s*)/);
                const currentIndent = indentMatch && indentMatch[1] ? indentMatch[1].length : 0;
                
                if (currentIndent > parentIndent) {
                    // This is a child, mark for removal
                    linesToRemove.push(i);
                } else {
                    // No longer a child, stop
                    break;
                }
            }

            // Remove lines (filter out marked lines)
            const updatedLines = lines.filter((_, index) => !linesToRemove.includes(index));
            
            await this.app.vault.modify(sourceFile, updatedLines.join('\n'));
            console.log(`[BuJo] Removed task and ${linesToRemove.length - 1} children from ${sourceFilePath}`);
            return { success: true };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[BuJo] Error removing task:`, error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Mark task as scheduled in source file (uses [s] marker)
     */
    async markAsScheduled(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);
            const taskText = this.getTaskText(cleanTaskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            let found = false;

            const taskTextClean = taskText.trim();
            console.log(`[BuJo] Looking for task to mark as scheduled: "${taskTextClean}" in ${sourceFilePath}`);

            // Normalize text for better matching
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedTaskText = normalizeText(taskTextClean);

            const updatedLines = lines.map(line => {
                // Match any task (incomplete, completed, deleted, or with migration markers)
                const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);
                if (!found && isTask) {
                    // Skip tasks that already have [>-] or [<] markers
                    if (line.includes('[>-]') || line.includes('[<]')) {
                        return line;
                    }
                    
                    const lineTaskText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(lineTaskText);
                    
                    // Compare task text (normalized, case-insensitive)
                    if (normalizedLineText === normalizedTaskText) {
                        console.log(`[BuJo] Found matching task to mark as scheduled: "${lineTaskText}"`);
                        found = true;
                        // Preserve indentation when replacing - replace any migration marker with [s]
                        return line.replace(/^(\s*-\s*)\[([^\]]+)\]/, '$1[s]');
                    }
                }
                return line;
            });

            // Try fuzzy matching if exact match not found
            if (!found) {
                const taskWords = normalizedTaskText.split(/\s+/).filter((w: string) => w.length > 2);
                let bestMatch: string | null = null;
                let bestScore = 0;
                
                lines.forEach(line => {
                    // Match any task (incomplete, completed, deleted, or with migration markers)
                    const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);
                    if (isTask) {
                        // Skip tasks that already have [>-] or [<] markers
                        if (line.includes('[>-]') || line.includes('[<]')) {
                            return;
                        }
                        
                        const lineTaskText = this.getTaskText(line).trim();
                        const normalizedLineText = normalizeText(lineTaskText);
                        const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);
                        
                        const matchingWords = taskWords.filter(w => lineWords.includes(w)).length;
                        const score = matchingWords / Math.max(taskWords.length, lineWords.length);
                        
                        if (score > bestScore && score > 0.7) {
                            bestScore = score;
                            bestMatch = line;
                        }
                    }
                });
                
                if (bestMatch) {
                    console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%) to mark as scheduled: "${this.getTaskText(bestMatch)}"`);
                    const updatedLinesFuzzy = lines.map(l => l === bestMatch ? l.replace(/^(\s*-\s*)\[([^\]]+)\]/, '$1[s]') : l);
                    await this.app.vault.modify(sourceFile, updatedLinesFuzzy.join('\n'));
                    return { success: true };
                }
            }

            if (found) {
                await this.app.vault.modify(sourceFile, updatedLines.join('\n'));
                return { success: true };
            }
            
            console.error(`[BuJo] Task not found to mark as scheduled: "${taskTextClean}" in ${sourceFilePath}`);
            return { success: false, error: 'Task not found' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    /**
     * Mark task as migrated in source file without creating destination task
     */
    async markAsMigrated(taskLine: string, sourceFilePath: string): Promise<MigrationResult> {
        try {
            const cleanTaskLine = this.removeMetadata(taskLine);
            const taskText = this.getTaskText(cleanTaskLine);

            const sourceFile = this.app.vault.getAbstractFileByPath(sourceFilePath);
            if (!sourceFile || !(sourceFile instanceof TFile)) {
                return { success: false, error: `Source file not found: ${sourceFilePath}` };
            }

            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            let found = false;

            const taskTextClean = taskText.trim();
            console.log(`[BuJo] Looking for task to mark as migrated: "${taskTextClean}" in ${sourceFilePath}`);

            // Normalize text for better matching
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedTaskText = normalizeText(taskTextClean);

            const updatedLines = lines.map(line => {
                // Match any task (incomplete, completed, deleted, or with migration markers)
                const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);
                if (!found && isTask) {
                    const lineTaskText = this.getTaskText(line).trim();
                    const normalizedLineText = normalizeText(lineTaskText);
                    
                    // Compare task text (normalized, case-insensitive)
                    if (normalizedLineText === normalizedTaskText) {
                        console.log(`[BuJo] Found matching task to mark as migrated: "${lineTaskText}"`);
                        found = true;
                        // Preserve indentation when replacing - replace any marker with [>]
                        return line.replace(/^(\s*-\s*)\[([^\]]+)\]/, '$1[>]');
                    }
                }
                return line;
            });

            // Try fuzzy matching if exact match not found
            if (!found) {
                const taskWords = normalizedTaskText.split(/\s+/).filter((w: string) => w.length > 2);
                let bestMatch: string | null = null;
                let bestScore = 0;
                
                lines.forEach(line => {
                    // Match any task (incomplete, completed, deleted, or with migration markers)
                    const isTask = /^\s*-\s*\[[^\]]+\]/.test(line);
                    if (isTask) {
                        const lineTaskText = this.getTaskText(line).trim();
                        const normalizedLineText = normalizeText(lineTaskText);
                        const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);
                        
                        const matchingWords = taskWords.filter(w => lineWords.includes(w)).length;
                        const score = matchingWords / Math.max(taskWords.length, lineWords.length);
                        
                        if (score > bestScore && score > 0.7) {
                            bestScore = score;
                            bestMatch = line;
                        }
                    }
                });
                
                if (bestMatch) {
                    console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%) to mark as migrated: "${this.getTaskText(bestMatch)}"`);
                    const updatedLinesFuzzy = lines.map(l => l === bestMatch ? l.replace(/^(\s*-\s*)\[([^\]]+)\]/, '$1[>]') : l);
                    await this.app.vault.modify(sourceFile, updatedLinesFuzzy.join('\n'));
                    return { success: true };
                }
            }

            if (found) {
                await this.app.vault.modify(sourceFile, updatedLines.join('\n'));
                return { success: true };
            }
            
            console.error(`[BuJo] Task not found to mark as migrated: "${taskTextClean}" in ${sourceFilePath}`);
            return { success: false, error: 'Task not found' };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
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
            console.log(`[BuJo] Creating new task with marker: ${marker}, type: ${type}, descriptor: ${descriptor}, sourceDate: ${sourceDate}`);
            
            const destination = this.calculateDestinationDate(marker, sourceDate, 'daily');
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            console.log(`[BuJo] New task destination:`, destination);

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType, destination.monthName);
            console.log(`[BuJo] New task target file: ${targetFilePath}`);

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            console.log(`[BuJo] New task text: "${taskText}", cleaned: "${cleanTaskText}"`);

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
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
            } else {
                destMarker = this.getDestinationMarker(type as TaskType);
            }
            // For information points (type === '.'), destMarker is empty, so format is: - Information text
            // For other types, format is: - [marker] text
            const destTaskLine = type === '.'
                ? `${indent}- ${cleanTaskText}`
                : `${indent}- ${destMarker} ${cleanTaskText}`;
            console.log(`[BuJo] New task line: ${destTaskLine}`);

            try {
                await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                console.log(`[BuJo] Successfully created new task in ${targetFilePath}`);
                return { success: true, destFile: targetFilePath };
            } catch (error) {
                console.error(`[BuJo] Failed to create new task in ${targetFilePath}:`, error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                return { success: false, error: `Failed to create task: ${errorMessage}` };
            }
        } catch (error) {
            console.error(`[BuJo] Create new task error:`, error);
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
                console.log(`[BuJo] Source file not found: ${sourceFilePath}`);
                return [];
            }
            
            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');
            
            // Find the parent task in the source file
            let parentIndex = -1;
            let parentIndent = 0;
            const normalizeText = (text: string): string => {
                return text.toLowerCase()
                    .replace(/\s+/g, ' ')
                    .replace(/\[\[([^\]]+)\]\]/g, '$1')
                    .trim();
            };
            const normalizedParentText = normalizeText(parentTaskText);
            
            // First, try exact match
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                if (this.isBulletItem(line)) {
                    const lineText = this.getTaskText(line);
                    const normalizedLineText = normalizeText(lineText);
                    
                    // Exact match
                    if (normalizedLineText === normalizedParentText) {
                        parentIndex = i;
                        parentIndent = this.getIndentLevel(line);
                        console.log(`[BuJo] Found exact parent match at line ${i + 1}: "${lineText}"`);
                        break;
                    }
                }
            }
            
            // If no exact match, try fuzzy match (check if parent text is contained in line or vice versa)
            if (parentIndex === -1) {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line) continue;
                    if (this.isBulletItem(line)) {
                        const lineText = this.getTaskText(line);
                        const normalizedLineText = normalizeText(lineText);
                        
                        // Check if one contains the other (for cases where metadata differs)
                        if (normalizedLineText.includes(normalizedParentText) ||
                            normalizedParentText.includes(normalizedLineText)) {
                            // Make sure it's a reasonable match (at least 50% overlap)
                            const shorter = normalizedLineText.length < normalizedParentText.length 
                                ? normalizedLineText 
                                : normalizedParentText;
                            const longer = normalizedLineText.length >= normalizedParentText.length 
                                ? normalizedLineText 
                                : normalizedParentText;
                            
                            if (longer.includes(shorter) && shorter.length >= longer.length * 0.5) {
                                parentIndex = i;
                                parentIndent = this.getIndentLevel(line);
                                console.log(`[BuJo] Found fuzzy parent match at line ${i + 1}: "${lineText}"`);
                                break;
                            }
                        }
                    }
                }
            }
            
            if (parentIndex === -1) {
                console.log(`[BuJo] Parent task not found in source file: ${sourceFilePath}, looking for: "${parentTaskText}"`);
                return [];
            }
            
            // Collect children from source file
            const childTasks = this.collectChildTasks(lines, parentIndex, parentIndent);
            console.log(`[BuJo] Found ${childTasks.length} child task(s) for parent in source file at line ${parentIndex + 1}`);
            return childTasks;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error(`[BuJo] Error collecting children from source: ${errorMessage}`);
            return [];
        }
    }

    /**
     * Normalize text for comparison (remove metadata, normalize whitespace)
     */
    normalizeText(text: string): string {
        return text.toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/\[\[([^\]]+)\]\]/g, '$1')
            .trim();
    }

    /**
     * Migrate a single task (and optionally its children)
     * If childTasks is empty, automatically collects children from source file
     */
    async migrateTask(taskLine: string, sourceFilePath: string, sourceDate: string, periodType: PeriodType = 'daily', childTasks: ChildTask[] = []): Promise<MigrationResult> {
        try {
            const parsed = this.parseMigrationMarker(taskLine);
            if (!parsed) return { success: false, error: 'No migration marker found' };

            const { marker, type, descriptor, originalMarker, isNewTask = false, isInfoPoint = false } = parsed;

            // Auto-collect children from source file if none provided
            if (childTasks.length === 0 && !isNewTask) {
                const taskText = this.getTaskText(taskLine);
                childTasks = await this.collectChildrenFromSource(sourceFilePath, taskText);
                if (childTasks.length > 0) {
                    console.log(`[BuJo] Auto-collected ${childTasks.length} children for task: "${taskText.substring(0, 40)}"`);
                }
            }

            // Handle new task marker [+> - don't update source, just create destination
            if (isNewTask) {
            const destination = this.calculateDestinationDate(marker, sourceDate, periodType as PeriodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType, destination.monthName);

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
                        destMarker = this.getDestinationMarker(type as TaskType);
                    }
                } else {
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;

                console.log(`[BuJo] Creating new task (no source update): "${cleanTaskText}" -> ${targetFilePath}`);

                try {
                    await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                    console.log(`[BuJo] Successfully created new task in ${targetFilePath}`);
                    return { success: true, sourceFile: null, destFile: targetFilePath, isNewTask: true };
                } catch (error) {
                    console.error(`[BuJo] Failed to create new task in ${targetFilePath}:`, error);
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

                const content = await this.app.vault.read(sourceFile);
                const lines = content.split('\n');
                let foundParent = false;
                let parentIndex = -1;
                let parentIndent = 0;

                // Determine the marker to use: [<] for scheduled, [>-] for migrated
                const targetMarker = marker === 'scheduled' ? '[<]' : '[>-]';

                const taskTextClean = taskText.trim();
                console.log(`[BuJo] Looking for task to mark as ${marker}: "${taskTextClean}" in ${sourceFilePath}`);

                // Normalize text for better matching
                const normalizeText = (text: string): string => {
                    return text.toLowerCase()
                        .replace(/\s+/g, ' ')
                        .replace(/\[\[([^\]]+)\]\]/g, '$1')
                        .trim();
                };
                const normalizedTaskText = normalizeText(taskTextClean);

                // Find parent task and track its position and indentation
                const updatedLines = lines.map((line, index) => {
                    if (!foundParent && this.isIncompleteTask(line)) {
                        const lineTaskText = this.getTaskText(line).trim();
                        const normalizedLineText = normalizeText(lineTaskText);

                        // Compare task text (normalized, case-insensitive)
                        if (normalizedLineText === normalizedTaskText) {
                            console.log(`[BuJo] Found matching task to mark as ${marker}: "${lineTaskText}"`);
                            foundParent = true;
                            parentIndex = index;
                            parentIndent = this.getIndentLevel(line);
                            // Preserve indentation when replacing
                            return line.replace(/^(\s*-\s*)\[\s\]/, `$1${targetMarker}`);
                        }
                    }
                    return line;
                });

                // Try fuzzy matching if exact match not found
                if (!foundParent) {
                    const taskWords = normalizedTaskText.split(/\s+/).filter((w: string) => w.length > 2);
                    let bestMatch: string | null = null;
                    let bestMatchIndex = -1;
                    let bestScore = 0;

                    lines.forEach((line, index) => {
                        if (this.isIncompleteTask(line)) {
                            const lineTaskText = this.getTaskText(line).trim();
                            const normalizedLineText = normalizeText(lineTaskText);
                            const lineWords = normalizedLineText.split(/\s+/).filter((w: string) => w.length > 2);

                            const matchingWords = taskWords.filter(w => lineWords.includes(w)).length;
                            const score = matchingWords / Math.max(taskWords.length, lineWords.length);

                            if (score > bestScore && score > 0.7) {
                                bestScore = score;
                                bestMatch = line;
                                bestMatchIndex = index;
                            }
                        }
                    });

                    if (bestMatch && typeof bestMatch === 'string') {
                        const matchedLine = bestMatch as string;
                        console.log(`[BuJo] Found fuzzy match (${Math.round(bestScore * 100)}%) to mark as ${marker}: "${this.getTaskText(matchedLine)}"`);
                        foundParent = true;
                        parentIndex = bestMatchIndex;
                        parentIndent = this.getIndentLevel(matchedLine);
                        updatedLines[bestMatchIndex] = matchedLine.replace(/^(\s*-\s*)\[\s\]/, `$1${targetMarker}`);
                    }
                }

                if (!foundParent) {
                    console.error(`[BuJo] Task not found to mark as ${marker}: "${taskTextClean}" in ${sourceFilePath}`);
                    return { success: false, error: 'Task not found' };
                }

                // Mark child tasks with the same marker (maintain parent-child relationship)
                let childrenMarkedCount = 0;
                for (let i = parentIndex + 1; i < updatedLines.length; i++) {
                    const line = updatedLines[i];
                    if (!line) continue;
                    const lineIndent = this.getIndentLevel(line);

                    // If line has same or less indentation, we've reached the end of children
                    if (lineIndent <= parentIndent) {
                        break;
                    }

                    // Skip empty lines or non-bullet items
                    if (!line.trim() || !this.isBulletItem(line)) {
                        continue;
                    }

                    // Mark child task if it's an incomplete task
                    if (this.isIncompleteTask(line)) {
                        updatedLines[i] = line.replace(/^(\s*-\s*)\[\s\]/, `$1${targetMarker}`);
                        childrenMarkedCount++;
                        console.log(`[BuJo] Marked child task as ${marker}: "${this.getTaskText(line).trim()}"`);
                    }
                }

                await this.app.vault.modify(sourceFile, updatedLines.join('\n'));

                if (childrenMarkedCount > 0) {
                    console.log(`[BuJo] Successfully marked parent and ${childrenMarkedCount} child task(s) as ${marker}`);
                } else {
                    console.log(`[BuJo] Successfully marked parent task as ${marker} (no children found)`);
                }

                return { success: true, sourceFile: sourceFilePath, destFile: null, skipped: true, childrenMarked: childrenMarkedCount };
            }

            const destination = this.calculateDestinationDate(marker, sourceDate, periodType as PeriodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            console.log(`[BuJo] Migration destination calculated:`, { marker, sourceDate, periodType, destination });

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType, destination.monthName);
            console.log(`[BuJo] Target file path: ${targetFilePath}`);

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            console.log(`[BuJo] Task text: "${taskText}", cleaned: "${cleanTaskText}"`);

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
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
            } else {
                // No original marker - could be plain list item (information point)
                // If no type specified, preserve as plain list item, otherwise use destination marker
                destMarker = this.getDestinationMarker(type as TaskType);
            }
            
            // Preserve indentation from original line
            const indentMatch = taskLine.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[0] : '';
            // For information points (type === '.'), destMarker is empty, so format is: - Information text
            // For other types, format is: - [marker] text
            const destTaskLine = type === '.'
                ? `${indent}- ${cleanTaskText}`
                : `${indent}- ${destMarker} ${cleanTaskText}`;
            console.log(`[BuJo] Destination task line: ${destTaskLine}`);

            // Process child tasks - Only incomplete children migrate with parent to preserve hierarchy
            const destChildLines = [];
            const updatedChildLines = [];
            const childIndicesToUpdate = [];
            for (const child of childTasks) {
                // Skip completed and cancelled children - they stay in source
                if (this.isCompletedTask(child.line) || this.isDeletedTask(child.line)) {
                    console.log(`[BuJo] Skipping completed/cancelled child: "${this.getTaskText(child.line)}"`);
                    continue;
                }

                const childParsed = this.parseMigrationMarker(child.line);
                const childIndentMatch = child.line.match(/^(\s*)/);
                const childIndent = childIndentMatch ? childIndentMatch[0] : '';

                // Calculate relative indent from parent (maintain hierarchy)
                const parentIndentLength = indent.length;
                const childIndentLength = childIndent.length;
                const childRelativeIndent = childIndentLength - parentIndentLength;
                // Destination child indent should maintain relative position to parent
                const destChildIndent = ' '.repeat(parentIndentLength + Math.max(0, childRelativeIndent));

                // Determine child type and descriptor (from migration marker if present, otherwise preserve original)
                const childType = childParsed ? childParsed.type : null;
                const childDescriptor = childParsed ? childParsed.descriptor : null;
                const childOriginalMarker = childParsed ? childParsed.originalMarker : null;

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
                        const childOrigMarker = this.getOriginalMarker(childMarker, childType);
                        // Replace checkbox content for child: [>mon] → [>] or [<]
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
                        console.log(`[BuJo] Plain info point child stays in source: "${childCleanText}"`);
                        continue;
                    }

                    // Has checkbox - mark it as migrated with parent's marker type
                    const parentOrigMarker = this.getOriginalMarker(marker, type);
                    if (this.isIncompleteTask(child.line)) {
                        // Mark incomplete task children with parent's marker: [ ] → [>] or [<]
                        updatedChildLines.push(child.line.replace(/^(\s*-\s*)\[\s\]/, `$1[${parentOrigMarker}]`));
                    } else {
                        // For non-task children (events, appointments), replace checkbox with parent's marker
                        const childLineWithMarker = child.line.replace(/^(\s*-\s*)\[[^\]]+\]/, `$1[${parentOrigMarker}]`);
                        updatedChildLines.push(childLineWithMarker);
                    }
                    childIndicesToUpdate.push(child);
                }
            }
            
            // Combine parent and children for destination (incomplete children only)
            const allDestLines = [destTaskLine, ...destChildLines];

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
                const origMarker = this.getOriginalMarker(marker, type);
                updatedSourceLine = taskLine.replace(/^(\s*-\s*)\[[^\]]+\]/, `$1[${origMarker}]`);
            }
            console.log(`[BuJo] Updated source line: ${updatedSourceLine}`);

            try {
                await this.appendToFile(targetFilePath, allDestLines, destination.monthName);
                const migratedChildrenCount = destChildLines.length;
                if (migratedChildrenCount > 0) {
                    console.log(`[BuJo] Successfully appended ${allDestLines.length} line(s) (parent + ${migratedChildrenCount} migrated children) to ${targetFilePath}`);
                } else {
                    console.log(`[BuJo] Successfully appended parent task to ${targetFilePath} (${childTasks.length} children without markers stayed in source)`);
                }
            } catch (error) {
                console.error(`[BuJo] Failed to append task to ${targetFilePath}:`, error);
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
                                console.error(`[BuJo] Failed to update child task "${childTaskText.substring(0, 50)}" in ${sourceFilePath}:`, childError);
                                // Continue processing other children instead of failing completely
                            }
                        }
                    }
                    
                    const migratedChildrenCount = childIndicesToUpdate.length;
                    const successfulChildUpdates = migratedChildrenCount - childUpdateErrors;
                    if (migratedChildrenCount > 0) {
                        console.log(`[BuJo] Successfully updated source file ${sourceFilePath} (parent + ${successfulChildUpdates}/${migratedChildrenCount} migrated children${childUpdateErrors > 0 ? `, ${childUpdateErrors} child updates failed` : ''})`);
                    } else {
                        console.log(`[BuJo] Successfully updated source file ${sourceFilePath} (parent only, ${childTasks.length - migratedChildrenCount} children without markers stayed)`);
                    }
                } catch (error) {
                    console.error(`[BuJo] Failed to update parent task in source file ${sourceFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to update source: ${errorMessage}` };
                }
            } else if (isNewTask) {
                console.log(`[BuJo] Skipping source update for new task marker [+>`);
            }

            return { success: true, sourceFile: sourceFilePath, destFile: targetFilePath };
        } catch (error) {
            console.error(`[BuJo] Migration error:`, error);
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

            const { marker, type, descriptor, originalMarker, isNewTask = false, isInfoPoint = false } = parsed;

            // Auto-collect children from source file if none provided
            if (childTasks.length === 0 && !isNewTask) {
                const taskText = this.getTaskText(taskLine);
                childTasks = await this.collectChildrenFromSource(sourceFilePath, taskText);
                if (childTasks.length > 0) {
                    console.log(`[BuJo] Auto-collected ${childTasks.length} children for scheduling: "${taskText.substring(0, 40)}"`);
                }
            }

            // Handle new task marker [+> - don't update source, just create destination
            if (isNewTask) {
                const destination = this.calculateDestinationDate(marker, sourceDate, periodType as PeriodType);
                if (!destination) {
                    return { success: false, error: `Invalid destination marker: ${marker}` };
                }
                const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType, destination.monthName);

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
                        destMarker = this.getDestinationMarker(type as TaskType);
                    }
                } else {
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;

                console.log(`[BuJo] Creating new task (no source update): "${cleanTaskText}" -> ${targetFilePath}`);

                try {
                    await this.appendToFile(targetFilePath, destTaskLine, destination.monthName || null);
                    console.log(`[BuJo] Successfully created new task in ${targetFilePath}`);
                    return { success: true, sourceFile: null, destFile: targetFilePath, isNewTask: true };
                } catch (error) {
                    console.error(`[BuJo] Failed to create new task in ${targetFilePath}:`, error);
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
                // If original marker was [>-], mark as [>], otherwise mark as [s]
                if (originalMarker === '[>-]') {
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

            const destination = this.calculateDestinationDate(marker, sourceDate, periodType as PeriodType);
            if (!destination) {
                return { success: false, error: `Invalid destination marker: ${marker}` };
            }
            console.log(`[BuJo] Planning migration destination calculated:`, { marker, sourceDate, periodType, destination });

            const targetFilePath = this.getTargetFilePath(destination.date, destination.targetType, destination.monthName);
            console.log(`[BuJo] Target file path: ${targetFilePath}`);

            const taskText = this.getTaskText(taskLine);
            const cleanTaskText = this.removeMetadata(taskText);
            console.log(`[BuJo] Task text: "${taskText}", cleaned: "${cleanTaskText}"`);

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
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
                } else {
                    destMarker = this.getDestinationMarker(type as TaskType);
                }
                // For information points (type === '.'), destMarker is empty, so format is: - Information text
                // For other types, format is: - [marker] text
                const destTaskLine = type === '.'
                    ? `${indent}- ${cleanTaskText}`
                    : `${indent}- ${destMarker} ${cleanTaskText}`;
            console.log(`[BuJo] Destination task line: ${destTaskLine}`);

            // Process child tasks - only incomplete children go to destination
            const destChildLines: string[] = [];
            const childUpdates: { original: string; updated: string }[] = [];

            for (const child of childTasks) {
                // Skip completed and cancelled children - they stay in source unchanged
                if (this.isCompletedTask(child.line) || this.isDeletedTask(child.line)) {
                    console.log(`[BuJo] Skipping completed/cancelled child: "${this.getTaskText(child.line)}"`);
                    continue;
                }

                const childIndentMatch = child.line.match(/^(\s*)/);
                const childIndent = childIndentMatch ? childIndentMatch[0] : '';
                const childText = this.getTaskText(child.line);
                const childCleanText = this.removeMetadata(childText);

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

                const childDestLine = `${childIndent}- ${childDestMarker} ${childCleanText}`;
                destChildLines.push(childDestLine);

                // Prepare source update for child
                const updatedChildLine = child.line.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[s]');
                childUpdates.push({ original: child.line, updated: updatedChildLine });
            }

            // Combine parent and children for destination
            const allDestLines = [destTaskLine, ...destChildLines];

            // Use [s] instead of [>] for planning - replace checkbox content
            const updatedSourceLine = taskLine.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[s]');
            console.log(`[BuJo] Updated source line (scheduled): ${updatedSourceLine}`);

            try {
                await this.appendToFile(targetFilePath, allDestLines, destination.monthName || null);
                if (destChildLines.length > 0) {
                    console.log(`[BuJo] Successfully appended task with ${destChildLines.length} children to ${targetFilePath}`);
                } else {
                    console.log(`[BuJo] Successfully appended task to ${targetFilePath}`);
                }
            } catch (error) {
                console.error(`[BuJo] Failed to append task to ${targetFilePath}:`, error);
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
                            console.error(`[BuJo] Failed to update child task "${childTaskText.substring(0, 50)}" in ${sourceFilePath}:`, childError);
                            // Continue processing other children instead of failing completely
                        }
                    }

                    const successfulChildUpdates = childUpdates.length - childUpdateErrors;
                    if (childUpdates.length > 0) {
                        console.log(`[BuJo] Successfully updated source file ${sourceFilePath} with [s] marker (parent + ${successfulChildUpdates}/${childUpdates.length} children${childUpdateErrors > 0 ? `, ${childUpdateErrors} child updates failed` : ''})`);
                    } else {
                        console.log(`[BuJo] Successfully updated source file ${sourceFilePath} with [s] marker`);
                    }
                } catch (error) {
                    console.error(`[BuJo] Failed to update parent task in source file ${sourceFilePath}:`, error);
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    return { success: false, error: `Failed to update source: ${errorMessage}` };
                }
            } else if (isNewTask) {
                console.log(`[BuJo] Skipping source update for new task marker [+>`);
            }

            return { success: true, sourceFile: sourceFilePath, destFile: targetFilePath, childrenMarked: childUpdates.length };
        } catch (error) {
            console.error(`[BuJo] Planning migration error:`, error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { success: false, error: errorMessage };
        }
    }

    // =================================================================
    // REVIEW COMMANDS
    // =================================================================

    /**
     * Process Daily Note - Migrate tasks in current daily note
     */
    async migrateDailyNote(): Promise<void> {
        try {
            new Notice('Processing daily note...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('Please open a daily note');
                return;
            }

            // Check if it's a daily note
            if (!activeFile.path.includes('Daily Notes')) {
                new Notice('Please open a daily note from Journal/001 Daily Notes/');
                return;
            }

            const sourceDate = this.getDateFromFilePath(activeFile.path);
            if (!sourceDate) {
                new Notice('Could not determine date from filename');
                return;
            }

            const content = await this.app.vault.read(activeFile as TFile);
            const lines = content.split('\n');

            let migratedCount = 0;
            let newTaskCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            const errors: string[] = [];

            // Process each line
            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!this.isBulletItem(trimmedLine)) continue;

                // Skip completed and cancelled tasks - they're already done, leave them as-is
                if (this.isCompletedTask(trimmedLine)) {
                    completedCount++;
                    continue;
                }
                
                if (this.isDeletedTask(trimmedLine)) {
                    completedCount++; // Count as "done" (cancelled)
                    continue;
                }
                
                // Skip already processed new tasks [+]
                if (/^-\s*\[\+\]/.test(trimmedLine)) {
                    console.log(`[BuJo] Skipping already-created new task: "${trimmedLine.substring(0, 50)}"`);
                    continue;
                }

                // Handle delete marker [d] - remove task entirely
                const parsed = this.parseMigrationMarker(trimmedLine);
                if (parsed && parsed.marker === 'delete') {
                    try {
                        const result = await this.deleteTask(line, activeFile.path);
                        if (result.success) {
                            deletedCount++;
                            console.log(`[BuJo] Deleted task: "${this.getTaskText(trimmedLine)}"`);
                        } else {
                            errors.push(`Delete failed: ${result.error}`);
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        errors.push(`Delete error: ${errorMessage}`);
                    }
                    continue;
                }

                // Check if this is a new task marker [+>
                const isNewTaskMarker = parsed && parsed.isNewTask;

                // Handle new tasks (don't require source path)
                if (isNewTaskMarker && this.hasMigrationMarker(trimmedLine)) {
                    console.log(`[BuJo] Creating new task: "${this.getTaskText(trimmedLine)}"`);
                    const result = await this.createNewTask(line, sourceDate);
                    if (result.success) {
                        newTaskCount++;
                        migratedCount++;
                        console.log(`[BuJo] Successfully created new task in ${result.destFile}`);
                        
                        // Mark as created with [+] (similar to how migrations mark as [>])
                        try {
                            const taskText = this.getTaskText(line);
                            const indent = line.match(/^(\s*)/)?.[0] || '';
                            const updatedLine = `${indent}- [+] ${taskText}`;
                            await this.updateTaskInFile(activeFile.path, line, updatedLine);
                            console.log(`[BuJo] Marked new task as created [+] in source file`);
                        } catch (updateError) {
                            console.error(`[BuJo] Failed to mark new task as created:`, updateError);
                            // Don't fail the whole operation if we can't mark it
                        }
                    } else {
                        errors.push(`New task creation failed: ${result.error}`);
                        console.error(`[BuJo] Failed to create new task: ${result.error}`);
                    }
                    continue;
                }

                // Handle migration markers (works for tasks, events, information, etc.)
                if (this.hasMigrationMarker(trimmedLine)) {
                    try {
                        const result = await this.migrateTask(
                            line,  // Pass original line with whitespace, not trimmed
                            activeFile.path,
                            sourceDate,
                            'daily'
                        );

                        if (result.success && !result.skipped) {
                            migratedCount++;
                        } else if (result.success && result.skipped) {
                            // Task was marked but not migrated (e.g., [<] or [>skip])
                            console.log(`[BuJo] Task marked but not migrated: "${trimmedLine.substring(0, 50)}"`);
                        } else {
                            // Skip invalid markers silently (like [>->])
                            if (result.error && result.error.includes('Unknown migration marker')) {
                                console.log(`[BuJo] Skipping invalid marker in task: "${trimmedLine.substring(0, 50)}"`);
                            } else {
                                errors.push(`Migration failed: ${result.error}`);
                            }
                        }
                    } catch (error) {
                        // Skip invalid markers silently
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (errorMessage.includes('Unknown migration marker')) {
                            console.log(`[BuJo] Skipping invalid marker in task: "${trimmedLine.substring(0, 50)}"`);
                        } else {
                            errors.push(`Migration error: ${errorMessage}`);
                        }
                    }
                }
            }

            const message = `Daily note processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}${deletedCount > 0 ? `, ${deletedCount} deleted` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Processing errors:', errors);
                console.error('Error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Process daily note error:', error);
        }
    }

    /**
     * Generate Weekly Review
     */
    async generateWeeklyReview(weekString: string | null = null): Promise<void> {
        try {
            new Notice('Generating weekly review...');

            let targetWeek;
            if (weekString) {
                targetWeek = moment(weekString, 'YYYY-[W]WW');
            } else {
                // Try to detect from active file
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile instanceof TFile) {
                    const weekMatch = activeFile.path.match(/(\d{4})-W(\d{2})\.md$/);
                    if (weekMatch && weekMatch[1] && weekMatch[2]) {
                        const year = parseInt(weekMatch[1]);
                        const week = parseInt(weekMatch[2]);
                        targetWeek = moment().year(year).isoWeek(week);
                    } else {
                        // Default to previous week
                        targetWeek = moment().subtract(1, 'week');
                    }
                } else {
                    // Default to previous week
                    targetWeek = moment().subtract(1, 'week');
                }
            }
            const year = targetWeek.year();
            const week = targetWeek.isoWeek();
            const weekStr = `${year}-W${String(week).padStart(2, '0')}`;

            const reviewPath = `Journal/Bujo Reviews/Weekly/${weekStr}-Review.md`;
            const monday = targetWeek.startOf('isoWeek');
            const tasks = [];

            const tasksBySource: Record<string, string[]> = {};

            for (let i = 0; i < 7; i++) {
                const currentDay = monday.clone().add(i, 'days');
                const dateStr = currentDay.format('YYYY-MM-DD');
                const dailyPath = `Journal/001 Daily Notes/${dateStr}.md`;

                const incompleteTasks = await this.getIncompleteTasks(dailyPath);

                if (incompleteTasks.length > 0) {
                    if (!tasksBySource[dailyPath]) {
                        tasksBySource[dailyPath] = [];
                    }
                    tasksBySource[dailyPath].push(...incompleteTasks);
                }
            }

            // Also check the weekly note itself for incomplete tasks
            const weeklyPath = `Journal/002 Weekly Notes/${weekStr}.md`;
            const weeklyTasks = await this.getIncompleteTasks(weeklyPath);
            if (weeklyTasks.length > 0) {
                tasksBySource[weeklyPath] = weeklyTasks;
            }

            const lines = [`# Weekly Review - ${weekStr}`, ''];

            if (Object.keys(tasksBySource).length === 0) {
                lines.push('No incomplete tasks found for this week.', '');
            } else {
                // Output tasks grouped by source path
                Object.entries(tasksBySource).sort().forEach(([source, sourceTasks]) => {
                    // Extract just the date/identifier from the path for cleaner headings
                    // Daily: Journal/001 Daily Notes/2026-01-07.md → 2026-01-07
                    // Weekly: Journal/002 Weekly Notes/2026-W02.md → 2026-W02
                    // Monthly: Journal/003 Monthly Notes/2026-02.md → 2026-02
                    const dateMatch = source.match(/(\d{4}-(?:W)?\d{2}(?:-\d{2})?)\.md$/);
                    const heading = dateMatch ? `## [[${dateMatch[1]}]]` : `## [[${source}]]`;
                    lines.push(heading);
                    sourceTasks.forEach(task => lines.push(task));
                    lines.push('');
                });
            }

            lines.push('---');
            lines.push('**Instructions:**');
            lines.push('- Add migration markers in brackets: [>>], [>w], [>m], [>{day}], [>{month}], [>fut]');
            lines.push('- Optionally specify item type: [>mon{o}] for event, [>fri{a}] for appointment');
            lines.push('- Mark completed tasks as [x]');
            lines.push('- Mark cancelled tasks as [-]');
            lines.push('- Delete tasks entirely with [d] (removes from source file)');
            lines.push('- Mark as migrated without migrating: [>skip] or [<] or [>-]');
            lines.push('- Add new tasks with [+> marker: [+>w], [+>m], [+>tue], etc. (creates new task, doesn\'t look for source)');
            lines.push('- Run "Process Weekly Review" when done');

            const content = lines.join('\n');
            const existingFile = this.app.vault.getAbstractFileByPath(reviewPath);

            if (existingFile) {
                await this.app.vault.modify(existingFile as TFile, content);
            } else {
                const folder = this.app.vault.getAbstractFileByPath('Journal/Bujo Reviews/Weekly');
                if (!folder) await this.app.vault.createFolder('Journal/Bujo Reviews/Weekly');
                await this.app.vault.create(reviewPath, content);
            }

            const file = this.app.vault.getAbstractFileByPath(reviewPath);
            if (file) await this.app.workspace.getLeaf().openFile(file as TFile);

            new Notice(`Weekly review created: ${reviewPath}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Weekly review error:', error);
        }
    }

    /**
     * Process Weekly Review
     */
    async migrateWeeklyReview(): Promise<void> {
        try {
            new Notice('Processing weekly review...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || !activeFile.path.includes('Bujo Reviews/Weekly')) {
                new Notice('Please open a weekly review note');
                return;
            }

            const reviewPath = activeFile.path;
            const reviewFile = this.app.vault.getAbstractFileByPath(reviewPath);
            const content = await this.app.vault.read(reviewFile as TFile);
            const lines = content.split('\n');

            let migratedCount = 0;
            let newTaskCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            const errors = [];
            let currentSourcePath = null;
            const processedLines = new Set(); // Track lines that have been processed as children

            for (let i = 0; i < lines.length; i++) {
                // Skip if this line was already processed as a child of a parent task
                if (processedLines.has(i)) {
                    continue;
                }
                
                const line = lines[i];
                if (!line) continue;
                const trimmedLine = line.trim();
                
                // Check if this is a source path heading (## or ###)
                if (trimmedLine.startsWith('### ')) {
                    let potentialPath = trimmedLine.substring(4).trim();
                    // Strip wikilink brackets if present
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    // Check if it's a date format and reconstruct full path
                    // Daily: 2026-01-07 → Journal/001 Daily Notes/2026-01-07.md
                    // Weekly: 2026-W02 → Journal/002 Weekly Notes/2026-W02.md
                    // Monthly: 2026-02 → Journal/003 Monthly Notes/2026-02.md
                    // Yearly: 2026 → Journal/004 Yearly Notes/2026.md
                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        // Daily note format
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ### heading (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        // Weekly note format
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ### heading (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        // Monthly note format
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ### heading (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        // Yearly note format
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ### heading (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        // Full path provided
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path from ### heading (full path): ${currentSourcePath}`);
                    }
                    continue;
                }

                // Check for ## heading as source path (for weekly reviews)
                if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                    let potentialPath = trimmedLine.substring(3).trim();
                    // Strip wikilink brackets if present
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    // Check if it's a date format and reconstruct full path
                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        // Daily note format
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ## heading (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        // Weekly note format
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ## heading (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        // Monthly note format
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ## heading (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        // Yearly note format
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path from ## heading (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        // Full path provided
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path from ## heading (full path): ${currentSourcePath}`);
                    }
                    continue;
                }
                
                if (!this.isBulletItem(trimmedLine)) continue;

                // Check if this is a new task marker [+>
                const parsedMarker = this.parseMigrationMarker(trimmedLine);
                const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

                // Try to extract source path from heading or use current
                const previousLines = lines.slice(Math.max(0, i - 10), i);
                const sourcePath = this.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
                const isNewTask = !sourcePath || isNewTaskMarker;

                // Handle new tasks (no source path or [+> marker)
                if (isNewTask) {
                    if (this.hasMigrationMarker(trimmedLine)) {
                        // Try to get date from review file path
                        let reviewDate = null;
                        const weekMatch = reviewPath.match(/(\d{4})-W(\d{2})/);
                        if (weekMatch && weekMatch[1] && weekMatch[2]) {
                            reviewDate = moment().year(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek').format('YYYY-MM-DD');
                        } else {
                            const monthMatch = reviewPath.match(/(\d{4}-\d{2})/);
                            if (monthMatch && monthMatch[1]) {
                                reviewDate = `${monthMatch[1]}-01`;
                            }
                        }

                        // Use original line to preserve indentation for nested tasks
                        const result = await this.createNewTask(line, reviewDate);
                        if (result.success) {
                            newTaskCount++;
                            migratedCount++;
                        } else {
                            errors.push(`New task creation failed: ${result.error}`);
                        }
                    }
                    continue;
                }

                // Handle existing tasks with source path
                if (this.isCompletedTask(trimmedLine)) {
                    const result = await this.completeTask(trimmedLine, sourcePath);
                    if (result.success) {
                        completedCount++;
                    } else {
                        errors.push(`Complete failed: ${result.error}`);
                    }
                    continue;
                }

                if (this.isDeletedTask(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    console.log(`[BuJo] Processing cancelled task: "${taskText}" from ${sourcePath}`);
                    // Use original line to preserve indentation
                    const result = await this.cancelTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                    } else {
                        const errorMsg = `Task "${taskText}": Cancel failed - ${result.error}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] Cancel failed for task: "${taskText}"`, result.error);
                    }
                    continue;
                }

                // Handle delete marker [d] - remove task entirely from source file
                const deleteMarkerParsedWeekly = this.parseMigrationMarker(trimmedLine);
                if (deleteMarkerParsedWeekly && deleteMarkerParsedWeekly.marker === 'delete') {
                    console.log(`[BuJo] Processing [d] marker: "${this.getTaskText(trimmedLine)}" from source: ${sourcePath}`);
                    if (!sourcePath) {
                        console.error(`[BuJo] No source path found for [d] task: "${this.getTaskText(trimmedLine)}"`);
                        errors.push(`Delete failed: No source path found for task "${this.getTaskText(trimmedLine)}"`);
                        continue;
                    }
                    const result = await this.deleteTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                        console.log(`[BuJo] Successfully deleted task from ${sourcePath}: "${this.getTaskText(trimmedLine)}"`);
                    } else {
                        console.error(`[BuJo] Failed to delete task from ${sourcePath}: ${result.error}`);
                        errors.push(`Delete failed: ${result.error}`);
                    }
                    continue;
                }

                if (this.hasMigrationMarker(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    const sourceDate = this.getDateFromFilePath(sourcePath);
                    const periodType = this.detectPeriodType(sourcePath);

                    console.log(`[BuJo] Attempting to migrate task: "${taskText}" from ${sourcePath} (date: ${sourceDate}, period: ${periodType})`);

                    if (!sourceDate) {
                        const errorMsg = `Task "${taskText}": Could not determine date from: ${sourcePath}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] ${errorMsg}`);
                        continue;
                    }

                    // Collect children from SOURCE file (not review file) to preserve actual parent-child relationships
                    const childTasks = await this.collectChildrenFromSource(sourcePath, taskText);
                    
                    // Mark child lines in review as processed (if they exist) so we don't process them separately
                    // But we'll use the children from the source file for migration
                    if (childTasks.length > 0) {
                        // Try to find matching children in review file and mark them as processed
                        const parentIndent = this.getIndentLevel(line);
                        const reviewChildren = this.collectChildTasks(lines, i, parentIndent);
                        reviewChildren.forEach(child => processedLines.add(child.index));
                    }
                    
                    // Use original line to preserve indentation for nested tasks
                    // Migrate parent with children from source file
                    const result = await this.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                    if (result.success && !result.skipped) {
                        migratedCount++;
                        if (childTasks.length > 0) {
                            console.log(`[BuJo] Successfully migrated task with ${childTasks.length} children: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                        } else {
                            console.log(`[BuJo] Successfully migrated task: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                        }
                    } else if (result.success && result.skipped) {
                        // Task was marked but not migrated (e.g., [<] or [>skip])
                        console.log(`[BuJo] Task marked but not migrated: "${taskText}"`);
                    } else {
                        const errorMsg = `Task "${taskText}": Migration failed - ${result.error}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] Migration failed for task: "${taskText}" from ${sourcePath}`, result.error);
                    }
                }
            }

            await this.app.vault.delete(reviewFile as TFile);

            const message = `Review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Processing errors:', errors);
                console.error('Full error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Process review error:', error);
        }
    }

    /**
     * Generate Monthly Review
     */
    async generateMonthlyReview(monthString: string | null = null): Promise<void> {
        try {
            new Notice('Generating monthly review...');

            let targetMonth;
            if (monthString) {
                targetMonth = moment(monthString, 'YYYY-MM');
            } else {
                // Try to detect from active file
                const activeFile = this.app.workspace.getActiveFile();
                if (activeFile && activeFile instanceof TFile) {
                    const monthMatch = activeFile.path.match(/(\d{4}-\d{2})\.md$/);
                    if (monthMatch) {
                        targetMonth = moment(monthMatch[1], 'YYYY-MM');
                    } else {
                        // Default to previous month
                        targetMonth = moment().subtract(1, 'month');
                    }
                } else {
                    // Default to previous month
                    targetMonth = moment().subtract(1, 'month');
                }
            }
            const yearMonth = targetMonth.format('YYYY-MM');
            const reviewPath = `Journal/Bujo Reviews/Monthly/${yearMonth}-Review.md`;

            const firstDay = targetMonth.startOf('month');
            const lastDay = targetMonth.clone().endOf('month');

            const tasksBySource: Record<string, string[]> = {};

            let currentDay = firstDay.clone();
            while (currentDay.isSameOrBefore(lastDay, 'day')) {
                const dateStr = currentDay.format('YYYY-MM-DD');
                const dailyPath = `Journal/001 Daily Notes/${dateStr}.md`;

                const incompleteTasks = await this.getIncompleteTasks(dailyPath);

                if (incompleteTasks.length > 0) {
                    if (!tasksBySource[dailyPath]) {
                        tasksBySource[dailyPath] = [];
                    }
                    tasksBySource[dailyPath].push(...incompleteTasks);
                }

                currentDay.add(1, 'day');
            }

            let weekNum = firstDay.isoWeek();
            const lastWeekNum = lastDay.isoWeek();
            while (weekNum <= lastWeekNum) {
                const weekStr = `${firstDay.year()}-W${String(weekNum).padStart(2, '0')}`;
                const weeklyPath = `Journal/002 Weekly Notes/${weekStr}.md`;
                const incompleteTasks = await this.getIncompleteTasks(weeklyPath);

                if (incompleteTasks.length > 0) {
                    if (!tasksBySource[weeklyPath]) {
                        tasksBySource[weeklyPath] = [];
                    }
                    tasksBySource[weeklyPath].push(...incompleteTasks);
                }
                weekNum++;
            }

            // Also check the monthly note itself for incomplete tasks
            const monthlyPath = `Journal/003 Monthly Notes/${yearMonth}.md`;
            const monthlyTasks = await this.getIncompleteTasks(monthlyPath);
            if (monthlyTasks.length > 0) {
                tasksBySource[monthlyPath] = monthlyTasks;
            }

            const lines = [`# Monthly Review - ${yearMonth}`, ''];

            if (Object.keys(tasksBySource).length === 0) {
                lines.push('No incomplete tasks found for this month.', '');
            } else {
                // Output tasks grouped by source path
                Object.entries(tasksBySource).sort().forEach(([source, sourceTasks]) => {
                    // Extract just the date/identifier from the path for cleaner headings
                    // Daily: Journal/001 Daily Notes/2026-01-07.md → 2026-01-07
                    // Weekly: Journal/002 Weekly Notes/2026-W02.md → 2026-W02
                    // Monthly: Journal/003 Monthly Notes/2026-02.md → 2026-02
                    const dateMatch = source.match(/(\d{4}-(?:W)?\d{2}(?:-\d{2})?)\.md$/);
                    const heading = dateMatch ? `## [[${dateMatch[1]}]]` : `## [[${source}]]`;
                    lines.push(heading);
                    sourceTasks.forEach(task => lines.push(task));
                        lines.push('');
                });
            }

            lines.push('---');
            lines.push('**Instructions:**');
            lines.push('- Add migration markers in brackets: [>>], [>w], [>m], [>{day}], [>{month}], [>fut]');
            lines.push('- Optionally specify item type: [>marker{o}] for event, [>marker{a}] for appointment');
            lines.push('- Mark completed tasks as [x]');
            lines.push('- Mark cancelled tasks as [-]');
            lines.push('- Delete tasks entirely with [d] (removes from source file)');
            lines.push('- Mark as migrated without migrating: [>skip] or [<] or [>-]');
            lines.push('- Add new tasks with [+> marker: [+>w], [+>m], [+>tue], etc. (creates new task, doesn\'t look for source)');
            lines.push('- Run "Process Monthly Review" when done');

            const content = lines.join('\n');
            const existingFile = this.app.vault.getAbstractFileByPath(reviewPath);

            if (existingFile) {
                await this.app.vault.modify(existingFile as TFile, content);
            } else {
                const folder = this.app.vault.getAbstractFileByPath('Journal/Bujo Reviews/Monthly');
                if (!folder) await this.app.vault.createFolder('Journal/Bujo Reviews/Monthly');
                await this.app.vault.create(reviewPath, content);
            }

            const file = this.app.vault.getAbstractFileByPath(reviewPath);
            if (file) await this.app.workspace.getLeaf().openFile(file as TFile);

            new Notice(`Monthly review created: ${reviewPath}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Monthly review error:', error);
        }
    }

    /**
     * Process Monthly Review
     */
    async migrateMonthlyReview(): Promise<void> {
        try {
            new Notice('Processing monthly review...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || !activeFile.path.includes('Bujo Reviews/Monthly')) {
                new Notice('Please open a monthly review note');
                return;
            }

            const reviewPath = activeFile.path;
            const reviewFile = this.app.vault.getAbstractFileByPath(reviewPath);
            const content = await this.app.vault.read(reviewFile as TFile);
            const lines = content.split('\n');

            let migratedCount = 0;
            let newTaskCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            const errors = [];
            let currentSourcePath = null;
            const processedLines = new Set(); // Track lines that have been processed as children

            for (let i = 0; i < lines.length; i++) {
                // Skip if this line was already processed as a child of a parent task
                if (processedLines.has(i)) {
                    continue;
                }

                const line = lines[i];
                if (!line) continue;
                const trimmedLine = line.trim();

                // Check if this is a source path heading (### for individual files)
                if (trimmedLine.startsWith('### ')) {
                    let potentialPath = trimmedLine.substring(4).trim();
                    // Remove wiki link brackets if present: [[2026-01-07]] → 2026-01-07
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    // Convert date patterns to full paths
                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path (full): ${currentSourcePath}`);
                    }
                    continue;
                }

                // Check for ## heading (section headers) - skip these
                if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                    continue;
                }

                if (!this.isBulletItem(trimmedLine)) continue;

                // Check if this is a new task marker [+>
                const parsedMarker = this.parseMigrationMarker(trimmedLine);
                const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

                // Try to extract source path from heading or use current
                const previousLines = lines.slice(Math.max(0, i - 10), i);
                const sourcePath = this.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
                const isNewTask = !sourcePath || isNewTaskMarker;

                // Handle new tasks (no source path or [+> marker)
                if (isNewTask) {
                    if (this.hasMigrationMarker(trimmedLine)) {
                        // Try to get date from review file path
                        let reviewDate = null;
                        const monthMatch = reviewPath.match(/(\d{4}-\d{2})/);
                        if (monthMatch) {
                            reviewDate = `${monthMatch[1]}-01`;
                        }

                        // Use original line to preserve indentation for nested tasks
                        const result = await this.createNewTask(line, reviewDate);
                        if (result.success) {
                            newTaskCount++;
                            migratedCount++;
                        } else {
                            errors.push(`New task creation failed: ${result.error}`);
                        }
                    }
                    continue;
                }

                // Handle existing tasks with source path
                if (this.isCompletedTask(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    console.log(`[BuJo] Processing completed task: "${taskText}" from ${sourcePath}`);
                    // Use original line to preserve indentation
                    const result = await this.completeTask(line, sourcePath);
                    if (result.success) {
                        completedCount++;
                    } else {
                        const errorMsg = `Task "${taskText}": Complete failed - ${result.error}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] Complete failed for task: "${taskText}"`, result.error);
                    }
                    continue;
                }

                if (this.isDeletedTask(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    console.log(`[BuJo] Processing cancelled task: "${taskText}" from ${sourcePath}`);
                    // Use original line to preserve indentation
                    const result = await this.cancelTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                    } else {
                        const errorMsg = `Task "${taskText}": Cancel failed - ${result.error}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] Cancel failed for task: "${taskText}"`, result.error);
                    }
                    continue;
                }

                // Handle delete marker [d] - remove task entirely from source file
                const deleteMarkerParsedMonthly = this.parseMigrationMarker(trimmedLine);
                if (deleteMarkerParsedMonthly && deleteMarkerParsedMonthly.marker === 'delete') {
                    const result = await this.deleteTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                        console.log(`[BuJo] Deleted task from ${sourcePath}: "${this.getTaskText(trimmedLine)}"`);
                    } else {
                        errors.push(`Delete failed: ${result.error}`);
                    }
                    continue;
                }

                if (this.hasMigrationMarker(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    const sourceDate = this.getDateFromFilePath(sourcePath);
                    const periodType = this.detectPeriodType(sourcePath);

                    console.log(`[BuJo] Attempting to migrate task: "${taskText}" from ${sourcePath} (date: ${sourceDate}, period: ${periodType})`);

                    if (!sourceDate) {
                        const errorMsg = `Task "${taskText}": Could not determine date from: ${sourcePath}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] ${errorMsg}`);
                        continue;
                    }

                    // Collect children from SOURCE file (not review file) to preserve actual parent-child relationships
                    const childTasks = await this.collectChildrenFromSource(sourcePath, taskText);
                    
                    // Mark child lines in review as processed (if they exist) so we don't process them separately
                    // But we'll use the children from the source file for migration
                    if (childTasks.length > 0) {
                        // Try to find matching children in review file and mark them as processed
                        const parentIndent = this.getIndentLevel(line);
                        const reviewChildren = this.collectChildTasks(lines, i, parentIndent);
                        reviewChildren.forEach(child => processedLines.add(child.index));
                    }
                    
                    // Use original line to preserve indentation for nested tasks
                    // Migrate parent with children from source file
                    const result = await this.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                    if (result.success && !result.skipped) {
                        migratedCount++;
                        if (childTasks.length > 0) {
                            console.log(`[BuJo] Successfully migrated task with ${childTasks.length} children: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                        } else {
                            console.log(`[BuJo] Successfully migrated task: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                        }
                    } else if (result.success && result.skipped) {
                        // Task was marked but not migrated (e.g., [<] or [>skip])
                        console.log(`[BuJo] Task marked but not migrated: "${taskText}"`);
                    } else {
                        const errorMsg = `Task "${taskText}": Migration failed - ${result.error}`;
                        errors.push(errorMsg);
                        console.error(`[BuJo] Migration failed for task: "${taskText}" from ${sourcePath}`, result.error);
                    }
                }
            }

            await this.app.vault.delete(reviewFile as TFile);

            const message = `Review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Processing errors:', errors);
                console.error('Full error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Process monthly review error:', error);
        }
    }

    /**
     * Process Weekly Plan - Process tasks directly in weekly note (marks as [s] instead of [>])
     */
    /**
     * Schedule Plan - Process tasks in weekly/monthly notes (marks as [s] instead of [>])
     * Unified method that handles both weekly and monthly planning
     */
    async schedulePlan(periodType: PeriodType): Promise<void> {
        const periodNames: Record<string, string> = {
            weekly: 'weekly',
            monthly: 'monthly'
        };
        const periodName = periodNames[periodType] || periodType;

        try {
            new Notice(`Processing ${periodName} plan...`);

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice(`Please open a ${periodName} note`);
                return;
            }

            const filePath = activeFile.path;
            const file = this.app.vault.getAbstractFileByPath(filePath);
            const content = await this.app.vault.read(file as TFile);
            const lines = content.split('\n');

            let scheduledCount = 0;
            let newTaskCount = 0;
            const errors: string[] = [];

            // Extract date from file path based on period type
            let sourceDate: string | null = null;
            if (periodType === 'weekly') {
                const weekMatch = filePath.match(/(\d{4})-W(\d{2})/);
                if (weekMatch && weekMatch[1] && weekMatch[2]) {
                    sourceDate = moment().year(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek').format('YYYY-MM-DD');
                }
            } else if (periodType === 'monthly') {
                const monthMatch = filePath.match(/(\d{4}-\d{2})\.md$/);
                if (monthMatch) {
                    sourceDate = `${monthMatch[1]}-01`;
                }
            }

            if (!sourceDate) {
                new Notice(`Could not determine date from file path`);
                return;
            }

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                const trimmedLine = line.trim();

                if (!trimmedLine.startsWith('- [')) continue;

                // Skip completed and deleted tasks
                if (this.isCompletedTask(trimmedLine) || this.isDeletedTask(trimmedLine)) {
                    continue;
                }

                // Check if this is a new task marker [+>
                const parsedMarker = this.parseMigrationMarker(trimmedLine);
                const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

                // Handle new tasks
                if (isNewTaskMarker) {
                    if (this.hasMigrationMarker(trimmedLine)) {
                        const result = await this.createNewTask(line, sourceDate);
                        if (result.success) {
                            newTaskCount++;
                            scheduledCount++;
                        } else {
                            errors.push(`New task creation failed: ${result.error}`);
                        }
                    }
                    continue;
                }

                // Skip tasks already marked as migrated/scheduled/created
                if (trimmedLine.includes('[>-]') || trimmedLine.includes('[<]') || trimmedLine.includes('[s]') || trimmedLine.includes('[+]') || /\[>\]/.test(trimmedLine)) {
                    continue;
                }

                // Handle migration markers
                if (this.hasMigrationMarker(trimmedLine)) {
                    const taskText = this.getTaskText(trimmedLine);
                    console.log(`[BuJo] Scheduling task: "${taskText}" from ${filePath}`);

                    const result = await this.migrateTaskForPlan(line, filePath, sourceDate, periodType);
                    if (result.success) {
                        scheduledCount++;
                        console.log(`[BuJo] Successfully scheduled task: "${taskText}" to ${result.destFile || 'marked as scheduled'}`);
                    } else {
                        errors.push(`Task "${taskText}": ${result.error}`);
                        console.error(`[BuJo] Scheduling failed: "${taskText}"`, result.error);
                    }
                }
            }

            const periodLabel = periodName.charAt(0).toUpperCase() + periodName.slice(1);
            const message = `${periodLabel} plan processed!\n✓ ${scheduledCount} tasks scheduled${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Scheduling errors:', errors);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error(`Schedule ${periodName} plan error:`, error);
        }
    }

    /**
     * Generate Global Review - All incomplete tasks from ALL journal notes
     */
    async generateGlobalReview(): Promise<void> {
        try {
            new Notice('Generating global review...');

            const reviewPath = `Journal/Bujo Reviews/Global/Global-Review-${moment().format('YYYY-MM-DD-HHmm')}.md`;
            const allTasks = [];

            // Get all files in Journal folder
            const allFiles = this.app.vault.getFiles();
            const today = moment().startOf('day');
            
            const journalFiles = allFiles.filter(file => {
                if (file.path.startsWith('Journal/001 Daily Notes/')) {
                    // Check if daily note date is before today
                    const dateMatch = file.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
                    if (dateMatch) {
                        const fileDate = moment(dateMatch[1], 'YYYY-MM-DD');
                        return fileDate.isBefore(today);
                    }
                    return false;
                } else if (file.path.startsWith('Journal/002 Weekly Notes/')) {
                    // Check if weekly note is before current week
                    const weekMatch = file.path.match(/(\d{4})-W(\d{2})\.md$/);
                    if (weekMatch && weekMatch[1] && weekMatch[2]) {
                        const fileWeek = moment().year(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek');
                        const currentWeek = moment().startOf('isoWeek');
                        return fileWeek.isBefore(currentWeek);
                    }
                    return false;
                } else if (file.path.startsWith('Journal/003 Monthly Notes/')) {
                    // Check if monthly note is before current month
                    const monthMatch = file.path.match(/(\d{4}-\d{2})\.md$/);
                    if (monthMatch) {
                        const fileMonth = moment(monthMatch[1], 'YYYY-MM').startOf('month');
                        const currentMonth = moment().startOf('month');
                        return fileMonth.isBefore(currentMonth);
                    }
                    return false;
                }
                return false;
            });

            // Sort files by path
            journalFiles.sort((a, b) => a.path.localeCompare(b.path));

            for (const file of journalFiles) {
                const incompleteTasks = await this.getIncompleteTasks(file.path);

                if (incompleteTasks.length > 0) {
                    let section = '';
                    if (file.path.includes('Daily Notes')) {
                        section = 'Daily Notes';
                    } else if (file.path.includes('Weekly Notes')) {
                        section = 'Weekly Notes';
                    } else if (file.path.includes('Monthly Notes')) {
                        section = 'Monthly Notes';
                    }

                    allTasks.push({
                        section,
                        filename: file.basename,
                        path: file.path,
                        tasks: incompleteTasks,
                    });
                }
            }

            const lines = [`# Global Review - ${moment().format('YYYY-MM-DD HH:mm')}`, ''];

            if (allTasks.length === 0) {
                lines.push('No incomplete tasks found in journal.');
                lines.push('');
            } else {
                // Group by section
                type TaskItem = { section: string; path: string; tasks: string[] };
                const sections: { [key: string]: TaskItem[] } = { 'Daily Notes': [], 'Weekly Notes': [], 'Monthly Notes': [] };
                allTasks.forEach((item: TaskItem) => {
                    if (!sections[item.section]) {
                        sections[item.section] = [];
                    }
                    sections[item.section]!.push(item);
                });

                // Output by section
                for (const [sectionName, items] of Object.entries(sections)) {
                    if (items.length > 0) {
                        lines.push(`## ${sectionName}`);
                        lines.push('');

                        items.forEach((item: TaskItem) => {
                            // Extract just the date/identifier from the path for cleaner headings
                            // Daily: Journal/001 Daily Notes/2026-01-07.md → 2026-01-07
                            // Weekly: Journal/002 Weekly Notes/2026-W02.md → 2026-W02
                            // Monthly: Journal/003 Monthly Notes/2026-02.md → 2026-02
                            const dateMatch = item.path.match(/(\d{4}-(?:W)?\d{2}(?:-\d{2})?)\.md$/);
                            const heading = dateMatch ? `### [[${dateMatch[1]}]]` : `### [[${item.path}]]`;
                            lines.push(heading);
                            item.tasks.forEach((task: string) => {
                                lines.push(task);
                            });
                            lines.push('');
                        });
                    }
                }

                lines.push(`---`);
                lines.push(`**Total: ${allTasks.reduce((sum, item) => sum + item.tasks.length, 0)} incomplete tasks**`);
                lines.push('');
            }

            lines.push('---');
            lines.push('**Instructions:**');
            lines.push('- Add migration markers in brackets: [>>], [>w], [>m], [>{day}], [>{month}], [>fut]');
            lines.push('- Optionally specify item type: [>mon{o}] for event, [>fri{a}] for appointment');
            lines.push('- Mark completed tasks as [x]');
            lines.push('- Mark cancelled tasks as [-]');
            lines.push('- Delete tasks entirely with [d] (removes from source file)');
            lines.push('- Mark as migrated without migrating: [>skip] or [<] or [>-]');
            lines.push('- Add new tasks with [+> marker: [+>w], [+>m], [+>tue], etc. (creates new task, doesn\'t look for source)');
            lines.push('- Run "Process Global Review" when done');

            const content = lines.join('\n');

            // Ensure directory exists
            const folder = this.app.vault.getAbstractFileByPath('Journal/Bujo Reviews/Global');
            if (!folder) await this.app.vault.createFolder('Journal/Bujo Reviews/Global');

            await this.app.vault.create(reviewPath, content);

            const file = this.app.vault.getAbstractFileByPath(reviewPath);
            if (file) await this.app.workspace.getLeaf().openFile(file as TFile);

            new Notice(`Global review created: ${reviewPath}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Global review error:', error);
        }
    }

    /**
     * Process Global Review
     */
    async migrateGlobalReview(): Promise<void> {
        try {
            new Notice('Processing global review...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile || !activeFile.path.includes('Bujo Reviews/Global')) {
                new Notice('Please open a global review note');
                return;
            }

            const reviewPath = activeFile.path;
            const reviewFile = this.app.vault.getAbstractFileByPath(reviewPath);
            const content = await this.app.vault.read(reviewFile as TFile);
            const lines = content.split('\n');

            let migratedCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            let newTaskCount = 0;
            const errors = [];
            let currentSourcePath = null;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!line) continue;
                const trimmedLine = line.trim();

                // Check if this is a source path heading (### for individual files)
                if (trimmedLine.startsWith('### ')) {
                    let potentialPath = trimmedLine.substring(4).trim();
                    // Remove wiki link brackets if present: [[2026-01-07]] → 2026-01-07
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    // Convert date patterns to full paths
                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        // Daily note: 2026-01-07 → Journal/001 Daily Notes/2026-01-07.md
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        // Weekly note: 2026-W05 → Journal/002 Weekly Notes/2026-W05.md
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        // Monthly note: 2026-01 → Journal/003 Monthly Notes/2026-01.md
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        // Yearly note: 2026 → Journal/004 Yearly Notes/2026.md
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        // Full path already provided
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path (full): ${currentSourcePath}`);
                    }
                    continue;
                }

                // Check for ## heading (section headers like "Daily Notes", "Weekly Notes")
                if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                    // Section headers don't set source path, individual ### headings do
                    continue;
                }
                
                if (!this.isBulletItem(trimmedLine)) continue;

                // Check if this is a new task marker [+>
                const parsedMarker = this.parseMigrationMarker(trimmedLine);
                const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

                // Try to extract source path from heading or use current
                const previousLines = lines.slice(Math.max(0, i - 10), i);
                const sourcePath = this.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
                const isNewTask = !sourcePath || isNewTaskMarker;

                // Handle new tasks (no source path or [+> marker)
                if (isNewTask) {
                    if (this.hasMigrationMarker(trimmedLine)) {
                        // For global reviews, use current date as reference
                        const reviewDate = moment().format('YYYY-MM-DD');
                        // Use original line to preserve indentation for nested tasks
                        const result = await this.createNewTask(line, reviewDate);
                        if (result.success) {
                            newTaskCount++;
                            migratedCount++;
                        } else {
                            errors.push(`New task creation failed: ${result.error}`);
                        }
                    }
                    continue;
                }

                // Handle existing tasks with source path
                if (this.isCompletedTask(trimmedLine)) {
                    // Use original line to preserve indentation
                    const result = await this.completeTask(line, sourcePath);
                    if (result.success) {
                        completedCount++;
                    } else {
                        errors.push(`Complete failed: ${result.error}`);
                    }
                    continue;
                }

                if (this.isDeletedTask(trimmedLine)) {
                    // Use original line to preserve indentation
                    const result = await this.cancelTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                    } else {
                        errors.push(`Cancel failed: ${result.error}`);
                    }
                    continue;
                }

                // Handle delete marker [d] - remove task entirely from source file
                const deleteMarkerParsed = this.parseMigrationMarker(trimmedLine);
                if (deleteMarkerParsed && deleteMarkerParsed.marker === 'delete') {
                    console.log(`[BuJo] Processing [d] marker: "${this.getTaskText(trimmedLine)}" from source: ${sourcePath}`);
                    if (!sourcePath) {
                        console.error(`[BuJo] No source path found for [d] task: "${this.getTaskText(trimmedLine)}"`);
                        errors.push(`Delete failed: No source path found for task "${this.getTaskText(trimmedLine)}"`);
                        continue;
                    }
                    const result = await this.deleteTask(line, sourcePath);
                    if (result.success) {
                        deletedCount++;
                        console.log(`[BuJo] Successfully deleted task from ${sourcePath}: "${this.getTaskText(trimmedLine)}"`);
                    } else {
                        console.error(`[BuJo] Failed to delete task from ${sourcePath}: ${result.error}`);
                        errors.push(`Delete failed: ${result.error}`);
                    }
                    continue;
                }

                if (this.hasMigrationMarker(trimmedLine)) {
                    const sourceDate = this.getDateFromFilePath(sourcePath);
                    const periodType = this.detectPeriodType(sourcePath);

                    if (!sourceDate) {
                        errors.push(`Could not determine date from: ${sourcePath}`);
                        continue;
                    }

                    // Collect children from SOURCE file to preserve actual parent-child relationships
                    const taskText = this.getTaskText(trimmedLine);
                    const childTasks = await this.collectChildrenFromSource(sourcePath, taskText);

                    // Use original line to preserve indentation for nested tasks
                    const result = await this.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                    if (result.success && !result.skipped) {
                        migratedCount++;
                        if (childTasks.length > 0) {
                            console.log(`[BuJo] Successfully migrated task with ${childTasks.length} children: "${taskText}"`);
                        }
                    } else if (result.success && result.skipped) {
                        // Task was marked but not migrated (e.g., [<] or [>skip])
                        console.log(`[BuJo] Task marked but not migrated: "${taskText}"`);
                    } else {
                        errors.push(`Migration failed: ${result.error}`);
                    }
                }
            }

            await this.app.vault.delete(reviewFile as TFile);

            const message = `Global review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) console.error('Processing errors:', errors);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Process global review error:', error);
        }
    }

    /**
     * Process Selected Tasks
     * Processes only the selected text in the current note
     * Updates the note as tasks are processed
     * Continues even if individual tasks fail
     */
    async migrateSelectedTasks(editor: Editor): Promise<void> {
        try {
            new Notice('Processing selected tasks...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('No active file');
                return;
            }

            const selection = editor.getSelection();
            if (!selection || selection.trim() === '') {
                new Notice('Please select tasks to process');
                return;
            }

            // Get the full content to find line numbers
            const fullContent = editor.getValue();
            const fullLines = fullContent.split('\n');

            // Get selection position
            const selectionStart = editor.getCursor('from');
            const selectionEnd = editor.getCursor('to');

            const selectedLines = selection.split('\n');
            let migratedCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            let newTaskCount = 0;
            const errors: string[] = [];
            let currentSourcePath: string | null = null;
            const linesToKeep: string[] = []; // Track which lines to keep in the review

            // Process each selected line
            for (let i = 0; i < selectedLines.length; i++) {
                const line = selectedLines[i];
                if (!line) {
                    linesToKeep.push(''); // Keep empty lines
                    continue;
                }
                const trimmedLine = line.trim();

                // Track source path from headings
                if (trimmedLine.startsWith('### ')) {
                    let potentialPath = trimmedLine.substring(4).trim();
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path (full): ${currentSourcePath}`);
                    }
                    linesToKeep.push(line); // Keep headings
                    continue;
                }

                if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                    let potentialPath = trimmedLine.substring(3).trim();
                    potentialPath = potentialPath.replace(/^\[\[(.+)\]\]$/, '$1');

                    if (/^\d{4}-\d{2}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/001 Daily Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (daily): ${currentSourcePath}`);
                    } else if (/^\d{4}-W\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/002 Weekly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (weekly): ${currentSourcePath}`);
                    } else if (/^\d{4}-\d{2}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/003 Monthly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (monthly): ${currentSourcePath}`);
                    } else if (/^\d{4}$/.test(potentialPath)) {
                        currentSourcePath = `Journal/004 Yearly Notes/${potentialPath}.md`;
                        console.log(`[BuJo] Set source path (yearly): ${currentSourcePath}`);
                    } else if (potentialPath.includes('/') && potentialPath.endsWith('.md')) {
                        currentSourcePath = potentialPath;
                        console.log(`[BuJo] Set source path (full): ${currentSourcePath}`);
                    }
                    linesToKeep.push(line); // Keep headings
                    continue;
                }

                if (!this.isBulletItem(trimmedLine)) {
                    linesToKeep.push(line); // Keep non-task lines
                    continue;
                }

                // Check if this is a new task marker
                const parsedMarker = this.parseMigrationMarker(trimmedLine);
                const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;
                const isNewTask = !currentSourcePath || isNewTaskMarker;

                // Handle new tasks
                if (isNewTask) {
                    if (this.hasMigrationMarker(trimmedLine)) {
                        const reviewDate = moment().format('YYYY-MM-DD');
                        const result = await this.createNewTask(line, reviewDate);
                        if (result.success) {
                            newTaskCount++;
                            migratedCount++;
                            // Don't add to linesToKeep - remove from review
                        } else {
                            errors.push(`New task failed: ${result.error}`);
                            linesToKeep.push(line); // Keep failed tasks
                        }
                    } else {
                        linesToKeep.push(line); // Keep tasks without markers
                    }
                    continue;
                }

                // Handle existing tasks with source path
                if (this.isCompletedTask(trimmedLine)) {
                    if (!currentSourcePath) {
                        errors.push(`Complete failed: No source path for "${this.getTaskText(trimmedLine)}"`);
                        linesToKeep.push(line);
                        continue;
                    }
                    const result = await this.completeTask(line, currentSourcePath);
                    if (result.success) {
                        completedCount++;
                        // Don't add to linesToKeep - remove from review
                    } else {
                        errors.push(`Complete failed: ${result.error}`);
                        linesToKeep.push(line); // Keep failed tasks
                    }
                    continue;
                }

                if (this.isDeletedTask(trimmedLine)) {
                    if (!currentSourcePath) {
                        errors.push(`Cancel failed: No source path for "${this.getTaskText(trimmedLine)}"`);
                        linesToKeep.push(line);
                        continue;
                    }
                    const result = await this.cancelTask(line, currentSourcePath);
                    if (result.success) {
                        deletedCount++;
                        // Don't add to linesToKeep - remove from review
                    } else {
                        errors.push(`Cancel failed: ${result.error}`);
                        linesToKeep.push(line); // Keep failed tasks
                    }
                    continue;
                }

                // Handle delete marker [d]
                const deleteMarkerParsed = this.parseMigrationMarker(trimmedLine);
                if (deleteMarkerParsed && deleteMarkerParsed.marker === 'delete') {
                    console.log(`[BuJo] Processing [d] marker: "${this.getTaskText(trimmedLine)}" from source: ${currentSourcePath}`);
                    if (!currentSourcePath) {
                        console.error(`[BuJo] No source path found for [d] task: "${this.getTaskText(trimmedLine)}"`);
                        errors.push(`Delete failed: No source path for "${this.getTaskText(trimmedLine)}"`);
                        linesToKeep.push(line);
                        continue;
                    }
                    const result = await this.deleteTask(line, currentSourcePath);
                    if (result.success) {
                        deletedCount++;
                        console.log(`[BuJo] Successfully deleted task from ${currentSourcePath}`);
                        // Don't add to linesToKeep - remove from review
                    } else {
                        console.error(`[BuJo] Failed to delete task: ${result.error}`);
                        errors.push(`Delete failed: ${result.error}`);
                        linesToKeep.push(line); // Keep failed tasks
                    }
                    continue;
                }

                // Handle migration markers
                if (this.hasMigrationMarker(trimmedLine)) {
                    if (!currentSourcePath) {
                        errors.push(`Migration failed: No source path for "${this.getTaskText(trimmedLine)}"`);
                        linesToKeep.push(line);
                        continue;
                    }

                    const sourceDate = this.getDateFromFilePath(currentSourcePath);
                    const periodType = this.detectPeriodType(currentSourcePath);

                    if (!sourceDate) {
                        errors.push(`Could not determine date from: ${currentSourcePath}`);
                        linesToKeep.push(line);
                        continue;
                    }

                    const result = await this.migrateTask(line, currentSourcePath, sourceDate, periodType);
                    if (result.success && !result.skipped) {
                        migratedCount++;
                        // Don't add to linesToKeep - remove from review
                    } else if (result.success && result.skipped) {
                        console.log(`[BuJo] Task marked but not migrated: "${this.getTaskText(trimmedLine)}"`);
                        // Don't add to linesToKeep - remove from review (task was marked)
                    } else {
                        errors.push(`Migration failed: ${result.error}`);
                        linesToKeep.push(line); // Keep failed tasks
                    }
                    continue;
                }

                // If we get here, it's a task without a migration marker - keep it
                linesToKeep.push(line);
            }

            // Update the editor to remove successfully processed tasks
            const updatedSelection = linesToKeep.join('\n');
            editor.replaceSelection(updatedSelection);

            const message = `Selected tasks processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Processing errors:', errors);
                console.error('Error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Process selected tasks error:', error);
        }
    }

    /**
     * Schedule Selected Tasks - Schedule only the selected tasks to their destination dates
     * Used for planning workflows - marks tasks as scheduled [<]
     */
    async scheduleSelectedTasks(editor: Editor): Promise<void> {
        try {
            new Notice('Scheduling selected tasks...');

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('No active file');
                return;
            }

            const selection = editor.getSelection();
            if (!selection || selection.trim() === '') {
                new Notice('Please select tasks to schedule');
                return;
            }

            const selectedLines = selection.split('\n');
            let scheduledCount = 0;
            const errors: string[] = [];
            const updatedLines: string[] = [];

            // Use current date as the base for scheduling
            const currentDate = moment().format('YYYY-MM-DD');

            for (let i = 0; i < selectedLines.length; i++) {
                const line = selectedLines[i];
                if (!line) {
                    updatedLines.push('');
                    continue;
                }
                const trimmedLine = line.trim();

                // Keep non-task lines as-is
                if (!trimmedLine.startsWith('- [')) {
                    updatedLines.push(line);
                    continue;
                }

                // Skip completed and cancelled tasks
                if (this.isCompletedTask(trimmedLine) || this.isDeletedTask(trimmedLine)) {
                    updatedLines.push(line);
                    continue;
                }

                // Skip tasks already marked as scheduled or migrated
                if (trimmedLine.includes('[s]') || trimmedLine.includes('[<]') || /\[>\]/.test(trimmedLine)) {
                    updatedLines.push(line);
                    continue;
                }

                // Only process tasks with migration markers
                if (!this.hasMigrationMarker(trimmedLine)) {
                    updatedLines.push(line);
                    continue;
                }

                // Schedule the task
                const result = await this.migrateTaskForPlan(
                    line,
                    activeFile.path,
                    currentDate,
                    'weekly'
                );

                if (result.success) {
                    scheduledCount++;
                    // Update the line to show it's been scheduled [s]
                    const updatedLine = line.replace(/- \[[^\]]+\]/, '- [s]');
                    updatedLines.push(updatedLine);
                } else {
                    errors.push(result.error || 'Unknown error');
                    updatedLines.push(line); // Keep original on failure
                }
            }

            // Update the selection with scheduled markers
            editor.replaceSelection(updatedLines.join('\n'));

            const message = `Tasks scheduled!\n✓ ${scheduledCount} tasks scheduled${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Scheduling errors:', errors);
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Schedule selected tasks error:', error);
        }
    }

    /**
     * Migrate Tasks - Smart command that detects note type and migrates tasks accordingly
     * Used for all journal notes (daily/weekly/monthly/yearly/future) and review documents
     */
    async migrateTasks(): Promise<void> {
        try {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('Please open a note to process');
                return;
            }

            const path = activeFile.path;

            // Detect note type and call appropriate method
            // Reviews first (more specific paths)
            if (path.includes('Bujo Reviews/Weekly')) {
                return await this.migrateWeeklyReview();
            } else if (path.includes('Bujo Reviews/Monthly')) {
                return await this.migrateMonthlyReview();
            } else if (path.includes('Bujo Reviews/Global')) {
                return await this.migrateGlobalReview();
            }
            // Journal notes
            else if (path.includes('Daily Notes') || path.includes('001 Daily')) {
                return await this.migrateJournalNote('daily');
            } else if (path.includes('Weekly Notes') || path.includes('002 Weekly')) {
                return await this.migrateJournalNote('weekly');
            } else if (path.includes('Monthly Notes') || path.includes('003 Monthly')) {
                return await this.migrateJournalNote('monthly');
            } else if (path.includes('Yearly Notes') || path.includes('004 Yearly')) {
                return await this.migrateJournalNote('yearly');
            } else if (path.includes('Future Log') || path.includes('004 Future') || path.includes('006 Future')) {
                return await this.migrateJournalNote('future');
            } else {
                new Notice('Cannot migrate from this note type. Please open a journal note or review document.');
                return;
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Migrate tasks error:', error);
        }
    }

    /**
     * Process any journal note type for migration (daily, weekly, monthly, yearly, future)
     */
    async migrateJournalNote(periodType: PeriodType | 'future'): Promise<void> {
        const periodNames: Record<string, string> = {
            daily: 'daily',
            weekly: 'weekly',
            monthly: 'monthly',
            yearly: 'yearly',
            future: 'future log'
        };

        const periodName = periodNames[periodType] || periodType;

        try {
            new Notice(`Processing ${periodName} note...`);

            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice(`Please open a ${periodName} note`);
                return;
            }

            const sourceDate = this.getDateFromFilePath(activeFile.path);
            if (!sourceDate && periodType !== 'future') {
                new Notice('Could not determine date from filename');
                return;
            }

            const content = await this.app.vault.read(activeFile as TFile);
            const lines = content.split('\n');

            let migratedCount = 0;
            let newTaskCount = 0;
            let completedCount = 0;
            let deletedCount = 0;
            const errors: string[] = [];

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!this.isBulletItem(trimmedLine)) continue;

                // Skip completed and cancelled tasks
                if (this.isCompletedTask(trimmedLine)) {
                    completedCount++;
                    continue;
                }

                if (this.isDeletedTask(trimmedLine)) {
                    completedCount++;
                    continue;
                }
                
                // Skip already processed new tasks [+]
                if (/^-\s*\[\+\]/.test(trimmedLine)) {
                    console.log(`[BuJo] Skipping already-created new task: "${trimmedLine.substring(0, 50)}"`);
                    continue;
                }

                // Handle delete marker [d]
                const parsed = this.parseMigrationMarker(trimmedLine);
                if (parsed && parsed.marker === 'delete') {
                    try {
                        const result = await this.deleteTask(line, activeFile.path);
                        if (result.success) {
                            deletedCount++;
                        } else {
                            errors.push(`Delete failed: ${result.error}`);
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        errors.push(`Delete error: ${errorMessage}`);
                    }
                    continue;
                }

                // Check if this is a new task marker [+>
                const isNewTaskMarker = parsed && parsed.isNewTask;

                // Handle new tasks (don't require source path)
                if (isNewTaskMarker && this.hasMigrationMarker(trimmedLine)) {
                    const effectiveDate = sourceDate || moment().format('YYYY-MM-DD');
                    console.log(`[BuJo] Creating new task: "${this.getTaskText(trimmedLine)}"`);
                    const result = await this.createNewTask(line, effectiveDate);
                    if (result.success) {
                        newTaskCount++;
                        migratedCount++;
                        console.log(`[BuJo] Successfully created new task in ${result.destFile}`);
                        
                        // Mark as created with [+] (similar to how migrations mark as [>])
                        try {
                            const taskText = this.getTaskText(line);
                            const indent = line.match(/^(\s*)/)?.[0] || '';
                            const updatedLine = `${indent}- [+] ${taskText}`;
                            await this.updateTaskInFile(activeFile.path, line, updatedLine);
                            console.log(`[BuJo] Marked new task as created [+] in source file`);
                        } catch (updateError) {
                            console.error(`[BuJo] Failed to mark new task as created:`, updateError);
                            // Don't fail the whole operation if we can't mark it
                        }
                    } else {
                        errors.push(`New task creation failed: ${result.error}`);
                        console.error(`[BuJo] Failed to create new task: ${result.error}`);
                    }
                    continue;
                }

                // Handle migration markers
                if (this.hasMigrationMarker(trimmedLine)) {
                    try {
                        const effectivePeriodType = periodType === 'future' ? 'daily' : periodType;
                        const effectiveDate = sourceDate || moment().format('YYYY-MM-DD');

                        const result = await this.migrateTask(
                            line,
                            activeFile.path,
                            effectiveDate,
                            effectivePeriodType as PeriodType
                        );

                        if (result.success && !result.skipped) {
                            migratedCount++;
                        } else if (result.success && result.skipped) {
                            console.log(`[BuJo] Task marked but not migrated: "${trimmedLine.substring(0, 50)}"`);
                        } else {
                            if (result.error && result.error.includes('Unknown migration marker')) {
                                console.log(`[BuJo] Skipping invalid marker: "${trimmedLine.substring(0, 50)}"`);
                            } else {
                                errors.push(`Migration failed: ${result.error}`);
                            }
                        }
                    } catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (errorMessage.includes('Unknown migration marker')) {
                            console.log(`[BuJo] Skipping invalid marker: "${trimmedLine.substring(0, 50)}"`);
                        } else {
                            errors.push(`Migration error: ${errorMessage}`);
                        }
                    }
                }
            }

            const periodLabel = periodName.charAt(0).toUpperCase() + periodName.slice(1);
            const message = `${periodLabel} note processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}${deletedCount > 0 ? `, ${deletedCount} deleted` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
            new Notice(message, 5000);

            if (errors.length > 0) {
                console.error('Processing errors:', errors);
                console.error('Error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error(`Process ${periodName} note error:`, error);
        }
    }

    /**
     * Schedule Tasks - Universal command that works from any note to schedule tasks
     */
    async scheduleTasks(): Promise<void> {
        try {
            const activeFile = this.app.workspace.getActiveFile();
            if (!activeFile) {
                new Notice('Please open a note with tasks to schedule');
                return;
            }

            const path = activeFile.path;

            // If we're in a weekly or monthly note, use the plan scheduler
            if (path.includes('002 Weekly Notes') || path.includes('Weekly Notes')) {
                return await this.schedulePlan('weekly');
            } else if (path.includes('003 Monthly Notes') || path.includes('Monthly Notes')) {
                return await this.schedulePlan('monthly');
            } else {
                // For any other note type (project notes, daily notes, etc.),
                // treat it like a weekly plan by default
                new Notice('Scheduling tasks from this note...');

                // Get the content
                const content = await this.app.vault.read(activeFile as TFile);
                const lines = content.split('\n');

                let scheduledCount = 0;
                const errors = [];

                // For now, we'll use the current week as the default scheduling target
                const currentWeekDate = moment().startOf('isoWeek').format('YYYY-MM-DD');

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (!line) continue;
                    const trimmedLine = line.trim();

                    if (!trimmedLine.startsWith('- [')) continue;

                    // Skip completed and deleted tasks
                    if (this.isCompletedTask(trimmedLine) || this.isDeletedTask(trimmedLine)) {
                        continue;
                    }

                    // Only process tasks with migration markers
                    if (!this.hasMigrationMarker(trimmedLine)) {
                        continue;
                    }

                    // Schedule the task using migrateTaskForPlan
                    const result = await this.migrateTaskForPlan(
                        line,
                        activeFile.path,
                        currentWeekDate,
                        'weekly'
                    );

                    if (result.success) {
                        scheduledCount++;
                    } else {
                        errors.push(result.error || 'Unknown error');
                    }
                }

                const message = `Tasks scheduled!\n✓ ${scheduledCount} tasks scheduled${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
                new Notice(message, 5000);

                if (errors.length > 0) {
                    console.error('Scheduling errors:', errors);
                }
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            new Notice(`Error: ${errorMessage}`);
            console.error('Schedule tasks error:', error);
        }
    }
}
