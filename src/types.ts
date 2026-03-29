import type { TFile } from "obsidian";

export type GenerationMode = "selection" | "file" | "folder-file" | "cursor-file";
export type ContentChunkKind = "selection" | "section";
export type CardBlockKind = "selection" | "heading" | "preamble";
export const SIDEBAR_TABLE_COLUMN_IDS = ["target", "tags", "kind", "sectionKey"] as const;
export type SidebarTableColumnId = (typeof SIDEBAR_TABLE_COLUMN_IDS)[number];

export interface TextRange {
	from: number;
	to: number;
}

export interface GenerationTarget {
	file: TFile;
	filePath: string;
	mode: GenerationMode;
	selectedRange?: TextRange;
	cursorOffset?: number;
}

export interface ContentChunk {
	file: TFile;
	filePath: string;
	text: string;
	range: TextRange;
	kind: ContentChunkKind;
	blockKind: CardBlockKind;
	sectionKey: string;
	sourceHash: string;
	headingPath: string[];
	insertOffset: number;
	bodyRange: TextRange;
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
	chunkId: string;
	filePath: string;
	titleHint?: string;
	sourcePreview: string;
	card: GeneratedBasicCard;
	approved: boolean;
}

export interface ReviewGroup {
	chunk: ContentChunk;
	sourcePreview: string;
	candidates: CardCandidate[];
}

export interface ApprovedCardGroup {
	chunk: ContentChunk;
	cards: GeneratedBasicCard[];
}

export type ReviewAction = "confirm" | "cancel" | "skip-file" | "stop-batch";

export interface ReviewResult {
	action: ReviewAction;
	approvedGroups: ApprovedCardGroup[];
}

export interface CardBlockMetadata {
	sectionKey: string;
	headingPath: string[];
	sourceHash: string;
	kind: CardBlockKind;
}

export interface ExistingCardBlock {
	metadata: CardBlockMetadata;
	range: TextRange;
}

export interface ExistingCardEntry {
	id: string;
	file: TFile;
	filePath: string;
	range: TextRange;
	blockRange: TextRange;
	front: string;
	back: string;
	tags: string[];
	metadata: CardBlockMetadata;
	titleHint: string;
	indexInSection: number;
}

export type ReviewSessionStatus = "reviewing" | "submitting";

export interface SidebarReviewSession {
	file: TFile;
	filePath: string;
	groups: ReviewGroup[];
	status: ReviewSessionStatus;
}
