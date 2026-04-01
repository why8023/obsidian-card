import type { FlashcardGenerationSettings } from "../settings";
import type { CompositionRequest, KnowledgeChunkAnalysis, KnowledgeTopic } from "../types";
import { hashContent } from "./markdown";

const FINGERPRINT_SCHEMA_VERSION = 1;

export function buildKnowledgeExtractionFingerprint(model: string, temperature: number, systemPrompt: string): string {
	return buildStageFingerprint("extract", {
		model,
		temperature,
		systemPrompt,
	});
}

export function buildTopicGroupingFingerprint(
	model: string,
	temperature: number,
	systemPrompt: string,
	analyses: KnowledgeChunkAnalysis[],
): string {
	return buildStageFingerprint("group", {
		model,
		temperature,
		systemPrompt,
		chunks: analyses.map((analysis) => ({
			chunkId: analysis.chunkId,
			status: analysis.status,
			summary: analysis.summary,
			topicHint: analysis.topicHint,
			evidenceExcerpt: analysis.evidenceExcerpt,
			rejectionReason: analysis.rejectionReason,
		})),
	});
}

export function buildTopicPlanFingerprint(
	settings: Pick<
		FlashcardGenerationSettings,
		"coreCardBudget" | "secondaryCardBudget" | "maxTotalCardsPerDocument" | "maxCardsPerTopic"
	>,
	topics: KnowledgeTopic[],
	remainingLlmCalls: number,
): string {
	return buildStageFingerprint("plan", {
		remainingLlmCalls,
		budgets: {
			coreCardBudget: settings.coreCardBudget,
			secondaryCardBudget: settings.secondaryCardBudget,
			maxTotalCardsPerDocument: settings.maxTotalCardsPerDocument,
			maxCardsPerTopic: settings.maxCardsPerTopic,
		},
		topics: topics.map((topic) => ({
			topicId: topic.topicId,
			tier: topic.tier,
			importanceScore: topic.importanceScore,
			recommendedCardCount: topic.recommendedCardCount,
			shouldCreateCards: topic.shouldCreateCards,
			memberChunkIds: [...topic.memberChunkIds],
		})),
	});
}

export function buildCardCompositionFingerprint(
	model: string,
	temperature: number,
	systemPrompt: string,
	request: CompositionRequest,
): string {
	return buildStageFingerprint("compose", {
		model,
		temperature,
		systemPrompt,
		cardCount: request.cardCount,
		topic: {
			topicId: request.topic.topicId,
			tier: request.topic.tier,
			knowledgeGroup: request.topic.knowledgeGroup,
			canonicalStatement: request.topic.canonicalStatement,
			summary: request.topic.summary,
			recommendedCardCount: request.topic.recommendedCardCount,
		},
		chunkAnalyses: request.chunkAnalyses.map((analysis) => ({
			chunkId: analysis.chunkId,
			summary: analysis.summary,
			topicHint: analysis.topicHint,
			evidenceExcerpt: analysis.evidenceExcerpt,
		})),
		sourceChunks: request.chunks.map((chunk) => ({
			chunkId: chunk.chunkId,
			text: chunk.text,
		})),
	});
}

function buildStageFingerprint(stage: string, payload: unknown): string {
	return hashContent(JSON.stringify({
		version: FINGERPRINT_SCHEMA_VERSION,
		stage,
		payload,
	}));
}
