import { App, PluginSettingTab, Setting } from "obsidian";

import { getDebugArtifactsDirectory } from "./debug/debugService";
import type ObcdPlugin from "./main";
import {
	DEFAULT_OBAR_FRONTMATTER_KEYS,
	normalizeObarFrontmatterKeys,
} from "./obarCompatibility";
import {
	PROVIDER_PRESET_INFO,
	createDefaultProvider,
	getActiveProvider,
	getDefaultModelForPreset,
	getProviderChatCompletionsUrl,
	type FlashcardProvider,
	type FlashcardProviderPresetType,
} from "./providerConfig";
import {
	listPromptTemplateFiles,
	normalizeConfiguredFolderPath,
	normalizeConfiguredTemplatePath,
} from "./prompts/promptResolver";
import { SIDEBAR_TABLE_COLUMN_IDS, type SidebarTableColumnId } from "./types";

const SETTINGS_SCHEMA_VERSION = 8;

export interface FlashcardGenerationSettings {
	model: string;
	maxCardsPerChunk: number;
	temperature: number;
	addObcdTag: boolean;
}

export interface ObcdDebugSettings {
	enabled: boolean;
}

export interface ObcdSidebarSettings {
	frontPreviewLength: number;
	visibleTableColumns: SidebarTableColumnId[];
}

export interface ObcdObarCompatibilitySettings {
	enabled: boolean;
	frontmatterKeys: string[];
}

export interface ObcdCompatibilitySettings {
	obar: ObcdObarCompatibilitySettings;
}

export interface ObcdFolderPromptRule {
	noteFolder: string;
	templatePath: string;
}

export interface ObcdPromptSettings {
	globalPrompt: string;
	templatesFolder: string;
	folderRules: ObcdFolderPromptRule[];
}

export interface ObcdSettings {
	version: number;
	providers: FlashcardProvider[];
	activeProviderId: string;
	generation: FlashcardGenerationSettings;
	prompts: ObcdPromptSettings;
	sidebar: ObcdSidebarSettings;
	compatibility: ObcdCompatibilitySettings;
	debug: ObcdDebugSettings;
}

export const DEFAULT_GENERATION_SETTINGS: FlashcardGenerationSettings = {
	model: getDefaultModelForPreset("openrouter"),
	maxCardsPerChunk: 3,
	temperature: 0.2,
	addObcdTag: true,
};

export const DEFAULT_SIDEBAR_SETTINGS: ObcdSidebarSettings = {
	frontPreviewLength: 72,
	visibleTableColumns: ["target"],
};

export const DEFAULT_PROMPT_SETTINGS: ObcdPromptSettings = {
	globalPrompt: "",
	templatesFolder: "",
	folderRules: [],
};

export const DEFAULT_DEBUG_SETTINGS: ObcdDebugSettings = {
	enabled: false,
};

export const DEFAULT_COMPATIBILITY_SETTINGS: ObcdCompatibilitySettings = {
	obar: {
		enabled: false,
		frontmatterKeys: [...DEFAULT_OBAR_FRONTMATTER_KEYS],
	},
};

export const DEFAULT_SETTINGS: ObcdSettings = createDefaultSettings();

export function createDefaultSettings(): ObcdSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [createDefaultProvider("openrouter")],
		activeProviderId: "primary",
		generation: {
			...DEFAULT_GENERATION_SETTINGS,
		},
		prompts: {
			...DEFAULT_PROMPT_SETTINGS,
			folderRules: [],
		},
		sidebar: {
			...DEFAULT_SIDEBAR_SETTINGS,
			visibleTableColumns: [...DEFAULT_SIDEBAR_SETTINGS.visibleTableColumns],
		},
		compatibility: {
			obar: {
				...DEFAULT_COMPATIBILITY_SETTINGS.obar,
				frontmatterKeys: [...DEFAULT_COMPATIBILITY_SETTINGS.obar.frontmatterKeys],
			},
		},
		debug: {
			...DEFAULT_DEBUG_SETTINGS,
		},
	};
}

