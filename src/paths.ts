// Vault path resolution.
//
// Every journal path the plugin reads or writes comes from here, derived from
// user settings. Folder names used to be hardcoded ("Journal/001 Daily Notes"),
// which made the settings tab decorative; nothing else in the codebase should
// build a journal path by hand.

import { moment } from 'obsidian';
import { BujoPluginSettings } from './settings';
import { PeriodType } from './types';

export type NoteKind = 'daily' | 'weekly' | 'monthly' | 'yearly' | 'future';
export type ReviewKind = 'Weekly' | 'Monthly' | 'Global';

/** Trailing slashes make `startsWith` checks and joins inconsistent. */
function normalizeFolder(folder: string): string {
	return folder.trim().replace(/^\/+|\/+$/g, '');
}

function join(folder: string, name: string): string {
	const base = normalizeFolder(folder);
	return base ? `${base}/${name}` : name;
}

export class BujoPaths {
	constructor(private settings: BujoPluginSettings) {}

	// ── Folders ───────────────────────────────────────────────────────────────

	get daily(): string { return normalizeFolder(this.settings.dailyNotesPath); }
	get weekly(): string { return normalizeFolder(this.settings.weeklyNotesPath); }
	get monthly(): string { return normalizeFolder(this.settings.monthlyNotesPath); }
	get yearly(): string { return normalizeFolder(this.settings.yearlyNotesPath); }
	get future(): string { return normalizeFolder(this.settings.futureLogPath); }
	get templates(): string { return normalizeFolder(this.settings.templatesPath); }
	get reviews(): string { return normalizeFolder(this.settings.reviewsPath); }

	folderFor(kind: NoteKind): string {
		switch (kind) {
			case 'daily': return this.daily;
			case 'weekly': return this.weekly;
			case 'monthly': return this.monthly;
			case 'yearly': return this.yearly;
			case 'future': return this.future;
		}
	}

	// ── Note paths ────────────────────────────────────────────────────────────

	dailyNote(date: string): string {
		return join(this.daily, `${date}.md`);
	}

	/** `week` is an ISO week number; the file is named `YYYY-Www`. */
	weeklyNote(year: number, week: number): string {
		return join(this.weekly, `${year}-W${String(week).padStart(2, '0')}.md`);
	}

	/** For callers that already hold a `YYYY-Www` string. */
	weeklyNoteByName(weekStr: string): string {
		return join(this.weekly, `${weekStr}.md`);
	}

	monthlyNote(yearMonth: string): string {
		return join(this.monthly, `${yearMonth}.md`);
	}

	yearlyNote(year: number | string): string {
		return join(this.yearly, `${year}.md`);
	}

	futureLog(year: number | string): string {
		return join(this.future, `${year} - Future Log.md`);
	}

	// ── Reviews ───────────────────────────────────────────────────────────────

	reviewFolder(kind: ReviewKind): string {
		return join(this.reviews, kind);
	}

	reviewNote(kind: ReviewKind, name: string): string {
		return join(this.reviewFolder(kind), `${name}.md`);
	}

	/** True when `path` is a generated review of the given kind. */
	isReview(path: string, kind: ReviewKind): boolean {
		return path.startsWith(`${this.reviewFolder(kind)}/`) || path.includes(`Bujo Reviews/${kind}`);
	}

	// ── Templates ─────────────────────────────────────────────────────────────

	templateFor(filePath: string): string | null {
		const kind = this.classify(filePath);
		if (!kind) return null;
		const names: Record<NoteKind, string | null> = {
			daily: 'Daily-Template.md',
			weekly: 'Weekly-Template.md',
			monthly: 'Monthly-Template.md',
			yearly: null,
			future: 'Future-Log-Template.md',
		};
		const name = names[kind];
		return name ? join(this.templates, name) : null;
	}

	// ── Classification ────────────────────────────────────────────────────────

