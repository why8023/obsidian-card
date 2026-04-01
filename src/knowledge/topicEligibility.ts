import type { KnowledgeChunkAnalysis, KnowledgeTopic, TopicTier } from "../types";
import { collapseWhitespace } from "../utils/markdown";

const DEFAULT_TOPIC_CARD_THRESHOLD = 0.55;

export function normalizeTopicImportance(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0.5;
	}

	return Math.max(0, Math.min(1, value));
}

export function normalizeTopicTier(value: unknown): TopicTier {
	return value === "secondary" ? "secondary" : "core";
}

export function normalizeRecommendedCardCount(
	value: unknown,
	maxCardsPerTopic: number,
	shouldCreateCards: boolean,
): number {
	if (!shouldCreateCards) {
		return 0;
	}

	if (typeof value !== "number" || Number.isNaN(value)) {
		return 1;
	}

	return Math.max(1, Math.min(maxCardsPerTopic, Math.round(value)));
}

export function normalizeShouldCreateCards(
	value: unknown,
	importanceScore: number,
	memberChunkCount: number,
): boolean {
	if (typeof value === "boolean") {
		return value;
	}

	return importanceScore >= DEFAULT_TOPIC_CARD_THRESHOLD && memberChunkCount > 0;
}

export function fallbackTopicRejectionReason(
	shouldCreateCards: boolean,
	importanceScore: number,
): string {
	if (shouldCreateCards) {
		return "";
	}

	if (importanceScore < DEFAULT_TOPIC_CARD_THRESHOLD) {
		return "The topic is too weak, too contextual, or too low-value for standalone flashcards.";
	}

	return "The topic does not justify standalone flashcards after deduplication.";
}

export function scoreChunkCluster(analyses: KnowledgeChunkAnalysis[]): number {
	if (analyses.length === 0) {
		return 0;
	}

	const evidenceScore = analyses
		.map((analysis) => collapseWhitespace(analysis.evidenceExcerpt).length >= 40 ? 0.15 : 0.05)
		.reduce((sum, score) => sum + score, 0) / analyses.length;
	const hintScore = analyses
		.map((analysis) => collapseWhitespace(analysis.topicHint).length > 0 ? 0.15 : 0)
		.reduce((sum, score) => sum + score, 0) / analyses.length;
	const summaryScore = analyses
		.map((analysis) => Math.min(collapseWhitespace(analysis.summary).length / 120, 0.35))
		.reduce((sum, score) => sum + score, 0) / analyses.length;
	const reuseScore = Math.min(analyses.length / 3, 1) * 0.35;

	return Number.parseFloat(Math.min(summaryScore + hintScore + evidenceScore + reuseScore, 1).toFixed(2));
}

export function buildFallbackTopic(
	memberChunkIds: string[],
	analyses: KnowledgeChunkAnalysis[],
	maxCardsPerTopic: number,
): KnowledgeTopic | null {
	if (memberChunkIds.length === 0 || analyses.length === 0) {
		return null;
	}

	const primaryAnalysis = analyses[0]!;
	const knowledgeGroup = collapseWhitespace(primaryAnalysis.topicHint) || collapseWhitespace(primaryAnalysis.summary);
	const canonicalStatement = collapseWhitespace(primaryAnalysis.summary);
	if (canonicalStatement.length === 0) {
		return null;
	}

	const importanceScore = scoreChunkCluster(analyses);
	const shouldCreateCards = normalizeShouldCreateCards(undefined, importanceScore, memberChunkIds.length);
	const tier = importanceScore >= 0.75 || memberChunkIds.length >= 2 ? "core" : "secondary";

	return {
		topicId: "",
		canonicalStatement,
		knowledgeGroup: knowledgeGroup.length > 0 ? knowledgeGroup : canonicalStatement,
		summary: canonicalStatement,
		memberChunkIds,
		importanceScore,
		tier,
		recommendedCardCount: normalizeRecommendedCardCount(
			shouldCreateCards && importanceScore >= 0.82 && memberChunkIds.length >= 2 ? 2 : 1,
			maxCardsPerTopic,
			shouldCreateCards,
		),
		shouldCreateCards,
		rejectionReason: fallbackTopicRejectionReason(shouldCreateCards, importanceScore),
	};
}
