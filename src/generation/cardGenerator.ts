import { requestUrl } from "obsidian";

import type { DebugRun } from "../debug/debugService";
import { buildFlashcardOutputConstraintPrompt, DEFAULT_FLASHCARD_PROMPT } from "../prompts/promptDefaults";
import type { ObsidianCardSettings } from "../settings";
import type { ContentChunk, GeneratedBasicCard } from "../types";
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

export class AiCardGenerator {
	private readonly settings: ObsidianCardSettings;
	private readonly generationPrompt: string;
	private readonly debugRun?: DebugRun;

	constructor(settings: ObsidianCardSettings, generationPrompt: string, debugRun?: DebugRun) {
		this.settings = settings;
		this.generationPrompt = generationPrompt.trim().length > 0 ? generationPrompt : DEFAULT_FLASHCARD_PROMPT;
		this.debugRun = debugRun;
	}

	async generate(chunk: ContentChunk, chunkIndex: number): Promise<GeneratedBasicCard[]> {
		const activeProvider = getActiveProvider(this.settings);
		const requestBody = {
			model: this.settings.generation.model,
			temperature: this.settings.generation.temperature,
			messages: [
				{
					role: "system",
					content: this.generationPrompt,
				},
				{
					role: "system",
					content: buildFlashcardOutputConstraintPrompt(this.settings.generation.maxCardsPerChunk),
				},
				{
					role: "user",
					content: JSON.stringify({
						filePath: chunk.filePath,
						sectionKey: chunk.sectionKey,
						blockKind: chunk.blockKind,
						titleHint: chunk.titleHint ?? "",
						headingPath: chunk.headingPath,
						text: chunk.text,
					}),
				},
			],
		};

		const headers = getProviderHeaders(activeProvider);
		const requestUrlValue = getProviderChatCompletionsUrl(activeProvider);

		this.debugRun?.recordChunkRequest(chunkIndex, {
			url: requestUrlValue,
			method: "POST",
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

		this.debugRun?.recordChunkResponse(chunkIndex, {
			status: response.status,
			headers: response.headers,
			text: response.text,
			json: response.json,
		});

		if (response.status >= 400) {
			throw new Error(`AI request failed with status ${response.status}: ${response.text.trim()}`);
		}

		const cards = parseGeneratedCards(response.json as ChatCompletionResponse | GeneratedBasicCard[] | Record<string, unknown>);
		this.debugRun?.recordChunkCards(chunkIndex, cards);
		return cards;
	}
}

function parseGeneratedCards(response: ChatCompletionResponse | GeneratedBasicCard[] | Record<string, unknown>): GeneratedBasicCard[] {
	if (Array.isArray(response)) {
		return coerceGeneratedCards(response);
	}

	if (hasCardsArray(response)) {
		return coerceGeneratedCards(response.cards);
	}

	const content = extractAssistantContent(response as ChatCompletionResponse);
	const parsedPayload = parseJsonPayload(content);

	if (Array.isArray(parsedPayload)) {
		return coerceGeneratedCards(parsedPayload);
	}

	if (hasCardsArray(parsedPayload)) {
		return coerceGeneratedCards(parsedPayload.cards);
	}

	throw new Error("AI response did not contain a JSON array of cards.");
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
	const candidates = [rawContent, fencedContent, extractBracketPayload(fencedContent, "[", "]"), extractBracketPayload(fencedContent, "{", "}")];

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
	const innerContent = match?.[1];
	return innerContent ? innerContent.trim() : trimmed;
}

function extractBracketPayload(rawContent: string, openCharacter: string, closeCharacter: string): string | null {
	const startIndex = rawContent.indexOf(openCharacter);
	const endIndex = rawContent.lastIndexOf(closeCharacter);

	if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
		return null;
	}

	return rawContent.slice(startIndex, endIndex + 1).trim();
}

function coerceGeneratedCards(values: unknown[]): GeneratedBasicCard[] {
	const cards: GeneratedBasicCard[] = [];

	for (const value of values) {
		if (!isObject(value)) {
			continue;
		}

		cards.push({
			front: typeof value.front === "string" ? value.front : "",
			back: typeof value.back === "string" ? value.back : "",
			tags: Array.isArray(value.tags)
				? value.tags.filter((tag): tag is string => typeof tag === "string")
				: [],
		});
	}

	return cards;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasCardsArray(value: unknown): value is { cards: unknown[] } {
	return isObject(value) && Array.isArray(value.cards);
}
