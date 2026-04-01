import type { App, TFile } from "obsidian";

import type { ResolvedGenerationPrompt } from "../prompts/promptResolver";
import type { BudgetPlan, GenerationMode, KnowledgeTopic } from "../types";
import { collectLineInfos, detectNewline, findFrontmatterEnd } from "../utils/markdown";

const DOCUMENT_METADATA_SCHEMA_VERSION = 2;

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

export interface PersistedDocumentTopics {
	version: number;
	generatedAt: string;
	groupFingerprint: string;
	topics: KnowledgeTopic[];
}

export interface PersistedDocumentGenerationMeta {
	version: number;
	generatedAt: string;
	mode: GenerationMode;
	provider: {
		presetType: string;
		model: string;
		temperature: number | null;
	};
	prompt: {
		source: string;
		noteFolder: string;
		templatePath: string;
	};
	fingerprints: {
		extract: string;
		group: string;
		plan: string;
	};
	documentFingerprint: string;
	configFingerprint: string;
	knowledgeChunkCount: number;
	topicCount: number;
	plannedCardCount: number;
	insertedCardCount: number | null;
	cardGenerationFingerprints: string[];
}

export interface PersistedDocumentTopicPlan {
	version: number;
	generatedAt: string;
	groupFingerprint: string;
	planFingerprint: string;
	remainingLlmCalls: number | null;
	budgetPlan: BudgetPlan | null;
}

export interface PersistedDocumentMetadata {
	topics: PersistedDocumentTopics | null;
	topicPlan: PersistedDocumentTopicPlan | null;
	generationMeta: PersistedDocumentGenerationMeta | null;
}

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
	documentFingerprint: string;
	configFingerprint: string;
	knowledgeChunkCount: number;
	topics: KnowledgeTopic[];
	budgetPlan: BudgetPlan | null;
	remainingLlmCalls: number | null;
	cardGenerationFingerprints: string[];
	insertedCardCount?: number;
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
		documentFingerprint: request.documentFingerprint,
		configFingerprint: request.configFingerprint,
		knowledgeChunkCount: request.knowledgeChunkCount,
		topicCount: request.topics.length,
		plannedCardCount: request.budgetPlan?.totalPlannedCards ?? 0,
		insertedCardCount: request.insertedCardCount ?? 0,
		cardGenerationFingerprints: normalizeCardGenerationFingerprints(request.cardGenerationFingerprints),
	});

	await app.vault.process(file, (content) => upsertDocumentMetadataFrontmatter(content, {
		[OBCD_TOPICS_FRONTMATTER_KEY]: topicsPayload,
		[OBCD_TOPIC_PLAN_FRONTMATTER_KEY]: topicPlanPayload,
		[OBCD_GENERATION_META_FRONTMATTER_KEY]: generationMetaPayload,
	}));
	return true;
}

export function readDocumentMetadata(app: App, file: TFile, content?: string): PersistedDocumentMetadata {
	const frontmatter = extractPersistedMetadataFrontmatter(content)
		?? app.metadataCache.getFileCache(file)?.frontmatter;
	if (!frontmatter) {
		return createEmptyDocumentMetadata();
	}

	return parsePersistedDocumentMetadata(frontmatter);
}

