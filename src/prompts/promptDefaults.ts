import type { GenerationStrategy } from "../types";

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

export function buildKnowledgeExtractionPrompt(maxKnowledgeUnitsPerChunk: number, customInstruction: string): string {
	return withCustomInstruction([
		"You analyze one markdown knowledge chunk for later flashcard generation.",
		"Do not generate flashcards in this step.",
		"First decide what this chunk mainly teaches, then decide which broader knowledge surface it belongs to.",
		"summary and group are additional metadata for later orchestration. They do not replace the knowledge units.",
		"Prefer core concepts, key conclusions, definitions, contrasts, causal relations, and decision-relevant steps.",
		"Down-rank examples, incidental details, rhetorical filler, document scaffolding, and temporary process traces.",
		"Returning an empty array is correct when the chunk has no worthwhile long-term memory targets.",
		"summary must briefly answer: what does this chunk mainly teach?",
		"group must be a short knowledge-surface label that can group related chunks for card generation.",
		`Return at most ${maxKnowledgeUnitsPerChunk} knowledge units for the chunk.`,
		"Each unit must contain: statement, kind, importanceLocal, candidateQuestionIntent, evidenceExcerpt.",
		"If the chunk contains any durable learning value, you should still return one or more units even after writing summary and group.",
		"kind must be one of: core-concept, key-conclusion, supporting-detail, background, example, process-detail, ignore.",
		"importanceLocal must be a number from 0 to 1.",
		"candidateQuestionIntent should briefly describe what a later card would test, not the final question wording.",
		"evidenceExcerpt should quote only the smallest useful supporting excerpt.",
		"Stay consistent with any existing chunk summary/group provided in the input unless the chunk content clearly no longer matches.",
		"Return only JSON in the shape {\"summary\":\"...\",\"group\":\"...\",\"units\":[...]} with no markdown fences or commentary.",
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
		"You consolidate chunk-level knowledge units into globally ranked learning topics for flashcard generation.",
		"Deduplicate overlapping units, merge paraphrases, and prefer one canonical statement per topic.",
		"Use chunk summaries and chunk group labels to keep each topic inside one coherent knowledge surface whenever possible.",
		"Do not merge units from different groups unless they clearly express the same learning target.",
		"Select the document's core learning skeleton first, then only keep secondary topics that still justify card budget.",
		"Do not keep topics just to maximize coverage.",
		`The document budgets are: core=${options.coreCardBudget}, secondary=${options.secondaryCardBudget}, total=${options.maxTotalCardsPerDocument}, maxCardsPerTopic=${options.maxCardsPerTopic}.`,
		"tier must be either core or secondary.",
		"importanceGlobal must be a number from 0 to 1.",
		"recommendedCardCount must be a small integer, usually 1 and never larger than the configured maxCardsPerTopic.",
		"Only reference memberUnitIds that exist in the input.",
		"Return only JSON in the shape {\"topics\": [...]} with fields: canonicalStatement, knowledgeGroup, memberUnitIds, importanceGlobal, tier, recommendedCardCount.",
	], customInstruction);
}

export function buildSectionAggregationPrompt(
	options: {
		maxSummaryTopics: number;
	},
	customInstruction: string,
): string {
	return withCustomInstruction([
		"You compress section-level knowledge units into a smaller set of representative section topics.",
		"Merge duplicates and closely related points, but keep the section's core knowledge skeleton intact.",
		"Prefer core concepts and key conclusions over examples, context, and minor details.",
		`Return at most ${options.maxSummaryTopics} section topics.`,
		"Each topic must contain: statement, importanceLocal, candidateQuestionIntent, evidenceExcerpt, memberUnitIds.",
		"importanceLocal must be a number from 0 to 1.",
		"memberUnitIds must reference only the unit ids from the input.",
		"Return only JSON in the shape {\"topics\": [...]} with no markdown fences or commentary.",
	], customInstruction);
}

export function buildCardCompositionPrompt(
	options: {
		cardCount: number;
		strategy: GenerationStrategy;
	},
	customInstruction: string,
): string {
	return withCustomInstruction([
		"You compose final BASIC flashcards from globally selected knowledge topics plus source evidence.",
		"Use the canonical topic statement and the supporting evidence to write clear, standalone Q/A cards.",
		"Use the chunk summaries and the topic's knowledge group to keep each card focused on a single knowledge surface.",
		"Questions must stand on their own without relying on section titles or surrounding prose.",
		"Answers must be concise but complete enough for review.",
		"Do not produce duplicate cards or split topics into trivia.",
		"Do not blend separate knowledge groups into one card.",
		"Stay faithful to the source evidence and use the same language as the source material unless the user explicitly requested another language.",
		`Return at most ${options.cardCount} cards for the topic. The current strategy is ${options.strategy}.`,
		"Return only a JSON array of {front, back, tags}. tags may be empty.",
		"Do not emit markdown card blocks, explanations, or extra keys.",
	], customInstruction);
}

export function buildPlanningPrompt(customInstruction: string): string {
	return withCustomInstruction([
		"You are planning flashcard generation for an oversized markdown document.",
		"Do not generate cards.",
		"Summarize the major sections, estimate where flashcard value density is highest, and recommend the next sections to scope down into.",
		"Return only JSON in the shape {\"sections\": [...]} with fields: title, summary, estimatedCardValueDensity, recommended.",
	], customInstruction);
}
