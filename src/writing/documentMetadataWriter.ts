import type { App, TFile } from "obsidian";

import type { ResolvedGenerationPrompt } from "../prompts/promptResolver";
import type { BudgetPlan, GenerationMode, KnowledgeTopic } from "../types";

const DOCUMENT_METADATA_SCHEMA_VERSION = 1;

export const OBCD_TOPICS_FRONTMATTER_KEY = "obcd_topics";
export const OBCD_TOPIC_PLAN_FRONTMATTER_KEY = "obcd_topic_plan";
export const OBCD_GENERATION_META_FRONTMATTER_KEY = "obcd_generation_meta";

type PersistedKnowledgeTopic = Pick<
	KnowledgeTopic,
	| "topicId"
	| "canonicalStatement"
	| "knowledgeGroup"
	| "summary"
	| "memberChunkIds"
	| "importanceScore"
	| "tier"
	| "recommendedCardCount"
	| "shouldCreateCards"
	| "rejectionReason"
>;

export interface DocumentMetadataWriteRequest {
	mode: GenerationMode;
	generatedAt: string;
	providerPresetType: string;
	model: string;
	temperature: number;
	resolvedPrompt: Pick<ResolvedGenerationPrompt, "source" | "noteFolder" | "templatePath">;
	extractFingerprint: string;
	groupFingerprint: string;
	planFingerprint: string;
	knowledgeChunkCount: number;
	topics: KnowledgeTopic[];
	budgetPlan: BudgetPlan | null;
	remainingLlmCalls: number | null;
}

export async function writeDocumentMetadata(
	app: App,
	file: TFile,
	request: DocumentMetadataWriteRequest,
): Promise<boolean> {
	if (!shouldPersistDocumentMetadataInFrontmatter(request.mode)) {
		return false;
	}

	const topicsPayload = JSON.stringify({
		version: DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: request.generatedAt,
		groupFingerprint: request.groupFingerprint,
		topics: request.topics.map(serializeTopicForFrontmatter),
	});
	const topicPlanPayload = JSON.stringify({
		version: DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: request.generatedAt,
		groupFingerprint: request.groupFingerprint,
		planFingerprint: request.planFingerprint,
		remainingLlmCalls: request.remainingLlmCalls,
		budgetPlan: request.budgetPlan
			? {
				maxTotalCards: request.budgetPlan.maxTotalCards,
				coreCardBudget: request.budgetPlan.coreCardBudget,
				secondaryCardBudget: request.budgetPlan.secondaryCardBudget,
				maxCardsPerTopic: request.budgetPlan.maxCardsPerTopic,
				totalPlannedCards: request.budgetPlan.totalPlannedCards,
				selectedTopics: request.budgetPlan.selectedTopics.map((topic) => ({
					topicId: topic.topicId,
					tier: topic.tier,
					cardCount: topic.cardCount,
				})),
			}
			: null,
	});
	const generationMetaPayload = JSON.stringify({
		version: DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: request.generatedAt,
		mode: request.mode,
		provider: {
			presetType: request.providerPresetType,
			model: request.model,
			temperature: request.temperature,
		},
		prompt: {
			source: request.resolvedPrompt.source,
			noteFolder: request.resolvedPrompt.noteFolder,
			templatePath: request.resolvedPrompt.templatePath,
		},
		fingerprints: {
			extract: request.extractFingerprint,
			group: request.groupFingerprint,
			plan: request.planFingerprint,
		},
		knowledgeChunkCount: request.knowledgeChunkCount,
		topicCount: request.topics.length,
		plannedCardCount: request.budgetPlan?.totalPlannedCards ?? 0,
	});

	await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
		frontmatter[OBCD_TOPICS_FRONTMATTER_KEY] = topicsPayload;
		frontmatter[OBCD_TOPIC_PLAN_FRONTMATTER_KEY] = topicPlanPayload;
		frontmatter[OBCD_GENERATION_META_FRONTMATTER_KEY] = generationMetaPayload;
	});
	return true;
}

function shouldPersistDocumentMetadataInFrontmatter(mode: GenerationMode): boolean {
	return mode === "file" || mode === "folder-file";
}

function serializeTopicForFrontmatter(topic: KnowledgeTopic): PersistedKnowledgeTopic {
	return {
		topicId: topic.topicId,
		canonicalStatement: topic.canonicalStatement,
		knowledgeGroup: topic.knowledgeGroup,
		summary: topic.summary,
		memberChunkIds: [...topic.memberChunkIds],
		importanceScore: topic.importanceScore,
		tier: topic.tier,
		recommendedCardCount: topic.recommendedCardCount,
		shouldCreateCards: topic.shouldCreateCards,
		rejectionReason: topic.rejectionReason,
	};
}
