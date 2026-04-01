import type { TFile, Vault } from "obsidian";

import { renderKnowledgeAnnotationEnd, renderKnowledgeAnnotationStart } from "../knowledge/knowledgeAnnotations";
import type { ObarCompatibilityConfig } from "../obarCompatibility";
import { isObarRecordContent, renderObarWrappedBlock } from "../obarCompatibility";
import type { ApprovedCardGroup, ContentChunk, GeneratedBasicCard, KnowledgeChunkAnalysis, TextRange } from "../types";
import { KNOWLEDGE_ANNOTATION_VERSION, GENERATED_CARD_TYPE } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { detectNewline } from "../utils/markdown";

export interface CardRegenerationOptions {
	mode: "none" | "all-plugin-generated" | "scoped-plugin-generated";
	ranges?: TextRange[];
}

export async function writeApprovedCardGroups(
	vault: Vault,
	file: TFile,
	groups: ApprovedCardGroup[],
	options?: {
		chunks?: ContentChunk[];
		chunkAnalyses?: KnowledgeChunkAnalysis[];
		obarCompatibility?: ObarCompatibilityConfig;
		regeneration?: CardRegenerationOptions;
	},
): Promise<number> {
	const chunks = options?.chunks ?? groups.map((group) => group.chunk);
	const chunkAnalyses = options?.chunkAnalyses ?? groups.map((group) => group.analysis);
	if (chunks.length === 0) {
		if (!options?.regeneration || options.regeneration.mode === "none") {
			return 0;
		}

		await vault.process(file, (content) => {
			const removableEntries = collectExistingCardEntries(file, content)
				.filter((entry) => entry.isPluginGenerated)
				.filter((entry) => shouldRemoveEntryForRegeneration(entry.blockRange, options.regeneration));
			if (removableEntries.length === 0) {
				return content;
			}

			return removeRangesWithWhitespaceCleanup(
				content,
				mergeRanges(removableEntries.map((entry) => entry.blockRange)),
				detectNewline(content),
			);
		});

		return 0;
	}

	const analysisByChunkId = new Map(chunkAnalyses.map((analysis) => [analysis.chunkId, analysis] as const));
	const cardsByChunkId = new Map(groups.map((group) => [group.chunk.chunkId, group.cards] as const));
	const sortedChunks = [...chunks].sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
	let insertedCount = 0;

	await vault.process(file, (content) => {
		const newline = detectNewline(content);
		const shouldUseObarWrapper = options?.obarCompatibility !== undefined
			? isObarRecordContent(content, options.obarCompatibility)
			: false;
		const removableEntries = collectExistingCardEntries(file, content)
			.filter((entry) => entry.isPluginGenerated)
			.filter((entry) => shouldRemoveEntryForRegeneration(entry.blockRange, options?.regeneration));
		const removableEntriesByChunkId = mapEntriesToChunks(sortedChunks, removableEntries, content, options?.regeneration);
		let workingContent = content;
		insertedCount = 0;

		for (let index = sortedChunks.length - 1; index >= 0; index -= 1) {
			const chunk = sortedChunks[index]!;
			const analysis = analysisByChunkId.get(chunk.chunkId);
			const cards = cardsByChunkId.get(chunk.chunkId) ?? [];
			const existingAnnotations = chunk.existingAnnotations ?? [];
			const needsRewrite = analysis !== undefined || existingAnnotations.length > 0 || cards.length > 0;
			if (!needsRewrite) {
				continue;
			}

			insertedCount += cards.length;
			const replaceStart = Math.min(
				chunk.range.from,
				...existingAnnotations.map((annotation) => annotation.blockRange.from),
			);
			const replaceEnd = resolveChunkReplaceEnd(
				chunk,
				removableEntriesByChunkId.get(chunk.chunkId) ?? [],
				content,
				getNextChunkStart(sortedChunks, index),
			);
			const bodyText = stripKnowledgeAnnotationMarkers(workingContent.slice(chunk.range.from, chunk.range.to));
			const replacement = renderChunkArtifacts(bodyText, analysis, cards, newline, shouldUseObarWrapper);
			workingContent = `${workingContent.slice(0, replaceStart)}${replacement}${workingContent.slice(replaceEnd)}`;
		}

		return workingContent;
	});

	return insertedCount;
}