function parsePersistedDocumentMetadata(frontmatter: Record<string, unknown>): PersistedDocumentMetadata {
	return {
		topics: parsePersistedTopics(frontmatter[OBCD_TOPICS_FRONTMATTER_KEY]),
		topicPlan: parsePersistedTopicPlan(frontmatter[OBCD_TOPIC_PLAN_FRONTMATTER_KEY]),
		generationMeta: parsePersistedGenerationMeta(frontmatter[OBCD_GENERATION_META_FRONTMATTER_KEY]),
	};
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

function parsePersistedTopics(value: unknown): PersistedDocumentTopics | null {
	const parsed = parseJsonFrontmatterValue<{
		version?: unknown;
		generatedAt?: unknown;
		groupFingerprint?: unknown;
		topics?: unknown[];
	}>(value);
	if (!parsed || !Array.isArray(parsed.topics)) {
		return null;
	}

	const topics = parsed.topics
		.map((topic) => parsePersistedTopic(topic))
		.filter((topic): topic is KnowledgeTopic => topic !== null);
	if (topics.length === 0) {
		return null;
	}

	return {
		version: typeof parsed.version === "number" ? parsed.version : DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: readString(parsed.generatedAt),
		groupFingerprint: readString(parsed.groupFingerprint),
		topics,
	};
}

function parsePersistedTopic(value: unknown): KnowledgeTopic | null {
	if (!isObject(value)) {
		return null;
	}

	const topicId = readString(value.topicId);
	const canonicalStatement = readString(value.canonicalStatement);
	const knowledgeGroup = readString(value.knowledgeGroup);
	const summary = readString(value.summary);
	const memberChunkIds = Array.isArray(value.memberChunkIds)
		? value.memberChunkIds.filter((chunkId): chunkId is string => typeof chunkId === "string" && chunkId.trim().length > 0)
		: [];
	if (
		topicId.length === 0
		|| canonicalStatement.length === 0
		|| knowledgeGroup.length === 0
		|| summary.length === 0
		|| memberChunkIds.length === 0
	) {
		return null;
	}

	return {
		topicId,
		canonicalStatement,
		knowledgeGroup,
		summary,
		memberChunkIds,
		importanceScore: readNumber(value.importanceScore),
		tier: value.tier === "secondary" ? "secondary" : "core",
		recommendedCardCount: Math.max(0, Math.round(readNumber(value.recommendedCardCount))),
		shouldCreateCards: typeof value.shouldCreateCards === "boolean"
			? value.shouldCreateCards
			: Math.round(readNumber(value.recommendedCardCount)) > 0,
		rejectionReason: readString(value.rejectionReason),
	};
}

function parsePersistedGenerationMeta(value: unknown): PersistedDocumentGenerationMeta | null {
	const parsed = parseJsonFrontmatterValue<{
		version?: unknown;
		generatedAt?: unknown;
		mode?: unknown;
		provider?: {
			presetType?: unknown;
			model?: unknown;
			temperature?: unknown;
		};
		prompt?: {
			source?: unknown;
			noteFolder?: unknown;
			templatePath?: unknown;
		};
		fingerprints?: {
			extract?: unknown;
			group?: unknown;
			plan?: unknown;
		};
		documentFingerprint?: unknown;
		configFingerprint?: unknown;
		knowledgeChunkCount?: unknown;
		topicCount?: unknown;
		plannedCardCount?: unknown;
		insertedCardCount?: unknown;
		cardGenerationFingerprints?: unknown;
	}>(value);
	if (!parsed || !isObject(parsed.fingerprints)) {
		return null;
	}

	const extract = readString(parsed.fingerprints.extract);
	const group = readString(parsed.fingerprints.group);
	const plan = readString(parsed.fingerprints.plan);
	if (extract.length === 0 && group.length === 0 && plan.length === 0) {
		return null;
	}

	return {
		version: typeof parsed.version === "number" ? parsed.version : DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: readString(parsed.generatedAt),
		mode: parseGenerationMode(parsed.mode),
		provider: {
			presetType: isObject(parsed.provider) ? readString(parsed.provider.presetType) : "",
			model: isObject(parsed.provider) ? readString(parsed.provider.model) : "",
			temperature: isObject(parsed.provider) && typeof parsed.provider.temperature === "number" && Number.isFinite(parsed.provider.temperature)
				? parsed.provider.temperature
				: null,
		},
		prompt: {
			source: isObject(parsed.prompt) ? readString(parsed.prompt.source) : "",
			noteFolder: isObject(parsed.prompt) ? readString(parsed.prompt.noteFolder) : "",
			templatePath: isObject(parsed.prompt) ? readString(parsed.prompt.templatePath) : "",
		},
		fingerprints: {
			extract,
			group,
			plan,
		},
		documentFingerprint: readString(parsed.documentFingerprint),
		configFingerprint: readString(parsed.configFingerprint),
		knowledgeChunkCount: Math.max(0, Math.round(readNumber(parsed.knowledgeChunkCount))),
		topicCount: Math.max(0, Math.round(readNumber(parsed.topicCount))),
		plannedCardCount: Math.max(0, Math.round(readNumber(parsed.plannedCardCount))),
		insertedCardCount: typeof parsed.insertedCardCount === "number" && Number.isFinite(parsed.insertedCardCount)
			? Math.max(0, Math.round(parsed.insertedCardCount))
			: null,
		cardGenerationFingerprints: normalizeCardGenerationFingerprints(parsed.cardGenerationFingerprints),
	};
}

function parsePersistedTopicPlan(value: unknown): PersistedDocumentTopicPlan | null {
	const parsed = parseJsonFrontmatterValue<{
		version?: unknown;
		generatedAt?: unknown;
		groupFingerprint?: unknown;
		planFingerprint?: unknown;
		remainingLlmCalls?: unknown;
		budgetPlan?: unknown;
	}>(value);
	if (!parsed) {
		return null;
	}

	return {
		version: typeof parsed.version === "number" ? parsed.version : DOCUMENT_METADATA_SCHEMA_VERSION,
		generatedAt: readString(parsed.generatedAt),
		groupFingerprint: readString(parsed.groupFingerprint),
		planFingerprint: readString(parsed.planFingerprint),
		remainingLlmCalls: typeof parsed.remainingLlmCalls === "number" && Number.isFinite(parsed.remainingLlmCalls)
			? Math.max(0, Math.round(parsed.remainingLlmCalls))
			: null,
		budgetPlan: parsePersistedBudgetPlan(parsed.budgetPlan),
	};
}

function parsePersistedBudgetPlan(value: unknown): BudgetPlan | null {
	if (!isObject(value) || !Array.isArray(value.selectedTopics)) {
		return null;
	}

	const selectedTopics = value.selectedTopics
		.map((topic) => parsePersistedBudgetAllocation(topic))
		.filter((topic): topic is BudgetPlan["selectedTopics"][number] => topic !== null);

	return {
		maxTotalCards: Math.max(0, Math.round(readNumber(value.maxTotalCards))),
		coreCardBudget: Math.max(0, Math.round(readNumber(value.coreCardBudget))),
		secondaryCardBudget: Math.max(0, Math.round(readNumber(value.secondaryCardBudget))),
		maxCardsPerTopic: Math.max(0, Math.round(readNumber(value.maxCardsPerTopic))),
		totalPlannedCards: Math.max(0, Math.round(readNumber(value.totalPlannedCards))),
		selectedTopics,
	};
}

function parsePersistedBudgetAllocation(value: unknown): BudgetPlan["selectedTopics"][number] | null {
	if (!isObject(value)) {
		return null;
	}

	const topicId = readString(value.topicId);
	if (topicId.length === 0) {
		return null;
	}

	return {
		topicId,
		tier: value.tier === "secondary" ? "secondary" : "core",
		cardCount: Math.max(0, Math.round(readNumber(value.cardCount))),
	};
}

function parseJsonFrontmatterValue<T>(value: unknown): T | null {
	if (isObject(value)) {
		return value as T;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}

	try {
		return JSON.parse(value) as T;
	} catch {
		return null;
	}
}

function parseGenerationMode(value: unknown): GenerationMode {
	return value === "selection" || value === "folder-file"
		? value
		: "file";
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function createEmptyDocumentMetadata(): PersistedDocumentMetadata {
	return {
		topics: null,
		topicPlan: null,
		generationMeta: null,
	};
}

function extractPersistedMetadataFrontmatter(content: string | undefined): Record<string, unknown> | null {
	if (!content) {
		return null;
	}

	const frontmatterEnd = findFrontmatterEnd(content);
	if (frontmatterEnd === 0) {
		return null;
	}

	const frontmatterBlock = content.slice(0, frontmatterEnd);
	const values: Record<string, unknown> = {};

	for (const key of [
		OBCD_TOPICS_FRONTMATTER_KEY,
		OBCD_TOPIC_PLAN_FRONTMATTER_KEY,
		OBCD_GENERATION_META_FRONTMATTER_KEY,
	]) {
		const extractedValue = extractFrontmatterScalar(frontmatterBlock, key);
		if (extractedValue !== null) {
			values[key] = extractedValue;
		}
	}

	return Object.keys(values).length > 0 ? values : null;
}

function upsertDocumentMetadataFrontmatter(content: string, values: Record<string, string>): string {
	const newline = detectNewline(content);
	const frontmatterEnd = findFrontmatterEnd(content);

	if (frontmatterEnd === 0) {
		const renderedLines = renderManagedFrontmatterLines(values, newline);
		return `---${newline}${renderedLines}${newline}---${newline}${content}`;
	}

	const frontmatterBlock = content.slice(0, frontmatterEnd);
	const updatedFrontmatter = upsertFrontmatterScalars(frontmatterBlock, values, newline);
	return `${updatedFrontmatter}${content.slice(frontmatterEnd)}`;
}

function upsertFrontmatterScalars(
	frontmatterBlock: string,
	values: Record<string, string>,
	newline: string,
): string {
	const lines = collectLineInfos(frontmatterBlock);
	const openingLine = lines[0];
	if (!openingLine) {
		return frontmatterBlock;
	}

	let closingLineIndex = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line && (line.text.trim() === "---" || line.text.trim() === "...")) {
			closingLineIndex = index;
			break;
		}
	}

	if (closingLineIndex <= 0) {
		return frontmatterBlock;
	}

	const closingLine = lines[closingLineIndex]!;
	const managedKeys = new Set(Object.keys(values));
	const innerBlock = frontmatterBlock.slice(openingLine.end, closingLine.start);
	const preservedInnerBlock = stripManagedFrontmatterLines(innerBlock, managedKeys);
	const normalizedInnerBlock = trimTrailingBlankLines(preservedInnerBlock, newline);
	const managedBlock = renderManagedFrontmatterLines(values, newline);

	const nextInnerBlock = normalizedInnerBlock.length > 0
		? `${normalizedInnerBlock}${newline}${managedBlock}${newline}`
		: `${managedBlock}${newline}`;

	return `${frontmatterBlock.slice(0, openingLine.end)}${nextInnerBlock}${frontmatterBlock.slice(closingLine.start)}`;
}

