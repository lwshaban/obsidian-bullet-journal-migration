// Task data hooks for the React planning workspace.
// Reads open tasks + [@] blocks from the vault via Obsidian API.

import { useState, useEffect, useCallback } from 'react';
import { App, TFile, moment } from 'obsidian';
import { scanOpenTasksFull, TrackableTask, parseTimeRange } from '../timeTracking';
import { normalizeText } from '../utils';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Block {
	id: string;
	taskText: string;
	day: number;           // 0=Mon..6=Sun
	startMin: number;
	endMin: number;
	durationMin: number;
	sourceFile: string;
	color: string;
}

export interface TaskWithBlocks {
	task: TrackableTask;
	blocks: Block[];
	done: boolean;
}

const COLORS = [
	'oklch(65% 0.15 35)', 'oklch(58% 0.14 270)',
	'oklch(55% 0.08 150)', 'oklch(50% 0.10 100)',
	'oklch(60% 0.12 200)', 'oklch(55% 0.09 310)',
];

function parseTimeToMin(range: string): { startMin: number; endMin: number; minutes: number } | null {
	const parsed = parseTimeRange(range);
	if (!parsed) return null;
	const [sh, sm] = parsed.start.split(':').map(Number);
	const [eh, em] = parsed.end.split(':').map(Number);
	if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return null;
	return { startMin: sh * 60 + sm, endMin: eh * 60 + em, minutes: parsed.minutes };
}

