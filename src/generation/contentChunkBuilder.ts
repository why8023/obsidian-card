import type { TFile } from "obsidian";

import {
	DEFAULT_PROTECTED_BLOCK_RULES,
	collectProtectedBlockRanges,
	type ProtectedBlockRule,
} from "./protectedBlockRules";
import { collectKnowledgeAnnotations, stripKnowledgeAnnotationMarkers } from "../knowledge/knowledgeAnnotations";
import type { ContentChunk, ExistingKnowledgeAnnotation, TextRange } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import {
	collectLineInfos,
	findFrontmatterEnd,
	hashContent,
	makePreview,
	normalizeContentForHash,
	sliceWithoutRanges,
	trimContentRange,
} from "../utils/markdown";

interface BuildFileChunksOptions {
	upToOffset?: number;
	targetChunkCharacters?: number;
	protectedBlockRules?: ProtectedBlockRule[];
}

interface CandidateBlock {
	range: TextRange;
	text: string;
	isProtected: boolean;
}

const DEFAULT_TARGET_CHUNK_CHARACTERS = 900;
const MIN_TARGET_CHUNK_CHARACTERS = 200;
const KNOWLEDGE_START_MARKER = /<!--\s*obcd-knowledge-start:/i;
const KNOWLEDGE_END_MARKER = /<!--\s*obcd-knowledge-end\s*-->/i;

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
	const protectedBlockRanges = collectProtectedBlockRanges(
		content,
		options.protectedBlockRules ?? DEFAULT_PROTECTED_BLOCK_RULES,
	);
	const atomicBlocks = collectAtomicBlocks(content, cardRanges, protectedBlockRanges, contentStart);
	const mergedBlocks = mergeBlocksByTargetSize(atomicBlocks, targetChunkCharacters);
	const chunks = materializeChunks(file, content, mergedBlocks, existingAnnotations);
	return filterChunksByOffset(chunks, options.upToOffset);
}

