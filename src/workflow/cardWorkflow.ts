import { MarkdownView, Notice, TFile } from "obsidian";

import type { Editor, MarkdownFileInfo } from "obsidian";

import type { DebugRun } from "../debug/debugService";
import type ObcdPlugin from "../main";
import { buildSelectionChunks, buildFileChunks } from "../generation/contentChunkBuilder";
import { listMarkdownFiles, resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";
import { allocateCardBudget } from "../knowledge/budgetAllocator";
import { GlobalRanker } from "../knowledge/globalRanker";
import { KnowledgeExtractor } from "../knowledge/knowledgeExtractor";
import { buildChapterPlan } from "../planning/chapterPlanner";
import { estimateScope } from "../planning/scopeEstimator";
import { resolveGenerationPrompt } from "../prompts/promptResolver";
import { PROVIDER_PRESET_INFO, getActiveProvider } from "../providerConfig";
import { DEFAULT_GENERATED_CARD_TAG } from "../settings";
import type {
	ApprovedCardGroup,
	BudgetPlan,
	CompositionRequest,
	ContentChunk,
	GeneratedBasicCard,
	GenerationMode,
	GenerationProgressPhase,
	GenerationProgressState,
	KnowledgeTopic,
	KnowledgeUnit,
	PlanningResult,
	ReviewAction,
	TextRange,
	TopicCompositionResult,
} from "../types";
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
			const chunks = buildFileChunks(target.file, content);
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
					const chunks = buildFileChunks(file, content);
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
			debugRun.log("estimate", "Calculated scope estimate.", scopeEstimate);
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "estimating",
				currentChunkIndex: 0,
				totalChunks: chunks.length,
				fileProgress: 0.12,
				detail: scopeEstimate.reason,
			});

			if (scopeEstimate.recommendedStrategy === "chapter-planning") {
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

			if (scopeEstimate.recommendedStrategy === "refuse-or-scope") {
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

			const knowledgeUnits = await this.extractKnowledgeUnits(chunks, resolvedPrompt.prompt, debugRun, file, mode, progressContext);
			if (knowledgeUnits.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "extracting",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "The scope did not yield durable knowledge units worth turning into cards.",
				});
				new Notice(`No useful knowledge units were found in ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-knowledge-units", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "ranking",
				currentChunkIndex: 0,
				totalChunks: knowledgeUnits.length,
				fileProgress: 0.62,
				detail: `Ranking ${knowledgeUnits.length} knowledge unit${knowledgeUnits.length === 1 ? "" : "s"} across the document.`,
			});
			const topics = await new GlobalRanker(this.plugin.settings, resolvedPrompt.prompt, debugRun).rank(knowledgeUnits);
			debugRun.log("topics", "Built document-level topics.", {
				topicCount: topics.length,
				topics,
			});

			if (topics.length === 0) {
				new Notice(`No document-level topics survived ranking for ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-topics", result);
				return result;
			}

			const remainingLlmCalls = this.plugin.settings.generation.maxTaskLlmCalls - chunks.length - 1;
			const budgetPlan = allocateCardBudget(topics, this.plugin.settings.generation, remainingLlmCalls);
			debugRun.log("budget", "Allocated document card budget.", budgetPlan);

			if (budgetPlan.selectedTopics.length === 0 || budgetPlan.totalPlannedCards === 0) {
				new Notice(`The ranked topics in ${file.basename} did not justify any card budget.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-budgeted-topics", result);
				return result;
			}

			const composedGroups = await this.composeCardGroups(
				file,
				chunks,
				knowledgeUnits,
				topics,
				budgetPlan,
				resolvedPrompt.prompt,
				debugRun,
				mode,
				progressContext,
			);

			if (composedGroups.length === 0) {
				new Notice(`No valid cards were composed for ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
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
			const insertedCount = await writeApprovedCardGroups(this.plugin.app.vault, file, composedGroups, {
				obarCompatibility: this.plugin.settings.compatibility.obar,
				regeneration: this.resolveRegenerationOptions(mode, chunks),
			});
			if (!isBatchMode) {
				await this.plugin.sidebar.refreshFromVault(file);
			}
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

	private async extractKnowledgeUnits(
		chunks: ContentChunk[],
		customPrompt: string,
		debugRun: DebugRun,
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<KnowledgeUnit[]> {
		const extractor = new KnowledgeExtractor(this.plugin.settings, customPrompt, debugRun);
		const units: KnowledgeUnit[] = [];
		const chunkErrors: string[] = [];

		for (const [index, chunk] of chunks.entries()) {
			const chunkNumber = index + 1;
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "extracting",
				currentChunkIndex: chunkNumber,
				totalChunks: chunks.length,
				fileProgress: this.getPhaseFileProgress(0.16, 0.54, chunks.length, index),
				detail: this.describeChunkProgress(chunk, chunkNumber, chunks.length),
			});

			try {
				units.push(...await extractor.extract(chunk, index));
			} catch (error) {
				chunkErrors.push(`chunk ${chunkNumber}: ${this.getErrorMessage(error)}`);
				debugRun.recordChunkError(index, error, {
					filePath: chunk.filePath,
					titleHint: chunk.titleHint ?? "",
				});
			}
		}

		if (chunkErrors.length > 0 && units.length === 0) {
			throw new Error(chunkErrors.join(" "));
		}

		if (chunkErrors.length > 0) {
			new Notice(`Some chunks failed during knowledge extraction and were skipped. ${chunkErrors.length} chunk error(s).`, 8000);
		}

		return units;
	}

	private async composeCardGroups(
		file: TFile,
		chunks: ContentChunk[],
		knowledgeUnits: KnowledgeUnit[],
		topics: KnowledgeTopic[],
		budgetPlan: BudgetPlan,
		customPrompt: string,
		debugRun: DebugRun,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ApprovedCardGroup[]> {
		const unitsById = new Map(knowledgeUnits.map((unit) => [unit.id, unit] as const));
		const topicsById = new Map(topics.map((topic) => [topic.topicId, topic] as const));
		const chunksBySectionKey = new Map(chunks.map((chunk) => [chunk.sectionKey, chunk] as const));
		const composer = new CardComposer(this.plugin.settings, customPrompt, debugRun);
		const groupedCards = new Map<string, ApprovedCardGroup>();
		const seenCards = new Set<string>();

		for (const [index, allocation] of budgetPlan.selectedTopics.entries()) {
			const topic = topicsById.get(allocation.topicId);
			if (!topic) {
				continue;
			}

			const topicUnits = topic.memberUnitIds
				.map((unitId) => unitsById.get(unitId))
				.filter((unit): unit is KnowledgeUnit => unit !== undefined);
			if (topicUnits.length === 0) {
				continue;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "composing",
				currentChunkIndex: index + 1,
				totalChunks: budgetPlan.selectedTopics.length,
				fileProgress: this.getPhaseFileProgress(0.7, 0.9, budgetPlan.selectedTopics.length, index),
				detail: `Composing cards for topic ${index + 1}/${budgetPlan.selectedTopics.length}: ${topic.canonicalStatement}`,
			});

			try {
				const composition = await composer.compose({
					topic,
					units: topicUnits,
					cardCount: allocation.cardCount,
					strategy: "direct-global",
				} satisfies CompositionRequest, index);
				this.appendComposedCards(composition, topicUnits, chunksBySectionKey, groupedCards, seenCards);
			} catch (error) {
				debugRun.log("compose:error", "Skipping a topic that failed during composition.", {
					topicId: topic.topicId,
					error: this.getErrorMessage(error),
				});
			}
		}

		return Array.from(groupedCards.values())
			.filter((group) => group.cards.length > 0)
			.sort((left, right) => left.chunk.insertOffset - right.chunk.insertOffset);
	}

	private appendComposedCards(
		composition: TopicCompositionResult,
		topicUnits: KnowledgeUnit[],
		chunksBySectionKey: Map<string, ContentChunk>,
		groupedCards: Map<string, ApprovedCardGroup>,
		seenCards: Set<string>,
	): void {
		if (composition.cards.length === 0) {
			return;
		}

		const anchorChunk = this.resolveAnchorChunk(topicUnits, chunksBySectionKey);
		if (!anchorChunk) {
			return;
		}

		const group = groupedCards.get(anchorChunk.sectionKey) ?? {
			chunk: anchorChunk,
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

		groupedCards.set(anchorChunk.sectionKey, group);
	}

	private resolveAnchorChunk(topicUnits: KnowledgeUnit[], chunksBySectionKey: Map<string, ContentChunk>): ContentChunk | null {
		for (const unit of topicUnits) {
			const chunk = chunksBySectionKey.get(unit.sectionKey);
			if (chunk) {
				return chunk;
			}
		}

		return null;
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
			throw new Error("Configure the provider access key in plugin settings before generating flashcards.");
		}

		if (this.plugin.settings.generation.model.trim().length === 0) {
			throw new Error("Configure the AI model in plugin settings before generating flashcards.");
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

	private describeChunkProgress(chunk: ContentChunk, chunkNumber: number, totalChunks: number): string {
		const title = chunk.titleHint?.trim() ?? "";
		if (title.length > 0) {
			return `Extracting knowledge from chunk ${chunkNumber}/${totalChunks}: ${title}`;
		}

		return `Extracting knowledge from chunk ${chunkNumber}/${totalChunks}.`;
	}

	private describePlanningResult(plan: PlanningResult): string {
		const recommendedSections = plan.sections
			.filter((section) => section.recommended)
			.slice(0, 3)
			.map((section) => section.title);

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
			? ` Recommended sections: ${recommendedSections}.`
			: "";
		new Notice(
			`${file.basename} was downgraded to chapter planning because it is outside the direct-global scope.${recommendationSuffix}`,
			12000,
		);
	}
}
