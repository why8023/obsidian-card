import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildKnowledgeExtractionPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { ChunkAnalysisResult, ContentChunk } from "../types";
import {
	hasReusableChunkAnalysis,
	hydrateChunkAnalysisFromAnnotation,
	normalizeChunkAnalysisPayload,
} from "./chunkEligibility";

export class KnowledgeExtractor {
	private readonly llmClient: LlmClient;

	constructor(
		private readonly settings: ObcdSettings,
		private readonly customInstruction: string,
		private readonly extractFingerprint: string,
		private readonly debugRun?: DebugRun,
	) {
		this.llmClient = new LlmClient(settings, debugRun);
	}

	async extract(chunk: ContentChunk, chunkIndex: number): Promise<ChunkAnalysisResult> {
		const cachedAnalysis = hydrateChunkAnalysisFromAnnotation(chunk, this.extractFingerprint);
		if (cachedAnalysis !== null) {
			this.debugRun?.log("extract:cache", "Reused cached chunk analysis.", {
				chunkIndex,
				chunkId: chunk.chunkId,
				status: cachedAnalysis.status,
			});

			return {
				chunk,
				analysis: cachedAnalysis,
			};
		}

		const payload = await this.llmClient.requestJson(`extract:${chunkIndex}`, [
			{
				role: "system",
				content: buildKnowledgeExtractionPrompt(
					this.settings.prompts.knowledgeExtractionPrompt,
					this.customInstruction,
				),
			},
			{
				role: "user",
				content: JSON.stringify({
					filePath: chunk.filePath,
					chunkId: chunk.chunkId,
					titleHint: chunk.titleHint ?? "",
					text: chunk.text,
					existingAnalysis: hasReusableChunkAnalysis(chunk, this.extractFingerprint)
						? chunk.existingAnnotation?.data
						: undefined,
				}),
			},
		]);

		const analysis = normalizeChunkAnalysisPayload(
			payload,
			chunk,
			this.extractFingerprint,
			new Date().toISOString(),
		);
		this.debugRun?.log("extract:analysis", "Analyzed one chunk for durable knowledge.", {
			chunkIndex,
			chunkId: chunk.chunkId,
			analysis,
		});

		return {
			chunk,
			analysis,
		};
	}
}