function collectAtomicBlocks(
	content: string,
	cardRanges: TextRange[],
	protectedBlockRanges: TextRange[],
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
			isProtected: false,
		});

		activeBlockStart = null;
		activeBlockEnd = 0;
	};

	while (lineIndex < lines.length) {
		const line = lines[lineIndex];
		if (!line) {
			break;
		}

		const coveringProtectedBlockRange = findCoveringRange(protectedBlockRanges, line.start);
		if (coveringProtectedBlockRange) {
			flushActiveBlock();
			const protectedBlock = createProtectedBlock(content, coveringProtectedBlockRange, cardRanges);
			if (protectedBlock) {
				blocks.push(protectedBlock);
			}
			lineIndex = advancePastOffset(lines, coveringProtectedBlockRange.to, lineIndex);
			fenceMarker = null;
			continue;
		}

		const coveringCardRange = findCoveringRange(cardRanges, line.start);
		if (coveringCardRange) {
			flushActiveBlock();
			lineIndex = advancePastOffset(lines, coveringCardRange.to, lineIndex);
			fenceMarker = null;
			continue;
		}

		if (KNOWLEDGE_START_MARKER.test(line.text) || KNOWLEDGE_END_MARKER.test(line.text)) {
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

function createProtectedBlock(content: string, range: TextRange, excludedRanges: TextRange[]): CandidateBlock | null {
	const text = stripKnowledgeAnnotationMarkers(
		sliceWithoutRanges(content, range.from, range.to, excludedRanges),
	).trim();
	if (text.length === 0 || !containsMeaningfulText(text)) {
		return null;
	}

	return {
		range: {
			from: range.from,
			to: range.to,
		},
		text,
		isProtected: true,
	};
}

function mergeBlocksByTargetSize(blocks: CandidateBlock[], targetChunkCharacters: number): CandidateBlock[] {
	if (blocks.length === 0) {
		return [];
	}

	const merged: CandidateBlock[] = [];
	let current = cloneBlock(blocks[0]!);

	for (const nextBlock of blocks.slice(1)) {
		if (current.isProtected || nextBlock.isProtected) {
			merged.push(current);
			current = cloneBlock(nextBlock);
			continue;
		}

		const mergedLength = current.text.length + 2 + nextBlock.text.length;
		if (mergedLength > targetChunkCharacters) {
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
			isProtected: false,
		};
	}

	merged.push(current);
	return merged;
}

function materializeChunks(
	file: TFile,
	content: string,
	blocks: CandidateBlock[],
	existingAnnotations: ExistingKnowledgeAnnotation[],
): ContentChunk[] {
	const hashOccurrences = new Map<string, number>();

	return blocks.map((block) => {
		const normalizedContent = normalizeContentForHash(block.text);
		const sourceHash = hashContent(normalizedContent);
		const occurrence = (hashOccurrences.get(sourceHash) ?? 0) + 1;
		hashOccurrences.set(sourceHash, occurrence);
		const relatedAnnotations = findRelatedAnnotationsForBlock(existingAnnotations, block.range, content, sourceHash);

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
			existingAnnotations: relatedAnnotations,
			existingAnnotation: relatedAnnotations[0],
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
		isProtected: block.isProtected,
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

function findRelatedAnnotationsForBlock(
	annotations: ExistingKnowledgeAnnotation[],
	blockRange: TextRange,
	content: string,
	sourceHash: string,
): ExistingKnowledgeAnnotation[] {
	const nearbyAnnotations = annotations.filter((annotation) => doesAnnotationTouchBlock(annotation, blockRange, content));
	const hashMatchedAnnotations = nearbyAnnotations.filter((annotation) => computeAnnotationSourceHash(annotation, content) === sourceHash);
	if (hashMatchedAnnotations.length > 0) {
		return sortAnnotationsBySpecificity(hashMatchedAnnotations);
	}

	return sortAnnotationsBySpecificity(
		nearbyAnnotations.filter((annotation) => isAnnotationBodyContainedWithinBlock(annotation, blockRange, content)),
	);
}

function doesAnnotationTouchBlock(annotation: ExistingKnowledgeAnnotation, blockRange: TextRange, content: string): boolean {
	const trimmedBody = trimContentRange(content, annotation.bodyRange.from, annotation.bodyRange.to);
	if (trimmedBody.text.length > 0 && rangesOverlap({
		from: trimmedBody.from,
		to: trimmedBody.to,
	}, blockRange)) {
		return true;
	}

	return annotation.blockRange.from <= blockRange.from && annotation.blockRange.to >= blockRange.to;
}

function isAnnotationBodyContainedWithinBlock(
	annotation: ExistingKnowledgeAnnotation,
	blockRange: TextRange,
	content: string,
): boolean {
	const trimmedBody = trimContentRange(content, annotation.bodyRange.from, annotation.bodyRange.to);
	if (trimmedBody.text.length === 0) {
		return false;
	}

	return trimmedBody.from >= blockRange.from && trimmedBody.to <= blockRange.to;
}

function computeAnnotationSourceHash(annotation: ExistingKnowledgeAnnotation, content: string): string {
	const annotationBody = stripKnowledgeAnnotationMarkers(
		content.slice(annotation.bodyRange.from, annotation.bodyRange.to),
	);
	if (annotationBody.length === 0) {
		return "";
	}

	return hashContent(normalizeContentForHash(annotationBody));
}

function sortAnnotationsBySpecificity(annotations: ExistingKnowledgeAnnotation[]): ExistingKnowledgeAnnotation[] {
	return [...annotations].sort((left, right) => {
		const lengthDelta = (left.blockRange.to - left.blockRange.from) - (right.blockRange.to - right.blockRange.from);
		if (lengthDelta !== 0) {
			return lengthDelta;
		}

		const extractedAtDelta = right.data.extractedAt.localeCompare(left.data.extractedAt);
		if (extractedAtDelta !== 0) {
			return extractedAtDelta;
		}

		return right.blockRange.from - left.blockRange.from;
	});
}

function rangesOverlap(left: TextRange, right: TextRange): boolean {
	return left.to > right.from && left.from < right.to;
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