	/**
	 * Which journal folder a path belongs to. Configured folders win; the
	 * name-based fallbacks keep vaults working when a note sits outside the
	 * configured tree (e.g. an archived copy) or settings were never touched.
	 */
	classify(filePath: string): NoteKind | null {
		const inFolder = (folder: string) => folder !== '' && filePath.startsWith(`${folder}/`);

		if (inFolder(this.daily)) return 'daily';
		if (inFolder(this.weekly)) return 'weekly';
		if (inFolder(this.monthly)) return 'monthly';
		if (inFolder(this.yearly)) return 'yearly';
		if (inFolder(this.future)) return 'future';

		if (filePath.includes('Daily Notes')) return 'daily';
		if (filePath.includes('Weekly Notes')) return 'weekly';
		if (filePath.includes('Monthly Notes')) return 'monthly';
		if (filePath.includes('Yearly Notes')) return 'yearly';
		if (filePath.includes('Future Log')) return 'future';

		return null;
	}

	/** Like `classify`, but collapsed to the period types migration works in. */
	detectPeriodType(filePath: string): PeriodType {
		const kind = this.classify(filePath);
		if (kind === 'weekly' || kind === 'monthly' || kind === 'yearly') return kind;
		return 'daily';
	}

	/**
	 * Resolves a heading-derived identifier ("2026-01-07", "2026-W02", "2026-02",
	 * "2026") to a full vault path. Already-qualified paths pass through.
	 */
	headingToSourcePath(rawHeading: string): string | null {
		// Strip wikilink brackets: [[2026-01-07]] → 2026-01-07
		const path = rawHeading.trim().replace(/^\[\[(.+)\]\]$/, '$1');

		if (/^\d{4}-\d{2}-\d{2}$/.test(path)) return this.dailyNote(path);
		if (/^\d{4}-W\d{2}$/.test(path)) return this.weeklyNoteByName(path);
		if (/^\d{4}-\d{2}$/.test(path)) return this.monthlyNote(path);
		if (/^\d{4}$/.test(path)) return this.yearlyNote(path);
		if (path.includes('/') && path.endsWith('.md')) return path;

		return null;
	}

	/**
	 * Detects a source-path heading (`##` or `###` holding a date or path) and
	 * resolves it. Returns null for any other line.
	 */
	tryParseHeadingPath(trimmedLine: string): string | null {
		let headingText: string | null = null;

		if (trimmedLine.startsWith('### ')) {
			headingText = trimmedLine.substring(4).trim();
		} else if (trimmedLine.startsWith('## ') && !trimmedLine.startsWith('###')) {
			headingText = trimmedLine.substring(3).trim();
		}

		if (!headingText) return null;
		return this.headingToSourcePath(headingText);
	}

	// ── Target resolution ─────────────────────────────────────────────────────

	/** Path for a migration target, given a resolved date and target type. */
	targetFilePath(date: string | null, targetType: string): string {
		if (targetType === 'future') {
			let year = moment().year();
			if (date) {
				const dateMoment = moment(date, 'YYYY-MM-DD');
				if (dateMoment.isValid()) year = dateMoment.year();
			}
			return this.futureLog(year);
		}

		if (!date) {
			throw new Error(`Date is required for target type: ${targetType}`);
		}

		const dateMoment = moment(date, 'YYYY-MM-DD');

		if (targetType === 'daily') return this.dailyNote(date);
		// GGGG (ISO week-year), not YYYY: ISO week 1 can fall in late December,
		// where the calendar year and the week-year disagree. The editor
		// suggester already formats week codes this way.
		if (targetType === 'weekly') return this.weeklyNoteByName(dateMoment.format('GGGG-[W]WW'));
		if (targetType === 'monthly') return this.monthlyNote(dateMoment.format('YYYY-MM'));
		if (targetType === 'yearly') return this.yearlyNote(dateMoment.year());

		throw new Error(`Unknown target type: ${targetType}`);
	}
}
