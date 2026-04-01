import type { TFile } from "obsidian";

import { collectKnowledgeAnnotations } from "../knowledge/knowledgeAnnotations";
import type { ContentChunk, ExistingKnowledgeAnnotation, TextRange } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import {
	collectLineInfos,
	findFrontmatterEnd,
	hashContent,
	makePreview,
	normalizeContentForHash,
	trimContentRange,
} from "../utils/markdown";

interface BuildFileChunksOptions {
	upToOffset?: number;
	targetChunkCharacters?: number;
}

interface CandidateBlock {
	range: TextRange;
	text: string;
}

const DEFAULT_TARGET_CHUNK_CHARACTERS = 900;
const MIN_TARGET_CHUNK_CHARACTERS = 200;
const KNOWLEDGE_START_LINE = /^<!--\s*obcd-knowledge-start:/i;
const KNOWLEDGE_END_LINE = /^<!--\s*obcd-knowledge-end\s*-->$/i;

export function buildSelectionChunks(file: TFile, selectedText: string, range: TextRange): ContentChunk[] {
	const trimmedText = selectedText.trim();
	if (trimmedText.length === 0) {
		return [];
	}

	const sourceHash = hashContent(normalizeContentForHash(trimmedText));

	return [{
		file,
		filePath: file.path,
		chunkId: `selection:${range.from}-${range.to}:${sourceHash.slice(0, 8)}`,
		text: trimmedText,
		range,
		kind: "selection",
		sourceHash,
		insertOffset: range.to,
		bodyRange: range,
		titleHint: file.basename,
		existingAnnotations: [],
	}];
}

export function buildFileChunks(file: TFile, content: string, options: BuildFileChunksOptions = {}): ContentChunk[] {
	const targetChunkCharacters = normalizeTargetChunkCharacters(options.targetChunkCharacters);
	const contentStart = findFrontmatterEnd(content);
	const existingAnnotations = collectKnowledgeAnnotations(content);
	const cardRanges = collectExistingCardEntries(file, content).map((entry) => entry.blockRange);
	const atomicBlocks = collectAtomicBlocks(content, cardRanges, contentStart);
	const mergedBlocks = mergeBlocksByTargetSize(atomicBlocks, targetChunkCharacters);
	const chunks = materializeChunks(file, mergedBlocks, existingAnnotations);
	return filterChunksByOffset(chunks, options.upToOffset);
}

function collectAtomicBlocks(
	content: string,
	cardRanges: TextRange[],
	contentStart: number,
): CandidateBlock[] {
	const lines = collectLineInfos(content);
	const blocks: CandidateBlock[] = [];
	let activeBlockStart: number | null = null;
	let activeBlockEnd = 0;
	let fenceMarker: string | null = null;
	let lineIndex = findFirstLineIndex(lines, contentStart);

	const flushActiveBlock = (): void => {
		if (activeBlockStart === null || activeBlockEnd <= activeBlockStart) {
			activeBlockStart = null;
			activeBlockEnd = 0;
			return;
		}

		const trimmed = trimContentRange(content, activeBlockStart, activeBlockEnd);
		if (trimmed.text.length === 0 || !containsMeaningfulText(trimmed.text)) {
			activeBlockStart = null;
			activeBlockEnd = 0;
			return;
		}

		blocks.push({
			range: {
				from: trimmed.from,
				to: trimmed.to,
			},
			text: trimmed.text,
		});

		activeBlockStart = null;
		activeBlockEnd = 0;
	};

	while (lineIndex < lines.length) {
		const line = lines[lineIndex];
		if (!line) {
			break;
		}

		const coveringCardRange = findCoveringRange(cardRanges, line.start);
		if (coveringCardRange) {
			flushActiveBlock();
			lineIndex = advancePastOffset(lines, coveringCardRange.to, lineIndex);
			fenceMarker = null;
			continue;
		}

		if (KNOWLEDGE_START_LINE.test(line.text.trim()) || KNOWLEDGE_END_LINE.test(line.text.trim())) {
			flushActiveBlock();
			lineIndex += 1;
			continue;
		}

		const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1];
			if (marker) {
				if (activeBlockStart === null) {
					activeBlockStart = line.start;
				}
				activeBlockEnd = line.end;

				if (fenceMarker === null) {
					fenceMarker = marker;
				} else if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length) {
					fenceMarker = null;
				}
			}

			lineIndex += 1;
			continue;
		}

		if (fenceMarker === null && line.text.trim().length === 0) {
			flushActiveBlock();
			lineIndex += 1;
			continue;
		}

		if (activeBlockStart === null) {
			activeBlockStart = line.start;
		}
		activeBlockEnd = line.end;
		lineIndex += 1;
	}

	flushActiveBlock();
	return blocks;
}

