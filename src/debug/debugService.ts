import { normalizePath } from "obsidian";

import type ObcdPlugin from "../main";
import { getActiveProvider, getProviderChatCompletionsUrl, getResolvedProviderBaseUrl } from "../providerConfig";
import type {
	CardCandidate,
	ContentChunk,
	GeneratedBasicCard,
	GenerationMode,
	ReviewResult,
	TextRange,
} from "../types";
import { makePreview } from "../utils/markdown";

const DEBUG_ARTIFACT_SCHEMA_VERSION = 1;
const DEBUG_ARTIFACT_DIRECTORY_NAME = "debug";
const DEBUG_CONSOLE_PREFIX = "[OBCD debug]";
const DEBUG_REDACTED_VALUE = "<redacted>";
const MAX_DEBUG_ARTIFACTS = 20;

export interface DebugRunContext {
	mode: GenerationMode;
	filePath: string;
	isBatchMode: boolean;
}

export interface DebugChunkRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export interface DebugChunkResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
}

interface DebugEvent {
	at: string;
	stage: string;
	message: string;
	details?: unknown;
}

interface DebugErrorRecord {
	stage: string;
	message: string;
	stack?: string;
	details?: unknown;
}

interface DebugChunkRecord {
	index: number;
	titleHint?: string;
	range?: TextRange;
	text?: string;
	textPreview?: string;
	request?: DebugChunkRequest;
	response?: DebugChunkResponse;
	generatedCards?: GeneratedBasicCard[];
	error?: DebugErrorRecord;
}

interface DebugReviewRecord {
	action: ReviewResult["action"];
	approvedCount: number;
	approvedCards: GeneratedBasicCard[];
}

interface DebugWriteRecord {
	insertedCount: number;
	approvedCount: number;
}

interface DebugArtifact {
	schemaVersion: number;
	runId: string;
	startedAt: string;
	completedAt?: string;
	outcome?: string;
	outcomeDetails?: unknown;
	context: DebugRunContext;
	provider: {
		presetType: string;
		baseUrl: string;
		resolvedBaseUrl: string;
		requestUrl: string;
		hasApiKey: boolean;
	};
	generation: {
		model: string;
		maxCardsPerChunk: number;
		temperature: number;
		addObcdTag: boolean;
	};
	events: DebugEvent[];
	chunks: DebugChunkRecord[];
	candidates?: CardCandidate[];
	review?: DebugReviewRecord;
	write?: DebugWriteRecord;
	error?: DebugErrorRecord;
}

export interface DebugRun {
	readonly enabled: boolean;
	recordChunks(chunks: ContentChunk[]): void;
	recordChunkRequest(chunkIndex: number, request: DebugChunkRequest): void;
	recordChunkResponse(chunkIndex: number, response: DebugChunkResponse): void;
	recordChunkCards(chunkIndex: number, cards: GeneratedBasicCard[]): void;
	recordChunkError(chunkIndex: number, error: unknown, details?: unknown): void;
	recordCandidates(candidates: CardCandidate[]): void;
	recordReview(reviewResult: ReviewResult): void;
	recordWrite(result: DebugWriteRecord): void;
	recordError(stage: string, error: unknown, details?: unknown): void;
	log(stage: string, message: string, details?: unknown): void;
	finish(outcome: string, details?: unknown): Promise<void>;
}

export class DebugService {
	private readonly disabledRun: DebugRun = new NoopDebugRun();

	constructor(private readonly plugin: ObcdPlugin) {}

	createRun(context: DebugRunContext): DebugRun {
		if (!this.plugin.settings.debug.enabled) {
			return this.disabledRun;
		}

		return new ActiveDebugRun(this.plugin, context);
	}
}

export function getDebugArtifactsDirectory(configDir: string, pluginDir: string | undefined, pluginId: string): string {
	const baseDirectory = pluginDir ?? normalizePath(`${configDir}/plugins/${pluginId}`);
	return normalizePath(`${baseDirectory}/${DEBUG_ARTIFACT_DIRECTORY_NAME}`);
}

class ActiveDebugRun implements DebugRun {
	readonly enabled = true;

	private readonly artifact: DebugArtifact;
	private completed = false;

	constructor(
		private readonly plugin: ObcdPlugin,
		private readonly context: DebugRunContext,
	) {
		const activeProvider = getActiveProvider(plugin.settings);
		const now = new Date().toISOString();

		this.artifact = {
			schemaVersion: DEBUG_ARTIFACT_SCHEMA_VERSION,
			runId: buildRunId(now),
			startedAt: now,
			context,
			provider: {
				presetType: activeProvider.presetType,
				baseUrl: activeProvider.baseUrl,
				resolvedBaseUrl: getResolvedProviderBaseUrl(activeProvider),
				requestUrl: getProviderChatCompletionsUrl(activeProvider),
				hasApiKey: activeProvider.apiKey.trim().length > 0,
			},
			generation: {
				model: plugin.settings.generation.model,
				maxCardsPerChunk: plugin.settings.generation.maxCardsPerChunk,
				temperature: plugin.settings.generation.temperature,
				addObcdTag: plugin.settings.generation.addObcdTag,
			},
			events: [],
			chunks: [],
		};

		this.log("run", "Started debug capture.", {
			filePath: context.filePath,
			isBatchMode: context.isBatchMode,
			mode: context.mode,
		});
	}

