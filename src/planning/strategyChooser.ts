import type { FlashcardGenerationSettings } from "../settings";
import type { GenerationMode, ScopeEstimate } from "../types";

export function chooseGenerationStrategy(
	mode: GenerationMode,
	estimate: Omit<ScopeEstimate, "recommendedStrategy" | "reason">,
	settings: FlashcardGenerationSettings,
): Pick<ScopeEstimate, "recommendedStrategy" | "reason"> {
	if (mode === "selection") {
		return {
			recommendedStrategy: "direct-global",
			reason: "Selection mode is already scoped to a small range.",
		};
	}

	if (estimate.chunkCount === 0) {
		return {
			recommendedStrategy: "direct-global",
			reason: "No eligible chunks were found, so no extra planning is required.",
		};
	}

	const exceedsHardInputLimit = estimate.estimatedInputTokens > settings.maxTaskInputTokens;
	const exceedsHardChunkLimit = estimate.chunkCount > settings.maxTaskChunks;
	const exceedsHardCallLimit = estimate.estimatedLlmCalls > settings.maxTaskLlmCalls;

	if (exceedsHardInputLimit || exceedsHardChunkLimit || exceedsHardCallLimit) {
		if (settings.oversizeStrategy === "chapter-planning" && estimate.headingCount > 0) {
			return {
				recommendedStrategy: "chapter-planning",
				reason: "The document exceeds the hard task limits, so the run is downgraded to chapter planning.",
			};
		}

		return {
			recommendedStrategy: "refuse-or-scope",
			reason: "The document exceeds the hard task limits for a single generation run.",
		};
	}

	const exceedsDirectGlobalTokenLimit = estimate.estimatedInputTokens > settings.maxTokensForDirectGlobal;
	const exceedsDirectGlobalChunkLimit = estimate.chunkCount > settings.maxChunksForDirectGlobal;
	const needsMoreThanDirectGlobal = estimate.isLikelyBookLikeDocument || exceedsDirectGlobalTokenLimit || exceedsDirectGlobalChunkLimit;
	if (needsMoreThanDirectGlobal) {
		if (!estimate.isLikelyBookLikeDocument && settings.maxHierarchyDepth > 1 && estimate.headingCount > 0) {
			return {
				recommendedStrategy: "hierarchical-global",
				reason: "The note is beyond the direct-global limits, so OBCD will compress section knowledge before global ranking.",
			};
		}

		if (settings.oversizeStrategy === "chapter-planning" && estimate.headingCount > 0) {
			return {
				recommendedStrategy: "chapter-planning",
				reason: "The note is too large or too book-like for direct global generation, so it is downgraded to chapter planning.",
			};
		}

		return {
			recommendedStrategy: "refuse-or-scope",
			reason: "The note is larger than the direct-global limits. Scope down to a chapter or selection.",
		};
	}

	return {
		recommendedStrategy: "direct-global",
		reason: "The note fits within the direct-global limits.",
	};
}
