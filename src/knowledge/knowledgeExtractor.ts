import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildKnowledgeExtractionPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { ChunkAnalysisResult, ContentChunk, KnowledgeChunkAnalysis, KnowledgeUnit, KnowledgeUnitKind } from "../types";
import { collapseWhitespace, makePreview } from "../utils/markdown";

interface KnowledgeExtractionResponse {
	summary?: unknown;
	group?: unknown;
	units?: unknown[];
}

export class KnowledgeExtractor {
	private readonly llmClient: LlmClient;

	constructor(
		private readonly settings: ObcdSettings,
		private readonly customInstruction: string,
		private readonly debugRun?: DebugRun,
	) {
		this.llmClient = new LlmClient(settings, debugRun);
	}

	async extract(chunk: ContentChunk, chunkIndex: number): Promise<ChunkAnalysisResult> {
		const payload = await this.llmClient.requestJson(`extract:${chunkIndex}`, [
			{
				role: "system",
				content: buildKnowledgeExtractionPrompt(this.settings.generation.maxKnowledgeUnitsPerChunk, this.customInstruction),
			},
			{
				role: "user",
				content: JSON.stringify({
					filePath: chunk.filePath,
					chunkId: chunk.chunkId,
					sectionKey: chunk.sectionKey,
					blockKind: chunk.blockKind,
					titleHint: chunk.titleHint ?? "",
					headingPath: chunk.headingPath,
					text: chunk.text,
					existingAnalysis: chunk.existingAnnotation?.data
						? {
							hash: chunk.existingAnnotation.data.hash,
							summary: chunk.existingAnnotation.data.summary,
							group: chunk.existingAnnotation.data.group,
						}
						: undefined,
				}),
			},
		]);

		const analysis = normalizeChunkAnalysis(payload, chunk);
		const units = normalizeKnowledgeUnits(payload, chunk, analysis);
		this.debugRun?.log("extract:units", `Extracted ${units.length} knowledge unit(s).`, {
			chunkIndex,
			chunkId: chunk.chunkId,
			analysis,
			units,
		});

		return {
			chunk,
			analysis,
			units,
		};
	}
}

function normalizeChunkAnalysis(payload: unknown, chunk: ContentChunk): KnowledgeChunkAnalysis {
	const response = isObject(payload) ? payload as KnowledgeExtractionResponse : {};
	const existing = chunk.existingAnnotation?.data;
	const summary = readPreferredText(
		response.summary,
		existing?.hash === chunk.sourceHash ? existing.summary : "",
		fallbackSummary(chunk),
	);
	const group = readPreferredText(
		response.group,
		existing?.hash === chunk.sourceHash ? existing.group : "",
		fallbackGroup(chunk),
	);

	return {
		chunkId: chunk.chunkId,
		filePath: chunk.filePath,
		sectionKey: chunk.sectionKey,
		titleHint: chunk.titleHint,
		headingPath: [...chunk.headingPath],
		hash: chunk.sourceHash,
		summary,
		group,
	};
}

function normalizeKnowledgeUnits(
	payload: unknown,
	chunk: ContentChunk,
	analysis: KnowledgeChunkAnalysis,
): KnowledgeUnit[] {
	const response = isObject(payload) ? payload as KnowledgeExtractionResponse : {};
	const rawUnits = Array.isArray(response.units) ? response.units : [];
	const units: KnowledgeUnit[] = [];

	for (const [index, rawUnit] of rawUnits.entries()) {
		if (!isObject(rawUnit)) {
			continue;
		}

		const statement = collapseWhitespace(readString(rawUnit.statement));
		const evidenceExcerpt = collapseWhitespace(readString(rawUnit.evidenceExcerpt));
		if (statement.length === 0 || evidenceExcerpt.length === 0) {
			continue;
		}

		units.push({
			id: `${chunk.chunkId}:unit:${index + 1}`,
			sourceUnitIds: [`${chunk.chunkId}:unit:${index + 1}`],
			filePath: chunk.filePath,
			chunkId: chunk.chunkId,
			sectionKey: chunk.sectionKey,
			headingPath: [...chunk.headingPath],
			titleHint: chunk.titleHint,
			chunkSummary: analysis.summary,
			groupLabel: analysis.group,
			statement,
			kind: normalizeKnowledgeKind(rawUnit.kind),
			importanceLocal: normalizeImportance(rawUnit.importanceLocal),
			candidateQuestionIntent: collapseWhitespace(readString(rawUnit.candidateQuestionIntent)),
			evidenceExcerpt,
			sourceHash: chunk.sourceHash,
			tokenEstimate: Math.max(1, Math.ceil((statement.length + evidenceExcerpt.length) / 4)),
		});
	}

	if (units.length === 0) {
		const fallbackUnit = buildFallbackKnowledgeUnit(chunk, analysis);
		if (fallbackUnit !== null) {
			units.push(fallbackUnit);
		}
	}

	return units;
}

function fallbackSummary(chunk: ContentChunk): string {
	if (chunk.titleHint && chunk.titleHint.trim().length > 0) {
		return collapseWhitespace(`${chunk.titleHint}: ${makePreview(chunk.text, 80)}`);
	}

	return makePreview(chunk.text, 96);
}

function fallbackGroup(chunk: ContentChunk): string {
	const deepestHeading = chunk.headingPath[chunk.headingPath.length - 1] ?? chunk.titleHint ?? "";
	if (deepestHeading.trim().length > 0) {
		return collapseWhitespace(deepestHeading);
	}

	return "未分组知识面";
}

function buildFallbackKnowledgeUnit(
	chunk: ContentChunk,
	analysis: KnowledgeChunkAnalysis,
): KnowledgeUnit | null {
	if (!isFallbackEligibleChunk(chunk.text)) {
		return null;
	}

	const summary = collapseWhitespace(analysis.summary);
	if (summary.length === 0) {
		return null;
	}

	const evidenceExcerpt = collapseWhitespace(makePreview(chunk.text, 180));
	if (evidenceExcerpt.length === 0) {
		return null;
	}

	return {
		id: `${chunk.chunkId}:unit:fallback`,
		sourceUnitIds: [`${chunk.chunkId}:unit:fallback`],
		filePath: chunk.filePath,
		chunkId: chunk.chunkId,
		sectionKey: chunk.sectionKey,
		headingPath: [...chunk.headingPath],
		titleHint: chunk.titleHint,
		chunkSummary: analysis.summary,
		groupLabel: analysis.group,
		statement: summary,
		kind: "core-concept",
		importanceLocal: 0.58,
		candidateQuestionIntent: `解释或回忆：${summary}`,
		evidenceExcerpt,
		sourceHash: chunk.sourceHash,
		tokenEstimate: Math.max(1, Math.ceil((summary.length + evidenceExcerpt.length) / 4)),
	};
}

function isFallbackEligibleChunk(value: string): boolean {
	const normalizedValue = collapseWhitespace(value);
	if (normalizedValue.length >= 140) {
		return true;
	}

	const sentenceCount = normalizedValue
		.split(/[.!?。！？；;]/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => sentence.length > 0)
		.length;
	return sentenceCount >= 2 && normalizedValue.length >= 80;
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

function normalizeKnowledgeKind(value: unknown): KnowledgeUnitKind {
	switch (value) {
		case "core-concept":
		case "key-conclusion":
		case "supporting-detail":
		case "background":
		case "example":
		case "process-detail":
		case "ignore":
			return value;
		default:
			return "supporting-detail";
	}
}

function normalizeImportance(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0.5;
	}

	return Math.max(0, Math.min(1, value));
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
