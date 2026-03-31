export type FlashcardProviderPresetType =
	| "openrouter"
	| "openai"
	| "alibaba-bailian"
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
		description: "通过 OpenAI 兼容的 /api/v1/chat/completions 接口使用 OpenRouter。",
		defaultBaseUrl: "https://openrouter.ai/api/v1",
		defaultModel: "openai/gpt-4.1-mini",
		requireApiKey: true,
	},
	openai: {
		label: "OpenAI",
		description: "使用官方 OpenAI API，默认走标准的 /v1/chat/completions 路径。",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4.1-mini",
		requireApiKey: true,
	},
	"alibaba-bailian": {
		label: "阿里云百炼",
		description: "使用阿里云百炼的 OpenAI 兼容接口。默认填写中国内地（北京）地域地址，如需新加坡、美国或其他地域，请手动修改 Base URL。",
		defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		defaultModel: "qwen-plus",
		requireApiKey: true,
	},
	"openai-compatible": {
		label: "OpenAI 兼容接口",
		description: "适用于任何提供 OpenAI 兼容 chat completions API 的服务。",
		defaultBaseUrl: "https://api.openai.com/v1",
		defaultModel: "gpt-4.1-mini",
		requireApiKey: false,
	},
	ollama: {
		label: "Ollama",
		description: "通过 OpenAI 兼容接口连接本地 Ollama 服务。",
		defaultBaseUrl: "http://127.0.0.1:11434/v1",
		defaultModel: "llama3.1",
		requireApiKey: false,
	},
	"lm-studio": {
		label: "LM Studio",
		description: "通过 OpenAI 兼容接口连接本地 LM Studio 服务。",
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
		headers["X-Title"] = "OBCD";
	}

	return headers;
}

export function getDefaultModelForPreset(presetType: FlashcardProviderPresetType): string {
	return PROVIDER_PRESET_INFO[presetType].defaultModel;
}
function normalizeBaseUrl(value: string): string {
	return value
		.trim()
		.replace(/\/chat\/completions\/?$/i, "")
		.replace(/\/+$/, "");
}
