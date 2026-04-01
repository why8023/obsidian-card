import type { TFile } from "obsidian";

export type GenerationMode = "selection" | "file" | "folder-file" | "cursor-file";
export type ContentChunkKind = "selection" | "paragraph-group";
export type ChunkKnowledgeStatus = "knowledge" | "no-knowledge";
export type TopicTier = "core" | "secondary";
export const GENERATED_CARD_TYPE = "obcd";
export const KNOWLEDGE_ANNOTATION_VERSION = 2;
export const SIDEBAR_TABLE_COLUMN_IDS = ["target", "tags", "kind"] as const;
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

export interface KnowledgeAnnotationData {
	version: number;
	hash: string;
	status: ChunkKnowledgeStatus;
	summary: string;
	topicHint: string;
	rejectionReason: string;
}

export interface ExistingKnowledgeAnnotation {
	blockRange: TextRange;
	bodyRange: TextRange;
	data: KnowledgeAnnotationData;
}

export interface ContentChunk {
	file: TFile;
	filePath: string;
	chunkId: string;
	text: string;
	range: TextRange;
	kind: ContentChunkKind;
	sourceHash: string;
	insertOffset: number;
	bodyRange: TextRange;
	titleHint?: string;
	existingAnnotations?: ExistingKnowledgeAnnotation[];
	existingAnnotation?: ExistingKnowledgeAnnotation;
}

export interface GeneratedBasicCard {
	front: string;
	back: string;
	tags: string[];
}

export interface KnowledgeChunkAnalysis {
	chunkId: string;
	filePath: string;
	hash: string;
	status: ChunkKnowledgeStatus;
	summary: string;
	topicHint: string;
	evidenceExcerpt: string;
	rejectionReason: string;
}

export interface ChunkAnalysisResult {
	chunk: ContentChunk;
	analysis: KnowledgeChunkAnalysis;
}

export interface KnowledgeTopic {
	topicId: string;
	canonicalStatement: string;
	knowledgeGroup: string;
	summary: string;
	memberChunkIds: string[];
	importanceScore: number;
	tier: TopicTier;
	recommendedCardCount: number;
	shouldCreateCards: boolean;
	rejectionReason: string;
}

export interface TopicBudgetAllocation {
	topicId: string;
	tier: TopicTier;
	cardCount: number;
}

export interface BudgetPlan {
	maxTotalCards: number;
	coreCardBudget: number;
	secondaryCardBudget: number;
	maxCardsPerTopic: number;
	totalPlannedCards: number;
	selectedTopics: TopicBudgetAllocation[];
}

export interface CardDraftSource {
	topicId: string;
	chunkIds: string[];
}

export interface CompositionRequest {
	topic: KnowledgeTopic;
	chunks: ContentChunk[];
	chunkAnalyses: KnowledgeChunkAnalysis[];
	cardCount: number;
}

export interface TopicCompositionResult {
	topic: KnowledgeTopic;
	cards: GeneratedBasicCard[];
	source: CardDraftSource;
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
	analysis: KnowledgeChunkAnalysis;
	cards: GeneratedBasicCard[];
}

export type ReviewAction = "confirm" | "cancel" | "skip-file" | "stop-batch";

export interface ReviewResult {
	action: ReviewAction;
	approvedGroups: ApprovedCardGroup[];
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
	type: string;
	isPluginGenerated: boolean;
	targetLabel: string;
}

export type GenerationProgressPhase =
	| "preparing"
	| "extracting"
	| "grouping"
	| "composing"
	| "writing";

export interface GenerationProgressState {
	phase: GenerationProgressPhase;
	mode: GenerationMode;
	filePath: string;
	fileName: string;
	currentFileIndex: number;
	totalFiles: number;
	currentChunkIndex: number;
	totalChunks: number;
	progress: number;
	summary: string;
	detail: string;
}
