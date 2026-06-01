// TimeBlock — draggable, resizable calendar block.

import { useState, useRef, useCallback } from 'react';
import { Block, minToTimeStr } from '../hooks';

interface Props {
	block: Block;
	dayW: number;
	hourHeight: number;
	startHour: number;
	snapMin: number;
	endHour: number;
	onUpdate: (block: Block) => void;
	onDelete: (block: Block) => void;
	onDuplicate: (block: Block) => void;
}

export function TimeBlock({ block, dayW, hourHeight, startHour, snapMin, endHour, onUpdate, onDelete, onDuplicate }: Props) {
	const left = block.day * dayW + 2;
	const top = ((block.startMin / 60) - startHour) * hourHeight;
	const h = ((block.endMin - block.startMin) / 60) * hourHeight;

	const [hover, setHover] = useState(false);
	const [dragging, setDragging] = useState(false);
	const [resizing, setResizing] = useState(false);
	const dragRef = useRef({ x: 0, y: 0, origDay: block.day, origStart: block.startMin });
	const resizeRef = useRef({ y: 0, origEnd: block.endMin });

	// ── Drag to move ──
	const onMouseDown = useCallback((e: any) => {
		if ((e.target as HTMLElement).dataset.action === 'resize') return;
		setDragging(true);
		dragRef.current = { x: e.clientX, y: e.clientY, origDay: block.day, origStart: block.startMin };
		e.preventDefault();
	}, [block.day, block.startMin]);

	const onMouseMove = useCallback((e: MouseEvent) => {
		if (dragging) {
			const dx = e.clientX - dragRef.current.x;
			const dy = e.clientY - dragRef.current.y;
			const newDay = Math.max(0, Math.min(6, dragRef.current.origDay + Math.round(dx / dayW)));
			const deltaMin = Math.round((dy / hourHeight) * 60 / snapMin) * snapMin;
			const newStart = Math.max(startHour * 60, Math.min((endHour - 1) * 60, dragRef.current.origStart + deltaMin));
			block.day = newDay;
			block.startMin = newStart;
			block.endMin = newStart + block.durationMin;
			// Force re-render via parent
		}
		if (resizing) {
			const deltaMin = Math.round(((e.clientY - resizeRef.current.y) / hourHeight) * 60 / snapMin) * snapMin;
			block.endMin = Math.max(block.startMin + 15, Math.min(endHour * 60, resizeRef.current.origEnd + deltaMin));
			block.durationMin = block.endMin - block.startMin;
		}
	}, [dragging, resizing, dayW, hourHeight, snapMin, startHour, endHour]);

	const onMouseUp = useCallback(() => {
		if (dragging) { setDragging(false); onUpdate(block); }
		if (resizing) { setResizing(false); onUpdate(block); }
	}, [dragging, resizing, block, onUpdate]);

	// Attach global listeners
	useState(() => {
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
		return () => {
			document.removeEventListener('mousemove', onMouseMove);
			document.removeEventListener('mouseup', onMouseUp);
		};
	});

	// ── Resize handle ──
	const onResizeDown = useCallback((e: any) => {
		setResizing(true);
		resizeRef.current = { y: e.clientY, origEnd: block.endMin };
		e.stopPropagation();
		e.preventDefault();
	}, [block.endMin]);

	return (
		<>
			<div
				onMouseDown={onMouseDown}
				onMouseEnter={() => setHover(true)}
				onMouseLeave={() => setHover(false)}
				onDblClick={(e: any) => { if (e.altKey) { onDuplicate(block); } }}
				style={{
					position: 'absolute', left, top, width: dayW - 4, height: Math.max(h, 16),
					background: block.color, color: 'white', borderRadius: 5,
					padding: '2px 5px', fontSize: 10, overflow: 'hidden',
					cursor: dragging ? 'grabbing' : 'grab', zIndex: dragging ? 20 : 3,
					opacity: dragging ? 0.7 : 0.9,
					boxShadow: dragging ? '0 4px 12px rgba(0,0,0,0.3)' : undefined,
					boxSizing: 'border-box', lineHeight: 1.3,
				}}>
				<div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
					{block.taskText.slice(0, 30)}
				</div>
				<div style={{ opacity: 0.8 }}>{minToTimeStr(block.startMin, block.endMin)}</div>

				{hover && (
					<div style={{ position: 'absolute', top: 1, right: 3, display: 'flex', gap: 2 }}>
						<span onClick={(e: any) => { e.stopPropagation(); onDuplicate(block); }} style={{ cursor: 'pointer', fontSize: 10, opacity: 0.7 }} title="Duplicate">⧉</span>
						<span onClick={(e: any) => { e.stopPropagation(); onDelete(block); }} style={{ cursor: 'pointer', fontSize: 11, opacity: 0.7 }} title="Delete">✕</span>
					</div>
				)}
			</div>

			{/* Resize handle */}
			<div
				data-action="resize"
				onMouseDown={onResizeDown}
				style={{
					position: 'absolute', left, top: top + h - 6, width: dayW - 4, height: 12,
					cursor: 'ns-resize', zIndex: 4,
				}}
			/>
		</>
	);
}
