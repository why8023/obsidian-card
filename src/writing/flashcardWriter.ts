import type { TFile, Vault } from "obsidian";

import type { ApprovedCardGroup, CardBlockMetadata, GeneratedBasicCard } from "../types";
import { collectObsidianCardBlocks, detectNewline } from "../utils/markdown";

const OBCARD_SECTION_END_MARKER = "<!-- obcard-section:end -->";

export async function writeApprovedCardGroups(vault: Vault, file: TFile, groups: ApprovedCardGroup[]): Promise<number> {
	if (groups.length === 0) {
		return 0;
	}

	let insertedCount = 0;
	await vault.process(file, (content) => {
		const result = upsertCardGroups(content, groups);
		insertedCount = result.insertedCount;
		return result.content;
	});
	return insertedCount;
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

function upsertCardGroups(content: string, groups: ApprovedCardGroup[]): { content: string; insertedCount: number } {
	const newline = detectNewline(content);
	const sortedGroups = [...groups].sort((left, right) => (
		right.chunk.insertOffset - left.chunk.insertOffset || right.chunk.range.from - left.chunk.range.from
	));

	let workingContent = content;
	let insertedCount = 0;

	for (const group of sortedGroups) {
		const block = renderCardBlock({
			sectionKey: group.chunk.sectionKey,
			headingPath: group.chunk.headingPath,
			sourceHash: group.chunk.sourceHash,
			kind: group.chunk.blockKind,
		}, group.cards, newline);

		insertedCount += group.cards.length;

		if (group.chunk.kind === "selection") {
			workingContent = insertBlockAt(workingContent, group.chunk.insertOffset, block, newline);
			continue;
		}

		const existingBlock = collectObsidianCardBlocks(workingContent)
			.find((entry) => entry.metadata.sectionKey === group.chunk.sectionKey);

		if (existingBlock) {
			workingContent = `${workingContent.slice(0, existingBlock.range.from)}${block}${workingContent.slice(existingBlock.range.to)}`;
			continue;
		}

		workingContent = insertBlockAt(workingContent, group.chunk.insertOffset, block, newline);
	}

	return {
		content: workingContent,
		insertedCount,
	};
}

function renderCardBlock(metadata: CardBlockMetadata, cards: GeneratedBasicCard[], newline: string): string {
	const serializedMetadata = JSON.stringify({
		sectionKey: metadata.sectionKey,
		headingPath: metadata.headingPath,
		sourceHash: metadata.sourceHash,
		kind: metadata.kind,
	});
	const parts = [`<!-- obcard-section:start ${serializedMetadata} -->`];

	for (const [index, card] of cards.entries()) {
		if (index > 0) {
			parts.push("");
		}

		parts.push(renderBasicCard(card, newline));
	}

	parts.push(OBCARD_SECTION_END_MARKER);
	return parts.join(newline);
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
