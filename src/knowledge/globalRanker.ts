import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildGlobalRankingPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { KnowledgeChunkAnalysis, KnowledgeTopic } from "../types";
import { collapseWhitespace, hashContent } from "../utils/markdown";
import {
	buildFallbackTopic,
	fallbackTopicRejectionReason,
	normalizeRecommendedCardCount,
	normalizeShouldCreateCards,
	normalizeTopicImportance,
	normalizeTopicTier,
} from "./topicEligibility";

interface RankingResponse {
	topics?: unknown[];
}

export class GlobalRanker {
	private readonly llmClient: LlmClient;

	constructor(
		private readonly settings: ObcdSettings,
		private readonly customInstruction: string,
		private readonly debugRun?: DebugRun,
	) {
		this.llmClient = new LlmClient(settings, debugRun);
	}

	async rank(analyses: KnowledgeChunkAnalysis[]): Promise<KnowledgeTopic[]> {
		if (analyses.length === 0) {
			return [];
		}

		try {
			const payload = await this.llmClient.requestJson("group", [
				{
					role: "system",
					content: buildGlobalRankingPrompt({
						coreCardBudget: this.settings.generation.coreCardBudget,
						secondaryCardBudget: this.settings.generation.secondaryCardBudget,
						maxTotalCardsPerDocument: this.settings.generation.maxTotalCardsPerDocument,
						maxCardsPerTopic: this.settings.generation.maxCardsPerTopic,
					}, this.customInstruction),
				},
				{
					role: "user",
					content: JSON.stringify({
						chunks: analyses.map((analysis) => ({
							chunkId: analysis.chunkId,
							summary: analysis.summary,
							topicHint: analysis.topicHint,
							evidenceExcerpt: analysis.evidenceExcerpt,
						})),
					}),
				},
			]);

			const topics = normalizeTopics(payload, analyses, this.settings.generation.maxCardsPerTopic);
			if (topics.length > 0) {
				this.debugRun?.log("topics", `Built ${topics.length} topic(s) with LLM grouping.`, {
					topicCount: topics.length,
					topics,
				});
				return topics;
			}
		} catch (error) {
			this.debugRun?.log("topics:fallback", "Topic grouping fell back to heuristics.", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const fallbackTopics = buildFallbackTopics(analyses, this.settings.generation.maxCardsPerTopic);
		this.debugRun?.log("topics", `Built ${fallbackTopics.length} topic(s) with heuristic grouping.`, {
			topicCount: fallbackTopics.length,
			topics: fallbackTopics,
		});
		return fallbackTopics;
	}
}

function normalizeTopics(payload: unknown, analyses: KnowledgeChunkAnalysis[], maxCardsPerTopic: number): KnowledgeTopic[] {
	const rawTopics = Array.isArray(payload)
		? payload
		: Array.isArray((payload as RankingResponse | undefined)?.topics)
		? (payload as RankingResponse).topics ?? []
		: [];
	const analysesByChunkId = new Map(analyses.map((analysis) => [analysis.chunkId, analysis] as const));
	const topics: KnowledgeTopic[] = [];
	const seenChunkIds = new Set<string>();

	for (const rawTopic of rawTopics) {
		if (!isObject(rawTopic)) {
			continue;
		}

		const memberChunkIds = Array.isArray(rawTopic.memberChunkIds)
			? rawTopic.memberChunkIds
				.filter((value): value is string => typeof value === "string" && analysesByChunkId.has(value))
				.filter((chunkId) => !seenChunkIds.has(chunkId))
			: [];
		if (memberChunkIds.length === 0) {
			continue;
		}
		const memberAnalyses = memberChunkIds
			.map((chunkId) => analysesByChunkId.get(chunkId))
			.filter((analysis): analysis is KnowledgeChunkAnalysis => analysis !== undefined);

		const canonicalStatement = collapseWhitespace(readString(rawTopic.canonicalStatement));
		const summary = collapseWhitespace(readString(rawTopic.summary)) || canonicalStatement;
		const knowledgeGroup = collapseWhitespace(readString(rawTopic.knowledgeGroup))
			|| resolveDominantGroup(memberAnalyses)
			|| canonicalStatement;
		if (canonicalStatement.length === 0 || summary.length === 0 || knowledgeGroup.length === 0) {
			continue;
		}

		const importanceScore = normalizeTopicImportance(rawTopic.importanceScore);
		const shouldCreateCards = normalizeShouldCreateCards(rawTopic.shouldCreateCards, importanceScore, memberChunkIds.length);
		const tier = normalizeTopicTier(rawTopic.tier);
		const recommendedCardCount = normalizeRecommendedCardCount(
			rawTopic.recommendedCardCount,
			maxCardsPerTopic,
			shouldCreateCards,
		);
		const rejectionReason = shouldCreateCards
			? ""
			: collapseWhitespace(readString(rawTopic.rejectionReason))
				|| fallbackTopicRejectionReason(shouldCreateCards, importanceScore);

		topics.push({
			topicId: `topic:${hashContent(`${knowledgeGroup}\u0000${canonicalStatement}\u0000${memberChunkIds.join(",")}`)}`,
			canonicalStatement,
			knowledgeGroup,
			summary,
			memberChunkIds,
			importanceScore,
			tier,
			recommendedCardCount,
			shouldCreateCards,
			rejectionReason,
		});
		memberChunkIds.forEach((chunkId) => seenChunkIds.add(chunkId));
	}

	for (const analysis of analyses) {
		if (seenChunkIds.has(analysis.chunkId)) {
			continue;
		}

		const fallbackTopic = buildFallbackTopic([analysis.chunkId], [analysis], maxCardsPerTopic);
		if (!fallbackTopic) {
			continue;
		}

		topics.push({
			...fallbackTopic,
			topicId: `topic:${hashContent(`${fallbackTopic.knowledgeGroup}\u0000${analysis.chunkId}`)}`,
		});
	}

	return topics.sort((left, right) => (
		Number(right.shouldCreateCards) - Number(left.shouldCreateCards)
		|| right.importanceScore - left.importanceScore
	));
}

function buildFallbackTopics(analyses: KnowledgeChunkAnalysis[], maxCardsPerTopic: number): KnowledgeTopic[] {
	const grouped = new Map<string, KnowledgeChunkAnalysis[]>();

	for (const analysis of analyses) {
		const key = collapseWhitespace(analysis.topicHint).toLowerCase()
			|| collapseWhitespace(analysis.summary).toLowerCase();
		const group = grouped.get(key) ?? [];
		group.push(analysis);
		grouped.set(key, group);
	}

	return Array.from(grouped.values())
		.map((group) => buildFallbackTopic(group.map((analysis) => analysis.chunkId), group, maxCardsPerTopic))
		.filter((topic): topic is KnowledgeTopic => topic !== null)
		.map((topic) => ({
			...topic,
			topicId: `topic:${hashContent(`${topic.knowledgeGroup}\u0000${topic.canonicalStatement}\u0000${topic.memberChunkIds.join(",")}`)}`,
		}))
		.sort((left, right) => (
			Number(right.shouldCreateCards) - Number(left.shouldCreateCards)
			|| right.importanceScore - left.importanceScore
		));
}

function resolveDominantGroup(analyses: KnowledgeChunkAnalysis[]): string {
	const counts = new Map<string, number>();

	for (const analysis of analyses) {
		const group = collapseWhitespace(analysis.topicHint);
		if (group.length === 0) {
			continue;
		}

		counts.set(group, (counts.get(group) ?? 0) + 1);
	}

	let selectedGroup = "";
	let selectedCount = -1;
	for (const [group, count] of counts) {
		if (count > selectedCount) {
			selectedGroup = group;
			selectedCount = count;
		}
	}

	return selectedGroup;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
