// Planning Workspace — full-page ItemView. Calendar-first with collapsible task pool.
// Left: tasks grouped by note. Right: week calendar. Drag tasks to schedule [@] blocks.
// Drag block edges to resize. Registered as a ribbon icon + command.

import { ItemView, WorkspaceLeaf, TFile, moment, Notice } from 'obsidian';
import { scanOpenTasksFull, TrackableTask, parseTimeRange } from './timeTracking';

export const VIEW_TYPE_PLANNING = 'bujo-planning-workspace';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlannedBlock {
	taskText: string;
	day: number;          // 0=Mon..6=Sun
	startMin: number;     // minutes from midnight
	endMin: number;
	durationMin: number;
	sourceFile: string;
}

interface TaskWithBlocks {
	task: TrackableTask;
	blocks: PlannedBlock[];
}

interface NoteGroup {
	path: string;
	label: string;        // e.g. "2026-06-01" or "Project X"
	tasks: TaskWithBlocks[];
}

// ── Hour/minute helpers ────────────────────────────────────────────────────────

function hourToMin(h: number, m: number = 0): number { return h * 60 + m; }

function parseTimeToMin(range: string): { startMin: number; endMin: number; minutes: number } | null {
	const parsed = parseTimeRange(range);
	if (!parsed) return null;
	const [sh, sm] = parsed.start.split(':').map(Number);
	const [eh, em] = parsed.end.split(':').map(Number);
	if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return null;
	return {
		startMin: sh * 60 + sm,
		endMin: eh * 60 + em,
		minutes: parsed.minutes,
	};
}

// ── The View ───────────────────────────────────────────────────────────────────

export class PlanningWorkspaceView extends ItemView {
	private tasks: TaskWithBlocks[] = [];
	private weekStart: moment.Moment;
	private calendarEl!: HTMLElement;
	private poolEl!: HTMLElement;
	private sidebarVisible = true;
	private draggedTask: TaskWithBlocks | null = null;

