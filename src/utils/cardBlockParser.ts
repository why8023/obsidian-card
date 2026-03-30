import type { TFile } from "obsidian";

import { expandRangeToIncludeObarCustomNote } from "../obarCompatibility";
import type { ExistingCardEntry, TextRange } from "../types";
import { GENERATED_CARD_TYPE } from "../types";
import { hashContent } from "./markdown";

const CARD_START_PREFIX = "<!-- card-start";
const CARD_BACK_MARKER = "<!-- card-back -->";
const CARD_END_PREFIX = "<!-- card-end";

interface ParsedCardStartAttributes {
	type: string;
	tags: string[];
}

interface ParsedCardBlock {
	range: TextRange;
	front: string;
	back: string;
	attributes: ParsedCardStartAttributes;
}

export function collectExistingCardEntries(file: TFile, content: string): ExistingCardEntry[] {
	const entries: ExistingCardEntry[] = [];
	const idOccurrences = new Map<string, number>();
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const parsedCard = findNextCard(content, searchOffset, content.length);
		if (parsedCard === null) {
			break;
		}

		searchOffset = parsedCard.range.to;

		if (parsedCard.attributes.type !== GENERATED_CARD_TYPE) {
			continue;
		}

		const blockRange = expandRangeToIncludeObarCustomNote(content, parsedCard.range);
		entries.push({
			id: buildCardId(parsedCard, idOccurrences),
			file,
			filePath: file.path,
			range: parsedCard.range,
			blockRange,
			front: parsedCard.front,
			back: parsedCard.back,
			tags: parsedCard.attributes.tags,
			type: parsedCard.attributes.type,
			targetLabel: "Generated",
		});
	}

	return entries;
}

function findNextCard(content: string, from: number, to: number): ParsedCardBlock | null {
	const cardStart = content.indexOf(CARD_START_PREFIX, from);
	if (cardStart === -1 || cardStart >= to) {
		return null;
	}

	const cardStartCommentEnd = content.indexOf("-->", cardStart);
	if (cardStartCommentEnd === -1 || cardStartCommentEnd >= to) {
		return null;
	}

	const cardBack = content.indexOf(CARD_BACK_MARKER, cardStartCommentEnd + 3);
	if (cardBack === -1 || cardBack >= to) {
		return null;
	}

	const cardEndStart = content.indexOf(CARD_END_PREFIX, cardBack + CARD_BACK_MARKER.length);
	if (cardEndStart === -1 || cardEndStart >= to) {
		return null;
	}

	const cardEndCommentEnd = content.indexOf("-->", cardEndStart);
	if (cardEndCommentEnd === -1 || cardEndCommentEnd >= to) {
		return null;
	}

	return {
		range: {
			from: cardStart,
			to: cardEndCommentEnd + 3,
		},
		front: content.slice(cardStartCommentEnd + 3, cardBack).trim(),
		back: content.slice(cardBack + CARD_BACK_MARKER.length, cardEndStart).trim(),
		attributes: parseCardStartAttributes(content.slice(cardStart, cardStartCommentEnd + 3)),
	};
}

function parseCardStartAttributes(comment: string): ParsedCardStartAttributes {
	const result: ParsedCardStartAttributes = {
		type: "",
		tags: [],
	};

	if (!comment.startsWith(CARD_START_PREFIX)) {
		return result;
	}

	const attributePattern = /([A-Za-z][\w-]*)="([^"]*)"/g;
	let match = attributePattern.exec(comment);
	while (match) {
		const attributeName = match[1]?.toLowerCase() ?? "";
		const attributeValue = match[2] ?? "";

		if (attributeName === "type") {
			result.type = attributeValue.trim().toLowerCase();
		} else if (attributeName === "tags") {
			result.tags = attributeValue
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0);
		}

		match = attributePattern.exec(comment);
	}

	return result;
}

function buildCardId(
	parsedCard: Pick<ParsedCardBlock, "front" | "back" | "attributes">,
	idOccurrences: Map<string, number>,
): string {
	const fingerprint = hashContent([
		parsedCard.attributes.type,
		parsedCard.front,
		parsedCard.back,
		parsedCard.attributes.tags.join(","),
	].join("\u0000"));
	const occurrence = (idOccurrences.get(fingerprint) ?? 0) + 1;
	idOccurrences.set(fingerprint, occurrence);
	return `standalone:${fingerprint}:${occurrence}`;
}
