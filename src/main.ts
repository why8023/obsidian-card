import { Plugin } from "obsidian";

import { registerCommands } from "./commands";
import { DebugService } from "./debug/debugService";
import { ObsidianCardSettingTab, createDefaultSettings, parseSettings, type ObsidianCardSettings } from "./settings";
import { FlashcardWorkflow } from "./workflow/cardWorkflow";

export default class ObsidianCardPlugin extends Plugin {
	settings: ObsidianCardSettings = createDefaultSettings();
	debug!: DebugService;
	workflow!: FlashcardWorkflow;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.debug = new DebugService(this);
		this.workflow = new FlashcardWorkflow(this);

		registerCommands(this);
		this.addSettingTab(new ObsidianCardSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		const storedSettings: unknown = await this.loadData();
		this.settings = parseSettings(storedSettings);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
