import { MarkdownView, Notice, TFile } from "obsidian";

import type { Editor, MarkdownFileInfo } from "obsidian";

import type ObsidianCardPlugin from "../main";
import { AiCardGenerator } from "../generation/cardGenerator";
import { buildReviewGroups } from "../generation/cardValidator";
import { buildFileChunks, buildSelectionChunks } from "../generation/contentChunkBuilder";
import { listMarkdownFiles, resolveCurrentFileTarget, resolveCursorTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";
import { PROVIDER_PRESET_INFO, getActiveProvider } from "../providerConfig";
import type { ApprovedCardGroup, ChunkGenerationResult, ContentChunk, GenerationMode, ReviewAction, ReviewResult } from "../types";
import { ReviewModal } from "../ui/reviewModal";
import { writeApprovedCardGroups } from "../writing/flashcardWriter";

interface FileProcessResult {
	action: ReviewAction;
	insertedCount: number;
}

export class FlashcardWorkflow {
	private readonly plugin: ObsidianCardPlugin;

	constructor(plugin: ObsidianCardPlugin) {
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
			await this.processSingleFile(target.file, chunks, false, target.mode);
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
			await this.processSingleFile(target.file, chunks, false, target.mode);
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
			await this.processSingleFile(target.file, chunks, false, target.mode);
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

			for (const file of markdownFiles) {
				try {
					const content = await this.loadFileContent(file);
					const chunks = buildFileChunks(file, content);
					const result = await this.processSingleFile(file, chunks, true, "folder-file");

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
				`${processedFiles} file${processedFiles === 1 ? "" : "s"} reviewed.`,
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
				console.error("Obsidian Card folder generation errors", errors);
			}
		});
	}

	private async processSingleFile(
		file: TFile,
		chunks: ContentChunk[],
		isBatchMode: boolean,
		mode: GenerationMode,
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

			const chunkResults = await this.generateChunkResults(chunks, debugRun);
			const reviewGroups = buildReviewGroups(chunkResults);
			debugRun.recordCandidates(reviewGroups.flatMap((group) => group.candidates));

			if (reviewGroups.length === 0) {
				new Notice(`No valid flashcard candidates were generated for ${file.basename}.`);
				const result = {
					action: isBatchMode ? "skip-file" : "cancel",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-candidates", result);
				return result;
			}

			const reviewResult = await new ReviewModal(this.plugin.app, {
				filePath: file.path,
				groups: reviewGroups,
				isBatchMode,
			}).openAndWait();
			debugRun.recordReview(reviewResult);

			if (reviewResult.action !== "confirm") {
				const result = {
					action: reviewResult.action,
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish(`review-${reviewResult.action}`, result);
				return result;
			}

			const groupsToWrite = this.buildGroupsToWrite(chunkResults, reviewResult, mode);
			const approvedCardCount = groupsToWrite.reduce((sum, group) => sum + group.cards.length, 0);

			if (approvedCardCount === 0 && mode === "selection") {
				new Notice(`No flashcards were kept for ${file.basename}.`);
				const result = {
					action: "confirm",
					insertedCount: 0,
				} satisfies FileProcessResult;
				await debugRun.finish("no-approved-cards", result);
				return result;
			}

			const insertedCount = await writeApprovedCardGroups(this.plugin.app.vault, file, groupsToWrite);
			const updatedSectionCount = groupsToWrite.length;
			const noticeParts = [
				`Updated ${updatedSectionCount} section${updatedSectionCount === 1 ? "" : "s"} in ${file.basename}.`,
				`Inserted ${insertedCount} flashcard${insertedCount === 1 ? "" : "s"}.`,
			];
			new Notice(noticeParts.join(" "));
			debugRun.recordWrite({
				insertedCount,
				approvedCount: approvedCardCount,
			});

			const result = {
				action: "confirm",
				insertedCount,
			} satisfies FileProcessResult;
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

	private async generateChunkResults(chunks: ContentChunk[], debugRun: ReturnType<ObsidianCardPlugin["debug"]["createRun"]>): Promise<ChunkGenerationResult[]> {
		const generator = new AiCardGenerator(this.plugin.settings, debugRun);
		const results: ChunkGenerationResult[] = [];
		const chunkErrors: string[] = [];

		for (const [index, chunk] of chunks.entries()) {
			try {
				const cards = await generator.generate(chunk, index);
				results.push({
					chunk,
					cards,
				});
			} catch (error) {
				debugRun.recordChunkError(index, error, {
					filePath: chunk.filePath,
					titleHint: chunk.titleHint ?? "",
				});
				chunkErrors.push(`chunk ${index + 1}: ${this.getErrorMessage(error)}`);
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
		try {
			await task();
		} catch (error) {
			const message = this.getErrorMessage(error);
			console.error("Obsidian Card command failed", error);
			new Notice(message, 10000);
		}
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}
}
