import type { TFile, Vault } from "obsidian";

import type { ObarCompatibilityConfig } from "../obarCompatibility";
import { isObarRecordContent, renderObarWrappedBlock } from "../obarCompatibility";
import type { ApprovedCardGroup, ExistingCardEntry, GeneratedBasicCard, TextRange } from "../types";
import { GENERATED_CARD_TYPE } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { detectNewline } from "../utils/markdown";

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
		const result = insertCardGroups(content, groups, options);
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

function insertCardGroups(
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
	const sortedGroups = [...groups]
		.filter((group) => group.cards.length > 0)
		.sort((left, right) => (
			right.chunk.insertOffset - left.chunk.insertOffset || right.chunk.range.from - left.chunk.range.from
		));

	let workingContent = content;
	let insertedCount = 0;

	for (const group of sortedGroups) {
		const blockToWrite = renderInsertedCards(group.cards, newline, shouldUseObarWrapper);
		insertedCount += group.cards.length;
		workingContent = insertBlockAt(workingContent, group.chunk.insertOffset, blockToWrite, newline);
	}

	return {
		content: workingContent,
		insertedCount,
	};
}

function renderInsertedCards(cards: GeneratedBasicCard[], newline: string, wrapEachCardWithObar: boolean): string {
	return cards
		.map((card) => {
			const renderedCard = renderBasicCard(card, newline);
			return wrapEachCardWithObar ? renderObarWrappedBlock(renderedCard, newline) : renderedCard;
		})
		.join(`${newline}${newline}`);
}

function insertBlockAt(content: string, offset: number, block: string, newline: string): string {
	const safeOffset = Math.max(0, Math.min(offset, content.length));
	const before = content.slice(0, safeOffset);
	const after = content.slice(safeOffset);
	const prefix = buildInsertPrefix(before, newline);
	const suffix = buildInsertSuffix(after, newline);

	return `${before}${prefix}${block}${suffix}${after}`;
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

	const replacements = mergeRanges(
		deletedEntries.map((entry) => entry.blockRange),
	);

	return {
		content: applyRangeReplacements(content, replacements.map((range) => ({ range, value: "" }))),
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

function applyRangeReplacements(content: string, replacements: Array<{ range: TextRange; value: string }>): string {
	return [...replacements]
		.sort((left, right) => right.range.from - left.range.from || right.range.to - left.range.to)
		.reduce((currentContent, replacement) => (
			`${currentContent.slice(0, replacement.range.from)}${replacement.value}${currentContent.slice(replacement.range.to)}`
		), content);
}
