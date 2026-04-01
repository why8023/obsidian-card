import { requestUrl } from "obsidian";

import type { DebugRun } from "../debug/debugService";
import type { ObcdSettings } from "../settings";
import { getActiveProvider, getProviderChatCompletionsUrl, getProviderHeaders } from "../providerConfig";

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{
				type?: string;
				text?: string;
			}>;
		};
	}>;
}

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

const CONNECTION_TEST_MAX_TOKENS = 16;

export class LlmClient {
	constructor(
		private readonly settings: ObcdSettings,
		private readonly debugRun?: DebugRun,
	) {}

	async requestJson(stage: string, messages: ChatMessage[]): Promise<unknown> {
		const activeProvider = getActiveProvider(this.settings);
		const requestBody = {
			model: this.settings.generation.model,
			temperature: this.settings.generation.temperature,
			messages,
		};
		const headers = getProviderHeaders(activeProvider);
		const requestUrlValue = getProviderChatCompletionsUrl(activeProvider);

		this.debugRun?.log(`${stage}:request`, "Sending LLM request.", {
			url: requestUrlValue,
			headers,
			body: requestBody,
		});

		const response = await requestUrl({
			url: requestUrlValue,
			method: "POST",
			contentType: "application/json",
			headers,
			body: JSON.stringify(requestBody),
			throw: false,
		});
		const responseJson = response.json as unknown;

		this.debugRun?.log(`${stage}:response`, "Received LLM response.", {
			status: response.status,
			headers: response.headers,
			text: response.text,
			json: responseJson,
		});

		if (response.status >= 400) {
			throw new Error(`AI request failed with status ${response.status}: ${response.text.trim()}`);
		}

		return parseJsonResponse(responseJson as ChatCompletionResponse | Record<string, unknown> | unknown[]);
	}

	async testConnection(): Promise<{
		status: number;
		model: string;
		url: string;
	}> {
		const activeProvider = getActiveProvider(this.settings);
		const requestUrlValue = getProviderChatCompletionsUrl(activeProvider);
		const headers = getProviderHeaders(activeProvider);
		const requestBody = {
			model: this.settings.generation.model,
			temperature: 0,
			max_tokens: CONNECTION_TEST_MAX_TOKENS,
			messages: [
				{
					role: "user" as const,
					content: "请只回复 OK。",
				},
			],
		};

		this.debugRun?.log("connection-test:request", "Sending connection test request.", {
			url: requestUrlValue,
			headers,
			body: requestBody,
		});

		const response = await requestUrl({
			url: requestUrlValue,
			method: "POST",
			contentType: "application/json",
			headers,
			body: JSON.stringify(requestBody),
			throw: false,
		});

		this.debugRun?.log("connection-test:response", "Received connection test response.", {
			status: response.status,
			headers: response.headers,
			text: response.text,
			json: response.json as unknown,
		});

		if (response.status >= 400) {
			throw new Error(`连接测试失败，状态码 ${response.status}: ${response.text.trim()}`);
		}

		return {
			status: response.status,
			model: this.settings.generation.model,
			url: requestUrlValue,
		};
	}
}

function parseJsonResponse(response: ChatCompletionResponse | Record<string, unknown> | unknown[]): unknown {
	if (Array.isArray(response)) {
		return response;
	}

	if (isObject(response)) {
		if (Array.isArray(response.units) || Array.isArray(response.topics) || Array.isArray(response.sections)) {
			return response;
		}
	}

	const content = extractAssistantContent(response as ChatCompletionResponse);
	return parseJsonPayload(content);
}

function extractAssistantContent(response: ChatCompletionResponse): string {
	const rawContent = response.choices?.[0]?.message?.content;

	if (typeof rawContent === "string") {
		return rawContent.trim();
	}

	if (Array.isArray(rawContent)) {
		return rawContent
			.map((item) => item.text ?? "")
			.join("")
			.trim();
	}

	throw new Error("AI response did not include message content.");
}

function parseJsonPayload(rawContent: string): unknown {
	const fencedContent = stripCodeFences(rawContent);
	const candidates = [
		rawContent,
		fencedContent,
		extractBracketPayload(fencedContent, "[", "]"),
		extractBracketPayload(fencedContent, "{", "}"),
	];

	for (const candidate of candidates) {
		if (!candidate) {
			continue;
		}

		try {
			return JSON.parse(candidate);
		} catch {
			continue;
		}
	}

	throw new Error("AI response was not valid JSON.");
}

function stripCodeFences(rawContent: string): string {
	const trimmed = rawContent.trim();
	const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
	return match?.[1]?.trim() ?? trimmed;
}

function extractBracketPayload(rawContent: string, openCharacter: string, closeCharacter: string): string | null {
	const startIndex = rawContent.indexOf(openCharacter);
	const endIndex = rawContent.lastIndexOf(closeCharacter);

	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		return null;
	}

	return rawContent.slice(startIndex, endIndex + 1).trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
