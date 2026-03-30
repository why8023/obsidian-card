import { MarkdownView, Notice, TFile } from "obsidian";

import type { Editor, MarkdownFileInfo } from "obsidian";

import type ObcdPlugin from "../main";
import { AiCardGenerator } from "../generation/cardGenerator";
import { buildReviewGroups } from "../generation/cardValidator";
import { buildFileChunks, buildSelectionChunks } from "../generation/contentChunkBuilder";
import { listMarkdownFiles, resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";
import { resolveGenerationPrompt } from "../prompts/promptResolver";
import { PROVIDER_PRESET_INFO, getActiveProvider } from "../providerConfig";
import { DEFAULT_GENERATED_CARD_TAG } from "../settings";
import type {
	ApprovedCardGroup,
	ChunkGenerationResult,
	ContentChunk,
	GeneratedBasicCard,
	GenerationMode,
	GenerationProgressPhase,
	GenerationProgressState,
	ReviewAction,
	ReviewGroup,
	ReviewResult,
} from "../types";
import { writeApprovedCardGroups } from "../writing/flashcardWriter";

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

			const chunks = buildSelectionChunks(target.file, editor.getSelection(), target.selectedRange);
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Analyzing selected content.");
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
			const chunks = buildFileChunks(target.file, content);
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Analyzing the current note.");
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

			const chunks = buildFileChunks(target.file, editor.getValue(), {
				upToOffset: target.cursorOffset,
			});
			const progressContext = {
				currentFileIndex: 1,
				totalFiles: 1,
			} satisfies GenerationProgressContext;
			await this.beginGenerationProgress(target.file, target.mode, progressContext, chunks.length, "Analyzing note content up to the cursor.");
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
			this.assertAiConfigured();

			if (chunks.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "generating",
					currentChunkIndex: 0,
					totalChunks: 0,
					fileProgress: 1,
					detail: "No eligible content was found in this file.",
				});
				const message = mode === "selection"
					? `No usable content found in ${file.basename}.`
					: `No uncovered content found in ${file.basename}.`;
				new Notice(message);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-usable-content", result);
				return result;
			}

			const resolvedPrompt = await resolveGenerationPrompt(this.plugin.app, this.plugin.settings.prompts, file);
			const chunkResults = await this.generateChunkResults(chunks, resolvedPrompt.prompt, debugRun, file, mode, progressContext);
			const reviewGroups = this.applyGenerationDefaultsToReviewGroups(buildReviewGroups(chunkResults));
			debugRun.recordCandidates(reviewGroups.flatMap((group) => group.candidates));

			if (reviewGroups.length === 0) {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "reviewing",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "The generated output did not contain any valid cards.",
				});
				new Notice(`No valid flashcard candidates were generated for ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-candidates", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "reviewing",
				currentChunkIndex: chunks.length,
				totalChunks: chunks.length,
				fileProgress: 0.82,
				detail: "Preparing generated cards for insertion.",
			});
			const reviewResult: ReviewResult = {
				action: "confirm",
				approvedGroups: reviewGroups.map((group) => ({
					chunk: group.chunk,
					cards: group.candidates
						.filter((candidate) => candidate.approved)
						.map((candidate) => ({
							front: candidate.card.front,
							back: candidate.card.back,
							tags: [...candidate.card.tags],
						})),
				})),
			};
			debugRun.recordReview(reviewResult);

			const groupsToWrite = this.buildGroupsToWrite(chunkResults, reviewResult, mode);
			const approvedCardCount = groupsToWrite.reduce((sum, group) => sum + group.cards.length, 0);

			if (approvedCardCount === 0 && mode === "selection") {
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "reviewing",
					currentChunkIndex: chunks.length,
					totalChunks: chunks.length,
					fileProgress: 1,
					detail: "No valid cards remained after final validation.",
				});
				new Notice(`No flashcards were inserted for ${file.basename}.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-approved-cards", result);
				return result;
			}

			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "writing",
				currentChunkIndex: chunks.length,
				totalChunks: chunks.length,
				fileProgress: 0.94,
				detail: "Writing generated cards into the note.",
			});
			const insertedCount = await writeApprovedCardGroups(this.plugin.app.vault, file, groupsToWrite, {
				obarCompatibility: this.plugin.settings.compatibility.obar,
			});
			if (!isBatchMode) {
				await this.plugin.sidebar.refreshFromVault(file);
			}
			new Notice(`Inserted ${insertedCount} flashcard${insertedCount === 1 ? "" : "s"} into ${file.basename}.`);
			debugRun.recordWrite({
				insertedCount,
				approvedCount: approvedCardCount,
			});

			const result = {
				action: "confirm",
				insertedCount,
			} satisfies FileProcessResult;
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "writing",
				currentChunkIndex: chunks.length,
				totalChunks: chunks.length,
				fileProgress: 1,
				detail: `Finished writing ${insertedCount} flashcard${insertedCount === 1 ? "" : "s"}.`,
			});
			await debugRun.finish("inserted", result);
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

	private async generateChunkResults(
		chunks: ContentChunk[],
		generationPrompt: string,
		debugRun: ReturnType<ObcdPlugin["debug"]["createRun"]>,
		file: TFile,
		mode: GenerationMode,
		progressContext: GenerationProgressContext,
	): Promise<ChunkGenerationResult[]> {
		const generator = new AiCardGenerator(this.plugin.settings, generationPrompt, debugRun);
		const results: ChunkGenerationResult[] = [];
		const chunkErrors: string[] = [];

		for (const [index, chunk] of chunks.entries()) {
			const chunkNumber = index + 1;
			this.updateGenerationProgress(file, mode, progressContext, {
				phase: "generating",
				currentChunkIndex: chunkNumber,
				totalChunks: chunks.length,
				fileProgress: this.getChunkFileProgress(chunks.length, index),
				detail: this.describeChunkProgress(chunk, chunkNumber, chunks.length),
			});
			try {
				const cards = await generator.generate(chunk, index);
				results.push({
					chunk,
					cards,
				});
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "generating",
					currentChunkIndex: chunkNumber,
					totalChunks: chunks.length,
					fileProgress: this.getChunkFileProgress(chunks.length, chunkNumber),
					detail: `Completed chunk ${chunkNumber}/${chunks.length}.`,
				});
			} catch (error) {
				debugRun.recordChunkError(index, error, {
					filePath: chunk.filePath,
					titleHint: chunk.titleHint ?? "",
				});
				chunkErrors.push(`chunk ${index + 1}: ${this.getErrorMessage(error)}`);
				this.updateGenerationProgress(file, mode, progressContext, {
					phase: "generating",
					currentChunkIndex: chunkNumber,
					totalChunks: chunks.length,
					fileProgress: this.getChunkFileProgress(chunks.length, chunkNumber),
					detail: `Chunk ${chunkNumber}/${chunks.length} failed and was skipped.`,
				});
			}
		}

		if (chunkErrors.length > 0 && results.length === 0) {
			throw new Error(chunkErrors.join(" "));
		}

		if (chunkErrors.length > 0) {
			debugRun.log("chunk-summary", "Some chunks failed and were skipped.", {
				errorCount: chunkErrors.length,
				successCount: results.length,
			});
			new Notice(`Some chunks failed to generate and were skipped. ${chunkErrors.length} chunk error(s).`, 8000);
		}

		return results;
	}

	private buildGroupsToWrite(chunkResults: ChunkGenerationResult[], reviewResult: ReviewResult, mode: GenerationMode): ApprovedCardGroup[] {
		if (mode === "selection") {
			return reviewResult.approvedGroups.filter((group) => group.cards.length > 0);
		}

		const approvedGroupsBySection = new Map(
			reviewResult.approvedGroups.map((group) => [group.chunk.sectionKey, group.cards] as const),
		);

		return chunkResults.map((result) => ({
			chunk: result.chunk,
			cards: [...(approvedGroupsBySection.get(result.chunk.sectionKey) ?? [])],
		}));
	}

	private applyGenerationDefaultsToReviewGroups(reviewGroups: ReviewGroup[]): ReviewGroup[] {
		if (!this.plugin.settings.generation.addObcdTag) {
			return reviewGroups;
		}

		return reviewGroups.map((group) => ({
			...group,
			candidates: group.candidates.map((candidate) => ({
				...candidate,
				card: this.applyGenerationDefaultsToCard(candidate.card),
			})),
		}));
	}

	private applyGenerationDefaultsToCard(card: GeneratedBasicCard): GeneratedBasicCard {
		return {
			...card,
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

	private getChunkFileProgress(totalChunks: number, completedChunks: number): number {
		if (totalChunks <= 0) {
			return 0.1;
		}

		return 0.1 + ((completedChunks / totalChunks) * 0.62);
	}

	private describeChunkProgress(chunk: ContentChunk, chunkNumber: number, totalChunks: number): string {
		const title = chunk.titleHint?.trim() ?? "";
		if (title.length > 0) {
			return `Generating chunk ${chunkNumber}/${totalChunks}: ${title}`;
		}

		return `Generating chunk ${chunkNumber}/${totalChunks}.`;
	}
}
