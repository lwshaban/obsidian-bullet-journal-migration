// Planning Workspace v2 — free-form calendar like Google Calendar.
// Sidebar: tasks grouped by note, click to cancel/done.
// Calendar: drag tasks to any minute position, drag blocks to move, resize edges.
// Snaps to 15-min increments. Colored by parent task.

import { ItemView, WorkspaceLeaf, TFile, moment, Notice } from 'obsidian';
import { scanOpenTasksFull, TrackableTask, parseTimeRange } from './timeTracking';
import { normalizeText, getTaskText, isIncompleteTask, isCompletedTask } from './utils';
import { MigrationPickerModal } from './migration-ui';

export const VIEW_TYPE_PLANNING = 'bujo-planning-workspace';

// ── Types ──────────────────────────────────────────────────────────────────────

interface PlannedBlock {
	id: string;            // unique per block for drag tracking
	taskText: string;
	day: number;           // 0=Mon..6=Sun
	startMin: number;      // minutes from midnight
	endMin: number;
	durationMin: number;
	sourceFile: string;
	color: string;
}

interface TaskState {
	task: TrackableTask;
	blocks: PlannedBlock[];
	done: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeToMin(h: number, m: number): number { return h * 60 + m; }
function minToTimeStr(startMin: number, endMin: number): string {
	const sh = Math.floor(startMin / 60), sm = startMin % 60;
	const eh = Math.floor(endMin / 60), em = endMin % 60;
	return `${String(sh).padStart(2,'0')}:${String(sm).padStart(2,'0')}-${String(eh).padStart(2,'0')}:${String(em).padStart(2,'0')}`;
}

/** Generate a short deterministic hash from task text (content-based, survives across files) */
function taskHash(taskText: string): string {
	let hash = 0;
	for (let i = 0; i < taskText.length; i++) {
		const ch = taskText.charCodeAt(i);
		hash = ((hash << 5) - hash) + ch;
		hash |= 0;
	}
	return Math.abs(hash).toString(36).slice(0, 6);
}

function parseTimeToMin(range: string): { startMin: number; endMin: number; minutes: number } | null {
	const parsed = parseTimeRange(range);
	if (!parsed) return null;
	const [sh, sm] = parsed.start.split(':').map(Number);
	const [eh, em] = parsed.end.split(':').map(Number);
	if (sh === undefined || sm === undefined || eh === undefined || em === undefined) return null;
	return { startMin: sh * 60 + sm, endMin: eh * 60 + em, minutes: parsed.minutes };
}

const TASK_COLORS = [
	'oklch(65% 0.15 35)',  'oklch(58% 0.14 270)',
	'oklch(55% 0.08 150)', 'oklch(50% 0.10 100)',
	'oklch(60% 0.12 200)', 'oklch(55% 0.09 310)',
];
let colorIdx = 0;
function nextColor(): string { return TASK_COLORS[colorIdx++ % TASK_COLORS.length]!; }

// ── The View ───────────────────────────────────────────────────────────────────

export class PlanningWorkspaceView extends ItemView {
	private tasks: TaskState[] = [];
	private weekStart: moment.Moment;
	private calendarEl!: HTMLElement;
	private poolEl!: HTMLElement;
	private sidebarVisible = true;

	// Layout
	private readonly HOUR_HEIGHT = 56;
	private readonly START_HOUR = 5;
	private readonly END_HOUR = 23;
	private readonly SNAP_MIN = 15; // snap to 15-min increments

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

		// ── Header ──
		const hdr = container.createDiv();
		hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 14px;border-bottom:1px solid var(--background-modifier-border);flex-shrink:0;background:var(--background-primary);';

		const weekEnd = this.weekStart.clone().add(6, 'days');
		hdr.createEl('div', { text: `${this.weekStart.format('MMM D')} – ${weekEnd.format('MMM D, YYYY')}` }).style.cssText = 'font-size:15px;font-weight:600;';

		const btns = hdr.createDiv();
		btns.style.cssText = 'display:flex;gap:6px;';

		const toggleBtn = btns.createEl('button', { text: '☰' });
		toggleBtn.style.cssText = this.btnCss();
		toggleBtn.title = 'Toggle sidebar';
		toggleBtn.onclick = () => { this.sidebarVisible = !this.sidebarVisible; this.poolEl.style.display = this.sidebarVisible ? '' : 'none'; this.renderCalendar(); };

