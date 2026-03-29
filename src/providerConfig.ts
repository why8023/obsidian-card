export type FlashcardProviderPresetType =
	| "openrouter"
	| "openai"
	| "openai-compatible"
	| "ollama"
	| "lm-studio";

export interface FlashcardProvider {
	id: string;
	presetType: FlashcardProviderPresetType;
	baseUrl: string;
	apiKey: string;
}

export interface ProviderPresetInfo {
	label: string;
	description: string;
	defaultBaseUrl: string;
	defaultModel: string;
	requireApiKey: boolean;
}

export const PROVIDER_PRESET_INFO: Record<FlashcardProviderPresetType, ProviderPresetInfo> = {
	openrouter: {
		label: "OpenRouter",
		description: "Use OpenRouter through its OpenAI-compatible /api/v1 chat completions endpoint.",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "openai/gpt-4.1-mini",
		requireApiKey: true,
	},
	openai: {
		label: "OpenAI",
		description: "Use the official OpenAI API with the standard /v1 chat completions path.",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4.1-mini",
		requireApiKey: true,
	},
	"openai-compatible": {
		label: "OpenAI compatible",
		description: "Use any provider that exposes an OpenAI-compatible chat completions API.",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4.1-mini",
		requireApiKey: false,
	},
	ollama: {
		label: "Ollama",
		description: "Use a local Ollama server through its OpenAI-compatible endpoint.",
		defaultBaseUrl: "http://127.0.0.1:11434/v1",
		defaultModel: "llama3.1",
		requireApiKey: false,
	},
	"lm-studio": {
		label: "LM Studio",
		description: "Use a local LM Studio server through its OpenAI-compatible endpoint.",
		defaultBaseUrl: "http://127.0.0.1:1234/v1",
		defaultModel: "local-model",
		requireApiKey: false,
	},
};

interface ProviderContainer {
	providers: FlashcardProvider[];
	activeProviderId: string;
}

export function createDefaultProvider(presetType: FlashcardProviderPresetType = "openrouter"): FlashcardProvider {
	const presetInfo = PROVIDER_PRESET_INFO[presetType];

	return {
		id: "primary",
		presetType,
		baseUrl: presetInfo.defaultBaseUrl,
		apiKey: "",
	};
}

export function getActiveProvider(container: ProviderContainer): FlashcardProvider {
	const matchingProvider = container.providers.find((provider) => provider.id === container.activeProviderId);
	if (matchingProvider) {
		return matchingProvider;
	}

	const firstProvider = container.providers[0];
	return firstProvider ?? createDefaultProvider();
}

export function getResolvedProviderBaseUrl(provider: FlashcardProvider): string {
	const configuredBaseUrl = provider.baseUrl.trim();
	if (configuredBaseUrl.length > 0) {
		return normalizeBaseUrl(configuredBaseUrl);
	}

	return normalizeBaseUrl(PROVIDER_PRESET_INFO[provider.presetType].defaultBaseUrl);
}

export function getProviderChatCompletionsUrl(provider: FlashcardProvider): string {
	return `${getResolvedProviderBaseUrl(provider)}/chat/completions`;
}

export function getProviderHeaders(provider: FlashcardProvider): Record<string, string> {
	const headers: Record<string, string> = {};
	const apiKey = provider.apiKey.trim();

	if (apiKey.length > 0) {
		headers.Authorization = `Bearer ${apiKey}`;
	}

	if (provider.presetType === "openrouter") {
		headers["HTTP-Referer"] = "https://obsidian.md";
		headers["X-Title"] = "OBCARD";
	}

	return headers;
}

export function getDefaultModelForPreset(presetType: FlashcardProviderPresetType): string {
	return PROVIDER_PRESET_INFO[presetType].defaultModel;
}

export function inferPresetTypeFromBaseUrl(baseUrl: string): FlashcardProviderPresetType {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl).toLowerCase();

	if (normalizedBaseUrl.includes("11434")) {
		return "ollama";
	}

	if (normalizedBaseUrl.includes("1234")) {
		return "lm-studio";
	}

	if (normalizedBaseUrl.includes("openrouter.ai")) {
		return "openrouter";
	}

	if (normalizedBaseUrl.includes("api.openai.com")) {
		return "openai";
	}

	return "openai-compatible";
}

export function normalizeLegacyEndpoint(value: string): string {
	const trimmedValue = value.trim();
	if (trimmedValue.length === 0) {
		return trimmedValue;
	}

	return normalizeBaseUrl(trimmedValue);
}

function normalizeBaseUrl(value: string): string {
	return value
		.trim()
		.replace(/\/chat\/completions\/?$/i, "")
		.replace(/\/+$/, "");
}
