import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildKnowledgeExtractionPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { ContentChunk, KnowledgeUnit, KnowledgeUnitKind } from "../types";
import { collapseWhitespace } from "../utils/markdown";

interface KnowledgeExtractionResponse {
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

	async extract(chunk: ContentChunk, chunkIndex: number): Promise<KnowledgeUnit[]> {
		const payload = await this.llmClient.requestJson(`extract:${chunkIndex}`, [
			{
				role: "system",
				content: buildKnowledgeExtractionPrompt(this.settings.generation.maxKnowledgeUnitsPerChunk, this.customInstruction),
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
		]);

		const units = normalizeKnowledgeUnits(payload, chunk);
		this.debugRun?.log("extract:units", `Extracted ${units.length} knowledge unit(s).`, {
			chunkIndex,
			sectionKey: chunk.sectionKey,
			units,
		});
		return units;
	}
}

function normalizeKnowledgeUnits(payload: unknown, chunk: ContentChunk): KnowledgeUnit[] {
	const rawUnits = Array.isArray(payload)
		? payload
		: Array.isArray((payload as KnowledgeExtractionResponse | undefined)?.units)
		? (payload as KnowledgeExtractionResponse).units ?? []
		: [];

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
			id: `${chunk.sectionKey}:unit:${index + 1}`,
			filePath: chunk.filePath,
			sectionKey: chunk.sectionKey,
			headingPath: [...chunk.headingPath],
			titleHint: chunk.titleHint,
			statement,
			kind: normalizeKnowledgeKind(rawUnit.kind),
			importanceLocal: normalizeImportance(rawUnit.importanceLocal),
			candidateQuestionIntent: collapseWhitespace(readString(rawUnit.candidateQuestionIntent)),
			evidenceExcerpt,
			sourceHash: chunk.sourceHash,
			tokenEstimate: Math.max(1, Math.ceil((statement.length + evidenceExcerpt.length) / 4)),
		});
	}

	return units;
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
