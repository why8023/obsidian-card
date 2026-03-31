import type { DebugRun } from "../debug/debugService";
import { LlmClient } from "../generation/llmClient";
import { buildSectionAggregationPrompt } from "../prompts/promptDefaults";
import type { ObcdSettings } from "../settings";
import type { ContentChunk, KnowledgeUnit } from "../types";
import { mapWithConcurrency } from "../utils/concurrency";
import { collapseWhitespace, hashContent } from "../utils/markdown";

interface SectionTopicResponse {
	topics?: unknown[];
}

interface SectionTopicGroup {
	sectionKey: string;
	title: string;
	headingPath: string[];
	units: KnowledgeUnit[];
}

export class HierarchicalAggregator {
	private readonly llmClient: LlmClient;

	constructor(
		private readonly settings: ObcdSettings,
		private readonly customInstruction: string,
		private readonly debugRun?: DebugRun,
	) {
		this.llmClient = new LlmClient(settings, debugRun);
	}

	async aggregate(chunks: ContentChunk[], units: KnowledgeUnit[]): Promise<KnowledgeUnit[]> {
		const sectionGroups = buildSectionGroups(chunks, units);
		const aggregatedUnits = (await mapWithConcurrency(
			sectionGroups,
			this.settings.generation.maxConcurrentLlmRequests,
			async (group, index) => {
				if (group.units.length <= this.settings.generation.maxKnowledgeUnitsPerChunk) {
					return group.units;
				}

				try {
					const sectionUnits = await this.aggregateSection(group, index);
					if (sectionUnits.length > 0) {
						return sectionUnits;
					}
				} catch (error) {
					this.debugRun?.log("hierarchy:section-fallback", "Section aggregation fell back to heuristic compression.", {
						sectionKey: group.sectionKey,
						error: error instanceof Error ? error.message : String(error),
					});
				}

				return compressSectionHeuristically(group, this.settings.generation.maxKnowledgeUnitsPerChunk);
			},
		)).flat();

		this.debugRun?.log("hierarchy:aggregate", "Built hierarchical section summaries.", {
			originalUnitCount: units.length,
			aggregatedUnitCount: aggregatedUnits.length,
			sectionCount: sectionGroups.length,
		});
		return aggregatedUnits;
	}

	private async aggregateSection(group: SectionTopicGroup, groupIndex: number): Promise<KnowledgeUnit[]> {
		const maxSummaryTopics = Math.min(
			this.settings.generation.maxKnowledgeUnitsPerChunk,
			Math.max(2, Math.ceil(group.units.length / 2)),
		);
		const payload = await this.llmClient.requestJson(`hierarchy:${groupIndex}`, [
			{
				role: "system",
				content: buildSectionAggregationPrompt({ maxSummaryTopics }, this.customInstruction),
			},
			{
				role: "user",
				content: JSON.stringify({
					sectionKey: group.sectionKey,
					title: group.title,
					headingPath: group.headingPath,
					units: group.units.map((unit) => ({
						id: unit.id,
						statement: unit.statement,
						kind: unit.kind,
						importanceLocal: unit.importanceLocal,
						candidateQuestionIntent: unit.candidateQuestionIntent,
						evidenceExcerpt: unit.evidenceExcerpt,
					})),
				}),
			},
		]);

		return normalizeSectionTopics(payload, group, maxSummaryTopics);
	}
}

export function estimateHierarchicalAggregationCalls(
	chunks: ContentChunk[],
	units: KnowledgeUnit[],
	maxKnowledgeUnitsPerChunk: number,
): number {
	return buildSectionGroups(chunks, units)
		.filter((group) => group.units.length > maxKnowledgeUnitsPerChunk)
		.length;
}

