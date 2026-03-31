import type { FlashcardGenerationSettings } from "../settings";
import type { BudgetPlan, KnowledgeTopic, TopicBudgetAllocation, TopicTier } from "../types";

const DEFAULT_MAX_SECTION_SHARE = 0.5;

export function allocateCardBudget(topics: KnowledgeTopic[], settings: FlashcardGenerationSettings, remainingLlmCalls: number): BudgetPlan {
	const maxTotalCards = Math.min(
		settings.maxTotalCardsPerDocument,
		Math.max(0, settings.coreCardBudget + settings.secondaryCardBudget),
	);
	const maxTopicSelections = Math.max(0, remainingLlmCalls);
	const sectionCap = Math.max(1, Math.ceil(maxTotalCards * DEFAULT_MAX_SECTION_SHARE));
	const selectedTopics: TopicBudgetAllocation[] = [];
	const cardsPerSection = new Map<string, number>();

	let remainingTotal = maxTotalCards;
	let remainingCore = Math.min(settings.coreCardBudget, remainingTotal);
	let remainingSecondary = Math.min(settings.secondaryCardBudget, Math.max(remainingTotal - remainingCore, 0));
	let remainingSelections = maxTopicSelections;

	const sortedTopics = [...topics].sort((left, right) => (
		tierOrder(left.tier) - tierOrder(right.tier) || right.importanceGlobal - left.importanceGlobal
	));

	for (const topic of sortedTopics) {
		if (remainingTotal <= 0 || remainingSelections <= 0) {
			break;
		}

		const tierBudget = topic.tier === "core" ? remainingCore : remainingSecondary;
		if (tierBudget <= 0) {
			continue;
		}

		const dominantSection = topic.coverageSections[0] ?? "";
		const usedBySection = cardsPerSection.get(dominantSection) ?? 0;
		if (dominantSection.length > 0 && usedBySection >= sectionCap) {
			continue;
		}

		const cardCount = Math.min(
			settings.maxCardsPerTopic,
			topic.recommendedCardCount,
			tierBudget,
			remainingTotal,
		);
		if (cardCount <= 0) {
			continue;
		}

		selectedTopics.push({
			topicId: topic.topicId,
			tier: topic.tier,
			cardCount,
		});

		if (dominantSection.length > 0) {
			cardsPerSection.set(dominantSection, usedBySection + cardCount);
		}
		remainingTotal -= cardCount;
		remainingSelections -= 1;
		if (topic.tier === "core") {
			remainingCore -= cardCount;
		} else {
			remainingSecondary -= cardCount;
		}
	}

	return {
		maxTotalCards,
		coreCardBudget: settings.coreCardBudget,
		secondaryCardBudget: settings.secondaryCardBudget,
		maxCardsPerTopic: settings.maxCardsPerTopic,
		totalPlannedCards: selectedTopics.reduce((sum, topic) => sum + topic.cardCount, 0),
		selectedTopics,
	};
}

function tierOrder(tier: TopicTier): number {
	return tier === "core" ? 0 : 1;
}
