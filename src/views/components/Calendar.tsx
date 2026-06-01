// Calendar — week grid with TimeBlocks. Handles drop zones and rendering.

import { useState, useCallback } from 'react';
import { moment } from 'obsidian';
import { TaskWithBlocks, Block, minToTimeStr } from '../hooks';
import { TimeBlock } from './TimeBlock';

interface Props {
	weekStart: moment.Moment;
	tasks: TaskWithBlocks[];
	onCreateBlock: (taskText: string, sourceFile: string, day: number, startMin: number, endMin: number) => void;
	onUpdateBlock: (block: Block) => void;
	onDeleteBlock: (block: Block) => void;
	onDuplicateBlock: (block: Block) => void;
}

const HOUR_HEIGHT = 56;
const START_HOUR = 5;
const END_HOUR = 23;
const SNAP_MIN = 15;
const TIME_LABEL = 48;

export function Calendar({ weekStart, tasks, onCreateBlock, onUpdateBlock, onDeleteBlock, onDuplicateBlock }: Props) {
	const days = Array.from({ length: 7 }, (_, d) => weekStart.clone().add(d, 'days'));
	const totalHours = END_HOUR - START_HOUR;
	const totalHeight = totalHours * HOUR_HEIGHT;
	const [gridW, setGridW] = useState(800);
	const dayW = (gridW - TIME_LABEL) / 7;

	// Measure container on mount/resize
	const measuredRef = useCallback((node: HTMLDivElement | null) => {
		if (node) { setGridW(node.clientWidth); }
	}, []);

	// All blocks across all tasks
	const allBlocks = tasks.flatMap(t => t.blocks);

	// Today line
	const now = moment();
	const nowDay = now.isoWeekday() - 1;
	const nowY = ((now.hour() * 60 + now.minute()) / 60 - START_HOUR) * HOUR_HEIGHT;

	return (
		<div ref={measuredRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
			{/* Day headers */}
			<div style={{ display: 'flex', position: 'sticky', top: 0, zIndex: 5, background: 'var(--background-primary)', borderBottom: '1px solid var(--background-modifier-border)', paddingLeft: TIME_LABEL }}>
				{days.map((day, d) => {
					const isToday = day.format('YYYY-MM-DD') === now.format('YYYY-MM-DD');
					return (
						<div key={d} style={{
							flex: 1, textAlign: 'center', padding: '5px 0', fontSize: 12, fontWeight: 600,
							...(isToday ? { background: 'var(--interactive-accent)', color: 'white', borderRadius: 4 } : {}),
						}}>
							{day.format('ddd D')}
						</div>
					);
				})}
			</div>

			{/* Grid */}
			<div style={{ position: 'relative', minHeight: totalHeight, paddingLeft: TIME_LABEL }}>
				{/* Time labels + grid lines */}
				{Array.from({ length: totalHours + 1 }, (_, i) => {
					const h = START_HOUR + i;
					const y = i * HOUR_HEIGHT;
					return (
						<div key={h}>
							<div style={{ position: 'absolute', left: -TIME_LABEL, top: y, width: TIME_LABEL - 4, textAlign: 'right', fontSize: 10, color: 'var(--text-muted)', transform: 'translateY(-7px)', paddingRight: 4 }}>
								{String(h).padStart(2, '0')}:00
							</div>
							<div style={{ position: 'absolute', left: 0, top: y, right: 0, height: 1, background: 'var(--background-modifier-border)' }} />
						</div>
					);
				})}

				{/* Day columns (drop zones) */}
				{days.map((day, d) => (
					<DropZone key={d} day={d} dayW={dayW} totalHeight={totalHeight} onCreateBlock={onCreateBlock} />
				))}

				{/* Time blocks */}
				{allBlocks.map(block => (
					<TimeBlock
						key={block.id}
						block={block}
						dayW={dayW}
						hourHeight={HOUR_HEIGHT}
						startHour={START_HOUR}
						snapMin={SNAP_MIN}
						endHour={END_HOUR}
						onUpdate={onUpdateBlock}
						onDelete={onDeleteBlock}
						onDuplicate={onDuplicateBlock}
					/>
				))}

				{/* Now line */}
				{nowDay >= 0 && nowDay < 7 && nowY > 0 && nowY < totalHeight && (
					<div style={{ position: 'absolute', left: nowDay * dayW, top: nowY, width: dayW, height: 2, background: 'var(--interactive-accent)', zIndex: 10, pointerEvents: 'none' }} />
				)}
			</div>
		</div>
	);
}

// ── Drop zone (one per day column) ──

function DropZone({ day, dayW, totalHeight, onCreateBlock }: { day: number; dayW: number; totalHeight: number; onCreateBlock: Props['onCreateBlock'] }) {
	const [hover, setHover] = useState(false);

	return (
		<div
			style={{
				position: 'absolute', left: day * dayW, top: 0, width: dayW, height: totalHeight,
				borderRight: '1px solid var(--background-modifier-border)',
				background: hover ? 'var(--background-modifier-hover)' : 'transparent',
				transition: 'background 0.1s',
			}}
			onDragOver={e => { e.preventDefault(); setHover(true); }}
			onDragLeave={() => setHover(false)}
			onDrop={e => {
				e.preventDefault(); setHover(false);
				const raw = e.dataTransfer?.getData('text/plain');
				if (!raw) return;
				try {
					const { taskText, sourceFile } = JSON.parse(raw) as { taskText: string; sourceFile: string };
					const rect = (e.target as HTMLElement).getBoundingClientRect();
					const y = e.clientY - rect.top;
					const rawMin = (y / HOUR_HEIGHT + START_HOUR) * 60;
					const startMin = Math.round(rawMin / SNAP_MIN) * SNAP_MIN;
					const clamped = Math.max(START_HOUR * 60, Math.min((END_HOUR - 1) * 60, startMin));
					onCreateBlock(taskText, sourceFile, day, clamped, clamped + 60);
				} catch { /* ignore */ }
			}}
		/>
	);
}