	// Layout constants
	private readonly HOUR_HEIGHT = 52;
	private readonly START_HOUR = 6;
	private readonly END_HOUR = 22;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.weekStart = moment().startOf('isoWeek');
	}

	getViewType(): string { return VIEW_TYPE_PLANNING; }
	getDisplayText(): string { return 'Bujo Planning'; }
	getIcon(): string { return 'calendar-days'; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.cssText = 'display:flex;flex-direction:column;height:100%;overflow:hidden;';

		// ── Header bar ──
		const header = container.createDiv();
		header.style.cssText = `
			display:flex; align-items:center; justify-content:space-between;
			padding:8px 14px; background:var(--background-primary);
			border-bottom:1px solid var(--background-modifier-border);
			flex-shrink:0;
		`;

		const weekEnd = this.weekStart.clone().add(6, 'days');
		const titleEl = header.createEl('div', {
			text: `${this.weekStart.format('MMM D')} – ${weekEnd.format('MMM D, YYYY')}`,
		});
		titleEl.style.cssText = 'font-size:16px;font-weight:600;';

		const navRow = header.createDiv();
		navRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

		// Toggle sidebar
		const toggleBtn = navRow.createEl('button', { text: '☰ Tasks' });
		toggleBtn.style.cssText = this.btnStyle();
		toggleBtn.onclick = () => {
			this.sidebarVisible = !this.sidebarVisible;
			this.poolEl.style.display = this.sidebarVisible ? '' : 'none';
			this.renderCalendar();
		};

		['←', 'Today', '→'].forEach((label, i) => {
			const btn = navRow.createEl('button', { text: label });
			btn.style.cssText = this.btnStyle();
			if (i === 0) btn.onclick = () => { this.weekStart.subtract(1, 'week'); this.reload(); };
			if (i === 1) btn.onclick = () => { this.weekStart = moment().startOf('isoWeek'); this.reload(); };
			if (i === 2) btn.onclick = () => { this.weekStart.add(1, 'week'); this.reload(); };
		});

		// ── Body: sidebar + calendar ──
		const body = container.createDiv();
		body.style.cssText = 'display:flex;flex:1;overflow:hidden;';

		this.poolEl = body.createDiv({ cls: 'bujo-pool' });
		this.poolEl.style.cssText = 'width:260px;border-right:1px solid var(--background-modifier-border);overflow-y:auto;padding:10px;flex-shrink:0;';

		this.calendarEl = body.createDiv({ cls: 'bujo-cal' });
		this.calendarEl.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;position:relative;';

		await this.reload();
	}

	private btnStyle(): string {
		return 'padding:4px 10px;border:1px solid var(--background-modifier-border);border-radius:5px;cursor:pointer;background:var(--background-primary);font-size:12px;color:var(--text-normal);';
	}

	// ── Data loading ────────────────────────────────────────────────────────────

	private async reload() {
		const rawTasks = await scanOpenTasksFull(this.app);
		const plannedBlocks = await this.collectWeekBlocks();

		this.tasks = rawTasks.map(t => {
			const blocks = plannedBlocks.filter(b => b.taskText === t.text);
			return { task: t, blocks };
		});

		this.tasks.sort((a, b) => {
			if (a.blocks.length > 0 && b.blocks.length === 0) return -1;
			if (a.blocks.length === 0 && b.blocks.length > 0) return 1;
			return a.task.text.localeCompare(b.task.text);
		});

		this.renderPool();
		this.renderCalendar();
	}

	private async collectWeekBlocks(): Promise<PlannedBlock[]> {
		const results: PlannedBlock[] = [];

		for (let d = 0; d < 7; d++) {
			const dayDate = this.weekStart.clone().add(d, 'days').format('YYYY-MM-DD');
			const filePath = `Journal/001 Daily Notes/${dayDate}.md`;
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) continue;

			const content = await this.app.vault.read(file);
			const lines = content.split('\n');

			let currentParent: string | null = null;
			let currentParentIndent = -1;

			for (const line of lines) {
				if (!line) continue;
				const trimmed = line.trim();

				const plannedMatch = trimmed.match(/^-\s*\[@\]\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})/);
				if (plannedMatch && plannedMatch[1] && currentParent) {
					const t = parseTimeToMin(plannedMatch[1]);
					if (t) {
						results.push({
							taskText: currentParent,
							day: d,
							startMin: t.startMin,
							endMin: t.endMin,
							durationMin: t.minutes,
							sourceFile: filePath,
						});
					}
					continue;
				}

				if (/^\s*- \[/.test(line) && !trimmed.startsWith('- [@]') && !trimmed.startsWith('- [t]')) {
					const indent = (line.match(/^(\s*)/)?.[1]?.length) || 0;
					if (currentParent === null || indent <= currentParentIndent) {
						currentParent = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, '');
						currentParentIndent = indent;
					}
				}
			}
		}

		return results;
	}

	// ── Task pool ───────────────────────────────────────────────────────────────

	private renderPool() {
		this.poolEl.empty();

		// Group by note
		const groups = new Map<string, TaskWithBlocks[]>();
		for (const t of this.tasks) {
			const label = this.noteLabel(t.task.file);
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label)!.push(t);
		}

		for (const [label, groupTasks] of groups) {
			// Note header
			const header = this.poolEl.createDiv();
			header.style.cssText = 'font-size:10px;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin:10px 0 6px;padding:2px 6px;';
			header.textContent = label;

			for (const task of groupTasks) {
				const card = this.poolEl.createDiv({ cls: 'bujo-task-card' });
				card.style.cssText = `
					padding:6px 8px; margin-bottom:3px; border-radius:5px;
					cursor:grab; font-size:12px; line-height:1.4;
					border:1px solid var(--background-modifier-border);
					background:var(--background-primary);
					${task.blocks.length > 0 ? 'opacity:0.55;' : ''}
				`;
				card.textContent = task.task.text.slice(0, 70);

				if (task.blocks.length > 0) {
					const dur = task.blocks.reduce((s, b) => s + b.durationMin, 0);
					const h = Math.floor(dur / 60), m = dur % 60;
					card.createEl('div', {
						text: `${task.blocks.length} block${task.blocks.length > 1 ? 's' : ''} · ${h > 0 ? `${h}h ` : ''}${m}m`,
					}).style.cssText = 'font-size:9px;color:var(--text-muted);margin-top:1px;';
				}

				card.setAttribute('draggable', 'true');
				card.ondragstart = (e) => {
					this.draggedTask = task;
					e.dataTransfer!.effectAllowed = 'move';
				};
				card.ondragend = () => { this.draggedTask = null; };

				card.onmouseenter = () => { card.style.background = 'var(--background-modifier-hover)'; };
				card.onmouseleave = () => { card.style.background = 'var(--background-primary)'; };
			}
		}

		if (this.tasks.length === 0) {
			this.poolEl.createEl('div', {
				text: 'No open tasks',
			}).style.cssText = 'color:var(--text-muted);font-size:13px;padding:20px;text-align:center;';
		}
	}

	private noteLabel(filePath: string): string {
		// Extract display label from file path
		if (filePath.includes('Daily Notes')) {
			const m = filePath.match(/(\d{4}-\d{2}-\d{2})\.md$/);
			if (m) return moment(m[1]).format('ddd MMM D');
		}
		if (filePath.includes('Weekly Notes')) {
				const m = filePath.match(/(\d{4}-W\d{2})\.md$/);
				if (m && m[1]) return m[1];
		}
		// Generic: use filename without extension
		const parts = filePath.split('/');
		const filename = parts[parts.length - 1] ?? filePath;
		return filename.replace('.md', '').slice(0, 25);
	}

	// ── Calendar ────────────────────────────────────────────────────────────────

	private renderCalendar() {
		this.calendarEl.empty();

		const totalHours = this.END_HOUR - this.START_HOUR;
		const totalHeight = totalHours * this.HOUR_HEIGHT;
		const timeLabelWidth = 48;
		const gridWidth = this.calendarEl.clientWidth - timeLabelWidth;
		const dayWidth = gridWidth / 7;

		// Day headers
		const headerRow = this.calendarEl.createDiv();
		headerRow.style.cssText = `
			display:flex; position:sticky; top:0; z-index:5;
			background:var(--background-primary);
			border-bottom:1px solid var(--background-modifier-border);
			padding-left:${timeLabelWidth}px;
		`;

		for (let d = 0; d < 7; d++) {
			const day = this.weekStart.clone().add(d, 'days');
			const hdr = headerRow.createDiv();
			hdr.style.cssText = `flex:1;text-align:center;padding:6px 0;font-size:12px;font-weight:600;min-width:${dayWidth}px;`;
			hdr.textContent = day.format('ddd D');

			const isToday = day.format('YYYY-MM-DD') === moment().format('YYYY-MM-DD');
			const isWeekend = d >= 5;
			if (isToday) {
				hdr.style.background = 'var(--interactive-accent)';
				hdr.style.color = 'var(--text-on-accent)';
				hdr.style.borderRadius = '4px';
			} else if (isWeekend) {
				hdr.style.background = 'var(--background-secondary)';
			}
		}

		// Scrollable grid area
		const gridArea = this.calendarEl.createDiv();
		gridArea.style.cssText = `position:relative;min-height:${totalHeight}px;padding-left:${timeLabelWidth}px;`;

		// Time labels + horizontal grid lines
		for (let h = this.START_HOUR; h <= this.END_HOUR; h++) {
			const y = (h - this.START_HOUR) * this.HOUR_HEIGHT;

			const label = gridArea.createDiv();
			label.style.cssText = `position:absolute;left:-${timeLabelWidth}px;top:${y}px;width:${timeLabelWidth - 4}px;text-align:right;font-size:10px;color:var(--text-muted);transform:translateY(-7px);padding-right:4px;`;
			label.textContent = `${String(h).padStart(2, '0')}:00`;

			const line = gridArea.createDiv();
			line.style.cssText = `position:absolute;left:0;top:${y}px;right:0;height:1px;background:var(--background-modifier-border);`;
		}

		// Day columns
		for (let d = 0; d < 7; d++) {
			const col = gridArea.createDiv();
			col.style.cssText = `
				position:absolute; left:${d * dayWidth}px; top:0;
				width:${dayWidth}px; height:${totalHeight}px;
				border-right:1px solid var(--background-modifier-border);
			`;

			const dayIdx = d;
			col.ondragover = (e) => {
				e.preventDefault();
				col.style.background = 'var(--background-modifier-hover)';
			};
			col.ondragleave = () => { col.style.background = ''; };
			col.ondrop = (e) => {
				e.preventDefault();
				col.style.background = '';
				if (!this.draggedTask) return;
				const rect = col.getBoundingClientRect();
				const y = e.clientY - rect.top;
				const startH = this.START_HOUR + Math.floor(y / this.HOUR_HEIGHT);
				this.scheduleTask(this.draggedTask, dayIdx, startH, startH + 1);
				this.draggedTask = null;
			};
		}

		// Render blocks
		const colors = this.blockColors();
		for (const task of this.tasks) {
			for (const block of task.blocks) {
				const color = colors[block.taskText] || 'var(--interactive-accent)';
				this.renderBlock(gridArea, block, dayWidth, color);
			}
		}

		// Current time line
		const now = moment();
		const nowDay = now.isoWeekday() - 1; // 0=Mon
		const nowMin = now.hour() * 60 + now.minute();
		const nowY = ((nowMin / 60) - this.START_HOUR) * this.HOUR_HEIGHT;

		if (nowDay >= 0 && nowDay < 7 && nowY > 0 && nowY < totalHeight) {
			const line = gridArea.createDiv();
			line.style.cssText = `position:absolute;left:${nowDay * dayWidth}px;top:${nowY}px;width:${dayWidth}px;height:2px;background:var(--interactive-accent);z-index:8;`;
		}
	}

	private blockColors(): Record<string, string> {
		// Assign distinct colors to different tasks for visual grouping
		const palette = [
			'oklch(65% 0.15 35)',  // terracotta
			'oklch(58% 0.14 270)', // indigo
			'oklch(55% 0.08 150)', // forest
			'oklch(50% 0.10 100)', // warm
			'oklch(60% 0.12 200)', // teal
			'oklch(55% 0.09 310)', // plum
		];
		const colors: Record<string, string> = {};
		let idx = 0;
		for (const task of this.tasks) {
			if (task.blocks.length > 0) {
				colors[task.task.text] = palette[idx % palette.length]!;
				idx++;
			}
		}
		return colors;
	}

	private renderBlock(
		container: HTMLElement,
		block: PlannedBlock,
		dayWidth: number,
		color: string,
	) {
		const left = block.day * dayWidth + 2;
		const top = ((block.startMin / 60) - this.START_HOUR) * this.HOUR_HEIGHT;
		const height = ((block.endMin - block.startMin) / 60) * this.HOUR_HEIGHT;

		const el = container.createDiv({ cls: 'bujo-cal-block' });
		el.style.cssText = `
			position:absolute; left:${left}px; top:${top}px;
			width:${dayWidth - 4}px; height:${Math.max(height, 20)}px;
			background:${color}; color:white; border-radius:5px;
			padding:3px 6px; font-size:10px; overflow:hidden;
			cursor:pointer; z-index:3; opacity:0.9;
			box-sizing:border-box; line-height:1.3;
		`;

		const sh = Math.floor(block.startMin / 60), sm = block.startMin % 60;
		const eh = Math.floor(block.endMin / 60), em = block.endMin % 60;
		const timeLabel = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}–${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;

		el.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${block.taskText.slice(0, 30)}</div><div style="opacity:0.8;margin-top:1px;">${timeLabel}</div>`;

		// Click to unschedule
		el.onclick = () => {
			if (confirm(`Unschedule "${block.taskText}"?`)) {
				this.unscheduleBlock(block);
			}
		};

		// Resize handle
		const handle = container.createDiv();
		handle.style.cssText = `
			position:absolute; left:${left}px; top:${top + height - 5}px;
			width:${dayWidth - 4}px; height:10px; cursor:ns-resize; z-index:4;
		`;

		let resizing = false, startY = 0, startEnd = block.endMin;

		handle.onmousedown = (e) => {
			resizing = true;
			startY = e.clientY;
			startEnd = block.endMin;
			e.preventDefault();
		};

		const onMove = (e: MouseEvent) => {
			if (!resizing) return;
			const deltaMin = Math.round(((e.clientY - startY) / this.HOUR_HEIGHT) * 60);
			const newEnd = Math.min(this.END_HOUR * 60, Math.max(block.startMin + 15, startEnd + deltaMin));
			block.endMin = newEnd;
			block.durationMin = newEnd - block.startMin;
			el.style.height = `${Math.max(20, ((newEnd - block.startMin) / 60) * this.HOUR_HEIGHT)}px`;
		};

		const onUp = () => {
			if (!resizing) return;
			resizing = false;
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);
			this.persistBlock(block);
		};

		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);
	}

	// ── Actions ─────────────────────────────────────────────────────────────────

	private scheduleTask(task: TaskWithBlocks, day: number, startH: number, endH: number) {
		const block: PlannedBlock = {
			taskText: task.task.text,
			day,
			startMin: startH * 60,
			endMin: endH * 60,
			durationMin: (endH - startH) * 60,
			sourceFile: task.task.file,
		};

		task.blocks.push(block);
		this.persistBlock(block);
		this.renderPool();
		this.renderCalendar();
	}

	private unscheduleBlock(block: PlannedBlock) {
		const task = this.tasks.find(t => t.task.text === block.taskText);
		if (task) {
			const idx = task.blocks.indexOf(block);
			if (idx !== -1) task.blocks.splice(idx, 1);
		}
		this.renderPool();
		this.renderCalendar();
	}

	private async persistBlock(block: PlannedBlock) {
		const dayDate = this.weekStart.clone().add(block.day, 'days').format('YYYY-MM-DD');
		const filePath = `Journal/001 Daily Notes/${dayDate}.md`;

		let file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			const folder = this.app.vault.getAbstractFileByPath('Journal/001 Daily Notes');
			if (!folder) await this.app.vault.createFolder('Journal/001 Daily Notes');
			file = await this.app.vault.create(filePath, '');
		}
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');

		const sh = Math.floor(block.startMin / 60), sm = block.startMin % 60;
		const eh = Math.floor(block.endMin / 60), em = block.endMin % 60;
		const timeStr = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}-${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
		const trackedLine = `\t- [@] ${timeStr}`;

		const normalizedTask = block.taskText.toLowerCase().trim();
		let parentIndex = -1;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line || !/^\s*- \[/.test(line.trim())) continue;
			const text = line.trim().replace(/^-\s*\[[^\]]*\]\s*/, '').toLowerCase();
			if (text === normalizedTask) { parentIndex = i; break; }
		}

		if (parentIndex === -1) {
			lines.push(`- [ ] ${block.taskText}`);
			lines.push(trackedLine);
		} else {
			const parentIndent = (lines[parentIndex]?.match(/^(\s*)/)?.[1]?.length) || 0;

			// Replace existing [@] block at this time, or insert
			let replaced = false;
			for (let i = parentIndex + 1; i < lines.length; i++) {
				const li = lines[i];
				if (!li || !li.trim()) continue;
				const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
				if (indent <= parentIndent) break;
				if (li.includes('[@]') && li.includes(block.taskText.slice(0, 15))) {
					lines[i] = trackedLine;
					replaced = true;
					break;
				}
			}

			if (!replaced) {
				let insertIdx = parentIndex + 1;
				for (let i = parentIndex + 1; i < lines.length; i++) {
					const li = lines[i];
					if (!li || !li.trim()) { insertIdx = i + 1; continue; }
					const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
					if (indent <= parentIndent) { insertIdx = i; break; }
					insertIdx = i + 1;
				}
				lines.splice(insertIdx, 0, trackedLine);
			}
		}

		await this.app.vault.modify(file, lines.join('\n'));
	}
}