function mergeBlocksByTargetSize(blocks: CandidateBlock[], targetChunkCharacters: number): CandidateBlock[] {
	if (blocks.length === 0) {
		return [];
	}

	const minChunkCharacters = Math.max(120, Math.round(targetChunkCharacters * 0.45));
	const softChunkCharacters = Math.max(minChunkCharacters, Math.round(targetChunkCharacters * 0.8));
	const maxChunkCharacters = Math.max(targetChunkCharacters + 200, Math.round(targetChunkCharacters * 1.6));
	const merged: CandidateBlock[] = [];
	let current = cloneBlock(blocks[0]!);

	for (const nextBlock of blocks.slice(1)) {
		const mergedLength = current.text.length + 2 + nextBlock.text.length;
		const shouldSoftSplit = current.text.length >= softChunkCharacters && mergedLength > targetChunkCharacters;
		const shouldHardSplit = mergedLength > maxChunkCharacters && current.text.length >= minChunkCharacters;

		if (shouldSoftSplit || shouldHardSplit) {
			merged.push(current);
			current = cloneBlock(nextBlock);
			continue;
		}

		current = {
			range: {
				from: current.range.from,
				to: nextBlock.range.to,
			},
			text: `${current.text}\n\n${nextBlock.text}`,
		};
	}

	merged.push(current);
	return merged;
}

function materializeChunks(
	file: TFile,
	blocks: CandidateBlock[],
	existingAnnotations: ExistingKnowledgeAnnotation[],
): ContentChunk[] {
	const hashOccurrences = new Map<string, number>();

	return blocks.map((block) => {
		const normalizedContent = normalizeContentForHash(block.text);
		const sourceHash = hashContent(normalizedContent);
		const occurrence = (hashOccurrences.get(sourceHash) ?? 0) + 1;
		hashOccurrences.set(sourceHash, occurrence);
		const overlappingAnnotations = existingAnnotations.filter((annotation) => isAnnotationContainedWithinBlock(annotation, block.range));
		const matchingAnnotation = overlappingAnnotations.find((annotation) => annotation.data.hash === sourceHash);

		return {
			file,
			filePath: file.path,
			chunkId: `block:${sourceHash}:${occurrence}`,
			text: block.text,
			range: {
				from: block.range.from,
				to: block.range.to,
			},
			kind: "paragraph-group",
			sourceHash,
			insertOffset: block.range.to,
			bodyRange: {
				from: block.range.from,
				to: block.range.to,
			},
			titleHint: buildChunkTitle(block.text, file.basename, occurrence),
			existingAnnotations: overlappingAnnotations,
			existingAnnotation: matchingAnnotation,
		} satisfies ContentChunk;
	});
}

function cloneBlock(block: CandidateBlock): CandidateBlock {
	return {
		range: {
			from: block.range.from,
			to: block.range.to,
		},
		text: block.text,
	};
}

function buildChunkTitle(text: string, fileBasename: string, occurrence: number): string {
	const preview = makePreview(text, 48);
	return preview.length > 0 ? preview : `${fileBasename} chunk ${occurrence}`;
}

function findCoveringRange(ranges: TextRange[], offset: number): TextRange | null {
	for (const range of ranges) {
		if (range.from <= offset && offset < range.to) {
			return range;
		}
	}

	return null;
}

function advancePastOffset(lines: ReturnType<typeof collectLineInfos>, offset: number, startIndex: number): number {
	let index = startIndex;
	while (index < lines.length && (lines[index]?.start ?? Number.POSITIVE_INFINITY) < offset) {
		index += 1;
	}
	return index;
}

function findFirstLineIndex(lines: ReturnType<typeof collectLineInfos>, offset: number): number {
	for (let index = 0; index < lines.length; index += 1) {
		if ((lines[index]?.end ?? 0) > offset) {
			return index;
		}
	}

	return lines.length;
}

function isAnnotationContainedWithinBlock(annotation: ExistingKnowledgeAnnotation, blockRange: TextRange): boolean {
	return annotation.bodyRange.from >= blockRange.from && annotation.bodyRange.to <= blockRange.to;
}

function filterChunksByOffset(chunks: ContentChunk[], upToOffset: number | undefined): ContentChunk[] {
	if (upToOffset === undefined) {
		return chunks;
	}

	return chunks.filter((chunk) => chunk.range.from <= upToOffset);
}

function normalizeTargetChunkCharacters(value: number | undefined): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return DEFAULT_TARGET_CHUNK_CHARACTERS;
	}

	return Math.max(MIN_TARGET_CHUNK_CHARACTERS, Math.round(value));
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