export interface DeleteExistingCardsResult {
	deletedCount: number;
	beforeContent: string;
	afterContent: string;
}

export async function deleteExistingCards(vault: Vault, file: TFile, cardIds: string[]): Promise<DeleteExistingCardsResult> {
	if (cardIds.length === 0) {
		const content = await vault.cachedRead(file);
		return {
			deletedCount: 0,
			beforeContent: content,
			afterContent: content,
		};
	}

	let beforeContent = "";
	let afterContent = "";
	let deletedCount = 0;
	const cardIdSet = new Set(cardIds);

	await vault.process(file, (content) => {
		beforeContent = content;
		const result = removeExistingCardsFromContent(file, content, cardIdSet);
		afterContent = result.content;
		deletedCount = result.deletedCount;
		return result.content;
	});

	return {
		deletedCount,
		beforeContent,
		afterContent,
	};
}

export async function restoreDeletedCards(
	vault: Vault,
	file: TFile,
	operation: { beforeContent: string; afterContent: string },
): Promise<boolean> {
	let restored = false;

	await vault.process(file, (content) => {
		if (content !== operation.afterContent) {
			return content;
		}

		restored = true;
		return operation.beforeContent;
	});

	return restored;
}

export function renderBasicCard(card: GeneratedBasicCard, newline = "\n"): string {
	const tags = sanitizeTags(card.tags);
	const attributes = [`type="${GENERATED_CARD_TYPE}"`];
	if (tags.length > 0) {
		attributes.push(`tags="${tags.join(",")}"`);
	}

	return [
		`<!-- card-start ${attributes.join(" ")} -->`,
		card.front.trim(),
		"<!-- card-back -->",
		card.back.trim(),
		"<!-- card-end -->",
	].join(newline);
}

function mapEntriesToChunks(
	chunks: ContentChunk[],
	entries: ReturnType<typeof collectExistingCardEntries>,
	content: string,
	regeneration: CardRegenerationOptions | undefined,
): Map<string, ReturnType<typeof collectExistingCardEntries>> {
	const entriesByChunkId = new Map<string, ReturnType<typeof collectExistingCardEntries>>();

	for (const [index, chunk] of chunks.entries()) {
		const nextChunkStart = getNextChunkStart(chunks, index);
		const associatedEntries = collectSequentialEntriesForChunk(chunk, entries, content, nextChunkStart, regeneration);
		entriesByChunkId.set(chunk.chunkId, associatedEntries);
	}

	return entriesByChunkId;
}

function collectSequentialEntriesForChunk(
	chunk: ContentChunk,
	entries: ReturnType<typeof collectExistingCardEntries>,
	content: string,
	nextChunkStart: number,
	regeneration: CardRegenerationOptions | undefined,
): ReturnType<typeof collectExistingCardEntries> {
	const associatedEntries: ReturnType<typeof collectExistingCardEntries> = [];
	let cursor = Math.max(
		chunk.range.to,
		...(chunk.existingAnnotations ?? []).map((annotation) => annotation.blockRange.to),
	);

	for (const entry of entries) {
		if (!shouldRemoveEntryForRegeneration(entry.blockRange, regeneration)) {
			continue;
		}
		if (entry.blockRange.from < cursor || entry.blockRange.from >= nextChunkStart) {
			continue;
		}

		const between = content.slice(cursor, entry.blockRange.from);
		if (/\S/.test(between)) {
			break;
		}

		associatedEntries.push(entry);
		cursor = entry.blockRange.to;
	}

	return associatedEntries;
}

