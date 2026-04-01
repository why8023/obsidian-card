function withCustomInstruction(baseLines: string[], customInstruction: string): string {
	const trimmedInstruction = customInstruction.trim();
	if (trimmedInstruction.length === 0) {
		return baseLines.join(" ");
	}

	return [
		...baseLines,
		`Additional generation policy: ${trimmedInstruction}`,
	].join(" ");
}

export function buildKnowledgeExtractionPrompt(customInstruction: string): string {
	return withCustomInstruction([
		"You are stage 1 of a two-stage flashcard workflow for one merged markdown chunk.",
		"Do not generate flashcards.",
		"Decide whether the chunk contains durable knowledge worth carrying into later topic grouping.",
		"If it does, return a concise summary, a short topicHint label, and a small evidenceExcerpt.",
		"If it does not, set hasKnowledge to false, keep topicHint empty, and explain why in rejectionReason.",
		"Prefer definitions, core concepts, distinctions, causal relations, rules, conclusions, and decision-relevant procedures.",
		"Down-rank scaffolding, transition text, metadata, rhetorical filler, isolated examples, and low-value context.",
		"summary should capture what the chunk mainly teaches.",
		"topicHint should be a short grouping label for chunks that teach the same knowledge point.",
		"evidenceExcerpt should be the smallest useful excerpt that supports the summary.",
		"rejectionReason should be empty when hasKnowledge is true.",
		"Stay consistent with any existingAnalysis when it still matches the current chunk content.",
		"Return only JSON in the shape {\"hasKnowledge\":true|false,\"summary\":\"...\",\"topicHint\":\"...\",\"evidenceExcerpt\":\"...\",\"rejectionReason\":\"...\"}.",
	], customInstruction);
}

export function buildGlobalRankingPrompt(
	options: {
		coreCardBudget: number;
		secondaryCardBudget: number;
		maxTotalCardsPerDocument: number;
		maxCardsPerTopic: number;
	},
	customInstruction: string,
): string {
	return withCustomInstruction([
		"You are stage 1b of a two-stage flashcard workflow.",
		"You receive chunk-level analyses for one note. Group chunks that teach the same knowledge point.",
		"Keep different knowledge points separate even if they are adjacent in the note.",
		"Treat the result as a chunk partition: each chunk id should appear in at most one topic.",
		"Create a topic even when it should not become flashcards yet, as long as it represents a distinct knowledge point.",
		"For each topic, decide whether it is worth making flashcards.",
		"A topic is usually card-worthy only when it expresses durable, non-trivial knowledge that can support standalone review.",
		"Prefer merging duplicate chunks over creating parallel topics for the same idea.",
		`The document budgets are: core=${options.coreCardBudget}, secondary=${options.secondaryCardBudget}, total=${options.maxTotalCardsPerDocument}, maxCardsPerTopic=${options.maxCardsPerTopic}.`,
		"importanceScore must be a number from 0 to 1.",
		"tier must be either core or secondary.",
		"recommendedCardCount must be 0 when shouldCreateCards is false, otherwise a small integer no larger than maxCardsPerTopic.",
		"rejectionReason should be empty when shouldCreateCards is true.",
		"Return only JSON in the shape {\"topics\": [...]} with fields: canonicalStatement, knowledgeGroup, summary, memberChunkIds, importanceScore, tier, recommendedCardCount, shouldCreateCards, rejectionReason.",
	], customInstruction);
}

export function buildCardCompositionPrompt(
	options: {
		cardCount: number;
	},
	customInstruction: string,
): string {
	return withCustomInstruction([
		"You compose final BASIC flashcards for one knowledge topic using only the provided source chunks.",
		"Questions must stand on their own and must not rely on headings, surrounding prose, or phrases like this section, above, below, here, or the title.",
		"Answers must be concise, complete, and faithful to the source material.",
		"Each card should test one clear, durable knowledge point, not trivia or mere document scaffolding.",
		"Do not blend separate ideas into one card.",
		"If the requested count is higher than the number of good cards, return fewer cards.",
		"Stay faithful to the source evidence and use the same language as the source material unless the user explicitly requested another language.",
		`Return at most ${options.cardCount} cards for the topic.`,
		"Return only a JSON array of {front, back, tags}. tags may be empty.",
	], customInstruction);
}
