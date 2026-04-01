import type {
	ExistingCardEntry,
	GenerationMode,
	TopicTier,
} from "../types";
import type { PersistedDocumentMetadata } from "../writing/documentMetadataWriter";

export type SidebarTopicAnalysisStatus = "planned" | "eligible" | "analysis-only";

export interface SidebarTopicAnalysisItem {
	topicId: string;
	canonicalStatement: string;
	knowledgeGroup: string;
	summary: string;
	memberChunkCount: number;
	importanceScore: number;
	tier: TopicTier;
	recommendedCardCount: number;
	plannedCardCount: number;
	insertedCardCount: number;
	status: SidebarTopicAnalysisStatus;
	rejectionReason: string;
}

export interface SidebarAnalysisSnapshot {
	generatedAt: string;
	mode: GenerationMode | null;
	model: string;
	promptSource: string;
	knowledgeChunkCount: number;
	topicCount: number;
	coreTopicCount: number;
	secondaryTopicCount: number;
	plannedTopicCount: number;
	analysisOnlyTopicCount: number;
	plannedCardCount: number;
	insertedCardCount: number;
	remainingLlmCalls: number | null;
	budget: {
		coreCardBudget: number;
		secondaryCardBudget: number;
		maxCardsPerTopic: number;
		maxTotalCards: number;
	} | null;
	topics: SidebarTopicAnalysisItem[];
}

export function buildSidebarAnalysisSnapshot(
	metadata: PersistedDocumentMetadata,
	cards: ExistingCardEntry[],
): SidebarAnalysisSnapshot | null {
	const persistedTopics = metadata.topics?.topics ?? [];
	const budgetPlan = metadata.topicPlan?.budgetPlan ?? null;
	const generationMeta = metadata.generationMeta;

	if (persistedTopics.length === 0 && budgetPlan === null && generationMeta === null) {
		return null;
	}

	const insertedPluginCards = cards.filter((card) => card.isPluginGenerated);
	const insertedCountByTopicId = new Map<string, number>();
	for (const card of insertedPluginCards) {
		const topicId = card.topicId?.trim();
		if (!topicId) {
			continue;
		}

		insertedCountByTopicId.set(topicId, (insertedCountByTopicId.get(topicId) ?? 0) + 1);
	}

	const plannedCountByTopicId = new Map<string, number>();
	for (const selectedTopic of budgetPlan?.selectedTopics ?? []) {
		plannedCountByTopicId.set(selectedTopic.topicId, selectedTopic.cardCount);
	}

	const topics = persistedTopics
		.map((topic) => {
			const plannedCardCount = plannedCountByTopicId.get(topic.topicId) ?? 0;
			const status = plannedCardCount > 0
				? "planned"
				: topic.shouldCreateCards
				? "eligible"
				: "analysis-only";

			return {
				topicId: topic.topicId,
				canonicalStatement: topic.canonicalStatement,
				knowledgeGroup: topic.knowledgeGroup,
				summary: topic.summary,
				memberChunkCount: topic.memberChunkIds.length,
				importanceScore: topic.importanceScore,
				tier: topic.tier,
				recommendedCardCount: topic.recommendedCardCount,
				plannedCardCount,
				insertedCardCount: insertedCountByTopicId.get(topic.topicId) ?? 0,
				status,
				rejectionReason: topic.rejectionReason,
			} satisfies SidebarTopicAnalysisItem;
		})
		.sort((left, right) => (
			getTopicStatusRank(left.status) - getTopicStatusRank(right.status)
			|| getTierRank(left.tier) - getTierRank(right.tier)
			|| right.importanceScore - left.importanceScore
			|| right.plannedCardCount - left.plannedCardCount
			|| left.canonicalStatement.localeCompare(right.canonicalStatement)
		));

	const generatedAt = generationMeta?.generatedAt
		|| metadata.topics?.generatedAt
		|| metadata.topicPlan?.generatedAt
		|| "";
	const uniqueChunkCount = new Set(
		persistedTopics.flatMap((topic) => topic.memberChunkIds),
	).size;

	return {
		generatedAt,
		mode: generationMeta?.mode ?? null,
		model: generationMeta?.provider?.model ?? "",
		promptSource: generationMeta?.prompt?.source ?? "",
		knowledgeChunkCount: generationMeta?.knowledgeChunkCount ?? uniqueChunkCount,
		topicCount: persistedTopics.length || generationMeta?.topicCount || 0,
		coreTopicCount: topics.filter((topic) => topic.tier === "core").length,
		secondaryTopicCount: topics.filter((topic) => topic.tier === "secondary").length,
		plannedTopicCount: topics.filter((topic) => topic.status === "planned").length,
		analysisOnlyTopicCount: topics.filter((topic) => topic.status === "analysis-only").length,
		plannedCardCount: budgetPlan?.totalPlannedCards ?? generationMeta?.plannedCardCount ?? 0,
		insertedCardCount: insertedPluginCards.length,
		remainingLlmCalls: metadata.topicPlan?.remainingLlmCalls ?? null,
		budget: budgetPlan
			? {
				coreCardBudget: budgetPlan.coreCardBudget,
				secondaryCardBudget: budgetPlan.secondaryCardBudget,
				maxCardsPerTopic: budgetPlan.maxCardsPerTopic,
				maxTotalCards: budgetPlan.maxTotalCards,
			}
			: null,
		topics,
	};
}

function getTopicStatusRank(status: SidebarTopicAnalysisStatus): number {
	switch (status) {
		case "planned":
			return 0;
		case "eligible":
			return 1;
		case "analysis-only":
		default:
			return 2;
	}
}

function getTierRank(tier: TopicTier): number {
	return tier === "core" ? 0 : 1;
}
