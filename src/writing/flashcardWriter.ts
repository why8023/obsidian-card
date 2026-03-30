import type { TFile, Vault } from "obsidian";

import type { ObarCompatibilityConfig } from "../obarCompatibility";
import { isObarRecordContent, renderObarWrappedBlock } from "../obarCompatibility";
import type { ApprovedCardGroup, CardBlockMetadata, ExistingCardEntry, GeneratedBasicCard, TextRange } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import {
	collectGeneratedCardBlocks,
	findGeneratedCardBlockInnerRange,
	GENERATED_CARD_BLOCK_END_MARKER,
} from "../utils/generatedCardBlocks";
import { detectNewline } from "../utils/markdown";

const CARD_START_MARKER = "<!-- card-start";

export async function writeApprovedCardGroups(
	vault: Vault,
	file: TFile,
	groups: ApprovedCardGroup[],
	options?: {
		obarCompatibility?: ObarCompatibilityConfig;
	},
): Promise<number> {
	if (groups.length === 0) {
		return 0;
	}

	let insertedCount = 0;
	await vault.process(file, (content) => {
		const result = upsertCardGroups(content, groups, options);
		insertedCount = result.insertedCount;
		return result.content;
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
	const tagsAttribute = tags.length > 0 ? ` tags="${tags.join(",")}"` : "";

	return [
		`<!-- card-start${tagsAttribute} -->`,
		card.front.trim(),
		"<!-- card-back -->",
		card.back.trim(),
		"<!-- card-end -->",
	].join(newline);
}

export function renderCardBlock(metadata: CardBlockMetadata, cards: GeneratedBasicCard[], newline: string): string {
	const serializedMetadata = JSON.stringify({
		sectionKey: metadata.sectionKey,
		headingPath: metadata.headingPath,
		sourceHash: metadata.sourceHash,
		kind: metadata.kind,
	});
	const parts = [`<!-- obcd-section:start ${serializedMetadata} -->`];

	for (const [index, card] of cards.entries()) {
		if (index > 0) {
			parts.push("");
		}

		parts.push(renderBasicCard(card, newline));
	}

	parts.push(GENERATED_CARD_BLOCK_END_MARKER);
	return parts.join(newline);
}

function upsertCardGroups(
	content: string,
	groups: ApprovedCardGroup[],
	options?: {
		obarCompatibility?: ObarCompatibilityConfig;
	},
): { content: string; insertedCount: number } {
	const newline = detectNewline(content);
	const shouldUseObarWrapper = options?.obarCompatibility !== undefined
		? isObarRecordContent(content, options.obarCompatibility)
		: false;
	const sortedGroups = [...groups].sort((left, right) => (
		right.chunk.insertOffset - left.chunk.insertOffset || right.chunk.range.from - left.chunk.range.from
	));

	let workingContent = content;
	let insertedCount = 0;

	for (const group of sortedGroups) {
		const existingBlock = group.chunk.kind === "selection"
			? undefined
			: collectGeneratedCardBlocks(workingContent)
				.find((entry) => entry.metadata.sectionKey === group.chunk.sectionKey);

		if (group.cards.length === 0) {
			if (existingBlock) {
				const rangeToRemove = expandBlockRemovalRange(workingContent, existingBlock.range, newline);
				workingContent = applyRangeReplacements(workingContent, [{
					range: rangeToRemove,
					value: "",
				}]);
			}

			continue;
		}

		const block = renderCardBlock({
			sectionKey: group.chunk.sectionKey,
			headingPath: group.chunk.headingPath,
			sourceHash: group.chunk.sourceHash,
			kind: group.chunk.blockKind,
		}, group.cards, newline);
		const blockToWrite = shouldUseObarWrapper && options?.obarCompatibility
			? renderObarWrappedBlock(block, newline)
			: block;

		insertedCount += group.cards.length;

		if (group.chunk.kind === "selection") {
			workingContent = insertBlockAt(workingContent, group.chunk.insertOffset, blockToWrite, newline);
			continue;
		}

		if (existingBlock) {
			workingContent = replaceBlockAt(workingContent, existingBlock.range, blockToWrite, newline);
			continue;
		}

		workingContent = insertBlockAt(workingContent, group.chunk.insertOffset, blockToWrite, newline);
	}

	return {
		content: workingContent,
		insertedCount,
	};
}

function insertBlockAt(content: string, offset: number, block: string, newline: string): string {
	const safeOffset = Math.max(0, Math.min(offset, content.length));
	const before = content.slice(0, safeOffset);
	const after = content.slice(safeOffset);
	const prefix = buildInsertPrefix(before, newline);
	const suffix = buildInsertSuffix(after, newline);

	return `${before}${prefix}${block}${suffix}${after}`;
}

function replaceBlockAt(content: string, range: TextRange, block: string, newline: string): string {
	const strippedContent = `${content.slice(0, range.from)}${content.slice(range.to)}`;
	return insertBlockAt(strippedContent, range.from, block, newline);
}

function buildInsertPrefix(before: string, newline: string): string {
	if (before.length === 0) {
		return "";
	}

	if (before.endsWith(`${newline}${newline}`)) {
		return "";
	}

	if (before.endsWith(newline)) {
		return newline;
	}

	return `${newline}${newline}`;
}

function buildInsertSuffix(after: string, newline: string): string {
	if (after.length === 0) {
		return newline;
	}

	if (after.startsWith(`${newline}${newline}`)) {
		return "";
	}

	if (after.startsWith(newline)) {
		return newline;
	}

	return `${newline}${newline}`;
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

	const newline = detectNewline(content);
	const replacements: Array<{ range: TextRange; value: string }> = [];

	for (const block of groupEntriesByBlock(entries)) {
		const remainingCards = block.cards.filter((entry) => !cardIds.has(entry.id));
		if (remainingCards.length === block.cards.length) {
			continue;
		}

		if (remainingCards.length === 0) {
			replacements.push({
				range: expandBlockRemovalRange(content, block.range, newline),
				value: "",
			});
			continue;
		}

		replacements.push({
			range: findGeneratedCardBlockInnerRange(content, block.range) ?? block.range,
			value: renderCardBlock(
				block.metadata,
				remainingCards.map((entry) => ({
					front: entry.front,
					back: entry.back,
					tags: entry.tags,
				})),
				newline,
			),
		});
	}

	return {
		content: cleanupEmptyGeneratedBlocks(applyRangeReplacements(content, replacements), newline),
		deletedCount: deletedEntries.length,
	};
}

function groupEntriesByBlock(entries: ExistingCardEntry[]): Array<{
	range: TextRange;
	metadata: CardBlockMetadata;
	cards: ExistingCardEntry[];
}> {
	const groups = new Map<string, {
		range: TextRange;
		metadata: CardBlockMetadata;
		cards: ExistingCardEntry[];
	}>();

	for (const entry of entries) {
		const groupKey = `${entry.blockRange.from}:${entry.blockRange.to}`;
		const existingGroup = groups.get(groupKey);
		if (existingGroup) {
			existingGroup.cards.push(entry);
			continue;
		}

		groups.set(groupKey, {
			range: entry.blockRange,
			metadata: entry.metadata,
			cards: [entry],
		});
	}

	return Array.from(groups.values());
}

function applyRangeReplacements(content: string, replacements: Array<{ range: TextRange; value: string }>): string {
	return [...replacements]
		.sort((left, right) => right.range.from - left.range.from || right.range.to - left.range.to)
		.reduce((currentContent, replacement) => (
			`${currentContent.slice(0, replacement.range.from)}${replacement.value}${currentContent.slice(replacement.range.to)}`
		), content);
}

function cleanupEmptyGeneratedBlocks(content: string, newline: string): string {
	const replacements = collectGeneratedCardBlocks(content)
		.filter((block) => isGeneratedBlockEmpty(content, block.range))
		.map((block) => ({
			range: expandBlockRemovalRange(content, block.range, newline),
			value: "",
		}));

	if (replacements.length === 0) {
		return content;
	}

	return applyRangeReplacements(content, replacements);
}

function expandBlockRemovalRange(content: string, range: TextRange, newline: string): TextRange {
	let from = range.from;
	let to = range.to;
	const remainingAfter = content.slice(to);

	if (from === 0) {
		while (content.slice(to, to + newline.length) === newline) {
			to += newline.length;
		}

		return { from, to };
	}

	if (remainingAfter === newline) {
		to += newline.length;
	}

	if (endsWithDoubleNewline(content.slice(0, from), newline)) {
		from -= newline.length;
	}

	if (startsWithDoubleNewline(content.slice(to), newline)) {
		to += newline.length;
	}

	return { from, to };
}

function isGeneratedBlockEmpty(content: string, outerRange: TextRange): boolean {
	const innerRange = findGeneratedCardBlockInnerRange(content, outerRange) ?? outerRange;
	return !content.slice(innerRange.from, innerRange.to).includes(CARD_START_MARKER);
}

function endsWithDoubleNewline(value: string, newline: string): boolean {
	return value.endsWith(`${newline}${newline}`);
}

function startsWithDoubleNewline(value: string, newline: string): boolean {
	return value.startsWith(`${newline}${newline}`);
}

