import { MarkdownView, Notice, TFile } from "obsidian";

import type { Editor, MarkdownFileInfo } from "obsidian";

import type { DebugRun } from "../debug/debugService";
import type ObcdPlugin from "../main";
import { CardComposer } from "../composition/cardComposer";
import { buildFileChunks, buildSelectionChunks } from "../generation/contentChunkBuilder";
import { listMarkdownFiles, resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";
import { allocateCardBudget } from "../knowledge/budgetAllocator";
import { hasReusableChunkAnalysis, isKnowledgeBearingAnalysis } from "../knowledge/chunkEligibility";
import { GlobalRanker } from "../knowledge/globalRanker";
import { KnowledgeExtractor } from "../knowledge/knowledgeExtractor";
import { buildCardCompositionPrompt, buildGlobalRankingPrompt, buildKnowledgeExtractionPrompt } from "../prompts/promptDefaults";
import { resolveGenerationPrompt, type ResolvedGenerationPrompt } from "../prompts/promptResolver";
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
	KnowledgeChunkAnalysis,
	KnowledgeTopic,
	ReviewAction,
	TextRange,
	TopicCompositionResult,
} from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { mapWithConcurrency } from "../utils/concurrency";
import {
	buildDocumentContentFingerprint,
	buildCardCompositionFingerprint,
	buildGenerationConfigFingerprint,
	buildKnowledgeExtractionFingerprint,
	buildTopicGroupingFingerprint,
	buildTopicPlanFingerprint,
} from "../utils/generationFingerprints";
import {
	writeApprovedCardGroups,
	type CardRegenerationOptions,
} from "../writing/flashcardWriter";
import {
	readDocumentMetadata,
	writeDocumentMetadata,
	type DocumentMetadataWriteRequest,
	type PersistedDocumentMetadata,
} from "../writing/documentMetadataWriter";

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
			await this.processSingleFile(target.file, chunks, false, target.mode, progressContext);
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
				protectedBlockRules: this.plugin.settings.generation.protectedBlockRules,
				targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
			});
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Preparing the current note.");
			await this.processSingleFile(target.file, chunks, false, target.mode, progressContext);
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
			const chunks = buildFileChunks(target.file, fullContent, {
				protectedBlockRules: this.plugin.settings.generation.protectedBlockRules,
				targetChunkCharacters: this.plugin.settings.generation.targetChunkCharacters,
				upToOffset: target.cursorOffset,
			});
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Preparing the note content up to the cursor.");
			await this.processSingleFile(target.file, chunks, false, target.mode, progressContext);
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
						protectedBlockRules: this.plugin.settings.generation.protectedBlockRules,
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
					const result = await this.processSingleFile(file, chunks, true, "folder-file", progressContext);

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
			if (chunks.length === 0) {
				await this.writeArtifacts(file, [], [], [], mode, null, debugRun);
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

			const content = await this.loadFileContent(file);
			const persistedMetadata = readDocumentMetadata(this.plugin.app, file, content);
			const resolvedPrompt = await resolveGenerationPrompt(this.plugin.app, this.plugin.settings.prompts, file);
			const generatedAt = new Date().toISOString();
			const activeProvider = getActiveProvider(this.plugin.settings);
			const extractionSystemPrompt = buildKnowledgeExtractionPrompt(
				this.plugin.settings.prompts.knowledgeExtractionPrompt,
				resolvedPrompt.prompt,
			);
			const extractFingerprint = buildKnowledgeExtractionFingerprint(
				this.plugin.settings.generation.model,
				this.plugin.settings.generation.temperature,
				extractionSystemPrompt,
			);
			const documentFingerprint = buildDocumentContentFingerprint(chunks);
			const configFingerprint = buildGenerationConfigFingerprint({
				providerPresetType: activeProvider.presetType,
				model: this.plugin.settings.generation.model,
				temperature: this.plugin.settings.generation.temperature,
				resolvedPrompt: resolvedPrompt.prompt,
				knowledgeExtractionPrompt: this.plugin.settings.prompts.knowledgeExtractionPrompt,
				globalRankingPrompt: this.plugin.settings.prompts.globalRankingPrompt,
				cardCompositionPrompt: this.plugin.settings.prompts.cardCompositionPrompt,
				coreCardBudget: this.plugin.settings.generation.coreCardBudget,
				secondaryCardBudget: this.plugin.settings.generation.secondaryCardBudget,
				maxTotalCardsPerDocument: this.plugin.settings.generation.maxTotalCardsPerDocument,
				maxCardsPerTopic: this.plugin.settings.generation.maxCardsPerTopic,
			});

			if (this.canReuseExistingGenerationBeforeAnalysis({
				file,
				content,
				mode,
				chunks,
				extractFingerprint,
				documentFingerprint,
				configFingerprint,
				persistedMetadata,
			})) {
				debugRun.log("up-to-date:early", "Skipped chunk analysis because the note body, generation config, and existing plugin cards are unchanged.", {
					documentFingerprint,
					configFingerprint,
					insertedCardCount: persistedMetadata.generationMeta?.insertedCardCount ?? null,
				});
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "writing",
					currentChunkIndex: 0,
					totalChunks: Math.max(chunks.length, 1),
					fileProgress: 1,
					detail: "No content or generation changes were detected. Skipping chunk analysis and keeping the existing flashcards.",
				});
				if (mode !== "folder-file") {
					await this.plugin.sidebar.refreshFromVault(file);
				}
				new Notice(`No content or generation changes were detected in ${file.basename}. Existing flashcards were kept.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("up-to-date", {
					documentFingerprint,
					configFingerprint,
					fingerprints: persistedMetadata.generationMeta?.fingerprints ?? {
						extract: extractFingerprint,
						group: "",
						plan: "",
					},
				});
				return result;
			}

			this.assertAiConfigured();
			this.assertScopeWithinTaskLimits(chunks, extractFingerprint);
			const analysisResults = await this.analyzeChunks(chunks, resolvedPrompt.prompt, extractFingerprint, debugRun, file, mode, progressContext);
			const chunkAnalyses = analysisResults.map((result) => result.analysis);
			const knowledgeAnalyses = chunkAnalyses.filter(isKnowledgeBearingAnalysis);

			if (knowledgeAnalyses.length === 0) {
				const documentMetadata = this.buildDocumentMetadataRequest({
					mode,
					generatedAt,
					resolvedPrompt,
					extractFingerprint,
					groupFingerprint: "",
					planFingerprint: "",
					documentFingerprint,
					configFingerprint,
					knowledgeChunkCount: 0,
					topics: [],
					budgetPlan: null,
					remainingLlmCalls: null,
					cardGenerationFingerprints: [],
				});
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "extracting",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "The scope did not contain any durable knowledge chunks worth carrying into topic grouping.",
				});
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode, documentMetadata, debugRun);
				new Notice(`No durable knowledge chunks were found in ${file.basename}.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-knowledge-chunks", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "grouping",
				currentChunkIndex: 0,
				totalChunks: knowledgeAnalyses.length,
				fileProgress: 0.62,
				detail: `Grouping ${knowledgeAnalyses.length} knowledge-bearing chunk${knowledgeAnalyses.length === 1 ? "" : "s"} into distinct topics.`,
			});
			const groupingSystemPrompt = buildGlobalRankingPrompt({
				coreCardBudget: this.plugin.settings.generation.coreCardBudget,
				secondaryCardBudget: this.plugin.settings.generation.secondaryCardBudget,
				maxTotalCardsPerDocument: this.plugin.settings.generation.maxTotalCardsPerDocument,
				maxCardsPerTopic: this.plugin.settings.generation.maxCardsPerTopic,
			}, this.plugin.settings.prompts.globalRankingPrompt, resolvedPrompt.prompt);
			const groupingFingerprint = buildTopicGroupingFingerprint(
				this.plugin.settings.generation.model,
				this.plugin.settings.generation.temperature,
				groupingSystemPrompt,
				knowledgeAnalyses,
			);
			const topics = this.resolveReusableTopics(persistedMetadata, extractFingerprint, groupingFingerprint, debugRun)
				?? await new GlobalRanker(this.plugin.settings, resolvedPrompt.prompt, debugRun).rank(knowledgeAnalyses);
			debugRun.log("topics", "Built chunk-group topics.", {
				topicCount: topics.length,
				topics,
			});

			if (topics.length === 0) {
				const documentMetadata = this.buildDocumentMetadataRequest({
					mode,
					generatedAt,
					resolvedPrompt,
					extractFingerprint,
					groupFingerprint: groupingFingerprint,
					planFingerprint: "",
					documentFingerprint,
					configFingerprint,
					knowledgeChunkCount: knowledgeAnalyses.length,
					topics,
					budgetPlan: null,
					remainingLlmCalls: null,
					cardGenerationFingerprints: [],
				});
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode, documentMetadata, debugRun);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no distinct knowledge topics were found.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-topics", result);
				return result;
			}

			const remainingLlmCalls = this.plugin.settings.generation.maxTaskLlmCalls
				- this.countPendingChunkExtractions(chunks, extractFingerprint)
				- 1;
			const budgetPlan = this.resolveReusableBudgetPlan(
				persistedMetadata,
				groupingFingerprint,
				topics,
				debugRun,
			) ?? allocateCardBudget(topics, this.plugin.settings.generation, remainingLlmCalls);
			const planFingerprint = buildTopicPlanFingerprint(
				this.plugin.settings.generation,
				topics,
				budgetPlan,
			);
			debugRun.log("budget", "Allocated card budget across grouped topics.", budgetPlan);

			if (await this.isGenerationUpToDate({
				file,
				mode,
				content,
				chunks,
				chunkAnalyses,
				topics,
				budgetPlan,
				customPrompt: resolvedPrompt.prompt,
				extractFingerprint,
				groupingFingerprint,
				planFingerprint,
				persistedMetadata,
			})) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "writing",
					currentChunkIndex: budgetPlan.selectedTopics.length,
					totalChunks: Math.max(budgetPlan.selectedTopics.length, 1),
					fileProgress: 1,
					detail: "No content or generation changes were detected. Reusing the existing knowledge annotations and flashcards.",
				});
				if (mode !== "folder-file") {
					await this.plugin.sidebar.refreshFromVault(file);
				}
				new Notice(`No content or generation changes were detected in ${file.basename}. Existing flashcards were kept.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("up-to-date", {
					budgetPlan,
					fingerprints: {
						extract: extractFingerprint,
						group: groupingFingerprint,
						plan: planFingerprint,
					},
				});
				return result;
			}

			if (budgetPlan.selectedTopics.length === 0 || budgetPlan.totalPlannedCards === 0) {
				const documentMetadata = this.buildDocumentMetadataRequest({
					mode,
					generatedAt,
					resolvedPrompt,
					extractFingerprint,
					groupFingerprint: groupingFingerprint,
					planFingerprint,
					documentFingerprint,
					configFingerprint,
					knowledgeChunkCount: knowledgeAnalyses.length,
					topics,
					budgetPlan,
					remainingLlmCalls,
					cardGenerationFingerprints: [],
				});
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode, documentMetadata, debugRun);
				new Notice(`Chunk analysis was updated in ${file.basename}, but no topics justified card generation.`);
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
				topics,
				budgetPlan,
				resolvedPrompt.prompt,
				debugRun,
				mode,
				progressContext,
			);

			if (composedGroups.length === 0) {
				const documentMetadata = this.buildDocumentMetadataRequest({
					mode,
					generatedAt,
					resolvedPrompt,
					extractFingerprint,
					groupFingerprint: groupingFingerprint,
					planFingerprint,
					documentFingerprint,
					configFingerprint,
					knowledgeChunkCount: knowledgeAnalyses.length,
					topics,
					budgetPlan,
					remainingLlmCalls,
					cardGenerationFingerprints: [],
				});
				await this.writeArtifacts(file, chunks, chunkAnalyses, [], mode, documentMetadata, debugRun);
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
				detail: "Writing knowledge annotations and the final flashcards.",
			});
			const documentMetadata = this.buildDocumentMetadataRequest({
				mode,
				generatedAt,
				resolvedPrompt,
				extractFingerprint,
				groupFingerprint: groupingFingerprint,
				planFingerprint,
				documentFingerprint,
				configFingerprint,
				knowledgeChunkCount: knowledgeAnalyses.length,
				topics,
				budgetPlan,
				remainingLlmCalls,
				cardGenerationFingerprints: this.collectCardGenerationFingerprints(composedGroups),
			});
			const insertedCount = await this.writeArtifacts(file, chunks, chunkAnalyses, composedGroups, mode, documentMetadata, debugRun);
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
		extractFingerprint: string,
		debugRun: DebugRun,
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ChunkAnalysisResult[]> {
		if (chunks.length === 0) {
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "extracting",
				currentChunkIndex: 0,
				totalChunks: 0,
				fileProgress: 0.55,
				detail: "No knowledge chunks were found in this scope.",
			});
			return [];
		}

		const extractor = new KnowledgeExtractor(this.plugin.settings, customPrompt, extractFingerprint, debugRun);
		const maxConcurrency = this.resolveLlmConcurrency(chunks.length);
		const chunkErrors = new Array<string | null>(chunks.length).fill(null);
		let completedChunks = 0;

		this.updateGenerationProgress(file, mode, progressContext, {
			phase: "extracting",
			currentChunkIndex: 0,
			totalChunks: chunks.length,
			fileProgress: 0.12,
			detail: `Analyzing ${chunks.length} chunk${chunks.length === 1 ? "" : "s"} with up to ${maxConcurrency} concurrent request${maxConcurrency === 1 ? "" : "s"}.`,
		});

		const analysisResults = await mapWithConcurrency(chunks, maxConcurrency, async (chunk, index) => {
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
					totalChunks: chunks.length,
					fileProgress: this.getPhaseProgressFromCompletionCount(0.12, 0.54, chunks.length, completedChunks),
					detail: this.describeCompletedChunkProgress(chunk, completedChunks, chunks.length),
				});
			}
		});

		const results = analysisResults.filter((result): result is ChunkAnalysisResult => result !== null);
		const failedChunks = chunkErrors.filter((error): error is string => error !== null);

		if (failedChunks.length > 0 && results.length === 0) {
			throw new Error(failedChunks.join(" "));
		}

		if (failedChunks.length > 0) {
			new Notice(`Some chunks failed during analysis and were skipped. ${failedChunks.length} chunk error(s).`, 8000);
		}

		return results;
	}

	private async composeCardGroups(
		file: TFile,
		chunks: ContentChunk[],
		chunkAnalyses: KnowledgeChunkAnalysis[],
		topics: KnowledgeTopic[],
		budgetPlan: BudgetPlan,
		customPrompt: string,
		debugRun: DebugRun,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ApprovedCardGroup[]> {
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
				const topicChunks = topic
					? topic.memberChunkIds
						.map((chunkId) => chunksByChunkId.get(chunkId))
						.filter((chunk): chunk is ContentChunk => chunk !== undefined)
					: [];
				const topicChunkAnalyses = topic
					? topic.memberChunkIds
						.map((chunkId) => analysesByChunkId.get(chunkId))
						.filter((analysis): analysis is KnowledgeChunkAnalysis => analysis !== undefined)
					: [];

				try {
					if (!topic || topicChunks.length === 0 || topicChunkAnalyses.length === 0) {
						return null;
					}

					const composition = await composer.compose({
						topic,
						chunks: topicChunks,
						chunkAnalyses: topicChunkAnalyses,
						cardCount: allocation.cardCount,
					} satisfies CompositionRequest, index);

					return {
						composition,
						topicChunks,
						topicChunkAnalyses,
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

			this.appendComposedCards(
				result.composition,
				result.topicChunks,
				result.topicChunkAnalyses,
				groupedCards,
				seenCards,
			);
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
		documentMetadata: DocumentMetadataWriteRequest | null,
		debugRun: DebugRun,
	): Promise<number> {
		const insertedCount = await writeApprovedCardGroups(this.plugin.app.vault, file, groups, {
			chunks,
			chunkAnalyses,
			obarCompatibility: this.plugin.settings.compatibility.obar,
			regeneration: this.resolveRegenerationOptions(mode, chunks),
		});
		try {
			if (documentMetadata) {
				const didPersistDocumentMetadata = await writeDocumentMetadata(this.plugin.app, file, {
					...documentMetadata,
					insertedCardCount: insertedCount,
				});
				if (didPersistDocumentMetadata) {
					debugRun.log("metadata:frontmatter", "Persisted document-level generation metadata to note frontmatter.", {
						knowledgeChunkCount: documentMetadata.knowledgeChunkCount,
						topicCount: documentMetadata.topics.length,
						plannedCardCount: documentMetadata.budgetPlan?.totalPlannedCards ?? 0,
					});
				}
			}
		} catch (error) {
			debugRun.log("metadata:frontmatter:error", "Failed to persist document-level metadata to note frontmatter.", {
				error: this.getErrorMessage(error),
			});
			new Notice(`The note was updated in ${file.basename}, but generation metadata could not be saved.`);
		}
		if (mode !== "folder-file") {
			await this.plugin.sidebar.refreshFromVault(file);
		}
		return insertedCount;
	}

	private resolveReusableTopics(
		persistedMetadata: PersistedDocumentMetadata,
		extractFingerprint: string,
		groupingFingerprint: string,
		debugRun: DebugRun,
	): KnowledgeTopic[] | null {
		const persistedTopics = persistedMetadata.topics;
		const generationMeta = persistedMetadata.generationMeta;
		if (!persistedTopics || !generationMeta) {
			return null;
		}

		if (
			persistedTopics.groupFingerprint !== groupingFingerprint
			|| generationMeta.fingerprints.extract !== extractFingerprint
			|| generationMeta.fingerprints.group !== groupingFingerprint
		) {
			return null;
		}

		const topics = persistedTopics.topics.map((topic) => ({
			...topic,
			memberChunkIds: [...topic.memberChunkIds],
		}));
		if (topics.length === 0) {
			return null;
		}

		debugRun.log("topics:cache", "Reused persisted chunk-group topics from note frontmatter.", {
			topicCount: topics.length,
			topics,
		});
		return topics;
	}

	private resolveReusableBudgetPlan(
		persistedMetadata: PersistedDocumentMetadata,
		groupingFingerprint: string,
		topics: KnowledgeTopic[],
		debugRun: DebugRun,
	): BudgetPlan | null {
		const topicPlan = persistedMetadata.topicPlan;
		const budgetPlan = topicPlan?.budgetPlan;
		if (!topicPlan || !budgetPlan) {
			return null;
		}

		if (topicPlan.groupFingerprint !== groupingFingerprint) {
			return null;
		}

		if (
			budgetPlan.maxTotalCards !== this.plugin.settings.generation.maxTotalCardsPerDocument
			|| budgetPlan.coreCardBudget !== this.plugin.settings.generation.coreCardBudget
			|| budgetPlan.secondaryCardBudget !== this.plugin.settings.generation.secondaryCardBudget
			|| budgetPlan.maxCardsPerTopic !== this.plugin.settings.generation.maxCardsPerTopic
		) {
			return null;
		}

		const knownTopicIds = new Set(topics.map((topic) => topic.topicId));
		if (budgetPlan.selectedTopics.some((topic) => !knownTopicIds.has(topic.topicId))) {
			return null;
		}

		const clonedBudgetPlan: BudgetPlan = {
			maxTotalCards: budgetPlan.maxTotalCards,
			coreCardBudget: budgetPlan.coreCardBudget,
			secondaryCardBudget: budgetPlan.secondaryCardBudget,
			maxCardsPerTopic: budgetPlan.maxCardsPerTopic,
			totalPlannedCards: budgetPlan.totalPlannedCards,
			selectedTopics: budgetPlan.selectedTopics.map((topic) => ({
				topicId: topic.topicId,
				tier: topic.tier,
				cardCount: topic.cardCount,
			})),
		};

		debugRun.log("budget:cache", "Reused persisted topic budget plan from note frontmatter.", clonedBudgetPlan);
		return clonedBudgetPlan;
	}

	private canReuseExistingGenerationBeforeAnalysis(options: {
		file: TFile;
		content: string;
		mode: GenerationMode;
		chunks: ContentChunk[];
		extractFingerprint: string;
		documentFingerprint: string;
		configFingerprint: string;
		persistedMetadata: PersistedDocumentMetadata;
	}): boolean {
		const generationMeta = options.persistedMetadata.generationMeta;
		if (!generationMeta) {
			return false;
		}

		if (
			generationMeta.fingerprints.extract !== options.extractFingerprint
			|| generationMeta.documentFingerprint !== options.documentFingerprint
			|| generationMeta.configFingerprint !== options.configFingerprint
		) {
			return false;
		}

		if (options.chunks.some((chunk) => !hasReusableChunkAnalysis(chunk, options.extractFingerprint))) {
			return false;
		}

		const existingCards = this.collectScopedPluginGeneratedCards(
			options.file,
			options.content,
			options.mode,
			options.chunks,
		);
		if (generationMeta.insertedCardCount === 0) {
			return existingCards.length === 0;
		}

		if (existingCards.length === 0) {
			return false;
		}

		const expectedFingerprints = new Set(generationMeta.cardGenerationFingerprints);
		if (expectedFingerprints.size === 0) {
			return false;
		}

		const hasUnexpectedCards = existingCards.some((card) => (
			!card.generationFingerprint || !expectedFingerprints.has(card.generationFingerprint)
		));
		if (hasUnexpectedCards) {
			return false;
		}

		return generationMeta.insertedCardCount === null
			? true
			: existingCards.length === generationMeta.insertedCardCount;
	}

	private async isGenerationUpToDate(options: {
		mode: GenerationMode;
		file: TFile;
		content: string;
		chunks: ContentChunk[];
		chunkAnalyses: KnowledgeChunkAnalysis[];
		topics: KnowledgeTopic[];
		budgetPlan: BudgetPlan;
		customPrompt: string;
		extractFingerprint: string;
		groupingFingerprint: string;
		planFingerprint: string;
		persistedMetadata: PersistedDocumentMetadata;
	}): Promise<boolean> {
		const generationMeta = options.persistedMetadata.generationMeta;
		if (!generationMeta) {
			return false;
		}

		if (
			generationMeta.fingerprints.extract !== options.extractFingerprint
			|| generationMeta.fingerprints.group !== options.groupingFingerprint
			|| generationMeta.fingerprints.plan !== options.planFingerprint
		) {
			return false;
		}

		const existingCards = this.collectScopedPluginGeneratedCards(
			options.file,
			options.content,
			options.mode,
			options.chunks,
		);
		if (options.budgetPlan.totalPlannedCards === 0) {
			return existingCards.length === 0;
		}

		if (existingCards.length === 0) {
			return false;
		}

		const expectedFingerprints = this.buildExpectedCardGenerationFingerprints(
			options.topics,
			options.budgetPlan,
			options.chunks,
			options.chunkAnalyses,
			options.customPrompt,
		);
		if (expectedFingerprints.size === 0) {
			return false;
		}

		const hasUnexpectedCards = existingCards.some((card) => (
			!card.generationFingerprint || !expectedFingerprints.has(card.generationFingerprint)
		));
		if (hasUnexpectedCards) {
			return false;
		}

		if (generationMeta.insertedCardCount !== null) {
			return existingCards.length === generationMeta.insertedCardCount;
		}

		return Array.from(expectedFingerprints).every((fingerprint) => (
			existingCards.some((card) => card.generationFingerprint === fingerprint)
		));
	}

	private collectScopedPluginGeneratedCards(
		file: TFile,
		content: string,
		mode: GenerationMode,
		chunks: ContentChunk[],
	) {
		const regeneration = this.resolveRegenerationOptions(mode, chunks);
		const pluginGeneratedEntries = collectExistingCardEntries(file, content)
			.filter((entry) => entry.isPluginGenerated);
		if (regeneration.mode === "all-plugin-generated") {
			return pluginGeneratedEntries;
		}

		if (regeneration.mode === "none" || chunks.length === 0) {
			return [];
		}

		const sortedChunks = [...chunks].sort((left, right) => left.range.from - right.range.from || left.range.to - right.range.to);
		const selectedEntries = new Set<string>();

		for (const [index, chunk] of sortedChunks.entries()) {
			let cursor = Math.max(
				chunk.range.to,
				...((chunk.existingAnnotations ?? []).map((annotation) => annotation.blockRange.to)),
			);
			const nextChunkStart = this.resolveNextChunkStart(sortedChunks, index);

			for (const entry of pluginGeneratedEntries) {
				if (entry.blockRange.from < cursor || entry.blockRange.from >= nextChunkStart) {
					continue;
				}

				const between = content.slice(cursor, entry.blockRange.from);
				if (/\S/.test(between)) {
					break;
				}

				selectedEntries.add(entry.id);
				cursor = entry.blockRange.to;
			}
		}

		return pluginGeneratedEntries.filter((entry) => selectedEntries.has(entry.id));
	}

	private buildExpectedCardGenerationFingerprints(
		topics: KnowledgeTopic[],
		budgetPlan: BudgetPlan,
		chunks: ContentChunk[],
		chunkAnalyses: KnowledgeChunkAnalysis[],
		customPrompt: string,
	): Set<string> {
		const topicsById = new Map(topics.map((topic) => [topic.topicId, topic] as const));
		const chunksByChunkId = new Map(chunks.map((chunk) => [chunk.chunkId, chunk] as const));
		const analysesByChunkId = new Map(chunkAnalyses.map((analysis) => [analysis.chunkId, analysis] as const));
		const fingerprints = new Set<string>();

		for (const allocation of budgetPlan.selectedTopics) {
			const topic = topicsById.get(allocation.topicId);
			if (!topic) {
				continue;
			}

			const topicChunks = topic.memberChunkIds
				.map((chunkId) => chunksByChunkId.get(chunkId))
				.filter((chunk): chunk is ContentChunk => chunk !== undefined);
			const topicChunkAnalyses = topic.memberChunkIds
				.map((chunkId) => analysesByChunkId.get(chunkId))
				.filter((analysis): analysis is KnowledgeChunkAnalysis => analysis !== undefined);
			if (topicChunks.length === 0 || topicChunkAnalyses.length === 0) {
				continue;
			}

			const systemPrompt = buildCardCompositionPrompt({
				cardCount: allocation.cardCount,
			}, this.plugin.settings.prompts.cardCompositionPrompt, customPrompt);
			fingerprints.add(buildCardCompositionFingerprint(
				this.plugin.settings.generation.model,
				this.plugin.settings.generation.temperature,
				systemPrompt,
				{
					topic,
					chunks: topicChunks,
					chunkAnalyses: topicChunkAnalyses,
					cardCount: allocation.cardCount,
				} satisfies CompositionRequest,
			));
		}

		return fingerprints;
	}

	private collectCardGenerationFingerprints(groups: ApprovedCardGroup[]): string[] {
		const fingerprints = new Set<string>();

		for (const group of groups) {
			for (const card of group.cards) {
				if (card.generationFingerprint?.trim()) {
					fingerprints.add(card.generationFingerprint.trim());
				}
			}
		}

		return Array.from(fingerprints);
	}

	private resolveNextChunkStart(chunks: ContentChunk[], index: number): number {
		const nextChunk = chunks[index + 1];
		if (!nextChunk) {
			return Number.POSITIVE_INFINITY;
		}

		return Math.min(
			nextChunk.range.from,
			...((nextChunk.existingAnnotations ?? []).map((annotation) => annotation.blockRange.from)),
		);
	}

	private appendComposedCards(
		composition: TopicCompositionResult,
		topicChunks: ContentChunk[],
		topicChunkAnalyses: KnowledgeChunkAnalysis[],
		groupedCards: Map<string, ApprovedCardGroup>,
		seenCards: Set<string>,
	): void {
		if (composition.cards.length === 0) {
			return;
		}

		const anchorChunk = this.resolveAnchorChunk(topicChunks);
		const anchorAnalysis = topicChunkAnalyses.find((analysis) => analysis.chunkId === anchorChunk?.chunkId);
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

	private resolveAnchorChunk(topicChunks: ContentChunk[]): ContentChunk | null {
		return [...topicChunks]
			.sort((left, right) => (
				right.range.to - left.range.to
				|| right.text.length - left.text.length
			))[0] ?? null;
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
				topicId: card.topicId,
				sourceChunkIds: card.sourceChunkIds ? [...card.sourceChunkIds] : undefined,
				generationFingerprint: card.generationFingerprint,
			};
		}

		return {
			front: card.front,
			back: card.back,
			tags: this.appendConfiguredTag(card.tags),
			topicId: card.topicId,
			sourceChunkIds: card.sourceChunkIds ? [...card.sourceChunkIds] : undefined,
			generationFingerprint: card.generationFingerprint,
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

	private assertScopeWithinTaskLimits(chunks: ContentChunk[], extractFingerprint: string): void {
		const characterCount = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
		const estimatedInputTokens = Math.ceil(characterCount / 4);
		const estimatedLlmCalls = this.countPendingChunkExtractions(chunks, extractFingerprint)
			+ 1
			+ Math.min(this.plugin.settings.generation.maxTotalCardsPerDocument, chunks.length);

		if (estimatedInputTokens > this.plugin.settings.generation.maxTaskInputTokens) {
			throw new Error("当前范围的内容过大，超过了单次任务的 Token 上限。请缩小范围后再试。");
		}

		if (chunks.length > this.plugin.settings.generation.maxTaskChunks) {
			throw new Error("当前范围的分块数量过多，超过了单次任务的分块上限。请缩小范围后再试。");
		}

		if (estimatedLlmCalls > this.plugin.settings.generation.maxTaskLlmCalls) {
			throw new Error("当前范围预计需要的模型调用次数过多，超过了单次任务上限。请缩小范围后再试。");
		}
	}

	private countPendingChunkExtractions(chunks: ContentChunk[], extractFingerprint: string): number {
		return chunks.filter((chunk) => !hasReusableChunkAnalysis(chunk, extractFingerprint)).length;
	}

	private buildDocumentMetadataRequest(options: {
		mode: GenerationMode;
		generatedAt: string;
		resolvedPrompt: ResolvedGenerationPrompt;
		extractFingerprint: string;
		groupFingerprint: string;
		planFingerprint: string;
		documentFingerprint: string;
		configFingerprint: string;
		knowledgeChunkCount: number;
		topics: KnowledgeTopic[];
		budgetPlan: BudgetPlan | null;
		remainingLlmCalls: number | null;
		cardGenerationFingerprints: string[];
	}): DocumentMetadataWriteRequest {
		const activeProvider = getActiveProvider(this.plugin.settings);
		return {
			mode: options.mode,
			generatedAt: options.generatedAt,
			providerPresetType: activeProvider.presetType,
			model: this.plugin.settings.generation.model,
			temperature: this.plugin.settings.generation.temperature,
			resolvedPrompt: {
				source: options.resolvedPrompt.source,
				noteFolder: options.resolvedPrompt.noteFolder,
				templatePath: options.resolvedPrompt.templatePath,
			},
			extractFingerprint: options.extractFingerprint,
			groupFingerprint: options.groupFingerprint,
			planFingerprint: options.planFingerprint,
			documentFingerprint: options.documentFingerprint,
			configFingerprint: options.configFingerprint,
			knowledgeChunkCount: options.knowledgeChunkCount,
			topics: options.topics,
			budgetPlan: options.budgetPlan,
			remainingLlmCalls: options.remainingLlmCalls,
			cardGenerationFingerprints: options.cardGenerationFingerprints,
		};
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

	private describeCompletedChunkProgress(chunk: ContentChunk, completedChunks: number, totalChunks: number): string {
		const title = chunk.titleHint?.trim() ?? "";
		if (title.length > 0) {
			return `Completed analysis for ${completedChunks}/${totalChunks} chunk${totalChunks === 1 ? "" : "s"}. Latest: ${title}`;
		}

		return `Completed analysis for ${completedChunks}/${totalChunks} chunk${totalChunks === 1 ? "" : "s"}.`;
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
}