		for (const [label, fn] of [['←', () => { this.weekStart.subtract(1,'week'); this.reload(); }], ['Today', () => { this.weekStart = moment().startOf('isoWeek'); this.reload(); }], ['→', () => { this.weekStart.add(1,'week'); this.reload(); }]] as const) {
			const b = btns.createEl('button', { text: label });
			b.style.cssText = this.btnCss();
			b.onclick = fn;
		}

		// ── Body ──
		const body = container.createDiv();
		body.style.cssText = 'display:flex;flex:1;overflow:hidden;';

		this.poolEl = body.createDiv();
		this.poolEl.style.cssText = 'width:250px;border-right:1px solid var(--background-modifier-border);overflow-y:auto;padding:8px;flex-shrink:0;';

		this.calendarEl = body.createDiv();
		this.calendarEl.style.cssText = 'flex:1;overflow-y:auto;overflow-x:hidden;position:relative;';

		await this.reload();
	}

	private btnCss(): string {
		return 'padding:4px 10px;border:1px solid var(--background-modifier-border);border-radius:5px;cursor:pointer;background:var(--background-primary);font-size:12px;color:var(--text-normal);';
	}

	// ── Data ────────────────────────────────────────────────────────────────────

	private async reload() {
		colorIdx = 0;
		const rawTasks = await scanOpenTasksFull(this.app);
		const plannedBlocks = await this.collectWeekBlocks();
		const taskColors = new Map<string, string>();

		this.tasks = rawTasks.map(t => {
			if (!taskColors.has(t.text)) taskColors.set(t.text, nextColor());
			const color = taskColors.get(t.text)!;
			const blocks = plannedBlocks.filter(b => b.taskText === t.text).map(b => ({ ...b, color }));
			return { task: t, blocks, done: false };
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
		let idCounter = 0;

		for (let d = 0; d < 7; d++) {
			const dayDate = this.weekStart.clone().add(d, 'days').format('YYYY-MM-DD');
			const filePath = `Journal/001 Daily Notes/${dayDate}.md`;
			const file = this.app.vault.getAbstractFileByPath(filePath);
			if (!(file instanceof TFile)) continue;

			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			let parent: string | null = null, parentIndent = -1;

			for (const line of lines) {
				if (!line) continue;
				const trimmed = line.trim();
				const m = trimmed.match(/^-\s*\[@\]\s+(\d{1,2}:\d{2}-\d{1,2}:\d{2})/);
				if (m && m[1] && parent) {
					const t = parseTimeToMin(m[1]);
					if (t) {
						results.push({ id: `b${idCounter++}`, taskText: parent, day: d, startMin: t.startMin, endMin: t.endMin, durationMin: t.minutes, sourceFile: filePath, color: '' });
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

	// ── Sidebar ─────────────────────────────────────────────────────────────────

	private renderPool() {
		this.poolEl.empty();

		const search = this.poolEl.createEl('input', { type: 'text', placeholder: 'Filter...' }) as HTMLInputElement;
		search.style.cssText = 'width:100%;padding:5px 8px;border:1px solid var(--background-modifier-border);border-radius:5px;margin-bottom:8px;font-size:12px;background:var(--background-primary);color:var(--text-normal);box-sizing:border-box;';

		const groups = new Map<string, TaskState[]>();
		for (const t of this.tasks) {
			const label = this.noteLabel(t.task.file);
			if (!groups.has(label)) groups.set(label, []);
			groups.get(label)!.push(t);
		}

		for (const [label, groupTasks] of groups) {
			const hdr = this.poolEl.createDiv();
			hdr.style.cssText = 'font-size:10px;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin:8px 0 4px;padding:2px 4px;';
			hdr.textContent = label;

			for (const task of groupTasks) {
				const row = this.poolEl.createDiv();
				row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 4px;margin-bottom:2px;border-radius:4px;font-size:12px;cursor:pointer;';
				row.onmouseenter = () => row.style.background = 'var(--background-modifier-hover)';
				row.onmouseleave = () => row.style.background = '';

				// Checkbox for done/cancel
				const cb = row.createEl('input', { type: 'checkbox' }) as HTMLInputElement;
				cb.style.cssText = 'margin:0;flex-shrink:0;';
				cb.checked = task.done;
				cb.onchange = async () => {
					task.done = cb.checked;
					await this.toggleTaskDone(task);
					this.renderPool();
				};

				// Task text — click to open migration picker
				const textEl = row.createEl('span');
				textEl.style.cssText = `flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${task.done ? 'text-decoration:line-through;color:var(--text-faint);' : 'color:var(--text-accent);cursor:pointer;'}`;
				textEl.textContent = task.task.text.slice(0, 60);
				textEl.title = 'Click to migrate this task';
				textEl.onclick = async (e) => {
					e.stopPropagation();
					const file = this.app.vault.getAbstractFileByPath(task.task.file);
					if (file instanceof TFile) {
						const leaf = this.app.workspace.getLeaf(false);
						await leaf.openFile(file);
						// Find the line with this task and set cursor
						const editor = this.app.workspace.activeEditor?.editor;
						if (editor) {
							const content = await this.app.vault.read(file);
							const lines = content.split('\n');
							const norm = normalizeText(task.task.text);
							for (let i = 0; i < lines.length; i++) {
								if (normalizeText(getTaskText(lines[i] || '')) === norm) {
									editor.setCursor({ line: i, ch: 0 });
									break;
								}
							}
							new MigrationPickerModal(this.app, editor).open();
						}
					}
				};

				// Block count
				if (task.blocks.length > 0) {
					const dur = task.blocks.reduce((s,b) => s + b.durationMin, 0);
					const h = Math.floor(dur / 60), m = dur % 60;
					row.createEl('span', { text: `${h > 0 ? `${h}h ` : ''}${m}m` }).style.cssText = 'font-size:9px;color:var(--text-muted);flex-shrink:0;';
				}

				// Drag handle
				row.setAttribute('draggable', 'true');
				row.ondragstart = (e) => {
					e.dataTransfer!.effectAllowed = 'move';
					e.dataTransfer!.setData('text/plain', JSON.stringify({ taskText: task.task.text, sourceFile: task.task.file }));
				};
			}
		}
	}

	private noteLabel(path: string): string {
		if (path.includes('Daily Notes')) {
			const m = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
			if (m && m[1]) return moment(m[1]).format('ddd MMM D');
		}
		if (path.includes('Weekly Notes')) {
			const m = path.match(/(\d{4}-W\d{2})\.md$/);
			if (m && m[1]) return m[1];
		}
		const parts = path.split('/');
		return (parts[parts.length - 1] ?? path).replace('.md', '').slice(0, 25);
	}

	private async toggleTaskDone(task: TaskState) {
		try {
			const file = this.app.vault.getAbstractFileByPath(task.task.file);
			if (!(file instanceof TFile)) {
				new Notice(`Could not find file: ${task.task.file}`);
				return;
			}

			const content = await this.app.vault.read(file);
			const lines = content.split('\n');
			const norm = normalizeText(task.task.text);
			let found = false;

			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				// Match any incomplete task line
				if (!isIncompleteTask(line) && !isCompletedTask(line)) continue;
				const lineText = getTaskText(line);
				if (normalizeText(lineText) === norm) {
					// Toggle: if currently [-], make [ ]; if [ ] or [x], make [-]
					const isAlreadyCancelled = /^\s*-\s*\[-\]/.test(line);
					if (isAlreadyCancelled) {
						lines[i] = line.replace(/^(\s*-\s*)\[-\]/, '$1[ ]');
					} else {
						lines[i] = line.replace(/^(\s*-\s*)\[[^\]]+\]/, '$1[-]');
					}
					found = true;
					break;
				}
			}

			if (found) {
				await this.app.vault.modify(file, lines.join('\n'));
				new Notice(task.done ? 'Task cancelled' : 'Task restored');
			} else {
				console.warn(`[BuJo] toggleTaskDone: task not found in file: "${task.task.text}" in ${task.task.file}`);
			}
		} catch (err) {
			console.error('[BuJo] toggleTaskDone error:', err);
			new Notice('Failed to update task');
		}
	}

	// ── Calendar rendering ──────────────────────────────────────────────────────

	private renderCalendar() {
		this.calendarEl.empty();

		const TIME_LABEL = 48;
		const totalHours = this.END_HOUR - this.START_HOUR;
		const totalH = totalHours * this.HOUR_HEIGHT;
		const gridW = this.calendarEl.clientWidth - TIME_LABEL;
		const dayW = gridW / 7;

		// Day headers
		const hdrRow = this.calendarEl.createDiv();
		hdrRow.style.cssText = `display:flex;position:sticky;top:0;z-index:5;background:var(--background-primary);border-bottom:1px solid var(--background-modifier-border);padding-left:${TIME_LABEL}px;`;

		for (let d = 0; d < 7; d++) {
			const day = this.weekStart.clone().add(d, 'days');
			const el = hdrRow.createDiv();
			el.style.cssText = `flex:1;text-align:center;padding:5px 0;font-size:12px;font-weight:600;`;
			el.textContent = day.format('ddd D');
			if (day.format('YYYY-MM-DD') === moment().format('YYYY-MM-DD')) {
				el.style.background = 'var(--interactive-accent)'; el.style.color = 'white'; el.style.borderRadius = '4px';
			}
		}

		// Grid area
		const grid = this.calendarEl.createDiv();
		grid.style.cssText = `position:relative;min-height:${totalH}px;padding-left:${TIME_LABEL}px;`;

		// Time labels + lines
		for (let h = this.START_HOUR; h <= this.END_HOUR; h++) {
			const y = (h - this.START_HOUR) * this.HOUR_HEIGHT;
			const lbl = grid.createDiv();
			lbl.style.cssText = `position:absolute;left:-${TIME_LABEL}px;top:${y}px;width:${TIME_LABEL - 4}px;text-align:right;font-size:10px;color:var(--text-muted);transform:translateY(-7px);padding-right:4px;`;
			lbl.textContent = `${String(h).padStart(2,'0')}:00`;

			const ln = grid.createDiv();
			ln.style.cssText = `position:absolute;left:0;top:${y}px;right:0;height:1px;background:var(--background-modifier-border);`;
		}

		// Day columns (drop zones with minute-level detection)
		for (let d = 0; d < 7; d++) {
			const col = grid.createDiv();
			col.style.cssText = `position:absolute;left:${d * dayW}px;top:0;width:${dayW}px;height:${totalH}px;border-right:1px solid var(--background-modifier-border);`;

			const dayIdx = d;
			col.ondragover = (e) => { e.preventDefault(); col.style.background = 'var(--background-modifier-hover)'; };
			col.ondragleave = () => { col.style.background = ''; };
			col.ondrop = (e) => {
				e.preventDefault();
				col.style.background = '';
				const data = e.dataTransfer?.getData('text/plain');
				if (!data) return;

				const rect = col.getBoundingClientRect();
				const y = e.clientY - rect.top;
				const rawMin = (y / this.HOUR_HEIGHT + this.START_HOUR) * 60;
				const startMin = Math.round(rawMin / this.SNAP_MIN) * this.SNAP_MIN;
				const clampedStart = Math.max(this.START_HOUR * 60, Math.min((this.END_HOUR - 1) * 60, startMin));
				const endMin = clampedStart + 60; // 1 hour default block

				try {
					const parsed = JSON.parse(data) as { taskText: string; sourceFile: string };
					this.createBlock(parsed.taskText, parsed.sourceFile, dayIdx, clampedStart, endMin);
				} catch {
					// Not JSON — try as legacy task drop
					const task = this.tasks.find(t => t.task.text === data);
					if (task) this.createBlock(task.task.text, task.task.file, dayIdx, clampedStart, endMin);
				}
			};
		}

		// Render existing blocks with full drag+resize
		for (const task of this.tasks) {
			for (const block of task.blocks) {
				this.renderBlock(grid, block, dayW);
			}
		}

		// Now line
		const now = moment();
		const nd = now.isoWeekday() - 1;
		const ny = ((now.hour() * 60 + now.minute()) / 60 - this.START_HOUR) * this.HOUR_HEIGHT;
		if (nd >= 0 && nd < 7 && ny > 0 && ny < totalH) {
			const nl = grid.createDiv();
			nl.style.cssText = `position:absolute;left:${nd * dayW}px;top:${ny}px;width:${dayW}px;height:2px;background:var(--interactive-accent);z-index:10;pointer-events:none;`;
		}
	}

	// ── Block rendering with full drag + resize ─────────────────────────────────

	private renderBlock(grid: HTMLElement, block: PlannedBlock, dayW: number) {
		const left = block.day * dayW + 2;
		const top = ((block.startMin / 60) - this.START_HOUR) * this.HOUR_HEIGHT;
		const h = ((block.endMin - block.startMin) / 60) * this.HOUR_HEIGHT;

		const el = grid.createDiv();
		el.style.cssText = `
			position:absolute; left:${left}px; top:${top}px;
			width:${dayW - 4}px; height:${Math.max(h, 16)}px;
			background:${block.color}; color:white; border-radius:5px;
			padding:2px 5px; font-size:10px; overflow:hidden;
			cursor:grab; z-index:3; opacity:0.9;
			box-sizing:border-box; line-height:1.3;
			transition: box-shadow 0.1s;
		`;
		el.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${block.taskText.slice(0,30)}</div><div style="opacity:0.8;">${minToTimeStr(block.startMin, block.endMin)}</div><div class="bujo-block-actions" style="position:absolute;top:1px;right:3px;display:none;gap:2px;"><span class="bujo-block-dup" title="Alt+click to duplicate" style="cursor:pointer;font-size:10px;opacity:0.6;">⧉</span><span class="bujo-block-del" title="Delete" style="cursor:pointer;font-size:11px;opacity:0.7;">✕</span></div>`;

		// Show actions on hover
		el.onmouseenter = () => {
			const actions = el.querySelector('.bujo-block-actions') as HTMLElement;
			if (actions) actions.style.display = 'flex';
		};
		el.onmouseleave = () => {
			const actions = el.querySelector('.bujo-block-actions') as HTMLElement;
			if (actions) actions.style.display = 'none';
		};

		// Delete button
		el.querySelector('.bujo-block-del')?.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			this.deleteBlock(block);
		});

		// Duplicate button
		el.querySelector('.bujo-block-dup')?.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			this.duplicateBlock(block);
		});

		// Alt+click to duplicate
		el.addEventListener('click', (e) => {
			if (e.altKey) {
				e.stopPropagation();
				e.preventDefault();
				this.duplicateBlock(block);
			}
		});

		// ── Drag entire block to move ──
		let dragging = false, dragStartX = 0, dragStartY = 0, origDay = block.day, origStart = block.startMin;

		el.onmousedown = (e) => {
			if ((e.target as HTMLElement).classList.contains('bujo-resize')) return;
			dragging = true;
			dragStartX = e.clientX;
			dragStartY = e.clientY;
			origDay = block.day;
			origStart = block.startMin;
			el.style.zIndex = '20';
			el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
			el.style.opacity = '0.7';
			e.preventDefault();
		};

		const onMove = (e: MouseEvent) => {
			if (!dragging) return;
			const dx = e.clientX - dragStartX;
			const dy = e.clientY - dragStartY;
			const newDay = Math.max(0, Math.min(6, origDay + Math.round(dx / dayW)));
			const deltaMin = Math.round((dy / this.HOUR_HEIGHT) * 60 / this.SNAP_MIN) * this.SNAP_MIN;
			const ns = origStart + deltaMin;
			const newStart = Math.max(this.START_HOUR * 60, Math.min((this.END_HOUR - 1) * 60, ns));
			const dur = block.endMin - block.startMin;
			block.day = newDay;
			block.startMin = newStart;
			block.endMin = newStart + dur;
			el.style.left = `${newDay * dayW + 2}px`;
			el.style.top = `${((newStart / 60) - this.START_HOUR) * this.HOUR_HEIGHT}px`;
			el.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${block.taskText.slice(0,30)}</div><div style="opacity:0.8;">${minToTimeStr(block.startMin, block.endMin)}</div>`;
		};

		const onUp = () => {
			if (!dragging) return;
			dragging = false;
			el.style.zIndex = '3';
			el.style.boxShadow = '';
			el.style.opacity = '0.9';
			document.removeEventListener('mousemove', onMove);
			document.removeEventListener('mouseup', onUp);

			if (block.day !== origDay) {
				const origDate = this.weekStart.clone().add(origDay, 'days').format('YYYY-MM-DD');
				const today = moment().format('YYYY-MM-DD');

				if (origDate < today) {
					// Past day — migrate (remove from old, add to new)
					this.persistBlock(block, origDay);
					new Notice(`Migrated "${block.taskText.slice(0,20)}" → ${this.weekStart.clone().add(block.day, 'days').format('ddd')}`);
				} else {
					// Future/today — duplicate (keep on both days, create new block on new day)
					const dup: PlannedBlock = {
						...block, id: `b${Date.now()}`,
						day: block.day, startMin: block.startMin, endMin: block.endMin,
						sourceFile: '',
					};
					// Restore original in-memory position
					const origEnd = block.endMin;
					block.day = origDay;
					block.startMin = origStart;
					block.endMin = origEnd;
					// Add duplicate to memory and persist
					const task = this.tasks.find(t => t.task.text === block.taskText);
					if (task) task.blocks.push(dup);
					this.persistBlock(dup);
					new Notice(`Duplicated "${block.taskText.slice(0,20)}" → ${this.weekStart.clone().add(dup.day, 'days').format('ddd')}`);
				}
				this.renderPool();
				this.renderCalendar();
			} else {
				// Same day — just update time
				this.persistBlock(block);
			}
		};

		document.addEventListener('mousemove', onMove);
		document.addEventListener('mouseup', onUp);

		// ── Resize handle at bottom ──
		const handle = grid.createDiv({ cls: 'bujo-resize' });
		handle.style.cssText = `
			position:absolute; left:${left}px; top:${top + h - 6}px;
			width:${dayW - 4}px; height:12px; cursor:ns-resize; z-index:4;
		`;

		let resizing = false, resizeStartY = 0, resizeOrigEnd = block.endMin;
		handle.onmousedown = (e) => {
			resizing = true;
			resizeStartY = e.clientY;
			resizeOrigEnd = block.endMin;
			e.stopPropagation();
			e.preventDefault();
		};

		const onResizeMove = (e: MouseEvent) => {
			if (!resizing) return;
			const deltaMin = Math.round(((e.clientY - resizeStartY) / this.HOUR_HEIGHT) * 60 / this.SNAP_MIN) * this.SNAP_MIN;
			const ne = Math.max(block.startMin + 15, Math.min(this.END_HOUR * 60, resizeOrigEnd + deltaMin));
			block.endMin = ne;
			block.durationMin = ne - block.startMin;
			const nh = ((ne - block.startMin) / 60) * this.HOUR_HEIGHT;
			el.style.height = `${Math.max(nh, 16)}px`;
			handle.style.top = `${top + nh - 6}px`;
			el.innerHTML = `<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${block.taskText.slice(0,30)}</div><div style="opacity:0.8;">${minToTimeStr(block.startMin, block.endMin)}</div>`;
		};

		const onResizeUp = () => {
			if (!resizing) return;
			resizing = false;
			document.removeEventListener('mousemove', onResizeMove);
			document.removeEventListener('mouseup', onResizeUp);
			this.persistBlock(block);
		};

		document.addEventListener('mousemove', onResizeMove);
		document.addEventListener('mouseup', onResizeUp);
	}

	// ── Block persistence ───────────────────────────────────────────────────────

	private createBlock(taskText: string, sourceFile: string, day: number, startMin: number, endMin: number) {
		const color = this.tasks.find(t => t.task.text === taskText)?.blocks[0]?.color || nextColor();
		const block: PlannedBlock = {
			id: `b${Date.now()}`, taskText, day, startMin, endMin,
			durationMin: endMin - startMin, sourceFile, color,
		};

		let task = this.tasks.find(t => t.task.text === taskText);
		if (!task) {
			task = { task: { text: taskText, file: sourceFile, line: '' }, blocks: [], done: false };
			this.tasks.push(task);
		}
		task.blocks.push(block);

		this.persistBlock(block);
		this.renderPool();
		this.renderCalendar();
	}

	private async persistBlock(block: PlannedBlock, previousDay?: number) {
		const hash = taskHash(block.taskText);
		const dayDate = this.weekStart.clone().add(block.day, 'days').format('YYYY-MM-DD');
		const filePath = `Journal/001 Daily Notes/${dayDate}.md`;

		// ── Clean up old entry if block was migrated from a past day ──
		if (previousDay !== undefined && previousDay !== block.day) {
			const oldDate = this.weekStart.clone().add(previousDay, 'days').format('YYYY-MM-DD');
			const oldPath = `Journal/001 Daily Notes/${oldDate}.md`;
			await this.removeBlockFromFile(oldPath, hash, block.startMin, block.endMin);
		}

		// ── Write to new day ──
		let file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			const f = this.app.vault.getAbstractFileByPath('Journal/001 Daily Notes');
			if (!f) await this.app.vault.createFolder('Journal/001 Daily Notes');
			file = await this.app.vault.create(filePath, '');
		}
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');
		const timeStr = minToTimeStr(block.startMin, block.endMin);
		const blockLine = `\t- [@] ${timeStr}`;

		const norm = normalizeText(block.taskText);
		let parentIdx = -1, parentIndent = 0;

		// Find parent by hash or text
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line) continue;
			// Match by hash comment
			if (line.includes(`<!-- bujo:${hash} -->`)) {
				parentIdx = i;
				parentIndent = (line.match(/^(\s*)/)?.[1]?.length) || 0;
				break;
			}
		}

		// Fallback: match by text
		if (parentIdx === -1) {
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				if (!line) continue;
				const trimmed = line.trim();
				if (trimmed.startsWith('- [@]') || trimmed.startsWith('- [t]')) continue;
				if (/^\s*- \[/.test(line)) {
					const text = trimmed.replace(/^-\s*\[[^\]]*\]\s*/, '');
					const indent = (line.match(/^(\s*)/)?.[1]?.length) || 0;
					if (normalizeText(text) === norm && (parentIdx === -1 || indent <= parentIndent)) {
						parentIdx = i;
						parentIndent = indent;
						break;
					}
				}
			}
		}

		if (parentIdx === -1) {
			// Create parent task with hash ID
			lines.push(`- [ ] ${block.taskText} <!-- bujo:${hash} -->`);
			lines.push(blockLine);
		} else {
			// Ensure parent has hash ID
			if (!lines[parentIdx]!.includes('<!-- bujo:')) {
				lines[parentIdx] = lines[parentIdx]!.trimEnd() + ` <!-- bujo:${hash} -->`;
			}

			// Check if a block with this time already exists — replace it
			let replaced = false;
			for (let i = parentIdx + 1; i < lines.length; i++) {
				const li = lines[i];
				if (!li || !li.trim()) continue;
				const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
				if (indent <= parentIndent) break;
				// Match by same time range
				if (li.includes('[@]') && li.includes(timeStr)) {
					lines[i] = blockLine;
					replaced = true;
					break;
				}
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

		await this.app.vault.modify(file, lines.join('\n'));
		block.sourceFile = filePath;
	}

	/** Remove a specific [@] block from a file by finding the parent task hash and matching the time range */
	private async removeBlockFromFile(filePath: string, hash: string, startMin: number, endMin: number) {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;

		const content = await this.app.vault.read(file);
		const lines = content.split('\n');
		const timeStr = minToTimeStr(startMin, endMin);

		// Find parent by hash
		let parentIdx = -1, parentIndent = 0;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i]?.includes(`<!-- bujo:${hash} -->`)) {
				parentIdx = i;
				parentIndent = (lines[i]?.match(/^(\s*)/)?.[1]?.length) || 0;
				break;
			}
		}

