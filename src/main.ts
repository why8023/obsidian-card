import { Plugin } from "obsidian";

import { registerCommands } from "./commands";
import { DebugService } from "./debug/debugService";
import { ObcdSettingTab, createDefaultSettings, parseSettings, type ObcdSettings } from "./settings";
import { CardSidebarController, OBCD_SIDEBAR_VIEW_TYPE } from "./ui/cardSidebarController";
import { CardSidebarView } from "./ui/cardSidebarView";
import { FlashcardWorkflow } from "./workflow/cardWorkflow";

export default class ObcdPlugin extends Plugin {
	settings: ObcdSettings = createDefaultSettings();
	debug!: DebugService;
	sidebar!: CardSidebarController;
	workflow!: FlashcardWorkflow;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.debug = new DebugService(this);
		this.sidebar = new CardSidebarController(this);
		this.workflow = new FlashcardWorkflow(this);
		this.registerView(OBCD_SIDEBAR_VIEW_TYPE, (leaf) => new CardSidebarView(leaf, this));

		registerCommands(this);
		this.addSettingTab(new ObcdSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const storedSettings: unknown = await this.loadData();
		this.settings = parseSettings(storedSettings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