export function minToTimeStr(startMin: number, endMin: number): string {
	const sh = Math.floor(startMin / 60), sm = startMin % 60;
	const eh = Math.floor(endMin / 60), em = endMin % 60;
	return `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
}

// ── Hook: task data for a week ─────────────────────────────────────────────────

export function useWeekData(app: App, weekStart: moment.Moment) {
	const [tasks, setTasks] = useState<TaskWithBlocks[]>([]);
	const [loading, setLoading] = useState(true);

	const reload = useCallback(async () => {
		setLoading(true);
		const rawTasks = await scanOpenTasksFull(app);
		const plannedBlocks = await collectBlocks(app, weekStart);

		let colorIdx = 0;
		const taskColors = new Map<string, string>();

		const result: TaskWithBlocks[] = rawTasks.map((t: TrackableTask) => {
			if (!taskColors.has(t.text)) {
				taskColors.set(t.text, COLORS[colorIdx++ % COLORS.length]!);
			}
			const color = taskColors.get(t.text)!;
			const blocks = plannedBlocks
				.filter(b => b.taskText === t.text)
				.map(b => ({ ...b, color }));
			return { task: t, blocks, done: false };
		});

		result.sort((a, b) => {
			if (a.blocks.length > 0 && b.blocks.length === 0) return -1;
			if (a.blocks.length === 0 && b.blocks.length > 0) return 1;
			return a.task.text.localeCompare(b.task.text);
		});

		setTasks(result);
		setLoading(false);
	}, [app, weekStart]);

	useEffect(() => { reload(); }, [reload]);

	return { tasks, setTasks, reload, loading };
}

// ── Block collection ───────────────────────────────────────────────────────────

async function collectBlocks(app: App, weekStart: moment.Moment): Promise<Omit<Block, 'color'>[]> {
	const results: Omit<Block, 'color'>[] = [];
	let idCounter = 0;

	for (let d = 0; d < 7; d++) {
		const dayDate = weekStart.clone().add(d, 'days').format('YYYY-MM-DD');
		const filePath = `Journal/001 Daily Notes/${dayDate}.md`;
		const file = app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) continue;

		const content = await app.vault.read(file);
		const lines = content.split('\n');
		let parent: string | null = null, parentIndent = -1;

		for (const line of lines) {
			if (!line) continue;
			const trimmed = line.trim();
			const m = trimmed.match(/^-\s*\[@\]\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})/);
			if (m && m[1] && parent) {
				const t = parseTimeToMin(m[1]);
				if (t) {
					results.push({
						id: `b${idCounter++}`, taskText: parent, day: d,
						startMin: t.startMin, endMin: t.endMin,
						durationMin: t.minutes, sourceFile: filePath,
					});
				}
				continue;
			}
			if (/^\s*- \[/.test(line) && !trimmed.startsWith('- [@]') && !trimmed.startsWith('- [t]')) {
				const indent = (line.match(/^(\s*)/)?.[1]?.length) || 0;
				if (parent === null || indent <= parentIndent) {
					parent = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, '');
					parentIndent = indent;
				}
			}
		}
	}

	return results;
}

// ── Block persistence ──────────────────────────────────────────────────────────

export async function persistBlock(
	app: App,
	block: Block,
	weekStart: moment.Moment,
	removeOld = false,
): Promise<void> {
	const dayDate = weekStart.clone().add(block.day, 'days').format('YYYY-MM-DD');
	const filePath = `Journal/001 Daily Notes/${dayDate}.md`;

	let file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		const f = app.vault.getAbstractFileByPath('Journal/001 Daily Notes');
		if (!f) await app.vault.createFolder('Journal/001 Daily Notes');
		file = await app.vault.create(filePath, '');
	}
	if (!(file instanceof TFile)) return;

	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const timeStr = minToTimeStr(block.startMin, block.endMin);
	const blockLine = `\t- [@] ${timeStr}`;

	const norm = normalizeText(block.taskText);
	let parentIdx = -1, parentIndent = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith('- [@]') || trimmed.startsWith('- [t]')) continue;
		if (/^\s*- \[/.test(line)) {
			const text = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/<!--.*?-->/, '').trim();
			const indent = (line.match(/^(\s*)/)?.[1]?.length) || 0;
			if (normalizeText(text) === norm && (parentIdx === -1 || indent <= parentIndent)) {
				parentIdx = i; parentIndent = indent; break;
			}
		}
	}

	if (parentIdx === -1) {
		lines.push(`- [ ] ${block.taskText}`);
		lines.push(blockLine);
	} else {
		lines[parentIdx] = lines[parentIdx]!.replace(/\s*<!--\s*bujo:[^>]*\s*-->/, '');
		let replaced = false;
		for (let i = parentIdx + 1; i < lines.length; i++) {
			const li = lines[i];
			if (!li || !li.trim()) continue;
			const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
			if (indent <= parentIndent) break;
			if (li.includes('[@]') && li.includes(timeStr)) { lines[i] = blockLine; replaced = true; break; }
		}
		if (!replaced) {
			let insert = parentIdx + 1;
			for (let i = parentIdx + 1; i < lines.length; i++) {
				const li = lines[i];
				if (!li || !li.trim()) { insert = i + 1; continue; }
				const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
				if (indent <= parentIndent) { insert = i; break; }
				insert = i + 1;
			}
			lines.splice(insert, 0, blockLine);
		}
	}

	await app.vault.modify(file, lines.join('\n'));
	block.sourceFile = filePath;
}

export async function removeBlockFromFile(
	app: App,
	filePath: string,
	taskText: string,
	startMin: number,
	endMin: number,
): Promise<void> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) return;

	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const timeStr = minToTimeStr(startMin, endMin);
	const norm = normalizeText(taskText);

	let parentIdx = -1, parentIndent = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line) continue;
		const trimmed = line.trim();
		if (trimmed.startsWith('- [@]') || trimmed.startsWith('- [t]')) continue;
		if (/^\s*- \[/.test(line)) {
			const text = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, '').replace(/<!--.*?-->/, '').trim();
			if (normalizeText(text) === norm) {
				parentIdx = i; parentIndent = (line.match(/^(\s*)/)?.[1]?.length) || 0; break;
			}
		}
	}
	if (parentIdx === -1) return;

	for (let i = parentIdx + 1; i < lines.length; i++) {
		const li = lines[i];
		if (!li || !li.trim()) continue;
		const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
		if (indent <= parentIndent) break;
		if (li.includes('[@]') && li.includes(timeStr)) {
			lines.splice(i, 1);
			await app.vault.modify(file, lines.join('\n'));
			return;
		}
	}
}
