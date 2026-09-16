import test from 'node:test';
import assert from 'node:assert/strict';

import { BujoPaths } from '../src/paths';
import { DEFAULT_SETTINGS, BujoPluginSettings } from '../src/settings';

const defaults = () => new BujoPaths({ ...DEFAULT_SETTINGS });

const custom = (overrides: Partial<BujoPluginSettings>) =>
	new BujoPaths({ ...DEFAULT_SETTINGS, ...overrides });

test('note paths follow the configured folders', () => {
	const paths = custom({
		dailyNotesPath: 'Bujo/Days',
		weeklyNotesPath: 'Bujo/Weeks',
		monthlyNotesPath: 'Bujo/Months',
		yearlyNotesPath: 'Bujo/Years',
		futureLogPath: 'Bujo/Future',
	});

	assert.equal(paths.dailyNote('2026-01-15'), 'Bujo/Days/2026-01-15.md');
	assert.equal(paths.weeklyNoteByName('2026-W03'), 'Bujo/Weeks/2026-W03.md');
	assert.equal(paths.monthlyNote('2026-01'), 'Bujo/Months/2026-01.md');
	assert.equal(paths.yearlyNote(2026), 'Bujo/Years/2026.md');
	assert.equal(paths.futureLog(2026), 'Bujo/Future/2026 - Future Log.md');
});

test('migration targets follow the configured folders', () => {
	const paths = custom({ dailyNotesPath: 'Bujo/Days', monthlyNotesPath: 'Bujo/Months' });

	assert.equal(paths.targetFilePath('2026-01-15', 'daily'), 'Bujo/Days/2026-01-15.md');
	assert.equal(paths.targetFilePath('2026-01-15', 'monthly'), 'Bujo/Months/2026-01.md');
});

test('trailing and leading slashes in settings are normalised away', () => {
	const paths = custom({ dailyNotesPath: '/Bujo/Days/' });
	assert.equal(paths.dailyNote('2026-01-15'), 'Bujo/Days/2026-01-15.md');
});

test('a folder set to the vault root produces bare filenames', () => {
	const paths = custom({ dailyNotesPath: '' });
	assert.equal(paths.dailyNote('2026-01-15'), '2026-01-15.md');
});

test('weekly targets use the ISO week-year at year boundaries', () => {
	// 2024-12-30 is a Monday in ISO week 1 of 2025: the calendar year (2024)
	// and the week-year (2025) disagree, and YYYY would file it as 2024-W01.
	assert.equal(
		defaults().targetFilePath('2024-12-30', 'weekly'),
		'Journal/002 Weekly Notes/2025-W01.md',
	);

	// The mirror case: 2028-01-01 is a Saturday still inside ISO week 52 of
	// 2027, where YYYY would file it as 2028-W52.
	assert.equal(
		defaults().targetFilePath('2028-01-01', 'weekly'),
		'Journal/002 Weekly Notes/2027-W52.md',
	);

	// 2026 is a 53-week ISO year, so late December stays in its own week-year.
	assert.equal(
		defaults().targetFilePath('2026-12-28', 'weekly'),
		'Journal/002 Weekly Notes/2026-W53.md',
	);
});

test('the future log target uses the year of the given date', () => {
	assert.equal(
		defaults().targetFilePath('2027-03-01', 'future'),
		'Journal/006 Future Log/2027 - Future Log.md',
	);
});

test('a target type that needs a date rejects a missing one', () => {
	assert.throws(() => defaults().targetFilePath(null, 'daily'), /Date is required/);
	assert.throws(() => defaults().targetFilePath('2026-01-15', 'quarterly'), /Unknown target type/);
});

test('reviews live under the configured reviews folder', () => {
	const paths = custom({ reviewsPath: 'Journal/Reviews' });

	assert.equal(paths.reviewFolder('Weekly'), 'Journal/Reviews/Weekly');
	assert.equal(
		paths.reviewNote('Monthly', '2026-01-Review'),
		'Journal/Reviews/Monthly/2026-01-Review.md',
	);
	assert.ok(paths.isReview('Journal/Reviews/Global/Global-Review-2026-01-15-0900.md', 'Global'));
	assert.ok(!paths.isReview('Journal/Reviews/Global/x.md', 'Weekly'));
});

test('classify matches configured folders first', () => {
	const paths = custom({ dailyNotesPath: 'Bujo/Days' });

	assert.equal(paths.classify('Bujo/Days/2026-01-15.md'), 'daily');
	assert.equal(paths.classify('Some/Other/Note.md'), null);
});

test('classify falls back to conventional folder names', () => {
	// A note outside the configured tree — an archived copy, say — still
	// classifies, so migrating from it keeps working.
	const paths = custom({ dailyNotesPath: 'Bujo/Days' });
	assert.equal(paths.classify('Archive/2024/Daily Notes/2024-01-15.md'), 'daily');
});

test('detectPeriodType collapses to the migration period types', () => {
	const paths = defaults();

	assert.equal(paths.detectPeriodType('Journal/002 Weekly Notes/2026-W03.md'), 'weekly');
	assert.equal(paths.detectPeriodType('Journal/003 Monthly Notes/2026-01.md'), 'monthly');
	// Unclassifiable notes default to daily rather than throwing.
	assert.equal(paths.detectPeriodType('Inbox/Scratch.md'), 'daily');
});

test('templates resolve from the configured templates folder', () => {
	const paths = custom({ templatesPath: 'Meta/Templates' });

	assert.equal(
		paths.templateFor('Journal/001 Daily Notes/2026-01-15.md'),
		'Meta/Templates/Daily-Template.md',
	);
	assert.equal(
		paths.templateFor('Journal/006 Future Log/2026 - Future Log.md'),
		'Meta/Templates/Future-Log-Template.md',
	);
	// Yearly notes have no template, and neither do unrelated notes.
	assert.equal(paths.templateFor('Journal/004 Yearly Notes/2026.md'), null);
	assert.equal(paths.templateFor('Inbox/Scratch.md'), null);
});

test('review headings resolve back to source notes', () => {
	const paths = custom({ dailyNotesPath: 'Bujo/Days', weeklyNotesPath: 'Bujo/Weeks' });

	assert.equal(paths.headingToSourcePath('2026-01-15'), 'Bujo/Days/2026-01-15.md');
	assert.equal(paths.headingToSourcePath('[[2026-01-15]]'), 'Bujo/Days/2026-01-15.md');
	assert.equal(paths.headingToSourcePath('2026-W03'), 'Bujo/Weeks/2026-W03.md');
	assert.equal(paths.headingToSourcePath('2026-01'), 'Journal/003 Monthly Notes/2026-01.md');
	// An already-qualified path passes through untouched.
	assert.equal(paths.headingToSourcePath('Some/Where/Note.md'), 'Some/Where/Note.md');
	assert.equal(paths.headingToSourcePath('not a date'), null);
});

test('tryParseHeadingPath only fires on headings', () => {
	const paths = defaults();

	assert.equal(
		paths.tryParseHeadingPath('## [[2026-01-15]]'),
		'Journal/001 Daily Notes/2026-01-15.md',
	);
	assert.equal(
		paths.tryParseHeadingPath('### 2026-W03'),
		'Journal/002 Weekly Notes/2026-W03.md',
	);
	assert.equal(paths.tryParseHeadingPath('- [ ] 2026-01-15'), null);
	assert.equal(paths.tryParseHeadingPath('# Weekly Review - 2026-W03'), null);
});
