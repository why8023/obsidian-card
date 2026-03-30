import type { TFile } from "obsidian";

import type { ContentChunk, TextRange } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import {
	collectMarkdownHeadings,
	findFrontmatterEnd,
	hashContent,
	sliceWithoutRanges,
	slugifyHeading,
} from "../utils/markdown";

interface BuildFileChunksOptions {
	upToOffset?: number;
}

const LEGACY_FLASHCARDS_SECTION_TITLE = "flashcards";

export function buildSelectionChunks(file: TFile, selectedText: string, range: TextRange): ContentChunk[] {
	const trimmedText = selectedText.trim();
	if (trimmedText.length === 0) {
		return [];
	}

	const sourceHash = hashContent(trimmedText);

	return [{
		file,
		filePath: file.path,
		text: trimmedText,
		range,
		kind: "selection",
		blockKind: "selection",
		sectionKey: `selection:${range.from}-${range.to}:${sourceHash.slice(-8)}`,
		sourceHash,
		headingPath: [],
		insertOffset: range.to,
		bodyRange: range,
	}];
}

export function buildFileChunks(file: TFile, content: string, options: BuildFileChunksOptions = {}): ContentChunk[] {
	const contentStart = findFrontmatterEnd(content);
	const headings = collectMarkdownHeadings(content).filter((heading) => heading.from >= contentStart);
	const blockRanges = dedupeRanges(
		collectExistingCardEntries(file, content).map((entry) => entry.blockRange),
	);

	const chunks: ContentChunk[] = [];

	if (headings.length === 0) {
		addChunkIfNeeded(chunks, {
			file,
			content,
			titleHint: file.basename,
			kind: "section",
			blockKind: "preamble",
			sectionKey: "preamble:root#1",
			headingPath: [],
			range: {
				from: contentStart,
				to: content.length,
			},
			bodyRange: {
				from: contentStart,
				to: content.length,
			},
			insertOffset: contentStart,
			blockRanges,
		});
		return filterChunksByOffset(chunks, options.upToOffset);
	}

	const firstHeading = headings[0];

	if (firstHeading && contentStart < firstHeading.from) {
		addChunkIfNeeded(chunks, {
			file,
			content,
			titleHint: file.basename,
			kind: "section",
			blockKind: "preamble",
			sectionKey: "preamble:root#1",
			headingPath: [],
			range: {
				from: contentStart,
				to: firstHeading.from,
			},
			bodyRange: {
				from: contentStart,
				to: firstHeading.from,
			},
			insertOffset: contentStart,
			blockRanges,
		});
	}

	const headingStack: Array<{ level: number; title: string }> = [];
	const pathOccurrenceCounts = new Map<string, number>();

	for (const [index, heading] of headings.entries()) {
		const nextHeading = headings[index + 1];
		if (heading.level === 2 && heading.title.trim().toLowerCase() === LEGACY_FLASHCARDS_SECTION_TITLE) {
			continue;
		}

		while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= heading.level) {
			headingStack.pop();
		}

		const headingPath = [...headingStack.map((entry) => entry.title), heading.title];
		headingStack.push({
			level: heading.level,
			title: heading.title,
		});

		const pathKey = headingPath.map((entry) => slugifyHeading(entry)).join("/");
		const occurrence = (pathOccurrenceCounts.get(pathKey) ?? 0) + 1;
		pathOccurrenceCounts.set(pathKey, occurrence);

		addChunkIfNeeded(chunks, {
			file,
			content,
			titleHint: heading.title,
			kind: "section",
			blockKind: "heading",
			sectionKey: `heading:${pathKey}#${occurrence}`,
			headingPath,
			range: {
				from: heading.from,
				to: nextHeading?.from ?? content.length,
			},
			bodyRange: {
				from: heading.lineEnd,
				to: nextHeading?.from ?? content.length,
			},
			insertOffset: heading.lineEnd,
			blockRanges,
		});
	}

	return filterChunksByOffset(chunks, options.upToOffset);
}

function addChunkIfNeeded(
	chunks: ContentChunk[],
	options: {
		file: TFile;
		content: string;
		titleHint?: string;
		kind: "section";
		blockKind: "heading" | "preamble";
		sectionKey: string;
		headingPath: string[];
		range: TextRange;
		bodyRange: TextRange;
		insertOffset: number;
		blockRanges: TextRange[];
	},
): void {
	const rawText = sliceWithoutRanges(options.content, options.bodyRange.from, options.bodyRange.to, options.blockRanges);
	const trimmedText = rawText.trim();
	if (trimmedText.length === 0 || !containsMeaningfulText(trimmedText)) {
		return;
	}

	const sourceHash = hashContent(trimmedText);
	chunks.push({
		file: options.file,
		filePath: options.file.path,
		text: trimmedText,
		range: options.range,
		kind: options.kind,
		blockKind: options.blockKind,
		sectionKey: options.sectionKey,
		sourceHash,
		headingPath: [...options.headingPath],
		insertOffset: options.insertOffset,
		bodyRange: options.bodyRange,
		titleHint: options.titleHint,
	});
}

function filterChunksByOffset(chunks: ContentChunk[], upToOffset: number | undefined): ContentChunk[] {
	if (upToOffset === undefined) {
		return chunks;
	}

	return chunks.filter((chunk) => chunk.range.from <= upToOffset);
}

function containsMeaningfulText(value: string): boolean {
	const normalizedValue = value
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`]*`/g, " ")
		.replace(/!\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/\[[^\]]*]\([^)]*\)/g, " ")
		.replace(/^\s*[-*+] \[[ xX]\]\s*$/gm, " ")
		.replace(/^\s*[-*+]\s+/gm, " ")
		.replace(/^\s*>+\s?/gm, " ");

	return /[\p{L}\p{N}]/u.test(normalizedValue);
}

function dedupeRanges(ranges: TextRange[]): TextRange[] {
	const seenRanges = new Set<string>();
	const results: TextRange[] = [];

	for (const range of ranges) {
		const rangeKey = `${range.from}:${range.to}`;
		if (seenRanges.has(rangeKey)) {
			continue;
		}

		seenRanges.add(rangeKey);
		results.push(range);
	}

	return results;
}
