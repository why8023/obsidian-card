import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildGlobalRankingPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { KnowledgeTopic, KnowledgeUnit, TopicTier } from "../types";
import { collapseWhitespace, hashContent } from "../utils/markdown";

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

	async rank(units: KnowledgeUnit[]): Promise<KnowledgeTopic[]> {
		if (units.length === 0) {
			return [];
		}

		try {
			const payload = await this.llmClient.requestJson("rank", [
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
						units: units.map((unit) => ({
							id: unit.id,
							sectionKey: unit.sectionKey,
							headingPath: unit.headingPath,
							statement: unit.statement,
							kind: unit.kind,
							importanceLocal: unit.importanceLocal,
							candidateQuestionIntent: unit.candidateQuestionIntent,
							evidenceExcerpt: unit.evidenceExcerpt,
						})),
					}),
				},
			]);

			const topics = normalizeTopics(payload, units, this.settings.generation.maxCardsPerTopic);
			if (topics.length > 0) {
				this.debugRun?.log("rank:topics", `Ranked ${topics.length} topic(s) with LLM output.`, {
					topicCount: topics.length,
					topics,
				});
				return topics;
			}
		} catch (error) {
			this.debugRun?.log("rank:fallback", "Global ranking fell back to the heuristic ranker.", {
				error: error instanceof Error ? error.message : String(error),
			});
		}

		const fallbackTopics = buildFallbackTopics(units, this.settings.generation.maxCardsPerTopic);
		this.debugRun?.log("rank:topics", `Ranked ${fallbackTopics.length} topic(s) with heuristic fallback.`, {
			topicCount: fallbackTopics.length,
			topics: fallbackTopics,
		});
		return fallbackTopics;
	}
}

function normalizeTopics(payload: unknown, units: KnowledgeUnit[], maxCardsPerTopic: number): KnowledgeTopic[] {
	const rawTopics = Array.isArray(payload)
		? payload
		: Array.isArray((payload as RankingResponse | undefined)?.topics)
		? (payload as RankingResponse).topics ?? []
		: [];
	const unitsById = new Map(units.map((unit) => [unit.id, unit] as const));
	const topics: KnowledgeTopic[] = [];

	for (const rawTopic of rawTopics) {
		if (!isObject(rawTopic)) {
			continue;
		}

		const memberUnitIds = Array.isArray(rawTopic.memberUnitIds)
			? rawTopic.memberUnitIds.filter((value): value is string => typeof value === "string" && unitsById.has(value))
			: [];
		if (memberUnitIds.length === 0) {
			continue;
		}

		const canonicalStatement = collapseWhitespace(readString(rawTopic.canonicalStatement));
		if (canonicalStatement.length === 0) {
			continue;
		}

		const memberUnits = memberUnitIds
			.map((unitId) => unitsById.get(unitId))
			.filter((unit): unit is KnowledgeUnit => unit !== undefined);
		const coverageSections = Array.from(new Set(memberUnits.map((unit) => unit.sectionKey)));

		topics.push({
			topicId: `topic:${hashContent(`${canonicalStatement}\u0000${memberUnitIds.join(",")}`)}`,
			canonicalStatement,
			memberUnitIds,
			importanceGlobal: normalizeImportance(rawTopic.importanceGlobal),
			coverageSections,
			tier: normalizeTier(rawTopic.tier),
			recommendedCardCount: normalizeCardCount(rawTopic.recommendedCardCount, maxCardsPerTopic),
			evidenceRefs: memberUnits.slice(0, 3).map((unit) => ({
				unitId: unit.id,
				excerpt: unit.evidenceExcerpt,
			})),
		});
	}

	return topics.sort((left, right) => right.importanceGlobal - left.importanceGlobal);
}

function buildFallbackTopics(units: KnowledgeUnit[], maxCardsPerTopic: number): KnowledgeTopic[] {
	const grouped = new Map<string, KnowledgeUnit[]>();

	for (const unit of units) {
		if (unit.kind === "ignore") {
			continue;
		}

		const key = collapseWhitespace(unit.statement).toLowerCase();
		const group = grouped.get(key) ?? [];
		group.push(unit);
		grouped.set(key, group);
	}

	return Array.from(grouped.values())
		.map((group) => {
			const canonicalStatement = group[0]?.statement ?? "";
			const importanceGlobal = group.reduce((sum, unit) => sum + scoreUnit(unit), 0) / Math.max(group.length, 1);
			const tier = importanceGlobal >= 0.72 ? "core" : "secondary";

			return {
				topicId: `topic:${hashContent(group.map((unit) => unit.id).join(","))}`,
				canonicalStatement,
				memberUnitIds: group.map((unit) => unit.id),
				importanceGlobal: Number.parseFloat(importanceGlobal.toFixed(2)),
				coverageSections: Array.from(new Set(group.map((unit) => unit.sectionKey))),
				tier,
				recommendedCardCount: Math.min(
					maxCardsPerTopic,
					tier === "core" && canonicalStatement.length > 120 ? 2 : 1,
				),
				evidenceRefs: group.slice(0, 3).map((unit) => ({
					unitId: unit.id,
					excerpt: unit.evidenceExcerpt,
				})),
			} satisfies KnowledgeTopic;
		})
		.sort((left, right) => right.importanceGlobal - left.importanceGlobal);
}

function scoreUnit(unit: KnowledgeUnit): number {
	const kindWeight = (() => {
		switch (unit.kind) {
			case "core-concept":
				return 1;
			case "key-conclusion":
				return 0.95;
			case "supporting-detail":
				return 0.65;
			case "process-detail":
				return 0.55;
			case "background":
				return 0.4;
			case "example":
				return 0.25;
			case "ignore":
				return 0;
		}
	})();

	return Number.parseFloat(((unit.importanceLocal * 0.7) + (kindWeight * 0.3)).toFixed(2));
}

function normalizeTier(value: unknown): TopicTier {
	return value === "secondary" ? "secondary" : "core";
}

function normalizeCardCount(value: unknown, maxCardsPerTopic: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 1;
	}

	return Math.max(1, Math.min(maxCardsPerTopic, Math.round(value)));
}

function normalizeImportance(value: unknown): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return 0.5;
	}

	return Math.max(0, Math.min(1, value));
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
