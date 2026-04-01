import { MarkdownView, Notice, TFile } from "obsidian";

import type { Editor, MarkdownFileInfo } from "obsidian";

import type { DebugRun } from "../debug/debugService";
import type ObcdPlugin from "../main";
import { buildSelectionChunks, buildFileChunks } from "../generation/contentChunkBuilder";
import { listMarkdownFiles, resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";
import { allocateCardBudget } from "../knowledge/budgetAllocator";
import { GlobalRanker } from "../knowledge/globalRanker";
import { HierarchicalAggregator, estimateHierarchicalAggregationCalls } from "../knowledge/hierarchicalAggregator";
import { KnowledgeExtractor } from "../knowledge/knowledgeExtractor";
import { buildChapterPlan } from "../planning/chapterPlanner";
import { estimateScope } from "../planning/scopeEstimator";
import { resolveGenerationPrompt } from "../prompts/promptResolver";
import { PROVIDER_PRESET_INFO, getActiveProvider } from "../providerConfig";
import { DEFAULT_GENERATED_CARD_TAG } from "../settings";
import type {
	ApprovedCardGroup,
	BudgetPlan,
	ChunkAnalysisResult,
	CompositionRequest,
	ContentChunk,
	GeneratedBasicCard,
	GenerationMode,
	GenerationProgressPhase,
	GenerationProgressState,
	GenerationStrategy,
	KnowledgeChunkAnalysis,
	KnowledgeTopic,
	KnowledgeUnit,
	PlanningResult,
	ReviewAction,
	TextRange,
	TopicCompositionResult,
} from "../types";
import { mapWithConcurrency } from "../utils/concurrency";
import { CardComposer } from "../composition/cardComposer";
import { writeApprovedCardGroups, type CardRegenerationOptions } from "../writing/flashcardWriter";

interface FileProcessResult {
	action: ReviewAction;
	insertedCount: number;
}

interface GenerationProgressContext {
	currentFileIndex: number;
	totalFiles: number;
}

export class FlashcardWorkflow {
	private readonly plugin: ObcdPlugin;
	private isGenerationRunning = false;

	constructor(plugin: ObcdPlugin) {
		this.plugin = plugin;
	}

	async generateFromSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
		await this.runSafely(async () => {
			const target = resolveSelectionTarget(editor, ctx);
			if (target === null || target.selectedRange === undefined) {
				new Notice("Select some note content before generating flashcards.");
				return;
			}

			const selectedText = editor.getSelection();
			const chunks = buildSelectionChunks(target.file, selectedText, target.selectedRange);
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Preparing the selected scope.");
			await this.processSingleFile(target.file, selectedText, chunks, false, target.mode, progressContext);
		});
	}

	async generateForCurrentFile(): Promise<void> {
		await this.runSafely(async () => {
			const target = resolveCurrentFileTarget(this.plugin.app);
			if (target === null) {
				new Notice("Open a Markdown file before generating flashcards.");
				return;
			}

			const content = await this.loadFileContent(target.file);
			const chunks = buildFileChunks(target.file, content, {
				targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
			});
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Preparing the current note.");
			await this.processSingleFile(target.file, content, chunks, false, target.mode, progressContext);
		});
	}

	async generateUpToCursor(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
		await this.runSafely(async () => {
			const target = resolveCursorTarget(editor, ctx);
			if (target === null || target.cursorOffset === undefined) {
				new Notice("Open a Markdown file before generating flashcards.");
				return;
			}

			const fullContent = editor.getValue();
			const scopedContent = fullContent.slice(0, target.cursorOffset);
			const chunks = buildFileChunks(target.file, fullContent, {
				targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
				upToOffset: target.cursorOffset,
			});
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Preparing the note content up to the cursor.");
			await this.processSingleFile(target.file, scopedContent, chunks, false, target.mode, progressContext);
		});
	}

	async generateForCurrentSection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
		await this.runSafely(async () => {
			const target = resolveCursorTarget(editor, ctx);
			if (target === null || target.cursorOffset === undefined) {
				new Notice("Open a Markdown file before generating flashcards.");
				return;
			}

			const content = editor.getValue();
			const allChunks = buildFileChunks(target.file, content, {
				targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
			});
			const sectionChunks = this.findCurrentSectionChunks(allChunks, target.cursorOffset);
			if (sectionChunks.length === 0) {
				new Notice("Move the cursor into a heading section before generating flashcards for the current section.");
				return;
			}

			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, "section-file", progressContext, sectionChunks.length, "Preparing the current section.");
			await this.processSingleFile(
				target.file,
				this.buildContentForChunks(content, sectionChunks),
				sectionChunks,
				false,
				"section-file",
				progressContext,
			);
		});
	}

	async generateForFolder(): Promise<void> {
		await this.runSafely(async () => {
			const folder = resolveFolderTarget(this.plugin.app);
			if (folder === null) {
				new Notice("Select a folder in the file explorer or open a file inside the target folder.");
				return;
			}

			const markdownFiles = listMarkdownFiles(folder);
			if (markdownFiles.length === 0) {
				new Notice("No Markdown files were found in the selected folder.");
				return;
			}

			let insertedCount = 0;
			let processedFiles = 0;
			let skippedFiles = 0;
			let stoppedEarly = false;
			const errors: string[] = [];

			for (const [fileIndex, file] of markdownFiles.entries()) {
				try {
					const content = await this.loadFileContent(file);
					const chunks = buildFileChunks(file, content, {
						targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
					});
					const progressContext = {
						currentFileIndex: fileIndex + 1,
						totalFiles: markdownFiles.length,
					} satisfies GenerationProgressContext;
					await this.beginGenerationProgress(
						file,
						"folder-file",
						progressContext,
						chunks.length,
						`Preparing ${file.basename} from the selected folder.`,
					);
					const result = await this.processSingleFile(file, content, chunks, true, "folder-file", progressContext);

					processedFiles += 1;
					insertedCount += result.insertedCount;
					if (result.action === "skip-file" || result.action === "cancel") {
						skippedFiles += 1;
					}
					if (result.action === "stop-batch") {
						stoppedEarly = true;
						break;
					}
				} catch (error) {
					errors.push(`${file.path}: ${this.getErrorMessage(error)}`);
				}
			}

			const summaryParts = [
				`Folder run finished for ${folder.path}.`,
				`${insertedCount} card${insertedCount === 1 ? "" : "s"} inserted.`,
				`${processedFiles} file${processedFiles === 1 ? "" : "s"} processed.`,
			];

			if (skippedFiles > 0) {
				summaryParts.push(`${skippedFiles} file${skippedFiles === 1 ? "" : "s"} skipped.`);
			}
			if (stoppedEarly) {
				summaryParts.push("Batch processing stopped early.");
			}
			if (errors.length > 0) {
				summaryParts.push(`${errors.length} file${errors.length === 1 ? "" : "s"} failed.`);
			}

			new Notice(summaryParts.join(" "), 12000);
			if (errors.length > 0) {
				console.error("OBCD folder generation errors", errors);
			}
		});
	}

	private async processSingleFile(
		file: TFile,
		contentForPlanning: string,
		chunks: ContentChunk[],
		isBatchMode: boolean,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<FileProcessResult> {
		const debugRun = this.plugin.debug.createRun({
			mode,
			filePath: file.path,
			isBatchMode,
		});

		debugRun.recordChunks(chunks);

		try {
			this.assertAiConfigured();

			if (chunks.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "preparing",
					currentChunkIndex: 0,
					totalChunks: 0,
					fileProgress: 1,
					detail: "No eligible content was found in this scope.",
				});
				new Notice(`No uncovered content found in ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-usable-content", result);
				return result;
			}

			const resolvedPrompt = await resolveGenerationPrompt(this.plugin.app, this.plugin.settings.prompts, file);
			const scopeEstimate = estimateScope(mode, contentForPlanning, chunks, this.plugin.settings.generation);
			const strategy = scopeEstimate.recommendedStrategy;
			debugRun.log("estimate", "Calculated scope estimate.", scopeEstimate);
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "estimating",
				currentChunkIndex: 0,
				totalChunks: chunks.length,
				fileProgress: 0.12,
				detail: scopeEstimate.reason,
			});

			if (strategy === "chapter-planning") {
				const plan = buildChapterPlan(chunks, scopeEstimate, scopeEstimate.reason);
				debugRun.log("planning", "Produced a chapter plan instead of generating cards.", plan);
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "planning-only",
					currentChunkIndex: 0,
					totalChunks: plan.sections.length,
					fileProgress: 1,
					detail: this.describePlanningResult(plan),
				});
				this.notifyPlanningResult(file, plan);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("planning-only", result);
				return result;
			}

			if (strategy === "refuse-or-scope") {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "planning-only",
					currentChunkIndex: 0,
					totalChunks: 0,
					fileProgress: 1,
					detail: scopeEstimate.reason,
				});
				new Notice(`${file.basename} is too large for one generation run. Scope down to a chapter or selection.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("refused-oversize", {
					reason: scopeEstimate.reason,
				});
				return result;
			}

			const analysisResults = await this.analyzeChunks(chunks, resolvedPrompt.prompt, debugRun, file, mode, progressContext);
			const chunkAnalyses = analysisResults.map((result) => result.analysis);
			const knowledgeUnits = analysisResults.flatMap((result) => result.units);
			if (chunkAnalyses.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "extracting",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "The scope did not contain any knowledge-bearing blocks worth analyzing.",
				});
				await this.writeArtifacts(file, chunks, [], [], mode);
				new Notice(`No knowledge-bearing blocks were found in ${file.basename}.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-chunk-analyses", result);
				return result;
			}

			if (knowledgeUnits.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "extracting",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "The scope did not yield durable knowledge units worth turning into cards.",
				});
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no useful knowledge units were found.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-knowledge-units", result);
				return result;
			}

			const rankingUnits = await this.prepareUnitsForRanking(
				file,
				chunks,
				knowledgeUnits,
				strategy,
				resolvedPrompt.prompt,
				debugRun,
				mode,
				progressContext,
			);
			if (rankingUnits.length === 0) {
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no high-value knowledge surfaces survived ranking.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-ranking-units", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "ranking",
				currentChunkIndex: 0,
				totalChunks: rankingUnits.length,
				fileProgress: 0.62,
				detail: this.describeRankingProgress(strategy, rankingUnits.length),
			});
			const topics = await new GlobalRanker(this.plugin.settings, resolvedPrompt.prompt, debugRun).rank(rankingUnits);
			debugRun.log("topics", "Built document-level topics.", {
				topicCount: topics.length,
				topics,
				strategy,
			});

			if (topics.length === 0) {
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no document-level topics survived ranking.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-topics", result);
				return result;
			}

			const remainingLlmCalls = this.plugin.settings.generation.maxTaskLlmCalls
				- chunks.length
				- 1
				- (strategy === "hierarchical-global"
					? estimateHierarchicalAggregationCalls(chunks, knowledgeUnits, this.plugin.settings.generation.maxKnowledgeUnitsPerChunk)
					: 0);
			const budgetPlan = allocateCardBudget(topics, this.plugin.settings.generation, remainingLlmCalls);
			debugRun.log("budget", "Allocated document card budget.", budgetPlan);

			if (budgetPlan.selectedTopics.length === 0 || budgetPlan.totalPlannedCards === 0) {
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode);
				new Notice(`Chunk analysis was updated in ${file.basename}, but the ranked topics did not justify any card budget.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-budgeted-topics", result);
				return result;
			}

			const composedGroups = await this.composeCardGroups(
				file,
				chunks,
				chunkAnalyses,
				knowledgeUnits,
				rankingUnits,
				topics,
				budgetPlan,
				strategy,
				resolvedPrompt.prompt,
				debugRun,
				mode,
				progressContext,
			);

			if (composedGroups.length === 0) {
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no valid cards were composed.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-composed-cards", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "writing",
				currentChunkIndex: composedGroups.length,
				totalChunks: composedGroups.length,
				fileProgress: 0.94,
				detail: "Rebuilding cards inside the current scope and writing the final result.",
			});
			const insertedCount = await this.writeArtifacts(file, chunks, chunkAnalyses, composedGroups, mode);
			debugRun.recordWrite({
				insertedCount,
				approvedCount: composedGroups.reduce((sum, group) => sum + group.cards.length, 0),
			});

			new Notice(`Inserted ${insertedCount} flashcard${insertedCount === 1 ? "" : "s"} into ${file.basename}.`);
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "writing",
				currentChunkIndex: composedGroups.length,
				totalChunks: composedGroups.length,
				fileProgress: 1,
				detail: `Finished writing ${insertedCount} flashcard${insertedCount === 1 ? "" : "s"}.`,
			});

			const result = {
				action: "confirm",
				insertedCount,
			} satisfies FileProcessResult;
			await debugRun.finish("inserted", {
				insertedCount,
				budgetPlan,
			});
			return result;
		} catch (error) {
			debugRun.recordError("processSingleFile", error, {
				filePath: file.path,
				isBatchMode,
				mode,
			});
			await debugRun.finish("error", {
				message: this.getErrorMessage(error),
			});
			throw error;
		}
	}

	private async analyzeChunks(
		chunks: ContentChunk[],
		customPrompt: string,
		debugRun: DebugRun,
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ChunkAnalysisResult[]> {
		const analyzableChunks = chunks;
		if (analyzableChunks.length === 0) {
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "extracting",
				currentChunkIndex: 0,
				totalChunks: chunks.length,
				fileProgress: 0.54,
				detail: "No knowledge chunks were found in this scope.",
			});
			return [];
		}

		const extractor = new KnowledgeExtractor(this.plugin.settings, customPrompt, debugRun);
		const maxConcurrency = this.resolveLlmConcurrency(analyzableChunks.length);
		const chunkErrors = new Array<string | null>(analyzableChunks.length).fill(null);
		let completedChunks = 0;

		this.updateGenerationProgress(file, mode, progressContext, {
			phase: "extracting",
			currentChunkIndex: 0,
			totalChunks: analyzableChunks.length,
			fileProgress: 0.16,
			detail: `Extracting knowledge from ${analyzableChunks.length} chunk${analyzableChunks.length === 1 ? "" : "s"} with up to ${maxConcurrency} concurrent request${maxConcurrency === 1 ? "" : "s"}.`,
		});

		const analysisResults = await mapWithConcurrency(analyzableChunks, maxConcurrency, async (chunk, index) => {
			try {
				return await extractor.extract(chunk, index);
			} catch (error) {
				chunkErrors[index] = `chunk ${index + 1}: ${this.getErrorMessage(error)}`;
				debugRun.recordChunkError(index, error, {
					filePath: chunk.filePath,
					titleHint: chunk.titleHint ?? "",
				});
				return null;
			} finally {
				completedChunks += 1;
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "extracting",
					currentChunkIndex: completedChunks,
					totalChunks: analyzableChunks.length,
					fileProgress: this.getPhaseProgressFromCompletionCount(0.16, 0.54, analyzableChunks.length, completedChunks),
					detail: this.describeCompletedChunkProgress(chunk, completedChunks, analyzableChunks.length),
				});
			}
		});
		const results = analysisResults
			.filter((result): result is ChunkAnalysisResult => result !== null)
			.filter((result) => result.units.length > 0);
		const units = results.flatMap((result) => result.units);
		const failedChunks = chunkErrors.filter((error): error is string => error !== null);

		if (failedChunks.length > 0 && units.length === 0) {
			throw new Error(failedChunks.join(" "));
		}

		if (failedChunks.length > 0) {
			new Notice(`Some chunks failed during knowledge extraction and were skipped. ${failedChunks.length} chunk error(s).`, 8000);
		}

		return results;
	}

	private async prepareUnitsForRanking(
		file: TFile,
		chunks: ContentChunk[],
		knowledgeUnits: KnowledgeUnit[],
		strategy: GenerationStrategy,
		customPrompt: string,
		debugRun: DebugRun,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<KnowledgeUnit[]> {
		if (strategy !== "hierarchical-global") {
			return knowledgeUnits;
		}

		this.updateGenerationProgress(file, mode, progressContext, {
			phase: "ranking",
			currentChunkIndex: 0,
			totalChunks: knowledgeUnits.length,
			fileProgress: 0.58,
			detail: `Compressing ${knowledgeUnits.length} knowledge units into section summaries before document ranking.`,
		});

		const aggregatedUnits = await new HierarchicalAggregator(this.plugin.settings, customPrompt, debugRun).aggregate(chunks, knowledgeUnits);
		debugRun.log("hierarchy", "Prepared section-level summary units for hierarchical ranking.", {
			originalUnitCount: knowledgeUnits.length,
			aggregatedUnitCount: aggregatedUnits.length,
		});
		return aggregatedUnits;
	}

	private async composeCardGroups(
		file: TFile,
		chunks: ContentChunk[],
		chunkAnalyses: KnowledgeChunkAnalysis[],
		originalKnowledgeUnits: KnowledgeUnit[],
		rankingUnits: KnowledgeUnit[],
		topics: KnowledgeTopic[],
		budgetPlan: BudgetPlan,
		strategy: GenerationStrategy,
		customPrompt: string,
		debugRun: DebugRun,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ApprovedCardGroup[]> {
		const originalUnitsById = new Map(originalKnowledgeUnits.map((unit) => [unit.id, unit] as const));
		const rankingUnitsById = new Map(rankingUnits.map((unit) => [unit.id, unit] as const));
		const topicsById = new Map(topics.map((topic) => [topic.topicId, topic] as const));
		const chunksByChunkId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk] as const));
		const analysesByChunkId = new Map(chunkAnalyses.map((analysis) => [analysis.chunkId, analysis] as const));
		const composer = new CardComposer(this.plugin.settings, customPrompt, debugRun);
		const groupedCards = new Map<string, ApprovedCardGroup>();
		const seenCards = new Set<string>();
		const maxConcurrency = this.resolveLlmConcurrency(budgetPlan.selectedTopics.length);
		let completedTopics = 0;

		this.updateGenerationProgress(file, mode, progressContext, {
			phase: "composing",
			currentChunkIndex: 0,
			totalChunks: budgetPlan.selectedTopics.length,
			fileProgress: 0.7,
			detail: `Composing cards for ${budgetPlan.selectedTopics.length} topic${budgetPlan.selectedTopics.length === 1 ? "" : "s"} with up to ${maxConcurrency} concurrent request${maxConcurrency === 1 ? "" : "s"}.`,
		});

		const compositionResults = await mapWithConcurrency(
			budgetPlan.selectedTopics,
			maxConcurrency,
			async (allocation, index) => {
				const topic = topicsById.get(allocation.topicId);
				const topicUnits = topic
					? this.resolveOriginalUnitsForTopic(topic, rankingUnitsById, originalUnitsById)
					: [];
				const topicChunkAnalyses = topic
					? topic.memberChunkIds
						.map((chunkId) => analysesByChunkId.get(chunkId))
						.filter((analysis): analysis is KnowledgeChunkAnalysis => analysis !== undefined)
					: [];

				try {
					if (!topic || topicUnits.length === 0 || topicChunkAnalyses.length === 0) {
						return null;
					}

					const composition = await composer.compose({
						topic,
						units: topicUnits,
						chunkAnalyses: topicChunkAnalyses,
						cardCount: allocation.cardCount,
						strategy,
					} satisfies CompositionRequest, index);

					return {
						composition,
						topicUnits,
					};
				} catch (error) {
					debugRun.log("compose:error", "Skipping a topic that failed during composition.", {
						topicId: topic?.topicId ?? allocation.topicId,
						error: this.getErrorMessage(error),
					});
					return null;
				} finally {
					completedTopics += 1;
					this.updateGenerationProgress(file, mode, progressContext, {
						phase: "composing",
						currentChunkIndex: completedTopics,
						totalChunks: budgetPlan.selectedTopics.length,
						fileProgress: this.getPhaseProgressFromCompletionCount(0.7, 0.9, budgetPlan.selectedTopics.length, completedTopics),
						detail: this.describeCompletedTopicProgress(topic, allocation.topicId, completedTopics, budgetPlan.selectedTopics.length),
					});
				}
			},
		);

		for (const result of compositionResults) {
			if (!result) {
				continue;
			}

			this.appendComposedCards(result.composition, result.topicUnits, analysesByChunkId, chunksByChunkId, groupedCards, seenCards);
		}

		return Array.from(groupedCards.values())
			.filter((group) => group.cards.length > 0)
			.sort((left, right) => left.chunk.insertOffset - right.chunk.insertOffset);
	}

	private async writeArtifacts(
		file: TFile,
		chunks: ContentChunk[],
		chunkAnalyses: KnowledgeChunkAnalysis[],
		groups: ApprovedCardGroup[],
		mode: GenerationMode,
	): Promise<number> {
		const insertedCount = await writeApprovedCardGroups(this.plugin.app.vault, file, groups, {
			chunks,
			chunkAnalyses,
			obarCompatibility: this.plugin.settings.compatibility.obar,
			regeneration: this.resolveRegenerationOptions(mode, chunks),
		});
		if (mode !== "folder-file") {
			await this.plugin.sidebar.refreshFromVault(file);
		}
		return insertedCount;
	}

	private appendComposedCards(
		composition: TopicCompositionResult,
		topicUnits: KnowledgeUnit[],
		analysesByChunkId: Map<string, KnowledgeChunkAnalysis>,
		chunksByChunkId: Map<string, ContentChunk>,
		groupedCards: Map<string, ApprovedCardGroup>,
		seenCards: Set<string>,
	): void {
		if (composition.cards.length === 0) {
			return;
		}

		const anchorChunk = this.resolveAnchorChunk(topicUnits, chunksByChunkId);
		const anchorAnalysis = anchorChunk ? analysesByChunkId.get(anchorChunk.chunkId) : undefined;
		if (!anchorChunk || !anchorAnalysis) {
			return;
		}

		const group = groupedCards.get(anchorChunk.chunkId) ?? {
			chunk: anchorChunk,
			analysis: anchorAnalysis,
			cards: [],
		};

		for (const card of composition.cards) {
			const normalizedCard = this.applyGenerationDefaultsToCard(card);
			const dedupeKey = `${normalizedCard.front.toLowerCase()}::${normalizedCard.back.toLowerCase()}`;
			if (seenCards.has(dedupeKey)) {
				continue;
			}

			seenCards.add(dedupeKey);
			group.cards.push(normalizedCard);
		}

		groupedCards.set(anchorChunk.chunkId, group);
	}

	private resolveOriginalUnitsForTopic(
		topic: KnowledgeTopic,
		rankingUnitsById: Map<string, KnowledgeUnit>,
		originalUnitsById: Map<string, KnowledgeUnit>,
	): KnowledgeUnit[] {
		const topicSourceUnitIds = topic.memberUnitIds.flatMap((unitId) => {
			const rankingUnit = rankingUnitsById.get(unitId);
			if (rankingUnit) {
				return rankingUnit.sourceUnitIds;
			}

			return originalUnitsById.has(unitId) ? [unitId] : [];
		});

		return Array.from(new Set(topicSourceUnitIds))
			.map((unitId) => originalUnitsById.get(unitId))
			.filter((unit): unit is KnowledgeUnit => unit !== undefined);
	}

	private resolveAnchorChunk(topicUnits: KnowledgeUnit[], chunksByChunkId: Map<string, ContentChunk>): ContentChunk | null {
		const chunkScores = new Map<string, { chunk: ContentChunk; score: number }>();

		for (const unit of topicUnits) {
			const chunk = chunksByChunkId.get(unit.chunkId);
			if (!chunk) {
				continue;
			}

			const score = chunkScores.get(unit.chunkId) ?? {
				chunk,
				score: 0,
			};
			score.score += unit.importanceLocal;
			chunkScores.set(unit.chunkId, score);
		}

		return Array.from(chunkScores.values())
			.sort((left, right) => (
				right.score - left.score
				|| right.chunk.range.to - left.chunk.range.to
			))[0]?.chunk ?? null;
	}

	private findCurrentSectionChunks(chunks: ContentChunk[], cursorOffset: number): ContentChunk[] {
		const activeIndex = this.findActiveChunkIndex(chunks, cursorOffset);
		if (activeIndex === -1) {
			return [];
		}

		const activeChunk = chunks[activeIndex]!;
		if (activeChunk.headingPath.length === 0) {
			return [activeChunk];
		}

		const rootTitle = activeChunk.headingPath[0];
		if (!rootTitle) {
			return [activeChunk];
		}

		let start = activeIndex;
		while (start > 0 && this.getChunkRootTitle(chunks[start - 1]!) === rootTitle) {
			start -= 1;
		}

		let end = activeIndex;
		while (end + 1 < chunks.length && this.getChunkRootTitle(chunks[end + 1]!) === rootTitle) {
			end += 1;
		}

		return chunks.slice(start, end + 1);
	}

	private findActiveChunkIndex(chunks: ContentChunk[], cursorOffset: number): number {
		const containingIndex = chunks.findIndex((chunk) => chunk.range.from <= cursorOffset && cursorOffset <= chunk.range.to);
		if (containingIndex !== -1) {
			return containingIndex;
		}

		for (let index = chunks.length - 1; index >= 0; index -= 1) {
			const chunk = chunks[index];
			if (chunk && chunk.range.from <= cursorOffset) {
				return index;
			}
		}

		return -1;
	}

	private getChunkRootTitle(chunk: ContentChunk): string {
		return chunk.headingPath[0] ?? chunk.sectionKey;
	}

	private buildContentForChunks(content: string, chunks: ContentChunk[]): string {
		if (chunks.length === 0) {
			return "";
		}

		const range = chunks.reduce((result, chunk) => ({
			from: Math.min(result.from, chunk.range.from),
			to: Math.max(result.to, chunk.range.to),
		}), {
			from: chunks[0]!.range.from,
			to: chunks[0]!.range.to,
		});

		return content.slice(range.from, range.to);
	}

	private resolveRegenerationOptions(mode: GenerationMode, chunks: ContentChunk[]): CardRegenerationOptions {
		if (mode === "file" || mode === "folder-file") {
			return this.plugin.settings.generation.defaultRegenerationPolicy === "full-document-rebuild"
				? { mode: "all-plugin-generated" }
				: { mode: "scoped-plugin-generated", ranges: this.buildScopedRanges(chunks) };
		}

		return {
			mode: "scoped-plugin-generated",
			ranges: this.buildScopedRanges(chunks),
		};
	}

	private buildScopedRanges(chunks: ContentChunk[]): TextRange[] {
		return chunks.map((chunk) => ({
			from: chunk.range.from,
			to: chunk.range.to,
		}));
	}

	private applyGenerationDefaultsToCard(card: GeneratedBasicCard): GeneratedBasicCard {
		if (!this.plugin.settings.generation.addObcdTag) {
			return {
				front: card.front,
				back: card.back,
				tags: [...card.tags],
			};
		}

		return {
			front: card.front,
			back: card.back,
			tags: this.appendConfiguredTag(card.tags),
		};
	}

	private appendConfiguredTag(tags: string[]): string[] {
		const normalizedTag = this.plugin.settings.generation.defaultTag.trim() || DEFAULT_GENERATED_CARD_TAG;
		if (normalizedTag.length === 0) {
			return [...tags];
		}

		const hasTag = tags.some((tag) => tag.trim().toLowerCase() === normalizedTag.toLowerCase());
		if (hasTag) {
			return [...tags];
		}

		return [...tags, normalizedTag];
	}

	private async loadFileContent(file: TFile): Promise<string> {
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path === file.path) {
			return activeView.editor.getValue();
		}

		return await this.plugin.app.vault.cachedRead(file);
	}

	private assertAiConfigured(): void {
		const activeProvider = getActiveProvider(this.plugin.settings);
		const presetInfo = PROVIDER_PRESET_INFO[activeProvider.presetType];

		if (presetInfo.requireApiKey && activeProvider.apiKey.trim().length === 0) {
			throw new Error("请先在插件设置中填写当前模型服务的 API Key，再生成卡片。");
		}

		if (this.plugin.settings.generation.model.trim().length === 0) {
			throw new Error("请先在插件设置中填写模型名称，再生成卡片。");
		}
	}

	private async runSafely(task: () => Promise<void>): Promise<void> {
		if (this.isGenerationRunning) {
			new Notice("Flashcard generation is already running.");
			return;
		}

		this.isGenerationRunning = true;

		try {
			await task();
		} catch (error) {
			const message = this.getErrorMessage(error);
			console.error("OBCD command failed", error);
			new Notice(message, 10000);
		} finally {
			this.isGenerationRunning = false;
			this.plugin.sidebar.clearGenerationProgress();
		}
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}

	private async beginGenerationProgress(
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
		totalChunks: number,
		detail: string,
	): Promise<void> {
		await this.plugin.sidebar.startGenerationProgress(
			this.buildGenerationProgressState(file, mode, progressContext, {
				phase: "preparing",
				currentChunkIndex: 0,
				totalChunks,
				fileProgress: totalChunks === 0 ? 0.08 : 0.04,
				detail,
			}),
		);
	}

	private updateGenerationProgress(
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
		options: {
			phase: GenerationProgressPhase;
			currentChunkIndex: number;
			totalChunks: number;
			fileProgress: number;
			detail: string;
		},
	): void {
		this.plugin.sidebar.updateGenerationProgress(
			this.buildGenerationProgressState(file, mode, progressContext, options),
		);
	}

	private buildGenerationProgressState(
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
		options: {
			phase: GenerationProgressPhase;
			currentChunkIndex: number;
			totalChunks: number;
			fileProgress: number;
			detail: string;
		},
	): GenerationProgressState {
		return {
			phase: options.phase,
			mode,
			filePath: file.path,
			fileName: file.basename,
			currentFileIndex: progressContext.currentFileIndex,
			totalFiles: progressContext.totalFiles,
			currentChunkIndex: options.currentChunkIndex,
			totalChunks: options.totalChunks,
			progress: this.combineOverallProgress(progressContext, options.fileProgress),
			summary: `Generating flashcards for ${file.basename}`,
			detail: options.detail,
		};
	}

	private combineOverallProgress(progressContext: GenerationProgressContext, fileProgress: number): number {
		const totalFiles = Math.max(progressContext.totalFiles, 1);
		const normalizedFileProgress = Math.max(0, Math.min(1, fileProgress));
		return ((progressContext.currentFileIndex - 1) + normalizedFileProgress) / totalFiles;
	}

	private getPhaseFileProgress(start: number, end: number, totalItems: number, completedItems: number): number {
		if (totalItems <= 0) {
			return end;
		}

		return start + (((completedItems + 1) / totalItems) * (end - start));
	}

	private getPhaseProgressFromCompletionCount(start: number, end: number, totalItems: number, completedItems: number): number {
		if (totalItems <= 0) {
			return end;
		}

		const normalizedCompletedItems = Math.max(0, Math.min(totalItems, completedItems));
		return start + ((normalizedCompletedItems / totalItems) * (end - start));
	}

	private resolveLlmConcurrency(taskCount: number): number {
		if (taskCount <= 0) {
			return 1;
		}

		return Math.max(
			1,
			Math.min(taskCount, this.plugin.settings.generation.maxConcurrentLlmRequests),
		);
	}

	private describeRankingProgress(strategy: GenerationStrategy, unitCount: number): string {
		if (strategy === "hierarchical-global") {
			return `Ranking ${unitCount} section summary unit${unitCount === 1 ? "" : "s"} across the document.`;
		}

		return `Ranking ${unitCount} knowledge unit${unitCount === 1 ? "" : "s"} across the document.`;
	}

	private describeCompletedChunkProgress(chunk: ContentChunk, completedChunks: number, totalChunks: number): string {
		const title = chunk.titleHint?.trim() ?? "";
		if (title.length > 0) {
			return `Completed knowledge extraction for ${completedChunks}/${totalChunks} chunk${totalChunks === 1 ? "" : "s"}. Latest: ${title}`;
		}

		return `Completed knowledge extraction for ${completedChunks}/${totalChunks} chunk${totalChunks === 1 ? "" : "s"}.`;
	}

	private describeCompletedTopicProgress(
		topic: KnowledgeTopic | undefined,
		topicId: string,
		completedTopics: number,
		totalTopics: number,
	): string {
		const topicLabel = topic?.canonicalStatement.trim() || topicId;
		return `Completed card composition for ${completedTopics}/${totalTopics} topic${totalTopics === 1 ? "" : "s"}. Latest: ${topicLabel}`;
	}

	private describePlanningResult(plan: PlanningResult): string {
		const recommendedSections = plan.sections
			.filter((section) => section.recommended)
			.slice(0, 3)
			.map((section) => `${section.title} (${section.chunkCount} chunk${section.chunkCount === 1 ? "" : "s"})`);

		if (recommendedSections.length === 0) {
			return plan.reason;
		}

		return `${plan.reason} Recommended sections: ${recommendedSections.join(", ")}.`;
	}

	private notifyPlanningResult(file: TFile, plan: PlanningResult): void {
		const recommendedSections = plan.sections
			.filter((section) => section.recommended)
			.slice(0, 3)
			.map((section) => section.title)
			.join(", ");

		const recommendationSuffix = recommendedSections.length > 0
			? ` Recommended sections: ${recommendedSections}. Use the current section command after moving the cursor into one of them.`
			: "";
		new Notice(
			`${file.basename} was downgraded to chapter planning because it is outside the direct-global scope.${recommendationSuffix}`,
			12000,
		);
	}
}
