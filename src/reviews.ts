// Review documents: generating them from outstanding tasks, and processing the
// user's marked-up copy back into the journal.
//
// These are commands rather than engine internals — each one is a whole
// user-visible operation built on BulletJournalMigration's task primitives.
// They take the migration instance explicitly instead of living on it, which
// keeps the engine file down to marker parsing and task manipulation.

import { Notice, TFile, moment } from 'obsidian';
import type { BulletJournalMigration } from './bulletJournalMigration';
import { log } from './log';

/**
 * Generate Weekly Review
 */
export async function generateWeeklyReview(bujo: BulletJournalMigration, weekString: string | null = null): Promise<void> {
    try {
        new Notice('Generating weekly review...');

        let targetWeek;
        if (weekString) {
            targetWeek = moment(weekString, 'YYYY-[W]WW');
        } else {
            // Try to detect from active file
            const activeFile = bujo.app.workspace.getActiveFile();
            if (activeFile && activeFile instanceof TFile) {
                const weekMatch = activeFile.path.match(/(\d{4})-W(\d{2})\.md$/);
                if (weekMatch && weekMatch[1] && weekMatch[2]) {
                    const year = parseInt(weekMatch[1]);
                    const week = parseInt(weekMatch[2]);
                    targetWeek = moment().isoWeekYear(year).isoWeek(week);
                } else {
                    // Default to previous week
                    targetWeek = moment().subtract(1, 'week');
                }
            } else {
                // Default to previous week
                targetWeek = moment().subtract(1, 'week');
            }
        }
        const paths = bujo.paths;
        // GGGG, not YYYY — see BujoPaths.targetFilePath
        const weekStr = targetWeek.format('GGGG-[W]WW');

        const reviewPath = paths.reviewNote('Weekly', `${weekStr}-Review`);
        const monday = targetWeek.startOf('isoWeek');

        const tasksBySource: Record<string, string[]> = {};

        for (let i = 0; i < 7; i++) {
            const currentDay = monday.clone().add(i, 'days');
            const dateStr = currentDay.format('YYYY-MM-DD');
            const dailyPath = paths.dailyNote(dateStr);

            const incompleteTasks = await bujo.getIncompleteTasks(dailyPath);

            if (incompleteTasks.length > 0) {
                if (!tasksBySource[dailyPath]) {
                    tasksBySource[dailyPath] = [];
                }
                tasksBySource[dailyPath].push(...incompleteTasks);
            }
        }

        // Also check the weekly note itself for incomplete tasks
        const weeklyPath = paths.weeklyNoteByName(weekStr);
        const weeklyTasks = await bujo.getIncompleteTasks(weeklyPath);
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
        lines.push('- Run "Migrate tasks" on this note when done');

        const content = lines.join('\n');
        const existingFile = bujo.getFile(reviewPath);

        if (existingFile) {
            await bujo.app.vault.modify(existingFile, content);
        } else {
            const folderPath = paths.reviewFolder('Weekly');
            if (!bujo.app.vault.getAbstractFileByPath(folderPath)) {
                await bujo.app.vault.createFolder(folderPath);
            }
            await bujo.app.vault.create(reviewPath, content);
        }

        const file = bujo.getFile(reviewPath);
        if (file) await bujo.app.workspace.getLeaf().openFile(file);

        new Notice(`Weekly review created: ${reviewPath}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Weekly review error:', error);
    }
}

/**
 * Process Weekly Review
 */
export async function migrateWeeklyReview(bujo: BulletJournalMigration): Promise<void> {
    try {
        new Notice('Processing weekly review...');

        const activeFile = bujo.app.workspace.getActiveFile();
        const paths = bujo.paths;
        if (!activeFile || !paths.isReview(activeFile.path, 'Weekly')) {
            new Notice('Please open a weekly review note');
            return;
        }

        const reviewFile = activeFile;
        const reviewPath = activeFile.path;
        const content = await bujo.app.vault.read(reviewFile);
        const lines = content.split('\n');

        let migratedCount = 0;
        let newTaskCount = 0;
        let completedCount = 0;
        let deletedCount = 0;
        const errors = [];
        let blankCount = 0;
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
            
            // Parse headings for source path (## or ###)
            const headingPath = paths.tryParseHeadingPath(trimmedLine);
            if (headingPath) {
                currentSourcePath = headingPath;
                log.debug(`Set source path: ${currentSourcePath}`);
                continue;
            }
            
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

            // Check if this is a new task marker [+>
            const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
            const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

            // Try to extract source path from heading or use current
            const previousLines = lines.slice(Math.max(0, i - 10), i);
            const sourcePath = bujo.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
            const isNewTask = !sourcePath || isNewTaskMarker;

            // Handle new tasks (no source path or [+> marker)
            if (isNewTask) {
                if (bujo.hasMigrationMarker(trimmedLine)) {
                    // Try to get date from review file path
                    let reviewDate = null;
                    const weekMatch = reviewPath.match(/(\d{4})-W(\d{2})/);
                    if (weekMatch && weekMatch[1] && weekMatch[2]) {
                        reviewDate = moment().isoWeekYear(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek').format('YYYY-MM-DD');
                    } else {
                        const monthMatch = reviewPath.match(/(\d{4}-\d{2})/);
                        if (monthMatch && monthMatch[1]) {
                            reviewDate = `${monthMatch[1]}-01`;
                        }
                    }

                    // Use original line to preserve indentation for nested tasks
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

            // Handle existing tasks with source path
            if (bujo.isCompletedTask(trimmedLine)) {
                const result = await bujo.completeTask(trimmedLine, sourcePath);
                if (result.success) {
                    completedCount++;
                } else {
                    errors.push(`Complete failed: ${result.error}`);
                }
                continue;
            }

            if (bujo.isDeletedTask(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                log.debug(`Processing cancelled task: "${taskText}" from ${sourcePath}`);
                // Use original line to preserve indentation
                const result = await bujo.cancelTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                } else {
                    const errorMsg = `Task "${taskText}": Cancel failed - ${result.error}`;
                    errors.push(errorMsg);
                    log.error(`Cancel failed for task: "${taskText}"`, result.error);
                }
                continue;
            }

            // Handle delete marker [d] - remove task entirely from source file
            const deleteMarkerParsedWeekly = bujo.parseMigrationMarker(trimmedLine);
            if (deleteMarkerParsedWeekly && deleteMarkerParsedWeekly.marker === 'delete') {
                log.debug(`Processing [d] marker: "${bujo.getTaskText(trimmedLine)}" from source: ${sourcePath}`);
                if (!sourcePath) {
                    log.error(`No source path found for [d] task: "${bujo.getTaskText(trimmedLine)}"`);
                    errors.push(`Delete failed: No source path found for task "${bujo.getTaskText(trimmedLine)}"`);
                    continue;
                }
                const result = await bujo.deleteTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                    log.debug(`Successfully deleted task from ${sourcePath}: "${bujo.getTaskText(trimmedLine)}"`);
                } else {
                    log.error(`Failed to delete task from ${sourcePath}: ${result.error}`);
                    errors.push(`Delete failed: ${result.error}`);
                }
                continue;
            }

            if (bujo.hasMigrationMarker(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                const sourceDate = bujo.getDateFromFilePath(sourcePath);
                const periodType = bujo.detectPeriodType(sourcePath);

                log.debug(`Attempting to migrate task: "${taskText}" from ${sourcePath} (date: ${sourceDate}, period: ${periodType})`);

                if (!sourceDate) {
                    const errorMsg = `Task "${taskText}": Could not determine date from: ${sourcePath}`;
                    errors.push(errorMsg);
                    log.error(`${errorMsg}`);
                    continue;
                }

                // Collect children from SOURCE file (not review file) to preserve actual parent-child relationships
                const childTasks = await bujo.collectChildrenFromSource(sourcePath, taskText);
                
                // Mark child lines in review as processed (if they exist) so we don't process them separately
                // But we'll use the children from the source file for migration
                if (childTasks.length > 0) {
                    // Try to find matching children in review file and mark them as processed
                    const parentIndent = bujo.getIndentLevel(line);
                    const reviewChildren = bujo.collectChildTasks(lines, i, parentIndent);
                    reviewChildren.forEach(child => processedLines.add(child.index));
                }
                
                // Use original line to preserve indentation for nested tasks
                // Migrate parent with children from source file
                const result = await bujo.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                if (result.success && !result.skipped) {
                    migratedCount++;
                    if (childTasks.length > 0) {
                        log.debug(`Successfully migrated task with ${childTasks.length} children: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                    } else {
                        log.debug(`Successfully migrated task: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                    }
                } else if (result.success && result.skipped) {
                    // Task was marked but not migrated (e.g., [<] or [>skip])
                    log.debug(`Task marked but not migrated: "${taskText}"`);
                } else {
                    const errorMsg = `Task "${taskText}": Migration failed - ${result.error}`;
                    errors.push(errorMsg);
                    log.error(`Migration failed for task: "${taskText}" from ${sourcePath}`, result.error);
                }
            }
        }

        // Only discard the review once everything in it landed. If any task
        // failed, the review is the user's only record of what is outstanding.
        if (errors.length === 0) {
            await bujo.trashFile(reviewFile);
        } else {
            log.warn(`Keeping ${reviewPath}: ${errors.length} task(s) could not be migrated`);
        }

        const message = `Review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${blankCount > 0 ? `\n• ${blankCount} blank marker line(s) skipped` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors — review kept for retry` : ''}`;
        new Notice(message, 5000);

        if (errors.length > 0) {
            log.error('Processing errors:', errors);
            log.error('Full error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Process review error:', error);
    }
}

/**
 * Generate Monthly Review
 */
export async function generateMonthlyReview(bujo: BulletJournalMigration, monthString: string | null = null): Promise<void> {
    try {
        new Notice('Generating monthly review...');

        let targetMonth;
        if (monthString) {
            targetMonth = moment(monthString, 'YYYY-MM');
        } else {
            // Try to detect from active file
            const activeFile = bujo.app.workspace.getActiveFile();
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
        const paths = bujo.paths;
        const yearMonth = targetMonth.format('YYYY-MM');
        const reviewPath = paths.reviewNote('Monthly', `${yearMonth}-Review`);

        const firstDay = targetMonth.startOf('month');
        const lastDay = targetMonth.clone().endOf('month');

        const tasksBySource: Record<string, string[]> = {};

        let currentDay = firstDay.clone();
        while (currentDay.isSameOrBefore(lastDay, 'day')) {
            const dateStr = currentDay.format('YYYY-MM-DD');
            const dailyPath = paths.dailyNote(dateStr);

            const incompleteTasks = await bujo.getIncompleteTasks(dailyPath);

            if (incompleteTasks.length > 0) {
                if (!tasksBySource[dailyPath]) {
                    tasksBySource[dailyPath] = [];
                }
                tasksBySource[dailyPath].push(...incompleteTasks);
            }

            currentDay.add(1, 'day');
        }

        // Walk actual week starts rather than week numbers: in January and
        // December the month spans two ISO week-years, where the first
        // week number is larger than the last and a numeric loop collapses.
        const weekCursor = firstDay.clone().startOf('isoWeek');
        const lastWeekStart = lastDay.clone().startOf('isoWeek');
        while (weekCursor.isSameOrBefore(lastWeekStart, 'day')) {
            const weeklyPath = paths.weeklyNoteByName(weekCursor.format('GGGG-[W]WW'));
            const incompleteTasks = await bujo.getIncompleteTasks(weeklyPath);

            if (incompleteTasks.length > 0) {
                if (!tasksBySource[weeklyPath]) {
                    tasksBySource[weeklyPath] = [];
                }
                tasksBySource[weeklyPath].push(...incompleteTasks);
            }
            weekCursor.add(1, 'week');
        }

        // Also check the monthly note itself for incomplete tasks
        const monthlyPath = paths.monthlyNote(yearMonth);
        const monthlyTasks = await bujo.getIncompleteTasks(monthlyPath);
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
        lines.push('- Run "Migrate tasks" on this note when done');

        const content = lines.join('\n');
        const existingFile = bujo.getFile(reviewPath);

        if (existingFile) {
            await bujo.app.vault.modify(existingFile, content);
        } else {
            const folderPath = paths.reviewFolder('Monthly');
            if (!bujo.app.vault.getAbstractFileByPath(folderPath)) {
                await bujo.app.vault.createFolder(folderPath);
            }
            await bujo.app.vault.create(reviewPath, content);
        }

        const file = bujo.getFile(reviewPath);
        if (file) await bujo.app.workspace.getLeaf().openFile(file);

        new Notice(`Monthly review created: ${reviewPath}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Monthly review error:', error);
    }
}

/**
 * Process Monthly Review
 */
export async function migrateMonthlyReview(bujo: BulletJournalMigration): Promise<void> {
    try {
        new Notice('Processing monthly review...');

        const activeFile = bujo.app.workspace.getActiveFile();
        const paths = bujo.paths;
        if (!activeFile || !paths.isReview(activeFile.path, 'Monthly')) {
            new Notice('Please open a monthly review note');
            return;
        }

        const reviewFile = activeFile;
        const reviewPath = activeFile.path;
        const content = await bujo.app.vault.read(reviewFile);
        const lines = content.split('\n');

        let migratedCount = 0;
        let newTaskCount = 0;
        let completedCount = 0;
        let deletedCount = 0;
        const errors = [];
        let blankCount = 0;
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

            const headingPath = paths.tryParseHeadingPath(trimmedLine);
            if (headingPath) {
                currentSourcePath = headingPath;
                log.debug(`Set source path: ${currentSourcePath}`);
                continue;
            }


            // Check for ## heading (section headers) - skip these
            if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                continue;
            }

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

            // Check if this is a new task marker [+>
            const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
            const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

            // Try to extract source path from heading or use current
            const previousLines = lines.slice(Math.max(0, i - 10), i);
            const sourcePath = bujo.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
            const isNewTask = !sourcePath || isNewTaskMarker;

            // Handle new tasks (no source path or [+> marker)
            if (isNewTask) {
                if (bujo.hasMigrationMarker(trimmedLine)) {
                    // Try to get date from review file path
                    let reviewDate = null;
                    const monthMatch = reviewPath.match(/(\d{4}-\d{2})/);
                    if (monthMatch) {
                        reviewDate = `${monthMatch[1]}-01`;
                    }

                    // Use original line to preserve indentation for nested tasks
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

            // Handle existing tasks with source path
            if (bujo.isCompletedTask(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                log.debug(`Processing completed task: "${taskText}" from ${sourcePath}`);
                // Use original line to preserve indentation
                const result = await bujo.completeTask(line, sourcePath);
                if (result.success) {
                    completedCount++;
                } else {
                    const errorMsg = `Task "${taskText}": Complete failed - ${result.error}`;
                    errors.push(errorMsg);
                    log.error(`Complete failed for task: "${taskText}"`, result.error);
                }
                continue;
            }

            if (bujo.isDeletedTask(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                log.debug(`Processing cancelled task: "${taskText}" from ${sourcePath}`);
                // Use original line to preserve indentation
                const result = await bujo.cancelTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                } else {
                    const errorMsg = `Task "${taskText}": Cancel failed - ${result.error}`;
                    errors.push(errorMsg);
                    log.error(`Cancel failed for task: "${taskText}"`, result.error);
                }
                continue;
            }

            // Handle delete marker [d] - remove task entirely from source file
            const deleteMarkerParsedMonthly = bujo.parseMigrationMarker(trimmedLine);
            if (deleteMarkerParsedMonthly && deleteMarkerParsedMonthly.marker === 'delete') {
                const result = await bujo.deleteTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                    log.debug(`Deleted task from ${sourcePath}: "${bujo.getTaskText(trimmedLine)}"`);
                } else {
                    errors.push(`Delete failed: ${result.error}`);
                }
                continue;
            }

            if (bujo.hasMigrationMarker(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                const sourceDate = bujo.getDateFromFilePath(sourcePath);
                const periodType = bujo.detectPeriodType(sourcePath);

                log.debug(`Attempting to migrate task: "${taskText}" from ${sourcePath} (date: ${sourceDate}, period: ${periodType})`);

                if (!sourceDate) {
                    const errorMsg = `Task "${taskText}": Could not determine date from: ${sourcePath}`;
                    errors.push(errorMsg);
                    log.error(`${errorMsg}`);
                    continue;
                }

                // Collect children from SOURCE file (not review file) to preserve actual parent-child relationships
                const childTasks = await bujo.collectChildrenFromSource(sourcePath, taskText);
                
                // Mark child lines in review as processed (if they exist) so we don't process them separately
                // But we'll use the children from the source file for migration
                if (childTasks.length > 0) {
                    // Try to find matching children in review file and mark them as processed
                    const parentIndent = bujo.getIndentLevel(line);
                    const reviewChildren = bujo.collectChildTasks(lines, i, parentIndent);
                    reviewChildren.forEach(child => processedLines.add(child.index));
                }
                
                // Use original line to preserve indentation for nested tasks
                // Migrate parent with children from source file
                const result = await bujo.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                if (result.success && !result.skipped) {
                    migratedCount++;
                    if (childTasks.length > 0) {
                        log.debug(`Successfully migrated task with ${childTasks.length} children: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                    } else {
                        log.debug(`Successfully migrated task: "${taskText}" to ${result.destFile || 'marked as migrated'}`);
                    }
                } else if (result.success && result.skipped) {
                    // Task was marked but not migrated (e.g., [<] or [>skip])
                    log.debug(`Task marked but not migrated: "${taskText}"`);
                } else {
                    const errorMsg = `Task "${taskText}": Migration failed - ${result.error}`;
                    errors.push(errorMsg);
                    log.error(`Migration failed for task: "${taskText}" from ${sourcePath}`, result.error);
                }
            }
        }

        // Only discard the review once everything in it landed. If any task
        // failed, the review is the user's only record of what is outstanding.
        if (errors.length === 0) {
            await bujo.trashFile(reviewFile);
        } else {
            log.warn(`Keeping ${reviewPath}: ${errors.length} task(s) could not be migrated`);
        }

        const message = `Review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${blankCount > 0 ? `\n• ${blankCount} blank marker line(s) skipped` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors — review kept for retry` : ''}`;
        new Notice(message, 5000);

        if (errors.length > 0) {
            log.error('Processing errors:', errors);
            log.error('Full error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Process monthly review error:', error);
    }
}

/**
 * Generate Global Review - All incomplete tasks from ALL journal notes
 */
export async function generateGlobalReview(bujo: BulletJournalMigration): Promise<void> {
    try {
        new Notice('Generating global review...');

        const paths = bujo.paths;
        const reviewPath = paths.reviewNote('Global', `Global-Review-${moment().format('YYYY-MM-DD-HHmm')}`);

        // Get all files in Journal folder
        const allFiles = bujo.app.vault.getFiles();
        const today = moment().startOf('day');

        const journalFiles = allFiles.filter(file => {
            const kind = paths.classify(file.path);
            if (kind === 'daily') {
                // Check if daily note date is before today
                const dateMatch = file.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
                if (dateMatch) {
                    const fileDate = moment(dateMatch[1], 'YYYY-MM-DD');
                    return fileDate.isBefore(today);
                }
                return false;
            } else if (kind === 'weekly') {
                // Check if weekly note is before current week
                const weekMatch = file.path.match(/(\d{4})-W(\d{2})\.md$/);
                if (weekMatch && weekMatch[1] && weekMatch[2]) {
                    const fileWeek = moment().isoWeekYear(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek');
                    const currentWeek = moment().startOf('isoWeek');
                    return fileWeek.isBefore(currentWeek);
                }
                return false;
            } else if (kind === 'monthly') {
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

        const sectionNames: Record<string, string> = {
            daily: 'Daily Notes',
            weekly: 'Weekly Notes',
            monthly: 'Monthly Notes',
        };
        const allTasks: { section: string; filename: string; path: string; tasks: string[] }[] = [];

        for (const file of journalFiles) {
            const incompleteTasks = await bujo.getIncompleteTasks(file.path);

            if (incompleteTasks.length > 0) {
                const kind = paths.classify(file.path);
                const section = (kind && sectionNames[kind]) || '';

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
        lines.push('- Run "Migrate tasks" on this note when done');

        const content = lines.join('\n');

        // Ensure directory exists
        const folderPath = paths.reviewFolder('Global');
        if (!bujo.app.vault.getAbstractFileByPath(folderPath)) {
            await bujo.app.vault.createFolder(folderPath);
        }

        await bujo.app.vault.create(reviewPath, content);

        const file = bujo.getFile(reviewPath);
        if (file) await bujo.app.workspace.getLeaf().openFile(file);

        new Notice(`Global review created: ${reviewPath}`);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Global review error:', error);
    }
}

/**
 * Process Global Review
 */
export async function migrateGlobalReview(bujo: BulletJournalMigration): Promise<void> {
    try {
        new Notice('Processing global review...');

        const activeFile = bujo.app.workspace.getActiveFile();
        const paths = bujo.paths;
        if (!activeFile || !paths.isReview(activeFile.path, 'Global')) {
            new Notice('Please open a global review note');
            return;
        }

        const reviewFile = activeFile;
        const reviewPath = activeFile.path;
        const content = await bujo.app.vault.read(reviewFile);
        const lines = content.split('\n');

        let migratedCount = 0;
        let completedCount = 0;
        let deletedCount = 0;
        let newTaskCount = 0;
        const errors = [];
        let blankCount = 0;
        let currentSourcePath = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line) continue;
            const trimmedLine = line.trim();

            const headingPath = paths.tryParseHeadingPath(trimmedLine);
            if (headingPath) {
                currentSourcePath = headingPath;
                log.debug(`Set source path: ${currentSourcePath}`);
                continue;
            }


            // Check for ## heading (section headers like "Daily Notes", "Weekly Notes")
            if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
                // Section headers don't set source path, individual ### headings do
                continue;
            }
            
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

            // Check if this is a new task marker [+>
            const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
            const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

            // Try to extract source path from heading or use current
            const previousLines = lines.slice(Math.max(0, i - 10), i);
            const sourcePath = bujo.extractSourcePath(trimmedLine, previousLines) || currentSourcePath;
            const isNewTask = !sourcePath || isNewTaskMarker;

            // Handle new tasks (no source path or [+> marker)
            if (isNewTask) {
                if (bujo.hasMigrationMarker(trimmedLine)) {
                    // For global reviews, use current date as reference
                    const reviewDate = moment().format('YYYY-MM-DD');
                    // Use original line to preserve indentation for nested tasks
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

            // Handle existing tasks with source path
            if (bujo.isCompletedTask(trimmedLine)) {
                // Use original line to preserve indentation
                const result = await bujo.completeTask(line, sourcePath);
                if (result.success) {
                    completedCount++;
                } else {
                    errors.push(`Complete failed: ${result.error}`);
                }
                continue;
            }

            if (bujo.isDeletedTask(trimmedLine)) {
                // Use original line to preserve indentation
                const result = await bujo.cancelTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                } else {
                    errors.push(`Cancel failed: ${result.error}`);
                }
                continue;
            }

            // Handle delete marker [d] - remove task entirely from source file
            const deleteMarkerParsed = bujo.parseMigrationMarker(trimmedLine);
            if (deleteMarkerParsed && deleteMarkerParsed.marker === 'delete') {
                log.debug(`Processing [d] marker: "${bujo.getTaskText(trimmedLine)}" from source: ${sourcePath}`);
                if (!sourcePath) {
                    log.error(`No source path found for [d] task: "${bujo.getTaskText(trimmedLine)}"`);
                    errors.push(`Delete failed: No source path found for task "${bujo.getTaskText(trimmedLine)}"`);
                    continue;
                }
                const result = await bujo.deleteTask(line, sourcePath);
                if (result.success) {
                    deletedCount++;
                    log.debug(`Successfully deleted task from ${sourcePath}: "${bujo.getTaskText(trimmedLine)}"`);
                } else {
                    log.error(`Failed to delete task from ${sourcePath}: ${result.error}`);
                    errors.push(`Delete failed: ${result.error}`);
                }
                continue;
            }

            if (bujo.hasMigrationMarker(trimmedLine)) {
                const sourceDate = bujo.getDateFromFilePath(sourcePath);
                const periodType = bujo.detectPeriodType(sourcePath);

                if (!sourceDate) {
                    errors.push(`Could not determine date from: ${sourcePath}`);
                    continue;
                }

                // Collect children from SOURCE file to preserve actual parent-child relationships
                const taskText = bujo.getTaskText(trimmedLine);
                const childTasks = await bujo.collectChildrenFromSource(sourcePath, taskText);

                // Use original line to preserve indentation for nested tasks
                const result = await bujo.migrateTask(line, sourcePath, sourceDate, periodType, childTasks);
                if (result.success && !result.skipped) {
                    migratedCount++;
                    if (childTasks.length > 0) {
                        log.debug(`Successfully migrated task with ${childTasks.length} children: "${taskText}"`);
                    }
                } else if (result.success && result.skipped) {
                    // Task was marked but not migrated (e.g., [<] or [>skip])
                    log.debug(`Task marked but not migrated: "${taskText}"`);
                } else {
                    errors.push(`Migration failed: ${result.error}`);
                }
            }
        }

        // Only discard the review once everything in it landed. If any task
        // failed, the review is the user's only record of what is outstanding.
        if (errors.length === 0) {
            await bujo.trashFile(reviewFile);
        } else {
            log.warn(`Keeping ${reviewPath}: ${errors.length} task(s) could not be migrated`);
        }

        const message = `Global review processed!\n✓ ${migratedCount} tasks migrated${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}\n✓ ${completedCount} tasks completed\n✓ ${deletedCount} tasks deleted${blankCount > 0 ? `\n• ${blankCount} blank marker line(s) skipped` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors — review kept for retry` : ''}`;
        new Notice(message, 5000);

        if (errors.length > 0) log.error('Processing errors:', errors);
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Process global review error:', error);
    }
}
