import { Plugin } from "obsidian";

import { registerCommands } from "./commands";
import { DebugService } from "./debug/debugService";
import { ObsidianCardSettingTab, createDefaultSettings, parseSettings, type ObsidianCardSettings } from "./settings";
import { CardSidebarController, OBCARD_SIDEBAR_VIEW_TYPE } from "./ui/cardSidebarController";
import { CardSidebarView } from "./ui/cardSidebarView";
import { FlashcardWorkflow } from "./workflow/cardWorkflow";

export default class ObsidianCardPlugin extends Plugin {
	settings: ObsidianCardSettings = createDefaultSettings();
	debug!: DebugService;
	sidebar!: CardSidebarController;
	workflow!: FlashcardWorkflow;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.debug = new DebugService(this);
		this.sidebar = new CardSidebarController(this);
		this.workflow = new FlashcardWorkflow(this);
		this.registerView(OBCARD_SIDEBAR_VIEW_TYPE, (leaf) => new CardSidebarView(leaf, this));

		registerCommands(this);
		this.addSettingTab(new ObsidianCardSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(OBCARD_SIDEBAR_VIEW_TYPE);
	}

	async loadSettings(): Promise<void> {
		const storedSettings: unknown = await this.loadData();
		this.settings = parseSettings(storedSettings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
