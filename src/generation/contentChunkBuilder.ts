import type { TFile } from "obsidian";

import type { ContentChunk, TextRange } from "../types";
import { collectMarkdownHeadings, findFrontmatterEnd, trimContentRange } from "../utils/markdown";

const FLASHCARDS_SECTION_TITLE = "flashcards";

export function buildSelectionChunks(file: TFile, selectedText: string, range: TextRange): ContentChunk[] {
	const trimmedText = selectedText.trim();
	if (trimmedText.length === 0) {
		return [];
	}

	return [{
		file,
		filePath: file.path,
		text: trimmedText,
		range,
	}];
}

export function buildFileChunks(file: TFile, content: string): ContentChunk[] {
	const contentStart = findFrontmatterEnd(content);
	const headings = collectMarkdownHeadings(content).filter((heading) => heading.from >= contentStart);

	if (headings.length === 0) {
		return createChunkList(file, content, [{
			from: contentStart,
			to: content.length,
			titleHint: file.basename,
		}]);
	}

	const ranges: Array<{ from: number; to: number; titleHint?: string }> = [];
	const firstHeading = headings[0];

	if (firstHeading && contentStart < firstHeading.from) {
		ranges.push({
			from: contentStart,
			to: firstHeading.from,
			titleHint: file.basename,
		});
	}

	for (const [index, heading] of headings.entries()) {
		const nextHeading = headings[index + 1];

		if (heading.level === 2 && heading.title.trim().toLowerCase() === FLASHCARDS_SECTION_TITLE) {
			continue;
		}

		ranges.push({
			from: heading.from,
			to: nextHeading?.from ?? content.length,
			titleHint: heading.title,
		});
	}

	return createChunkList(file, content, ranges);
}

function createChunkList(file: TFile, content: string, ranges: Array<{ from: number; to: number; titleHint?: string }>): ContentChunk[] {
	const chunks: ContentChunk[] = [];

	for (const range of ranges) {
		const normalizedRange = trimContentRange(content, range.from, range.to);
		if (normalizedRange.text.length === 0) {
			continue;
		}

		chunks.push({
			file,
			filePath: file.path,
			text: normalizedRange.text,
			range: {
				from: normalizedRange.from,
				to: normalizedRange.to,
			},
			titleHint: range.titleHint,
		});
	}

	return chunks;
}