function resolveChunkReplaceEnd(
	chunk: ContentChunk,
	entries: ReturnType<typeof collectExistingCardEntries>,
	content: string,
	nextChunkStart: number,
): number {
	const baseEnd = Math.max(
		chunk.range.to,
		...(chunk.existingAnnotations ?? []).map((annotation) => annotation.blockRange.to),
	);
	if (entries.length === 0) {
		return baseEnd;
	}

	let replaceEnd = baseEnd;
	for (const entry of entries) {
		const between = content.slice(replaceEnd, entry.blockRange.from);
		if (/\S/.test(between)) {
			break;
		}

		replaceEnd = entry.blockRange.to;
	}

	return extendWhitespaceOnly(content, replaceEnd, nextChunkStart);
}

function extendWhitespaceOnly(content: string, from: number, limit: number): number {
	let index = from;

	while (index < limit && /\s/.test(content[index] ?? "")) {
		index += 1;
	}

	return index;
}

function getNextChunkStart(chunks: ContentChunk[], index: number): number {
	const nextChunk = chunks[index + 1];
	if (!nextChunk) {
		return Number.POSITIVE_INFINITY;
	}

	return Math.min(
		nextChunk.range.from,
		...((nextChunk.existingAnnotations ?? []).map((annotation) => annotation.blockRange.from)),
	);
}

function renderChunkArtifacts(
	bodyText: string,
	analysis: KnowledgeChunkAnalysis | undefined,
	cards: GeneratedBasicCard[],
	newline: string,
	wrapEachCardWithObar: boolean,
): string {
	const annotationBlock = analysis
		? renderKnowledgeBlock(bodyText, analysis, newline)
		: bodyText;
	if (cards.length === 0) {
		return annotationBlock;
	}

	return `${annotationBlock}${newline}${newline}${renderInsertedCards(cards, newline, wrapEachCardWithObar)}`;
}

function stripKnowledgeAnnotationMarkers(value: string): string {
	return value
		.replace(/^\s*<!--\s*obcd-knowledge-start:[\s\S]*?-->\s*$/gm, "")
		.replace(/^\s*<!--\s*obcd-knowledge-end\s*-->\s*$/gm, "")
		.trim();
}

function renderKnowledgeBlock(bodyText: string, analysis: KnowledgeChunkAnalysis, newline: string): string {
	const normalizedBody = bodyText.endsWith(newline) ? bodyText.slice(0, -newline.length) : bodyText;

	return [
		renderKnowledgeAnnotationStart({
			version: KNOWLEDGE_ANNOTATION_VERSION,
			hash: analysis.hash,
			status: analysis.status,
			summary: analysis.summary,
			topicHint: analysis.topicHint,
			rejectionReason: analysis.rejectionReason,
		}),
		normalizedBody,
		renderKnowledgeAnnotationEnd(),
	].join(newline);
}

function shouldRemoveEntryForRegeneration(blockRange: TextRange, regeneration: CardRegenerationOptions | undefined): boolean {
	if (!regeneration || regeneration.mode === "none") {
		return false;
	}

	if (regeneration.mode === "all-plugin-generated") {
		return true;
	}

	const ranges = regeneration.ranges ?? [];
	return ranges.some((range) => hasScopedOverlap(blockRange, range));
}

function hasScopedOverlap(blockRange: TextRange, scopeRange: TextRange): boolean {
	const scopedEnd = scopeRange.to + 32;
	return blockRange.to >= scopeRange.from && blockRange.from <= scopedEnd;
}

function renderInsertedCards(cards: GeneratedBasicCard[], newline: string, wrapEachCardWithObar: boolean): string {
	return cards
		.map((card) => {
			const renderedCard = renderBasicCard(card, newline);
			return wrapEachCardWithObar ? renderObarWrappedBlock(renderedCard, newline) : renderedCard;
		})
		.join(`${newline}${newline}`);
}