		if (parentIdx === -1) return;

		// Remove matching [@] child by time range
		for (let i = parentIdx + 1; i < lines.length; i++) {
			const li = lines[i];
			if (!li || !li.trim()) continue;
			const indent = (li.match(/^(\s*)/)?.[1]?.length) || 0;
			if (indent <= parentIndent) break;
			if (li.includes('[@]') && li.includes(timeStr)) {
				lines.splice(i, 1);
				await this.app.vault.modify(file, lines.join('\n'));
				return;
			}
		}
	}

	/** Delete a block from the calendar and its markdown */
	private deleteBlock(block: PlannedBlock) {
		const hash = taskHash(block.taskText);

		// Remove from in-memory state
		const task = this.tasks.find(t => t.task.text === block.taskText);
		if (task) {
			const idx = task.blocks.indexOf(block);
			if (idx !== -1) task.blocks.splice(idx, 1);
		}

		// Remove from markdown
		this.removeBlockFromFile(block.sourceFile, hash, block.startMin, block.endMin);

		// Re-render
		this.renderPool();
		this.renderCalendar();
	}

	/** Duplicate a block (same task, new time slot) */
	private duplicateBlock(block: PlannedBlock) {
		const dup: PlannedBlock = {
			...block,
			id: `b${Date.now()}`,
			taskText: block.taskText,
			day: block.day,
			startMin: block.startMin + 60, // offset by 1 hour
			endMin: block.endMin + 60,
			durationMin: block.durationMin,
			sourceFile: block.sourceFile,
			color: block.color,
		};

		const task = this.tasks.find(t => t.task.text === block.taskText);
		if (task) {
			task.blocks.push(dup);
		}

		this.persistBlock(dup);
		this.renderCalendar();
	}
}
