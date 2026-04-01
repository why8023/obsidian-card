import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildCardCompositionPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { CompositionRequest, GeneratedBasicCard, TopicCompositionResult } from "../types";
import { collapseWhitespace } from "../utils/markdown";

export class CardComposer {
	private readonly llmClient: LlmClient;

	constructor(
		private readonly settings: ObcdSettings,
		private readonly customInstruction: string,
		private readonly debugRun?: DebugRun,
	) {
		this.llmClient = new LlmClient(settings, debugRun);
	}

	async compose(request: CompositionRequest, topicIndex: number): Promise<TopicCompositionResult> {
		const payload = await this.llmClient.requestJson(`compose:${topicIndex}`, [
			{
				role: "system",
				content: buildCardCompositionPrompt({
					cardCount: request.cardCount,
					strategy: request.strategy,
				}, this.customInstruction),
			},
			{
				role: "user",
				content: JSON.stringify({
					topic: {
						topicId: request.topic.topicId,
						tier: request.topic.tier,
						knowledgeGroup: request.topic.knowledgeGroup,
						canonicalStatement: request.topic.canonicalStatement,
						recommendedCardCount: request.topic.recommendedCardCount,
					},
					knowledgeBlocks: request.chunkAnalyses.map((analysis) => ({
						chunkId: analysis.chunkId,
						titleHint: analysis.titleHint ?? "",
						headingPath: analysis.headingPath,
						summary: analysis.summary,
						group: analysis.group,
					})),
					sourceUnits: request.units.map((unit) => ({
						id: unit.id,
						chunkId: unit.chunkId,
						headingPath: unit.headingPath,
						chunkSummary: unit.chunkSummary,
						groupLabel: unit.groupLabel,
						statement: unit.statement,
						candidateQuestionIntent: unit.candidateQuestionIntent,
						evidenceExcerpt: unit.evidenceExcerpt,
					})),
				}),
			},
		]);

		const cards = normalizeCards(payload).slice(0, request.cardCount);
		this.debugRun?.log("compose:cards", `Composed ${cards.length} card(s) for topic ${request.topic.topicId}.`, {
			topicId: request.topic.topicId,
			cardCount: cards.length,
			cards,
		});

		return {
			topic: request.topic,
			cards,
			source: {
				topicId: request.topic.topicId,
				unitIds: request.units.map((unit) => unit.id),
				chunkIds: Array.from(new Set(request.units.map((unit) => unit.chunkId))),
				strategy: request.strategy,
			},
		};
	}
}

function normalizeCards(payload: unknown): GeneratedBasicCard[] {
	const rawCards = Array.isArray(payload)
		? payload
		: Array.isArray((payload as { cards?: unknown[] } | undefined)?.cards)
		? (payload as { cards?: unknown[] }).cards ?? []
		: [];
	const cards: GeneratedBasicCard[] = [];
	const seenKeys = new Set<string>();

	for (const rawCard of rawCards) {
		if (!isObject(rawCard)) {
			continue;
		}

		const front = collapseWhitespace(readString(rawCard.front));
		const back = collapseWhitespace(readString(rawCard.back));
		if (front.length === 0 || back.length === 0 || front.toLowerCase() === back.toLowerCase()) {
			continue;
		}

		const tags = Array.isArray(rawCard.tags)
			? rawCard.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter((tag) => tag.length > 0)
			: [];
		const dedupeKey = `${front.toLowerCase()}::${back.toLowerCase()}`;
		if (seenKeys.has(dedupeKey)) {
			continue;
		}

		seenKeys.add(dedupeKey);
		cards.push({
			front,
			back,
			tags,
		});
	}

	return cards;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