function sanitizeTags(tags: string[]): string[] {
	const results: string[] = [];
	const seenTags = new Set<string>();

	for (const rawTag of tags) {
		const sanitizedTag = rawTag
			.replace(/"/g, "")
			.replace(/,/g, " ")
			.trim();

		if (sanitizedTag.length === 0) {
			continue;
		}

		const dedupeKey = sanitizedTag.toLowerCase();
		if (seenTags.has(dedupeKey)) {
			continue;
		}

		seenTags.add(dedupeKey);
		results.push(sanitizedTag);
	}

	return results;
}

function removeExistingCardsFromContent(
	file: TFile,
	content: string,
	cardIds: Set<string>,
): { content: string; deletedCount: number } {
	if (cardIds.size === 0) {
		return {
			content,
			deletedCount: 0,
		};
	}

	const entries = collectExistingCardEntries(file, content);
	const deletedEntries = entries.filter((entry) => cardIds.has(entry.id));
	if (deletedEntries.length === 0) {
		return {
			content,
			deletedCount: 0,
		};
	}

	const replacements = mergeRanges(
		deletedEntries.map((entry) => entry.blockRange),
	);
	const newline = detectNewline(content);

	return {
		content: removeRangesWithWhitespaceCleanup(content, replacements, newline),
		deletedCount: deletedEntries.length,
	};
}

function mergeRanges(ranges: TextRange[]): TextRange[] {
	if (ranges.length === 0) {
		return [];
	}

	const sortedRanges = [...ranges].sort((left, right) => left.from - right.from || left.to - right.to);
	const mergedRanges: TextRange[] = [{ ...sortedRanges[0]! }];

	for (const range of sortedRanges.slice(1)) {
		const currentRange = mergedRanges[mergedRanges.length - 1]!;
		if (range.from > currentRange.to) {
			mergedRanges.push({ ...range });
			continue;
		}

		currentRange.to = Math.max(currentRange.to, range.to);
	}

	return mergedRanges;
}

function removeRangesWithWhitespaceCleanup(content: string, ranges: TextRange[], newline: string): string {
	return [...ranges]
		.sort((left, right) => right.from - left.from || right.to - left.to)
		.reduce((currentContent, range) => {
			const before = currentContent.slice(0, range.from);
			const after = currentContent.slice(range.to);
			const trimmedBefore = trimTrailingBlankLines(before, newline);
			const trimmedAfter = trimLeadingBlankLines(after, newline);
			const hasTextBefore = /\S/.test(trimmedBefore);
			const hasTextAfter = /\S/.test(trimmedAfter);
			const separator = resolveDeletionSeparator(
				before,
				after,
				currentContent.endsWith(newline),
				hasTextBefore,
				hasTextAfter,
				newline,
			);
			return `${trimmedBefore}${separator}${trimmedAfter}`;
		}, content);
}

function resolveDeletionSeparator(
	before: string,
	after: string,
	fileEndedWithNewline: boolean,
	hasTextBefore: boolean,
	hasTextAfter: boolean,
	newline: string,
): string {
	if (hasTextBefore && hasTextAfter) {
		return endsWithBlankLine(before, newline) || startsWithBlankLine(after, newline)
			? `${newline}${newline}`
			: newline;
	}

	if (hasTextBefore && fileEndedWithNewline) {
		return newline;
	}

	return "";
}

function trimTrailingBlankLines(value: string, newline: string): string {
	return value.replace(new RegExp(`(?:${escapeRegExp(newline)}[\\t ]*)+$`), "");
}

function trimLeadingBlankLines(value: string, newline: string): string {
	return value.replace(new RegExp(`^(?:[\\t ]*${escapeRegExp(newline)})+`), "");
}

function endsWithBlankLine(value: string, newline: string): boolean {
	return new RegExp(`${escapeRegExp(newline)}[\\t ]*${escapeRegExp(newline)}[\\t ]*$`).test(value);
}

function startsWithBlankLine(value: string, newline: string): boolean {
	return new RegExp(`^[\\t ]*${escapeRegExp(newline)}[\\t ]*${escapeRegExp(newline)}`).test(value);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
