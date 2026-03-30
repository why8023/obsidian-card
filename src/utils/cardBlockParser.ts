import type { TFile } from "obsidian";

import type { CardBlockMetadata, ExistingCardEntry, TextRange } from "../types";
import { collectGeneratedCardBlocks, findGeneratedCardBlockInnerRange } from "./generatedCardBlocks";
const CARD_START_PREFIX = "<!-- card-start";
const CARD_BACK_MARKER = "<!-- card-back -->";
const CARD_END_PREFIX = "<!-- card-end";

export function collectExistingCardEntries(file: TFile, content: string): ExistingCardEntry[] {
	const entries: ExistingCardEntry[] = [];

	for (const block of collectGeneratedCardBlocks(content)) {
		const innerRange = findGeneratedCardBlockInnerRange(content, block.range) ?? block.range;
		entries.push(...collectCardsWithinBlock(
			file,
			content,
			block.metadata,
			block.range,
			innerRange.from,
			innerRange.to,
		));
	}

	return entries;
}

function collectCardsWithinBlock(
	file: TFile,
	content: string,
	metadata: CardBlockMetadata,
	blockRange: TextRange,
	from: number,
	to: number,
): ExistingCardEntry[] {
	const entries: ExistingCardEntry[] = [];
	let searchOffset = from;

	while (searchOffset < to) {
		const cardStart = content.indexOf(CARD_START_PREFIX, searchOffset);
		if (cardStart === -1 || cardStart >= to) {
			break;
		}

		const cardStartCommentEnd = content.indexOf("-->", cardStart);
		if (cardStartCommentEnd === -1 || cardStartCommentEnd >= to) {
			break;
		}

		const cardBack = content.indexOf(CARD_BACK_MARKER, cardStartCommentEnd + 3);
		if (cardBack === -1 || cardBack >= to) {
			break;
		}

		const cardEndStart = content.indexOf(CARD_END_PREFIX, cardBack + CARD_BACK_MARKER.length);
		if (cardEndStart === -1 || cardEndStart >= to) {
			break;
		}

		const cardEndCommentEnd = content.indexOf("-->", cardEndStart);
		if (cardEndCommentEnd === -1 || cardEndCommentEnd >= to) {
			break;
		}

		const front = content.slice(cardStartCommentEnd + 3, cardBack).trim();
		const back = content.slice(cardBack + CARD_BACK_MARKER.length, cardEndStart).trim();
		const tags = parseCardTags(content.slice(cardStart, cardStartCommentEnd + 3));

		if (front.length > 0 || back.length > 0) {
			const indexInSection = entries.length;
			entries.push({
				id: `${metadata.sectionKey}:${indexInSection}`,
				file,
				filePath: file.path,
				range: {
					from: cardStart,
					to: cardEndCommentEnd + 3,
				},
				blockRange,
				front,
				back,
				tags,
				metadata,
				titleHint: metadata.headingPath.at(-1) ?? file.basename,
				indexInSection,
			});
		}

		searchOffset = cardEndCommentEnd + 3;
	}

	return entries;
}
function parseCardTags(comment: string): string[] {
	const match = comment.match(/^<!--\s*card-start(?:\s+tags="([^"]*)")?\s*-->$/);
	const rawTags = match?.[1];
	if (!rawTags) {
		return [];
	}

	return rawTags
		.split(",")
		.map((tag) => tag.trim())
		.filter((tag) => tag.length > 0);
}
