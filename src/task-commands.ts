// Task commands: migrating and scheduling from the note or selection the user
// currently has open, plus the dispatch that picks the right one.
//
// See reviews.ts for the same arrangement applied to review documents.

import { Notice, Editor, moment } from 'obsidian';
import type { BulletJournalMigration } from './bulletJournalMigration';
import type { PeriodType } from './types';
import { log } from './log';

/**
 * Process Weekly Plan - Process tasks directly in weekly note (marks as [s] instead of [>])
 */
/**
 * Schedule Plan - Process tasks in weekly/monthly notes (marks as [s] instead of [>])
 * Unified method that handles both weekly and monthly planning
 */
export async function schedulePlan(bujo: BulletJournalMigration, periodType: PeriodType): Promise<void> {
    const periodNames: Record<string, string> = {
        weekly: 'weekly',
        monthly: 'monthly'
    };
    const periodName = periodNames[periodType] || periodType;

    try {
        new Notice(`Processing ${periodName} plan...`);

        const activeFile = bujo.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice(`Please open a ${periodName} note`);
            return;
        }

        const filePath = activeFile.path;
        const content = await bujo.app.vault.read(activeFile);
        const lines = content.split('\n');

        let scheduledCount = 0;
        let newTaskCount = 0;
        const errors: string[] = [];

        // Extract date from file path based on period type
        let sourceDate: string | null = null;
        if (periodType === 'weekly') {
            const weekMatch = filePath.match(/(\d{4})-W(\d{2})/);
            if (weekMatch && weekMatch[1] && weekMatch[2]) {
                sourceDate = moment().isoWeekYear(parseInt(weekMatch[1], 10)).isoWeek(parseInt(weekMatch[2], 10)).startOf('isoWeek').format('YYYY-MM-DD');
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
            if (bujo.isCompletedTask(trimmedLine) || bujo.isDeletedTask(trimmedLine)) {
                continue;
            }

            // Check if this is a new task marker [+>
            const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
            const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;

            // Handle new tasks
            if (isNewTaskMarker) {
                if (bujo.hasMigrationMarker(trimmedLine)) {
                    const result = await bujo.createNewTask(line, sourceDate);
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
            if (bujo.hasMigrationMarker(trimmedLine)) {
                const taskText = bujo.getTaskText(trimmedLine);
                log.debug(`Scheduling task: "${taskText}" from ${filePath}`);

                const result = await bujo.migrateTaskForPlan(line, filePath, sourceDate, periodType);
                if (result.success) {
                    scheduledCount++;
                    log.debug(`Successfully scheduled task: "${taskText}" to ${result.destFile || 'marked as scheduled'}`);
                } else {
                    errors.push(`Task "${taskText}": ${result.error}`);
                    log.error(`Scheduling failed: "${taskText}"`, result.error);
                }
            }
        }

        const periodLabel = periodName.charAt(0).toUpperCase() + periodName.slice(1);
        const message = `${periodLabel} plan processed!\n✓ ${scheduledCount} tasks scheduled${newTaskCount > 0 ? ` (${newTaskCount} new)` : ''}${errors.length > 0 ? `\n⚠ ${errors.length} errors` : ''}`;
        new Notice(message, 5000);

        if (errors.length > 0) {
            log.error('Scheduling errors:', errors);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error(`Schedule ${periodName} plan error:`, error);
    }
}

/**
 * Process Selected Tasks
 * Processes only the selected text in the current note
 * Updates the note as tasks are processed
 * Continues even if individual tasks fail
 */
export async function migrateSelectedTasks(bujo: BulletJournalMigration, editor: Editor): Promise<void> {
    try {
        new Notice('Processing selected tasks...');

        const activeFile = bujo.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('No active file');
            return;
        }

        const paths = bujo.paths;
        const selection = editor.getSelection();
        if (!selection || selection.trim() === '') {
            new Notice('Please select tasks to process');
            return;
        }

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

            // Parse headings for source path (## or ###)
            const headingPath = paths.tryParseHeadingPath(trimmedLine);
            if (headingPath) {
                currentSourcePath = headingPath;
                log.debug(`Set source path: ${currentSourcePath}`);
                linesToKeep.push(line); // Keep headings
                continue;
            }

            if (!bujo.isBulletItem(trimmedLine)) {
                linesToKeep.push(line); // Keep non-task lines
                continue;
            }

            // Check if this is a new task marker
            const parsedMarker = bujo.parseMigrationMarker(trimmedLine);
            const isNewTaskMarker = parsedMarker && parsedMarker.isNewTask;
            const isNewTask = !currentSourcePath || isNewTaskMarker;

            // Handle new tasks
            if (isNewTask) {
                if (bujo.hasMigrationMarker(trimmedLine)) {
                    const reviewDate = moment().format('YYYY-MM-DD');
                    const result = await bujo.createNewTask(line, reviewDate);
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
            if (bujo.isCompletedTask(trimmedLine)) {
                if (!currentSourcePath) {
                    errors.push(`Complete failed: No source path for "${bujo.getTaskText(trimmedLine)}"`);
                    linesToKeep.push(line);
                    continue;
                }
                const result = await bujo.completeTask(line, currentSourcePath);
                if (result.success) {
                    completedCount++;
                    // Don't add to linesToKeep - remove from review
                } else {
                    errors.push(`Complete failed: ${result.error}`);
                    linesToKeep.push(line); // Keep failed tasks
                }
                continue;
            }

            if (bujo.isDeletedTask(trimmedLine)) {
                if (!currentSourcePath) {
                    errors.push(`Cancel failed: No source path for "${bujo.getTaskText(trimmedLine)}"`);
                    linesToKeep.push(line);
                    continue;
                }
                const result = await bujo.cancelTask(line, currentSourcePath);
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
            const deleteMarkerParsed = bujo.parseMigrationMarker(trimmedLine);
            if (deleteMarkerParsed && deleteMarkerParsed.marker === 'delete') {
                log.debug(`Processing [d] marker: "${bujo.getTaskText(trimmedLine)}" from source: ${currentSourcePath}`);
                if (!currentSourcePath) {
                    log.error(`No source path found for [d] task: "${bujo.getTaskText(trimmedLine)}"`);
                    errors.push(`Delete failed: No source path for "${bujo.getTaskText(trimmedLine)}"`);
                    linesToKeep.push(line);
                    continue;
                }
                const result = await bujo.deleteTask(line, currentSourcePath);
                if (result.success) {
                    deletedCount++;
                    log.debug(`Successfully deleted task from ${currentSourcePath}`);
                    // Don't add to linesToKeep - remove from review
                } else {
                    log.error(`Failed to delete task: ${result.error}`);
                    errors.push(`Delete failed: ${result.error}`);
                    linesToKeep.push(line); // Keep failed tasks
                }
                continue;
            }

            // Handle migration markers
            if (bujo.hasMigrationMarker(trimmedLine)) {
                if (!currentSourcePath) {
                    errors.push(`Migration failed: No source path for "${bujo.getTaskText(trimmedLine)}"`);
                    linesToKeep.push(line);
                    continue;
                }

                const sourceDate = bujo.getDateFromFilePath(currentSourcePath);
                const periodType = bujo.detectPeriodType(currentSourcePath);

                if (!sourceDate) {
                    errors.push(`Could not determine date from: ${currentSourcePath}`);
                    linesToKeep.push(line);
                    continue;
                }

                const result = await bujo.migrateTask(line, currentSourcePath, sourceDate, periodType);
                if (result.success && !result.skipped) {
                    migratedCount++;
                    // Don't add to linesToKeep - remove from review
                } else if (result.success && result.skipped) {
                    log.debug(`Task marked but not migrated: "${bujo.getTaskText(trimmedLine)}"`);
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
            log.error('Processing errors:', errors);
            log.error('Error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Process selected tasks error:', error);
    }
}

/**
 * Schedule Selected Tasks - Schedule only the selected tasks to their destination dates
 * Used for planning workflows - marks tasks as scheduled [<]
 */
export async function scheduleSelectedTasks(bujo: BulletJournalMigration, editor: Editor): Promise<void> {
    try {
        new Notice('Scheduling selected tasks...');

        const activeFile = bujo.app.workspace.getActiveFile();
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
            if (bujo.isCompletedTask(trimmedLine) || bujo.isDeletedTask(trimmedLine)) {
                updatedLines.push(line);
                continue;
            }

            // Skip tasks already marked as scheduled or migrated
            if (trimmedLine.includes('[s]') || trimmedLine.includes('[<]') || /\[>\]/.test(trimmedLine)) {
                updatedLines.push(line);
                continue;
            }

            // Only process tasks with migration markers
            if (!bujo.hasMigrationMarker(trimmedLine)) {
                updatedLines.push(line);
                continue;
            }

            // Schedule the task
            const result = await bujo.migrateTaskForPlan(
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
            log.error('Scheduling errors:', errors);
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Schedule selected tasks error:', error);
    }
}

/**
 * Migrate Tasks - Smart command that detects note type and migrates tasks accordingly
 * Used for all journal notes (daily/weekly/monthly/yearly/future) and review documents
 */
export async function migrateTasks(bujo: BulletJournalMigration): Promise<void> {
    try {
        const activeFile = bujo.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note to process');
            return;
        }

        const path = activeFile.path;

        // Detect note type and call appropriate method
        // Reviews first (more specific paths)
        const paths = bujo.paths;
        if (paths.isReview(path, 'Weekly')) {
            return await bujo.migrateWeeklyReview();
        } else if (paths.isReview(path, 'Monthly')) {
            return await bujo.migrateMonthlyReview();
        } else if (paths.isReview(path, 'Global')) {
            return await bujo.migrateGlobalReview();
        }
        // Journal notes
        const kind = paths.classify(path);
        if (kind) {
            return await bujo.migrateJournalNote(kind);
        }
        new Notice('Cannot migrate from this note type. Please open a journal note or review document.');
        return;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Migrate tasks error:', error);
    }
}

/**
 * Process any journal note type for migration (daily, weekly, monthly, yearly, future)
 */
export async function migrateJournalNote(bujo: BulletJournalMigration, periodType: PeriodType | 'future'): Promise<void> {
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

        const activeFile = bujo.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice(`Please open a ${periodName} note`);
            return;
        }

        const sourceDate = bujo.getDateFromFilePath(activeFile.path);
        if (!sourceDate && periodType !== 'future') {
            new Notice('Could not determine date from filename');
            return;
        }

        const content = await bujo.app.vault.read(activeFile);
        const lines = content.split('\n');

        let migratedCount = 0;
        let newTaskCount = 0;
        let deletedCount = 0;
        const errors: string[] = [];

        for (const line of lines) {
            const trimmedLine = line.trim();
            if (!bujo.isBulletItem(trimmedLine)) continue;

            // Skip completed and cancelled tasks
            if (bujo.isCompletedTask(trimmedLine) || bujo.isDeletedTask(trimmedLine)) {
                continue;
            }
            
            // Skip already processed new tasks [+]
            if (/^-\s*\[\+\]/.test(trimmedLine)) {
                log.debug(`Skipping already-created new task: "${trimmedLine.substring(0, 50)}"`);
                continue;
            }

            // Handle delete marker [d]
            const parsed = bujo.parseMigrationMarker(trimmedLine);
            if (parsed && parsed.marker === 'delete') {
                try {
                    const result = await bujo.deleteTask(line, activeFile.path);
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
            if (isNewTaskMarker && bujo.hasMigrationMarker(trimmedLine)) {
                const effectiveDate = sourceDate || moment().format('YYYY-MM-DD');
                log.debug(`Creating new task: "${bujo.getTaskText(trimmedLine)}"`);
                const result = await bujo.createNewTask(line, effectiveDate);
                if (result.success) {
                    newTaskCount++;
                    migratedCount++;
                    log.debug(`Successfully created new task in ${result.destFile}`);
                    
                    // Mark as created with [+] (similar to how migrations mark as [>])
                    try {
                        const taskText = bujo.getTaskText(line);
                        const indent = line.match(/^(\s*)/)?.[0] || '';
                        const updatedLine = `${indent}- [+] ${taskText}`;
                        await bujo.updateTaskInFile(activeFile.path, line, updatedLine);
                        log.debug(`Marked new task as created [+] in source file`);
                    } catch (updateError) {
                        log.error(`Failed to mark new task as created:`, updateError);
                        // Don't fail the whole operation if we can't mark it
                    }
                } else {
                    errors.push(`New task creation failed: ${result.error}`);
                    log.error(`Failed to create new task: ${result.error}`);
                }
                continue;
            }

            // Handle migration markers
            if (bujo.hasMigrationMarker(trimmedLine)) {
                try {
                    const effectivePeriodType = periodType === 'future' ? 'daily' : periodType;
                    const effectiveDate = sourceDate || moment().format('YYYY-MM-DD');

                    const result = await bujo.migrateTask(
                        line,
                        activeFile.path,
                        effectiveDate,
                        effectivePeriodType
                    );

                    if (result.success && !result.skipped) {
                        migratedCount++;
                    } else if (result.success && result.skipped) {
                        log.debug(`Task marked but not migrated: "${trimmedLine.substring(0, 50)}"`);
                    } else {
                        if (result.error && result.error.includes('Unknown migration marker')) {
                            log.debug(`Skipping invalid marker: "${trimmedLine.substring(0, 50)}"`);
                        } else {
                            errors.push(`Migration failed: ${result.error}`);
                        }
                    }
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    if (errorMessage.includes('Unknown migration marker')) {
                        log.debug(`Skipping invalid marker: "${trimmedLine.substring(0, 50)}"`);
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
            log.error('Processing errors:', errors);
            log.error('Error details:', errors.map((e, i) => `${i + 1}. ${e}`).join('\n'));
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error(`Process ${periodName} note error:`, error);
    }
}

/**
 * Schedule Tasks - Universal command that works from any note to schedule tasks
 */
export async function scheduleTasks(bujo: BulletJournalMigration): Promise<void> {
    try {
        const activeFile = bujo.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Please open a note with tasks to schedule');
            return;
        }

        const path = activeFile.path;

        // If we're in a weekly or monthly note, use the plan scheduler
        if (path.includes('002 Weekly Notes') || path.includes('Weekly Notes')) {
            return await bujo.schedulePlan('weekly');
        } else if (path.includes('003 Monthly Notes') || path.includes('Monthly Notes')) {
            return await bujo.schedulePlan('monthly');
        } else {
            // For any other note type (project notes, daily notes, etc.),
            // treat it like a weekly plan by default
            new Notice('Scheduling tasks from this note...');

            // Get the content
            const content = await bujo.app.vault.read(activeFile);
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
                if (bujo.isCompletedTask(trimmedLine) || bujo.isDeletedTask(trimmedLine)) {
                    continue;
                }

                // Only process tasks with migration markers
                if (!bujo.hasMigrationMarker(trimmedLine)) {
                    continue;
                }

                // Schedule the task using migrateTaskForPlan
                const result = await bujo.migrateTaskForPlan(
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
                log.error('Scheduling errors:', errors);
            }
        }
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        new Notice(`Error: ${errorMessage}`);
        log.error('Schedule tasks error:', error);
    }
}
