import type { TFile } from "obsidian";

export type GenerationMode = "selection" | "file" | "folder-file" | "cursor-file" | "section-file";
export type ContentChunkKind = "selection" | "section";
export type CardBlockKind = "selection" | "heading" | "preamble";
export type GenerationStrategy = "direct-global" | "hierarchical-global" | "chapter-planning" | "refuse-or-scope";
export type KnowledgeUnitKind =
	| "core-concept"
	| "key-conclusion"
	| "supporting-detail"
	| "background"
	| "example"
	| "process-detail"
	| "ignore";
export type TopicTier = "core" | "secondary";
export const GENERATED_CARD_TYPE = "obcd";
export const KNOWLEDGE_ANNOTATION_VERSION = 1;
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
	summary: string;
	group: string;
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
	isKnowledgeCandidate: boolean;
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
	existingAnnotations?: ExistingKnowledgeAnnotation[];
	existingAnnotation?: ExistingKnowledgeAnnotation;
}

export interface GeneratedBasicCard {
	front: string;
	back: string;
	tags: string[];
}

export interface ScopeEstimate {
	characterCount: number;
	chunkCount: number;
	headingCount: number;
	headingDepth: number;
	estimatedInputTokens: number;
	estimatedKnowledgeUnitCount: number;
	estimatedLlmCalls: number;
	isLikelyBookLikeDocument: boolean;
	recommendedStrategy: GenerationStrategy;
	reason: string;
}

export interface KnowledgeUnit {
	id: string;
	sourceUnitIds: string[];
	filePath: string;
	chunkId: string;
	sectionKey: string;
	headingPath: string[];
	titleHint?: string;
	chunkSummary: string;
	groupLabel: string;
	statement: string;
	kind: KnowledgeUnitKind;
	importanceLocal: number;
	candidateQuestionIntent: string;
	evidenceExcerpt: string;
	sourceHash: string;
	tokenEstimate: number;
}

export interface KnowledgeChunkAnalysis {
	chunkId: string;
	filePath: string;
	sectionKey: string;
	titleHint?: string;
	headingPath: string[];
	hash: string;
	summary: string;
	group: string;
}

export interface ChunkAnalysisResult {
	chunk: ContentChunk;
	analysis: KnowledgeChunkAnalysis;
	units: KnowledgeUnit[];
}

export interface KnowledgeTopicEvidence {
	unitId: string;
	excerpt: string;
}

export interface KnowledgeTopic {
	topicId: string;
	canonicalStatement: string;
	knowledgeGroup: string;
	memberUnitIds: string[];
	memberChunkIds: string[];
	importanceGlobal: number;
	coverageSections: string[];
	tier: TopicTier;
	recommendedCardCount: number;
	evidenceRefs: KnowledgeTopicEvidence[];
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

export interface PlanningSection {
	sectionKey: string;
	title: string;
	headingPath: string[];
	range: TextRange;
	chunkCount: number;
	summary: string;
	estimatedCardValueDensity: number;
	recommended: boolean;
}

export interface PlanningResult {
	strategy: Extract<GenerationStrategy, "chapter-planning" | "refuse-or-scope">;
	reason: string;
	estimate: ScopeEstimate;
	sections: PlanningSection[];
}

export interface CardDraftSource {
	topicId: string;
	unitIds: string[];
	chunkIds: string[];
	strategy: GenerationStrategy;
}

export interface CompositionRequest {
	topic: KnowledgeTopic;
	units: KnowledgeUnit[];
	chunkAnalyses: KnowledgeChunkAnalysis[];
	cardCount: number;
	strategy: GenerationStrategy;
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
	| "estimating"
	| "extracting"
	| "ranking"
	| "composing"
	| "writing"
	| "planning-only";

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
