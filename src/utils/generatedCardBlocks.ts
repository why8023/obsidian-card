import { expandRangeToIncludeObarCustomNote } from "../obarCompatibility";
import type { CardBlockKind, CardBlockMetadata, ExistingCardBlock, TextRange } from "../types";

export const GENERATED_CARD_BLOCK_START_PREFIX = "<!-- obcd-section:start";
export const GENERATED_CARD_BLOCK_END_MARKER = "<!-- obcd-section:end -->";
const GENERATED_CARD_BLOCK_START_PATTERN = /^<!--\s*obcd-section:start\s+([\s\S]+?)\s*-->$/;

export function collectGeneratedCardBlocks(content: string): ExistingCardBlock[] {
	const blocks: ExistingCardBlock[] = [];
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const startIndex = content.indexOf(GENERATED_CARD_BLOCK_START_PREFIX, searchOffset);
		if (startIndex === -1) {
			break;
		}

		const startCommentEnd = content.indexOf("-->", startIndex);
		if (startCommentEnd === -1) {
			break;
		}

		const metadata = parseGeneratedCardBlockMetadata(content.slice(startIndex, startCommentEnd + 3));
		if (metadata === null) {
			searchOffset = startCommentEnd + 3;
			continue;
		}

		const endIndex = content.indexOf(GENERATED_CARD_BLOCK_END_MARKER, startCommentEnd + 3);
		if (endIndex === -1) {
			break;
		}

		blocks.push({
			metadata,
			range: expandRangeToIncludeObarCustomNote(content, {
				from: startIndex,
				to: endIndex + GENERATED_CARD_BLOCK_END_MARKER.length,
			}),
		});

		searchOffset = blocks[blocks.length - 1]?.range.to ?? endIndex + GENERATED_CARD_BLOCK_END_MARKER.length;
	}

	return blocks;
}

export function parseGeneratedCardBlockMetadata(comment: string): CardBlockMetadata | null {
	const rawPayload = comment.match(GENERATED_CARD_BLOCK_START_PATTERN)?.[1];
	if (!rawPayload) {
		return null;
	}

	try {
		const parsed = JSON.parse(rawPayload) as Record<string, unknown>;
		const sectionKey = typeof parsed.sectionKey === "string" ? parsed.sectionKey : "";
		const sourceHash = typeof parsed.sourceHash === "string" ? parsed.sourceHash : "";
		const headingPath = Array.isArray(parsed.headingPath)
			? parsed.headingPath.filter((entry): entry is string => typeof entry === "string")
			: [];

		if (sectionKey.length === 0 || sourceHash.length === 0 || !isCardBlockKind(parsed.kind)) {
			return null;
		}

		return {
			sectionKey,
			headingPath,
			sourceHash,
			kind: parsed.kind,
		};
	} catch {
		return null;
	}
}

export function findGeneratedCardBlockInnerRange(content: string, outerRange: TextRange): TextRange | null {
	const blockContent = content.slice(outerRange.from, outerRange.to);
	const innerStart = blockContent.indexOf(GENERATED_CARD_BLOCK_START_PREFIX);
	if (innerStart === -1) {
		return null;
	}

	const innerEndMarkerIndex = blockContent.indexOf(GENERATED_CARD_BLOCK_END_MARKER, innerStart);
	if (innerEndMarkerIndex === -1) {
		return null;
	}

	return {
		from: outerRange.from + innerStart,
		to: outerRange.from + innerEndMarkerIndex + GENERATED_CARD_BLOCK_END_MARKER.length,
	};
}

function isCardBlockKind(value: unknown): value is CardBlockKind {
	return value === "selection" || value === "heading" || value === "preamble";
}
