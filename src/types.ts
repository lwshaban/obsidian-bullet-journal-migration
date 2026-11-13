// Type definitions for Bullet Journal Migration plugin

export interface MigrationMarker {
	marker: string;
	type: TaskType;           // Destination checkbox via {...} e.g., {=}
	sourceType?: TaskType;    // Source checkbox via (...) e.g., (/)
	descriptor?: string | null;
	originalMarker: string;
	isInfoPoint?: boolean;
	isNewTask?: boolean;
}

export interface MigrationResult {
	success: boolean;
	error?: string;
	destinationPath?: string;
	sourceFile?: string | null;
	destFile?: string | null;
	skipped?: boolean;
	childrenMarked?: number;
	isNewTask?: boolean;
	/**
	 * The destination already held a live copy, so nothing new was written.
	 * The migration is satisfied — the task is there — but the two items have
	 * been merged into one, which is worth telling the user about.
	 */
	deduped?: boolean;
}

/**
 * Which entries a review should list. Every bullet in a journal note falls into
 * exactly one of these groups, so a review is described by the groups it asks
 * for.
 */
export interface TaskInclusion {
	/**
	 * Everything still outstanding — not just `[ ]` and `[s]` but events `[o]`,
	 * appointments `[a]`, any other checkbox state, plain information bullets,
	 * and anything already carrying a migration marker. A bullet journal page
	 * is not only tasks, and a review that hides half of it isn't a review.
	 */
	outstanding: boolean;
	/** `[>]`, `[<]`, `[+]` — already filed. The recovery view. */
	migrated: boolean;
	/** `[x]` — for a retrospective rather than a triage list. */
	completed: boolean;
	/** `[-]` */
	cancelled: boolean;
}

export const OUTSTANDING_ONLY: TaskInclusion = {
	outstanding: true,
	migrated: false,
	completed: false,
	cancelled: false,
};

export type TaskType = string | null;
export type PeriodType = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'global';

export interface ChildTask {
	line: string;
	indent: number;
}

export interface DestinationDate {
	date: string | null;
	targetType: PeriodType | 'future';
	monthName?: string;
}

