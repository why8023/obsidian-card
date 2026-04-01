import type { ContentChunk, KnowledgeChunkAnalysis } from "../types";
import { collapseWhitespace, makePreview } from "../utils/markdown";

interface ChunkExtractionResponse {
	hasKnowledge?: unknown;
	summary?: unknown;
	topicHint?: unknown;
	evidenceExcerpt?: unknown;
	rejectionReason?: unknown;
}

export function hasReusableChunkAnalysis(chunk: ContentChunk): boolean {
	return chunk.existingAnnotation?.data.hash === chunk.sourceHash;
}

export function hydrateChunkAnalysisFromAnnotation(chunk: ContentChunk): KnowledgeChunkAnalysis | null {
	if (!hasReusableChunkAnalysis(chunk)) {
		return null;
	}

	const cached = chunk.existingAnnotation?.data;
	if (!cached) {
		return null;
	}

	return {
		chunkId: chunk.chunkId,
		filePath: chunk.filePath,
		hash: chunk.sourceHash,
		status: cached.status,
		summary: cached.summary,
		topicHint: cached.topicHint,
		evidenceExcerpt: cached.status === "knowledge" ? fallbackEvidenceExcerpt(chunk.text) : "",
		rejectionReason: cached.rejectionReason,
	};
}

export function normalizeChunkAnalysisPayload(payload: unknown, chunk: ContentChunk): KnowledgeChunkAnalysis {
	const response = isObject(payload) ? payload as ChunkExtractionResponse : {};
	const cached = hasReusableChunkAnalysis(chunk) ? chunk.existingAnnotation?.data : undefined;
	const inferredKnowledge = inferKnowledgeStatus(response, cached?.status);
	const summary = readPreferredText(
		response.summary,
		cached?.summary ?? "",
		fallbackSummary(chunk),
	);
	const topicHint = inferredKnowledge
		? readPreferredText(
			response.topicHint,
			cached?.topicHint ?? "",
			fallbackTopicHint(summary),
		)
		: "";
	const evidenceExcerpt = inferredKnowledge
		? readPreferredText(
			response.evidenceExcerpt,
			"",
			fallbackEvidenceExcerpt(chunk.text),
		)
		: "";
	const rejectionReason = inferredKnowledge
		? ""
		: readPreferredText(
			response.rejectionReason,
			cached?.rejectionReason ?? "",
			fallbackNoKnowledgeReason(chunk.text),
		);

	return {
		chunkId: chunk.chunkId,
		filePath: chunk.filePath,
		hash: chunk.sourceHash,
		status: inferredKnowledge ? "knowledge" : "no-knowledge",
		summary,
		topicHint,
		evidenceExcerpt,
		rejectionReason,
	};
}

export function isKnowledgeBearingAnalysis(analysis: KnowledgeChunkAnalysis): boolean {
	return analysis.status === "knowledge";
}

function inferKnowledgeStatus(
	response: ChunkExtractionResponse,
	cachedStatus: KnowledgeChunkAnalysis["status"] | undefined,
): boolean {
	if (typeof response.hasKnowledge === "boolean") {
		return response.hasKnowledge;
	}

	if (cachedStatus) {
		return cachedStatus === "knowledge";
	}

	const topicHint = collapseWhitespace(readString(response.topicHint));
	const evidenceExcerpt = collapseWhitespace(readString(response.evidenceExcerpt));
	const rejectionReason = collapseWhitespace(readString(response.rejectionReason));

	if (topicHint.length > 0 || evidenceExcerpt.length > 0) {
		return true;
	}

	if (rejectionReason.length > 0) {
		return false;
	}

	return collapseWhitespace(readString(response.summary)).length >= 20;
}

function fallbackSummary(chunk: ContentChunk): string {
	return makePreview(chunk.text, 96);
}

function fallbackTopicHint(summary: string): string {
	return collapseWhitespace(summary)
		.split(/[。！？.!?;；:：]/)[0]
		?.trim() ?? "";
}

function fallbackEvidenceExcerpt(text: string): string {
	return makePreview(text, 180);
}

function fallbackNoKnowledgeReason(text: string): string {
	const normalizedText = collapseWhitespace(text);
	if (normalizedText.length < 80) {
		return "The chunk is too small or too fragmentary to support durable flashcards.";
	}

	return "The chunk is mostly scaffolding, transition, or low-value detail without a stable flashcard target.";
}

function readPreferredText(value: unknown, fallback: string, finalFallback: string): string {
	const normalizedValue = collapseWhitespace(readString(value));
	if (normalizedValue.length > 0) {
		return normalizedValue;
	}

	if (fallback.trim().length > 0) {
		return collapseWhitespace(fallback);
	}

	return collapseWhitespace(finalFallback);
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
