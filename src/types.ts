// Type definitions for Bullet Journal Migration plugin

export interface MigrationMarker {
	marker: string;
	type: TaskType;
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
}

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

