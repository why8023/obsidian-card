import type { TFile } from "obsidian";

import { expandRangeToIncludeObarCustomNote } from "../obarCompatibility";
import type { CardBlockMetadata, ExistingCardEntry, TextRange } from "../types";

const OBCARD_SECTION_START_PREFIX = "<!-- obcard-section:start";
const OBCARD_SECTION_END_MARKER = "<!-- obcard-section:end -->";
const CARD_START_PREFIX = "<!-- card-start";
const CARD_BACK_MARKER = "<!-- card-back -->";
const CARD_END_PREFIX = "<!-- card-end";

export function collectExistingCardEntries(file: TFile, content: string): ExistingCardEntry[] {
	const entries: ExistingCardEntry[] = [];
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const blockStart = content.indexOf(OBCARD_SECTION_START_PREFIX, searchOffset);
		if (blockStart === -1) {
			break;
		}

		const startCommentEnd = content.indexOf("-->", blockStart);
		if (startCommentEnd === -1) {
			break;
		}

		const metadata = parseCardBlockMetadata(content.slice(blockStart, startCommentEnd + 3));
		const blockEndMarkerIndex = content.indexOf(OBCARD_SECTION_END_MARKER, startCommentEnd + 3);
		if (blockEndMarkerIndex === -1) {
			break;
		}

		const innerBlockRange = {
			from: blockStart,
			to: blockEndMarkerIndex + OBCARD_SECTION_END_MARKER.length,
		} satisfies TextRange;
		const blockRange = expandRangeToIncludeObarCustomNote(content, innerBlockRange);

		if (metadata !== null) {
			entries.push(...collectCardsWithinBlock(
				file,
				content,
				metadata,
				blockRange,
				startCommentEnd + 3,
				blockEndMarkerIndex,
			));
		}

		searchOffset = blockRange.to;
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

function parseCardBlockMetadata(comment: string): CardBlockMetadata | null {
	const match = comment.match(/^<!--\s*obcard-section:start\s+([\s\S]+?)\s*-->$/);
	const rawPayload = match?.[1];
	if (!rawPayload) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
		const sectionKey = typeof parsed.sectionKey === "string" ? parsed.sectionKey : "";
		const sourceHash = typeof parsed.sourceHash === "string" ? parsed.sourceHash : "";
		const kind = parsed.kind;

		if (sectionKey.length === 0 || sourceHash.length === 0 || (kind !== "selection" && kind !== "heading" && kind !== "preamble")) {
			return null;
		}

		return {
			sectionKey,
			headingPath: Array.isArray(parsed.headingPath)
				? parsed.headingPath.filter((entry): entry is string => typeof entry === "string")
				: [],
			sourceHash,
			kind,
		};
	} catch {
		return null;
	}
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