function stripManagedFrontmatterLines(block: string, managedKeys: Set<string>): string {
	if (block.length === 0 || managedKeys.size === 0) {
		return block;
	}

	let result = "";
	for (const line of collectLineInfos(block)) {
		const rawLine = block.slice(line.start, line.end);
		if (isManagedFrontmatterLine(line.text, managedKeys)) {
			continue;
		}

		result += rawLine;
	}

	return result;
}

function isManagedFrontmatterLine(line: string, managedKeys: Set<string>): boolean {
	for (const key of managedKeys) {
		if (new RegExp(`^[\\t ]*${escapeRegExp(key)}\\s*:`).test(line)) {
			return true;
		}
	}

	return false;
}

function trimTrailingBlankLines(value: string, newline: string): string {
	return value.replace(new RegExp(`(?:${escapeRegExp(newline)}[\\t ]*)+$`), "");
}

function renderManagedFrontmatterLines(values: Record<string, string>, newline: string): string {
	return Object.entries(values)
		.map(([key, value]) => `${key}: ${quoteYamlScalar(value)}`)
		.join(newline);
}

function quoteYamlScalar(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function extractFrontmatterScalar(frontmatterBlock: string, key: string): string | null {
	const pattern = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(key)}\\s*:\\s*(.+)(?=\\r?\\n|$)`);
	const match = frontmatterBlock.match(pattern);
	const rawValue = match?.[1]?.trim();
	if (!rawValue) {
		return null;
	}

	return unwrapYamlScalar(rawValue);
}

function unwrapYamlScalar(value: string): string {
	if (value.startsWith("'") && value.endsWith("'")) {
		return value
			.slice(1, -1)
			.replace(/''/g, "'");
	}

	if (value.startsWith("\"") && value.endsWith("\"")) {
		return value.slice(1, -1);
	}

	return value;
}

function normalizeCardGenerationFingerprints(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}

	const seenFingerprints = new Set<string>();
	const fingerprints: string[] = [];

	for (const rawValue of value) {
		const fingerprint = readString(rawValue);
		if (fingerprint.length === 0 || seenFingerprints.has(fingerprint)) {
			continue;
		}

		seenFingerprints.add(fingerprint);
		fingerprints.push(fingerprint);
	}

	return fingerprints;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
