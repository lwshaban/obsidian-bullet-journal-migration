// React Planning Workspace — ItemView that mounts Preact into an Obsidian pane.

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { render } from 'preact';
import { PlanningApp } from './components/PlanningApp';

export const VIEW_TYPE_PLANNING = 'bujo-planning-workspace';

export class PlanningWorkspaceView extends ItemView {

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
	}

	getViewType(): string { return VIEW_TYPE_PLANNING; }
	getDisplayText(): string { return 'Bujo Planning'; }
	getIcon(): string { return 'calendar-days'; }

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.style.cssText = 'height:100%;overflow:hidden;';
		render(<PlanningApp app={this.app} />, container);
	}

	async onClose() {
		const container = this.containerEl.children[1] as HTMLElement;
		render(null, container);
	}
}