	recordChunks(chunks: ContentChunk[]): void {
		this.artifact.chunks = chunks.map((chunk, index) => ({
			index,
			titleHint: chunk.titleHint,
			range: {
				from: chunk.range.from,
				to: chunk.range.to,
			},
			text: chunk.text,
			textPreview: makePreview(chunk.text),
		}));

		this.log("chunks", `Prepared ${chunks.length} chunk(s).`, {
			chunkCount: chunks.length,
		});
	}

	recordChunkRequest(chunkIndex: number, request: DebugChunkRequest): void {
		const chunk = this.ensureChunkRecord(chunkIndex);
		chunk.request = {
			url: request.url,
			method: request.method,
			headers: sanitizeHeaders(request.headers),
			body: toSerializableValue(request.body),
		};

		this.log("request", `Sending request for chunk ${chunkIndex + 1}.`, {
			chunkIndex,
			method: request.method,
			url: request.url,
		});
	}

	recordChunkResponse(chunkIndex: number, response: DebugChunkResponse): void {
		const chunk = this.ensureChunkRecord(chunkIndex);
		chunk.response = {
			status: response.status,
			headers: sanitizeHeaders(response.headers),
			text: response.text,
			json: toSerializableValue(response.json),
		};

		this.log("response", `Received response for chunk ${chunkIndex + 1}.`, {
			chunkIndex,
			status: response.status,
		});
	}

	recordChunkCards(chunkIndex: number, cards: GeneratedBasicCard[]): void {
		const chunk = this.ensureChunkRecord(chunkIndex);
		chunk.generatedCards = cloneCards(cards);

		this.log("cards", `Parsed ${cards.length} card(s) for chunk ${chunkIndex + 1}.`, {
			cardCount: cards.length,
			chunkIndex,
		});
	}

	recordChunkError(chunkIndex: number, error: unknown, details?: unknown): void {
		const chunk = this.ensureChunkRecord(chunkIndex);
		chunk.error = serializeErrorRecord("chunk", error, details);

		this.log("chunk-error", `Chunk ${chunkIndex + 1} failed.`, {
			chunkIndex,
			error: chunk.error.message,
		});
	}

	recordCandidates(candidates: CardCandidate[]): void {
		this.artifact.candidates = candidates.map((candidate) => ({
			...candidate,
			card: {
				front: candidate.card.front,
				back: candidate.card.back,
				tags: [...candidate.card.tags],
			},
		}));

		this.log("candidates", `Built ${candidates.length} candidate(s).`, {
			candidateCount: candidates.length,
		});
	}

	recordReview(reviewResult: ReviewResult): void {
		const approvedCards = flattenApprovedCards(reviewResult);
		this.artifact.review = {
			action: reviewResult.action,
			approvedCount: approvedCards.length,
			approvedCards,
		};

		this.log("review", `Review finished with action ${reviewResult.action}.`, {
			action: reviewResult.action,
			approvedCount: approvedCards.length,
		});
	}

	recordWrite(result: DebugWriteRecord): void {
		this.artifact.write = {
			insertedCount: result.insertedCount,
			approvedCount: result.approvedCount,
		};

		this.log("write", `Inserted ${result.insertedCount} card(s).`, result);
	}

	recordError(stage: string, error: unknown, details?: unknown): void {
		this.artifact.error = serializeErrorRecord(stage, error, details);
		this.log("error", `Error at ${stage}: ${this.artifact.error.message}`, {
			stage,
		});
	}

	log(stage: string, message: string, details?: unknown): void {
		const event: DebugEvent = {
			at: new Date().toISOString(),
			stage,
			message,
		};

		if (details !== undefined) {
			event.details = toSerializableValue(details);
		}

		this.artifact.events.push(event);
		if (details === undefined) {
			console.debug(DEBUG_CONSOLE_PREFIX, stage, message);
			return;
		}

		console.debug(DEBUG_CONSOLE_PREFIX, stage, message, event.details);
	}

	async finish(outcome: string, details?: unknown): Promise<void> {
		if (this.completed) {
			return;
		}

		this.completed = true;
		this.artifact.completedAt = new Date().toISOString();
		this.artifact.outcome = outcome;
		if (details !== undefined) {
			this.artifact.outcomeDetails = toSerializableValue(details);
		}

		this.log("complete", `Completed with outcome ${outcome}.`, details);

		try {
			const artifactPath = await this.writeArtifact();
			console.debug(DEBUG_CONSOLE_PREFIX, "artifact", `Saved debug artifact to ${artifactPath}`);
		} catch (error) {
			console.warn(DEBUG_CONSOLE_PREFIX, "artifact", "Failed to save debug artifact.", serializeErrorRecord("persist", error));
		}
	}

