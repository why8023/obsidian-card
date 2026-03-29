import type { TFile } from "obsidian";

export type GenerationMode = "selection" | "file" | "folder-file";

export interface TextRange {
	from: number;
	to: number;
}

export interface GenerationTarget {
	file: TFile;
	filePath: string;
	mode: GenerationMode;
	selectedRange?: TextRange;
}

export interface ContentChunk {
	file: TFile;
	filePath: string;
	text: string;
	range: TextRange;
	titleHint?: string;
}

export interface GeneratedBasicCard {
	front: string;
	back: string;
	tags: string[];
}

export interface ChunkGenerationResult {
	chunk: ContentChunk;
	cards: GeneratedBasicCard[];
}

export interface CardCandidate {
	id: string;
	filePath: string;
	chunkIndex: number;
	titleHint?: string;
	sourcePreview: string;
	card: GeneratedBasicCard;
	approved: boolean;
}

export type ReviewAction = "confirm" | "cancel" | "skip-file" | "stop-batch";

export interface ReviewResult {
	action: ReviewAction;
	approvedCards: GeneratedBasicCard[];
}
