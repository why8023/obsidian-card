import type { FlashcardGenerationSettings } from "../settings";
import type { ContentChunk, GenerationMode, ScopeEstimate } from "../types";
import { collectMarkdownHeadings } from "../utils/markdown";
import { chooseGenerationStrategy } from "./strategyChooser";

export function estimateScope(
	mode: GenerationMode,
	content: string,
	chunks: ContentChunk[],
	settings: FlashcardGenerationSettings,
): ScopeEstimate {
	const headings = collectMarkdownHeadings(content);
	const headingDepth = headings.reduce((maxDepth, heading) => Math.max(maxDepth, heading.level), 0);
	const characterCount = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
	const estimatedInputTokens = estimateTokenCount(characterCount);
	const estimatedKnowledgeUnitCount = Math.min(
		chunks.length * Math.max(settings.maxKnowledgeUnitsPerChunk, 1),
		Math.max(Math.ceil(characterCount / 900), chunks.length),
	);
	const estimatedLlmCalls = chunks.length + 1 + Math.min(settings.maxTotalCardsPerDocument, chunks.length + estimatedKnowledgeUnitCount);
	const topLevelHeadingCount = headings.filter((heading) => heading.level <= 2).length;
	const isLikelyBookLikeDocument = (
		characterCount >= 32000
		&& (topLevelHeadingCount >= 10 || headings.length >= 24 || headingDepth >= 4)
	);

	const baseEstimate = {
		characterCount,
		chunkCount: chunks.length,
		headingCount: headings.length,
		headingDepth,
		estimatedInputTokens,
		estimatedKnowledgeUnitCount,
		estimatedLlmCalls,
		isLikelyBookLikeDocument,
	};
	const strategy = chooseGenerationStrategy(mode, baseEstimate, settings);

	return {
		...baseEstimate,
		...strategy,
	};
}

function estimateTokenCount(characterCount: number): number {
	return Math.ceil(characterCount / 4);
}
