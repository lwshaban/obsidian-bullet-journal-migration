// TaskPool — sidebar with task cards, grouped by section (scheduled / needs review / done).

import { useState } from 'react';
import { App, TFile } from 'obsidian';
import { TaskWithBlocks } from '../hooks';
import { normalizeText, getTaskText } from '../../utils';
import { MigrationPicker } from './MigrationPicker';

interface Props {
	tasks: TaskWithBlocks[];
	app: App;
	doneCollapsed: boolean;
	onToggleDoneCollapsed: () => void;
	onToggleDone: (task: TaskWithBlocks) => void;
}

export function TaskPool({ tasks, app, doneCollapsed, onToggleDoneCollapsed, onToggleDone }: Props) {
	const [filter, setFilter] = useState('');
	const [migratingTask, setMigratingTask] = useState<TaskWithBlocks | null>(null);

	const scheduled = tasks.filter(t => t.blocks.length > 0 && !t.done);
	const unscheduled = tasks.filter(t => t.blocks.length === 0 && !t.done);
	const done = tasks.filter(t => t.done);

	const matchFilter = (t: TaskWithBlocks) => !filter || t.task.text.toLowerCase().includes(filter.toLowerCase());

	return (
		<div style={{ width: 280, borderRight: '1px solid var(--background-modifier-border)', overflowY: 'auto', background: 'var(--background-secondary)', flexShrink: 0 }}>
			{/* Search */}
			<div style={{ position: 'sticky', top: 0, zIndex: 5, padding: 10, background: 'var(--background-secondary)', borderBottom: '1px solid var(--background-modifier-border)' }}>
				<input
					type="text" placeholder="Filter tasks..." value={filter} onInput={e => setFilter((e.target as HTMLInputElement).value)}
					style={{ width: '100%', padding: '6px 10px', border: '1px solid var(--background-modifier-border)', borderRadius: 6, fontSize: 12, background: 'var(--background-primary)', color: 'var(--text-normal)', boxSizing: 'border-box' }}
				/>
			</div>

			{renderSection('📅 Scheduled', scheduled, filter, false, onToggleDone, app, setMigratingTask, matchFilter)}
			{renderSection('Needs review', unscheduled, filter, false, onToggleDone, app, setMigratingTask, matchFilter)}
			{renderSection('Done', done, filter, doneCollapsed, onToggleDone, app, setMigratingTask, matchFilter, onToggleDoneCollapsed)}

			{/* Migration picker modal */}
			{migratingTask && (
				<MigrationPicker
					task={migratingTask}
					app={app}
					onClose={() => setMigratingTask(null)}
					onMigrate={(marker) => {
						handleMigrate(app, migratingTask, marker);
						setMigratingTask(null);
					}}
				/>
			)}
		</div>
	);
}

// ── Section ──

function renderSection(
	title: string,
	tasks: TaskWithBlocks[],
	filter: string,
	collapsed: boolean,
	onToggleDone: (t: TaskWithBlocks) => void,
	app: App,
	onMigrate: (t: TaskWithBlocks) => void,
	matchFilter: (t: TaskWithBlocks) => boolean,
	onToggleCollapse?: () => void,
) {
	const [isCollapsed, setCollapsed] = useState(collapsed);
	const visible = tasks.filter(matchFilter);

	return (
		<div>
			<div
				onClick={() => { setCollapsed(v => !v); onToggleCollapse?.(); }}
				style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 12px 4px', cursor: 'pointer', userSelect: 'none' }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
					<span style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-muted)', letterSpacing: '.5px' }}>{title}</span>
					<span style={{ fontSize: 10, color: 'var(--text-faint)', background: 'var(--background-modifier-border)', padding: '1px 6px', borderRadius: 99 }}>{visible.length}</span>
				</div>
				<span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{isCollapsed ? '▸' : '▾'}</span>
			</div>

			{!isCollapsed && visible.length > 0 && (
				<div style={{ padding: '2px 8px' }}>
					{visible.map(task => (
						<TaskCard key={task.task.text} task={task} onToggleDone={onToggleDone} onMigrate={() => onMigrate(task)} />
					))}
				</div>
			)}

			{!isCollapsed && visible.length === 0 && tasks.length > 0 && (
				<div style={{ padding: 12, fontSize: 12, color: 'var(--text-faint)', textAlign: 'center' }}>No matches</div>
			)}
		</div>
	);
}

// ── Task card ──

function TaskCard({ task, onToggleDone, onMigrate }: { task: TaskWithBlocks; onToggleDone: (t: TaskWithBlocks) => void; onMigrate: () => void }) {
	const [hover, setHover] = useState(false);
	const dur = task.blocks.reduce((s, b) => s + b.durationMin, 0);
	const h = Math.floor(dur / 60), m = dur % 60;

	return (
		<div
			onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
			onClick={onMigrate}
			draggable
			onDragStart={(e: any) => e.dataTransfer!.setData('text/plain', JSON.stringify({ taskText: task.task.text, sourceFile: task.task.file }))}
			style={{
				margin: '1px 0', padding: '8px 10px', borderRadius: 6, cursor: 'grab', fontSize: 13, lineHeight: 1.4,
				border: `1px solid ${hover ? 'var(--background-modifier-border)' : 'transparent'}`,
				background: 'var(--background-primary)', opacity: task.done ? 0.5 : 1,
				transition: 'all .12s',
			}}>
			{/* Color dot */}
			{task.blocks[0] && <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 99, background: task.blocks[0].color, marginRight: 6, verticalAlign: 'middle' }} />}
			<span style={{ textDecoration: task.done ? 'line-through' : 'none', color: task.done ? 'var(--text-faint)' : 'var(--text-normal)' }}>
				{task.task.text.slice(0, 80)}
			</span>

			{hover && (
				<div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
					<button onClick={e => { e.stopPropagation(); onMigrate(); }} style={actionBtn(true)}>→ Migrate</button>
					<button onClick={e => { e.stopPropagation(); onToggleDone(task); }} style={actionBtn(false)}>{task.done ? '↩ Restore' : '✓ Done'}</button>
				</div>
			)}

			{task.blocks.length > 0 && (
				<div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
					{task.blocks.length} block{task.blocks.length > 1 ? 's' : ''} · {h > 0 ? `${h}h ` : ''}{m}m
				</div>
			)}
		</div>
	);
}

const actionBtn = (primary: boolean) => ({
	padding: '3px 8px', border: primary ? '1px solid var(--interactive-accent)' : '1px solid var(--background-modifier-border)',
	borderRadius: 4, fontSize: 10, fontWeight: 500,
	color: primary ? 'var(--interactive-accent)' : 'var(--text-muted)',
	background: 'transparent', cursor: 'pointer',
});

// ── Migration helper ──

async function handleMigrate(app: App, task: TaskWithBlocks, marker: string) {
	const file = app.vault.getAbstractFileByPath(task.task.file);
	if (!(file instanceof TFile)) return;
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const norm = task.task.text.toLowerCase().trim();
	for (let i = 0; i < lines.length; i++) {
		const text = (lines[i]?.trim().replace(/^-\s*\[[^\]]*\]\s*/, '') || '').toLowerCase();
		if (text === norm) {
			const indent = (lines[i]?.match(/^(\s*)/)?.[1]) || '';
			lines[i] = `${indent}- ${marker} ${task.task.text}`;
			await app.vault.modify(file, lines.join('\n'));
			break;
		}
	}
}