export function parseSettings(data: unknown): ObcdSettings {
	const defaults = createDefaultSettings();
	if (!isRecord(data)) {
		return defaults;
	}

	const providers = parseProviders(data.providers, defaults.providers);
	const activeProviderId = typeof data.activeProviderId === "string" && providers.some((provider) => provider.id === data.activeProviderId)
		? data.activeProviderId
		: providers[0]?.id ?? defaults.activeProviderId;

	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers,
		activeProviderId,
		generation: parseGenerationSettings(data.generation, defaults.generation),
		prompts: parsePromptSettings(data.prompts, defaults.prompts),
		sidebar: parseSidebarSettings(data.sidebar, defaults.sidebar),
		compatibility: parseCompatibilitySettings(data.compatibility, defaults.compatibility),
		debug: parseDebugSettings(data.debug, defaults.debug),
	};
}

export class ObcdSettingTab extends PluginSettingTab {
	plugin: ObcdPlugin;

	constructor(app: App, plugin: ObcdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const activeProvider = getActiveProvider(this.plugin.settings);
		const presetInfo = PROVIDER_PRESET_INFO[activeProvider.presetType];
		const templateOptions = listPromptTemplateFiles(this.app, this.plugin.settings.prompts.templatesFolder);

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Configure the service used to generate flashcard candidates.")
			.setHeading();

		containerEl.createEl("p", {
			cls: "obcd-settings-hint",
			text: presetInfo.description,
		});

		new Setting(containerEl)
			.setName("Provider preset")
			.setDesc("Choose a provider profile, then adjust the resolved base URL if needed.")
			.addDropdown((dropdown) => {
				for (const [presetType, info] of Object.entries(PROVIDER_PRESET_INFO) as Array<[FlashcardProviderPresetType, typeof presetInfo]>) {
					dropdown.addOption(presetType, info.label);
				}

				dropdown
					.setValue(activeProvider.presetType)
					.onChange(async (value) => {
						const currentProvider = getActiveProvider(this.plugin.settings);
						const nextPresetType = value as FlashcardProviderPresetType;
						const previousDefaultModel = getDefaultModelForPreset(currentProvider.presetType);
						const nextDefaultModel = getDefaultModelForPreset(nextPresetType);

						this.updateActiveProvider({
							...currentProvider,
							presetType: nextPresetType,
							baseUrl: PROVIDER_PRESET_INFO[nextPresetType].defaultBaseUrl,
						});

						if (this.plugin.settings.generation.model.trim().length === 0 || this.plugin.settings.generation.model === previousDefaultModel) {
							this.plugin.settings.generation.model = nextDefaultModel;
						}

						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("Base URL only. The chat completions path is appended automatically.")
			.addText((text) => text
				.setPlaceholder(PROVIDER_PRESET_INFO[activeProvider.presetType].defaultBaseUrl)
				.setValue(activeProvider.baseUrl)
				.onChange(async (value) => {
					this.updateActiveProvider({
						...getActiveProvider(this.plugin.settings),
						baseUrl: value.trim(),
					});
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Access key")
			.setDesc(presetInfo.requireApiKey
				? "Required for this provider preset."
				: "Optional for local or proxy providers.")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Enter access key")
					.setValue(activeProvider.apiKey)
					.onChange(async (value) => {
						this.updateActiveProvider({
							...getActiveProvider(this.plugin.settings),
							apiKey: value.trim(),
						});
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Resolved request URL")
			.setDesc("Computed from the preset and base URL. This is the final endpoint used for generation.")
			.addText((text) => text
				.setValue(getProviderChatCompletionsUrl(activeProvider))
				.setDisabled(true));

		new Setting(containerEl)
			.setName("Generation")
			.setDesc("Model and sampling options used after the provider is resolved.")
			.setHeading();

		new Setting(containerEl)
			.setName("Model name")
			.setDesc(`Recommended default for ${presetInfo.label}: ${presetInfo.defaultModel}`)
			.addText((text) => text
				.setPlaceholder(presetInfo.defaultModel)
				.setValue(this.plugin.settings.generation.model)
				.onChange(async (value) => {
					this.plugin.settings.generation.model = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Max cards per chunk")
			.setDesc("Upper bound for each selection or heading chunk.")
			.addText((text) => text
				.setPlaceholder("3")
				.setValue(String(this.plugin.settings.generation.maxCardsPerChunk))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxCardsPerChunk = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Temperature")
			.setDesc("Lower values keep answers tighter and more predictable.")
			.addText((text) => text
				.setPlaceholder("0.2")
				.setValue(String(this.plugin.settings.generation.temperature))
				.onChange(async (value) => {
					const parsedValue = Number.parseFloat(value);
					if (Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 2) {
						this.plugin.settings.generation.temperature = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Add default obcd tag")
			.setDesc("Append the obcd tag to every generated card before review and insertion.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.generation.addObcdTag)
				.onChange(async (value) => {
					this.plugin.settings.generation.addObcdTag = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Prompts")
			.setDesc("Choose the global fallback prompt and folder-specific prompt templates.")
			.setHeading();

		new Setting(containerEl)
			.setName("Global prompt")
			.setDesc("Used when no folder rule matches. Leave empty to fall back to the built-in default prompt.")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("Describe how flashcards should be generated by default.")
					.setValue(this.plugin.settings.prompts.globalPrompt)
					.onChange(async (value) => {
						this.plugin.settings.prompts.globalPrompt = value;
						await this.plugin.saveSettings();
					});

				textArea.inputEl.rows = 8;
				textArea.inputEl.cols = 40;
			});

		new Setting(containerEl)
			.setName("Prompt templates folder")
			.setDesc("Vault-relative folder containing Markdown prompt templates. Use / for the vault root.")
			.addText((text) => {
				text
					.setPlaceholder("Prompts/flashcards")
					.setValue(this.plugin.settings.prompts.templatesFolder)
					.onChange(async (value) => {
						this.plugin.settings.prompts.templatesFolder = normalizeConfiguredFolderPath(value);
						await this.plugin.saveSettings();
					});

				text.inputEl.addEventListener("blur", () => this.display());
			});

		containerEl.createEl("p", {
			cls: "obcd-settings-hint",
			text: this.describePromptTemplateState(templateOptions),
		});

		new Setting(containerEl)
			.setName("Folder prompt rules")
			.setDesc("The closest matching folder wins. Rules apply to that folder and all of its descendants.")
			.addButton((button) => button
				.setButtonText("Add rule")
				.onClick(async () => {
					this.plugin.settings.prompts.folderRules = [
						...this.plugin.settings.prompts.folderRules,
						createEmptyFolderPromptRule(),
					];
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.prompts.folderRules.length === 0) {
			containerEl.createEl("p", {
				cls: "obcd-settings-hint",
				text: "No folder prompt rules yet.",
			});
		}

		this.plugin.settings.prompts.folderRules.forEach((rule, index) => {
			new Setting(containerEl)
				.setName(`Folder rule ${index + 1}`)
				.setDesc("Map a note folder to a prompt template file from the configured templates folder.")
				.addText((text) => text
					.setPlaceholder("Projects/biology")
					.setValue(rule.noteFolder)
					.onChange(async (value) => {
						await this.updateFolderPromptRule(index, {
							noteFolder: normalizeConfiguredFolderPath(value),
						});
					}))
				.addDropdown((dropdown) => {
					dropdown.addOption("", templateOptions.length === 0 ? "No templates found" : "Select a template");

					for (const templateOption of templateOptions) {
						dropdown.addOption(templateOption, templateOption);
					}

					const normalizedTemplatePath = normalizeConfiguredTemplatePath(rule.templatePath);
					if (normalizedTemplatePath.length > 0 && !templateOptions.includes(normalizedTemplatePath)) {
						dropdown.addOption(normalizedTemplatePath, `${normalizedTemplatePath} (missing)`);
					}

					dropdown
						.setValue(normalizedTemplatePath)
						.onChange(async (value) => {
							await this.updateFolderPromptRule(index, {
								templatePath: normalizeConfiguredTemplatePath(value),
							});
						});
				})
				.addExtraButton((button) => button
					.setIcon("trash")
					.setTooltip("Remove folder rule")
					.onClick(async () => {
						this.plugin.settings.prompts.folderRules = this.plugin.settings.prompts.folderRules
							.filter((_, currentIndex) => currentIndex !== index);
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		new Setting(containerEl)
			.setName("Sidebar")
			.setDesc("Display settings for the inserted flashcards table in the sidebar.")
			.setHeading();

		new Setting(containerEl)
			.setName("Question preview length")
			.setDesc("Maximum characters shown for each question in the inserted cards table. Range: 20 to 200.")
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SIDEBAR_SETTINGS.frontPreviewLength))
				.setValue(String(this.plugin.settings.sidebar.frontPreviewLength))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue >= 20 && parsedValue <= 200) {
						this.plugin.settings.sidebar.frontPreviewLength = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("Compatibility")
			.setDesc("Integration behavior for notes generated by other plugins.")
			.setHeading();

		new Setting(containerEl)
			.setName("Enable obar compatibility")
			.setDesc("When a note frontmatter contains configured obar keys, wrap inserted flashcards in an obar custom note block.")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.compatibility.obar.enabled)
				.onChange(async (value) => {
					this.plugin.settings.compatibility.obar.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Obar frontmatter keys")
			.setDesc("Comma-separated keys. If any configured key is present in frontmatter, the file is treated as an obar record.")
			.addText((text) => text
				.setPlaceholder(DEFAULT_OBAR_FRONTMATTER_KEYS.join(", "))
				.setValue(this.plugin.settings.compatibility.obar.frontmatterKeys.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.compatibility.obar.frontmatterKeys = parseCommaSeparatedValues(
						value,
						DEFAULT_OBAR_FRONTMATTER_KEYS,
					);
					await this.plugin.saveSettings();
				}));

		const debugArtifactsDirectory = getDebugArtifactsDirectory(
			this.plugin.app.vault.configDir,
			this.plugin.manifest.dir,
			this.plugin.manifest.id,
		);

		new Setting(containerEl)
			.setName("Debug")
			.setDesc("Verbose logs and saved local data for troubleshooting generation issues.")
			.setHeading();

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc(`Print detailed logs to the developer console and save local debug artifacts to ${debugArtifactsDirectory}. Saved artifacts may include note excerpts and AI responses.`)
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.debug.enabled)
				.onChange(async (value) => {
					this.plugin.settings.debug.enabled = value;
					await this.plugin.saveSettings();
				}));
	}

	private updateActiveProvider(provider: FlashcardProvider): void {
		this.plugin.settings.providers = this.plugin.settings.providers.map((currentProvider) => (
			currentProvider.id === provider.id ? provider : currentProvider
		));
	}

	private describePromptTemplateState(templateOptions: string[]): string {
		const templatesFolder = this.plugin.settings.prompts.templatesFolder;
		if (templatesFolder.length === 0) {
			return "Set a prompt templates folder to enable reusable Markdown prompt files.";
		}

		if (templateOptions.length === 0) {
			return `No Markdown prompt templates were found in ${templatesFolder}.`;
		}

		return `${templateOptions.length} prompt template${templateOptions.length === 1 ? "" : "s"} available in ${templatesFolder}.`;
	}

	private async updateFolderPromptRule(index: number, update: Partial<ObcdFolderPromptRule>): Promise<void> {
		this.plugin.settings.prompts.folderRules = this.plugin.settings.prompts.folderRules.map((rule, currentIndex) => (
			currentIndex === index
				? {
					...rule,
					...update,
				}
				: rule
		));
		await this.plugin.saveSettings();
	}
}

function parseProviders(value: unknown, fallback: FlashcardProvider[]): FlashcardProvider[] {
	if (!Array.isArray(value)) {
		return fallback.map(cloneProvider);
	}

	const providers = value
		.map((entry, index) => parseProvider(entry, index))
		.filter((provider): provider is FlashcardProvider => provider !== null);

	return providers.length > 0 ? providers : fallback.map(cloneProvider);
}

function parseGenerationSettings(value: unknown, fallback: FlashcardGenerationSettings): FlashcardGenerationSettings {
	const generationSource = isRecord(value) ? value : {};

	return {
		model: readString(generationSource.model, fallback.model),
		maxCardsPerChunk: readNumber(generationSource.maxCardsPerChunk, fallback.maxCardsPerChunk, { min: 1, max: 20 }),
		temperature: readNumber(generationSource.temperature, fallback.temperature, { min: 0, max: 2 }),
		addObcdTag: readBoolean(generationSource.addObcdTag, fallback.addObcdTag),
	};
}

function parsePromptSettings(value: unknown, fallback: ObcdPromptSettings): ObcdPromptSettings {
	const promptSource = isRecord(value) ? value : {};

	return {
		globalPrompt: readString(promptSource.globalPrompt, fallback.globalPrompt),
		templatesFolder: normalizeConfiguredFolderPath(readString(promptSource.templatesFolder, fallback.templatesFolder)),
		folderRules: parseFolderPromptRules(promptSource.folderRules),
	};
}

function parseSidebarSettings(value: unknown, fallback: ObcdSidebarSettings): ObcdSidebarSettings {
	const sidebarSource = isRecord(value) ? value : {};

	return {
		frontPreviewLength: readNumber(sidebarSource.frontPreviewLength, fallback.frontPreviewLength, { min: 20, max: 200 }),
		visibleTableColumns: readSidebarColumns(sidebarSource.visibleTableColumns, fallback.visibleTableColumns),
	};
}

function parseDebugSettings(value: unknown, fallback: ObcdDebugSettings): ObcdDebugSettings {
	const debugSource = isRecord(value) ? value : {};

	return {
		enabled: readBoolean(debugSource.enabled, fallback.enabled),
	};
}

function parseCompatibilitySettings(value: unknown, fallback: ObcdCompatibilitySettings): ObcdCompatibilitySettings {
	const compatibilitySource = isRecord(value) ? value : {};
	const obarSource = isRecord(compatibilitySource.obar) ? compatibilitySource.obar : {};

	return {
		obar: {
			enabled: readBoolean(obarSource.enabled, fallback.obar.enabled),
			frontmatterKeys: normalizeObarFrontmatterKeys(obarSource.frontmatterKeys, fallback.obar.frontmatterKeys),
		},
	};
}

function parseProvider(value: unknown, index: number): FlashcardProvider | null {
	if (!isRecord(value)) {
		return null;
	}

	const presetType = readPresetType(value.presetType, "openrouter");
	const defaultProvider = createDefaultProvider(presetType);

	return {
		id: readString(value.id, index === 0 ? "primary" : `provider-${index + 1}`),
		presetType,
		baseUrl: readString(value.baseUrl, defaultProvider.baseUrl),
		apiKey: readString(value.apiKey, ""),
	};
}

function cloneProvider(provider: FlashcardProvider): FlashcardProvider {
	return {
		...provider,
	};
}

function readPresetType(value: unknown, fallback: FlashcardProviderPresetType): FlashcardProviderPresetType {
	if (typeof value === "string" && value in PROVIDER_PRESET_INFO) {
		return value as FlashcardProviderPresetType;
	}

	return fallback;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function readNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}

	if (value < range.min || value > range.max) {
		return fallback;
	}

	return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readSidebarColumns(value: unknown, fallback: SidebarTableColumnId[]): SidebarTableColumnId[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	return value
		.filter((entry): entry is SidebarTableColumnId => (
			typeof entry === "string" && SIDEBAR_TABLE_COLUMN_IDS.includes(entry as SidebarTableColumnId)
		))
		.filter((entry, index, items) => items.indexOf(entry) === index);
}

function parseFolderPromptRules(value: unknown): ObcdFolderPromptRule[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => parseFolderPromptRule(entry))
		.filter((entry): entry is ObcdFolderPromptRule => entry !== null);
}

function parseFolderPromptRule(value: unknown): ObcdFolderPromptRule | null {
	if (!isRecord(value)) {
		return null;
	}

	return {
		noteFolder: normalizeConfiguredFolderPath(readString(value.noteFolder, "")),
		templatePath: normalizeConfiguredTemplatePath(readString(value.templatePath, "")),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseCommaSeparatedValues(value: string, fallback: string[]): string[] {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.filter((entry, index, items) => items.indexOf(entry) === index);

	return entries.length > 0 ? entries : [...fallback];
}

function createEmptyFolderPromptRule(): ObcdFolderPromptRule {
	return {
		noteFolder: "",
		templatePath: "",
	};
}
