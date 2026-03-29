import { App, PluginSettingTab, Setting } from "obsidian";

import { getDebugArtifactsDirectory } from "./debug/debugService";
import type ObsidianCardPlugin from "./main";
import {
	PROVIDER_PRESET_INFO,
	createDefaultProvider,
	getActiveProvider,
	getDefaultModelForPreset,
	getProviderChatCompletionsUrl,
	inferPresetTypeFromBaseUrl,
	normalizeLegacyEndpoint,
	type FlashcardProvider,
	type FlashcardProviderPresetType,
} from "./providerConfig";

const SETTINGS_SCHEMA_VERSION = 2;

export interface FlashcardGenerationSettings {
	model: string;
	maxCardsPerChunk: number;
	temperature: number;
}

export interface ObsidianCardDebugSettings {
	enabled: boolean;
}

export interface ObsidianCardSettings {
	version: number;
	providers: FlashcardProvider[];
	activeProviderId: string;
	generation: FlashcardGenerationSettings;
	debug: ObsidianCardDebugSettings;
}

interface LegacySettings {
	apiEndpoint?: unknown;
	apiKey?: unknown;
	model?: unknown;
	maxCardsPerChunk?: unknown;
	temperature?: unknown;
}

export const DEFAULT_GENERATION_SETTINGS: FlashcardGenerationSettings = {
	model: getDefaultModelForPreset("openrouter"),
	maxCardsPerChunk: 3,
	temperature: 0.2,
};

export const DEFAULT_SETTINGS: ObsidianCardSettings = createDefaultSettings();

export function createDefaultSettings(): ObsidianCardSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [createDefaultProvider("openrouter")],
		activeProviderId: "primary",
		generation: {
			...DEFAULT_GENERATION_SETTINGS,
		},
		debug: {
			enabled: false,
		},
	};
}

export function parseSettings(data: unknown): ObsidianCardSettings {
	if (!isRecord(data) || Object.keys(data).length === 0) {
		return createDefaultSettings();
	}

	if (Array.isArray(data.providers) || isRecord(data.generation)) {
		return parseCurrentSettings(data);
	}

	return parseLegacySettings(data as LegacySettings);
}

export class ObsidianCardSettingTab extends PluginSettingTab {
	plugin: ObsidianCardPlugin;

	constructor(app: App, plugin: ObsidianCardPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const activeProvider = getActiveProvider(this.plugin.settings);
		const presetInfo = PROVIDER_PRESET_INFO[activeProvider.presetType];

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Configure the service used to generate flashcard candidates.")
			.setHeading();

		containerEl.createEl("p", {
			cls: "obcard-settings-hint",
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
						const previousPresetType = currentProvider.presetType;
						const previousDefaultModel = getDefaultModelForPreset(previousPresetType);
						const nextDefaultModel = getDefaultModelForPreset(nextPresetType);
						const nextProvider = {
							...currentProvider,
							presetType: nextPresetType,
							baseUrl: PROVIDER_PRESET_INFO[nextPresetType].defaultBaseUrl,
						};

						this.updateActiveProvider(nextProvider);
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
					const currentProvider = getActiveProvider(this.plugin.settings);
					this.updateActiveProvider({
						...currentProvider,
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
						const currentProvider = getActiveProvider(this.plugin.settings);
						this.updateActiveProvider({
							...currentProvider,
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
		const providers = this.plugin.settings.providers.map((currentProvider) => (
			currentProvider.id === provider.id ? provider : currentProvider
		));

		this.plugin.settings.providers = providers;
	}
}

function parseCurrentSettings(data: Record<string, unknown>): ObsidianCardSettings {
	const defaults = createDefaultSettings();
	const parsedProviders = Array.isArray(data.providers)
		? data.providers
			.map((provider, index) => parseProvider(provider, index))
			.filter((provider): provider is FlashcardProvider => provider !== null)
		: [];

	const providers = parsedProviders.length > 0 ? parsedProviders : defaults.providers.map(cloneProvider);
	const generationSource = isRecord(data.generation) ? data.generation : {};
	const activeProviderId = typeof data.activeProviderId === "string" && providers.some((provider) => provider.id === data.activeProviderId)
		? data.activeProviderId
		: providers[0]?.id ?? defaults.activeProviderId;

	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers,
		activeProviderId,
		generation: {
			model: readString(generationSource.model, defaults.generation.model),
			maxCardsPerChunk: readNumber(generationSource.maxCardsPerChunk, defaults.generation.maxCardsPerChunk, { min: 1, max: 20 }),
			temperature: readNumber(generationSource.temperature, defaults.generation.temperature, { min: 0, max: 2 }),
		},
		debug: {
			enabled: readBoolean(data.debugEnabled, readBoolean(isRecord(data.debug) ? data.debug.enabled : undefined, defaults.debug.enabled)),
		},
	};
}

function parseLegacySettings(data: LegacySettings): ObsidianCardSettings {
	const defaults = createDefaultSettings();
	const legacyEndpoint = readString(data.apiEndpoint, defaults.providers[0]?.baseUrl ?? "");
	const resolvedBaseUrl = legacyEndpoint.length > 0
		? normalizeLegacyEndpoint(legacyEndpoint)
		: defaults.providers[0]?.baseUrl ?? "";
	const presetType = resolvedBaseUrl.length > 0 ? inferPresetTypeFromBaseUrl(resolvedBaseUrl) : "openrouter";
	const provider = createDefaultProvider(presetType);

	provider.baseUrl = resolvedBaseUrl.length > 0 ? resolvedBaseUrl : provider.baseUrl;
	provider.apiKey = readString(data.apiKey, "");

	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [provider],
		activeProviderId: provider.id,
		generation: {
			model: readString(data.model, getDefaultModelForPreset(provider.presetType)),
			maxCardsPerChunk: readNumber(data.maxCardsPerChunk, defaults.generation.maxCardsPerChunk, { min: 1, max: 20 }),
			temperature: readNumber(data.temperature, defaults.generation.temperature, { min: 0, max: 2 }),
		},
		debug: {
			enabled: defaults.debug.enabled,
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