	private ensureChunkRecord(chunkIndex: number): DebugChunkRecord {
		const existingChunk = this.artifact.chunks[chunkIndex];
		if (existingChunk) {
			return existingChunk;
		}

		const chunkRecord: DebugChunkRecord = {
			index: chunkIndex,
		};
		this.artifact.chunks[chunkIndex] = chunkRecord;
		return chunkRecord;
	}

	private async writeArtifact(): Promise<string> {
		const adapter = this.plugin.app.vault.adapter;
		const artifactDirectory = getDebugArtifactsDirectory(
			this.plugin.app.vault.configDir,
			this.plugin.manifest.dir,
			this.plugin.manifest.id,
		);

		if (!await adapter.exists(artifactDirectory)) {
			await adapter.mkdir(artifactDirectory);
		}

		const artifactPath = normalizePath(`${artifactDirectory}/${buildArtifactFileName(this.context.filePath, this.context.mode, this.artifact.runId)}`);
		await adapter.write(artifactPath, JSON.stringify(this.artifact, null, 2));
		await trimDebugArtifacts(adapter, artifactDirectory);
		return artifactPath;
	}
}

class NoopDebugRun implements DebugRun {
	readonly enabled = false;

	recordChunks(_chunks: ContentChunk[]): void {}
	recordChunkRequest(_chunkIndex: number, _request: DebugChunkRequest): void {}
	recordChunkResponse(_chunkIndex: number, _response: DebugChunkResponse): void {}
	recordChunkCards(_chunkIndex: number, _cards: GeneratedBasicCard[]): void {}
	recordChunkError(_chunkIndex: number, _error: unknown, _details?: unknown): void {}
	recordCandidates(_candidates: CardCandidate[]): void {}
	recordReview(_reviewResult: ReviewResult): void {}
	recordWrite(_result: DebugWriteRecord): void {}
	recordError(_stage: string, _error: unknown, _details?: unknown): void {}
	log(_stage: string, _message: string, _details?: unknown): void {}
	async finish(_outcome: string, _details?: unknown): Promise<void> {}
}

async function trimDebugArtifacts(
	adapter: ObcdPlugin["app"]["vault"]["adapter"],
	artifactDirectory: string,
): Promise<void> {
	const listedFiles = await adapter.list(artifactDirectory);
	const artifactFiles = listedFiles.files
		.filter((filePath) => filePath.endsWith(".json"))
		.sort((left, right) => left.localeCompare(right));

	const filesToRemove = artifactFiles.slice(0, Math.max(artifactFiles.length - MAX_DEBUG_ARTIFACTS, 0));
	for (const filePath of filesToRemove) {
		await adapter.remove(filePath);
	}
}

function buildRunId(timestamp: string): string {
	return `${formatTimestampForFileName(timestamp)}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildArtifactFileName(filePath: string, mode: GenerationMode, runId: string): string {
	const fileName = filePath.split("/").pop() ?? "note";
	const baseName = fileName.replace(/\.[^.]+$/, "");
	return `${runId}-${mode}-${makeSafeFileSegment(baseName)}.json`;
}

function formatTimestampForFileName(timestamp: string): string {
	return timestamp
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z")
		.replace("T", "-");
}

function makeSafeFileSegment(value: string): string {
	const normalizedValue = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return normalizedValue.length > 0 ? normalizedValue : "note";
}

function cloneCards(cards: GeneratedBasicCard[]): GeneratedBasicCard[] {
	return cards.map((card) => ({
		front: card.front,
		back: card.back,
		tags: [...card.tags],
	}));
}

function flattenApprovedCards(reviewResult: ReviewResult): GeneratedBasicCard[] {
	return cloneCards(reviewResult.approvedGroups.flatMap((group) => group.cards));
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
	const sanitizedHeaders: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		sanitizedHeaders[key] = key.toLowerCase() === "authorization" ? DEBUG_REDACTED_VALUE : value;
	}
	return sanitizedHeaders;
}

function serializeErrorRecord(stage: string, error: unknown, details?: unknown): DebugErrorRecord {
	const errorRecord: DebugErrorRecord = {
		stage,
		message: getErrorMessage(error),
	};

	if (error instanceof Error && error.stack) {
		errorRecord.stack = error.stack;
	}

	if (details !== undefined) {
		errorRecord.details = toSerializableValue(details);
	}

	return errorRecord;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function toSerializableValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (value === null || value === undefined) {
		return value;
	}

	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}

	if (value instanceof Date) {
		return value.toISOString();
	}

	if (value instanceof Error) {
		return serializeErrorRecord("error", value);
	}

	if (Array.isArray(value)) {
		return value.map((item) => toSerializableValue(item, seen));
	}

	if (typeof value === "object") {
		if (seen.has(value)) {
			return "[Circular]";
		}

		seen.add(value);
		const result: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value)) {
			result[key] = toSerializableValue(entry, seen);
		}
		seen.delete(value);
		return result;
	}

	if (typeof value === "bigint") {
		return value.toString();
	}

	if (typeof value === "symbol") {
		return value.description ? `Symbol(${value.description})` : "Symbol()";
	}

	if (typeof value === "function") {
		return `[Function ${value.name || "anonymous"}]`;
	}

	return "";
}