function buildSectionGroups(chunks: ContentChunk[], units: KnowledgeUnit[]): SectionTopicGroup[] {
	const topLevelTitles = new Map<string, { title: string; headingPath: string[] }>();
	for (const chunk of chunks) {
		topLevelTitles.set(chunk.sectionKey, {
			title: chunk.headingPath[0] ?? chunk.titleHint ?? chunk.sectionKey,
			headingPath: [...chunk.headingPath],
		});
	}

	const groups = new Map<string, SectionTopicGroup>();
	for (const unit of units) {
		const topLevelKey = unit.headingPath[0] ?? unit.sectionKey;
		const groupKey = topLevelKey.length > 0 ? topLevelKey : unit.sectionKey;
		const sectionMeta = topLevelTitles.get(unit.sectionKey);
		const existing = groups.get(groupKey) ?? {
			sectionKey: groupKey,
			title: sectionMeta?.title ?? topLevelKey ?? unit.sectionKey,
			headingPath: sectionMeta?.headingPath ?? [...unit.headingPath],
			units: [],
		};
		existing.units.push(unit);
		groups.set(groupKey, existing);
	}

	return Array.from(groups.values())
		.sort((left, right) => left.title.localeCompare(right.title));
}

function normalizeSectionTopics(payload: unknown, group: SectionTopicGroup, maxSummaryTopics: number): KnowledgeUnit[] {
	const rawTopics = Array.isArray(payload)
		? payload
		: Array.isArray((payload as SectionTopicResponse | undefined)?.topics)
		? (payload as SectionTopicResponse).topics ?? []
		: [];
	const unitsById = new Map(group.units.map((unit) => [unit.id, unit] as const));
	const aggregatedUnits: KnowledgeUnit[] = [];

	for (const [index, rawTopic] of rawTopics.entries()) {
		if (!isObject(rawTopic)) {
			continue;
		}

		const memberUnits = Array.isArray(rawTopic.memberUnitIds)
			? rawTopic.memberUnitIds
				.filter((value): value is string => typeof value === "string" && unitsById.has(value))
				.map((unitId) => unitsById.get(unitId)!)
			: [];
		if (memberUnits.length === 0) {
			continue;
		}

		const statement = collapseWhitespace(readString(rawTopic.statement));
		const evidenceExcerpt = collapseWhitespace(readString(rawTopic.evidenceExcerpt));
		if (statement.length === 0 || evidenceExcerpt.length === 0) {
			continue;
		}

		aggregatedUnits.push({
			id: `hier:${hashContent(`${group.sectionKey}\u0000${statement}\u0000${index}`)}`,
			sourceUnitIds: flattenSourceUnitIds(memberUnits),
			filePath: memberUnits[0]!.filePath,
			sectionKey: memberUnits[0]!.sectionKey,
			headingPath: [...memberUnits[0]!.headingPath],
			titleHint: group.title,
			statement,
			kind: "core-concept",
			importanceLocal: normalizeImportance(rawTopic.importanceLocal),
			candidateQuestionIntent: collapseWhitespace(readString(rawTopic.candidateQuestionIntent)),
			evidenceExcerpt,
			sourceHash: hashContent(memberUnits.map((unit) => unit.sourceHash).join(",")),
			tokenEstimate: Math.max(1, Math.ceil((statement.length + evidenceExcerpt.length) / 4)),
		});
	}

	return aggregatedUnits.slice(0, maxSummaryTopics);
}

function compressSectionHeuristically(group: SectionTopicGroup, maxSummaryTopics: number): KnowledgeUnit[] {
	return [...group.units]
		.sort((left, right) => right.importanceLocal - left.importanceLocal)
		.slice(0, maxSummaryTopics)
		.map((unit, index) => ({
			...unit,
			id: `hier:${hashContent(`${group.sectionKey}\u0000${unit.id}\u0000${index}`)}`,
			sourceUnitIds: [...unit.sourceUnitIds],
			titleHint: group.title,
		}));
}

function flattenSourceUnitIds(units: KnowledgeUnit[]): string[] {
	return Array.from(new Set(units.flatMap((unit) => unit.sourceUnitIds)));
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
