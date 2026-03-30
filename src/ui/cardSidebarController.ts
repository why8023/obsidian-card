import { MarkdownView, Notice, TAbstractFile, TFile } from "obsidian";

import type ObcdPlugin from "../main";
import type { ExistingCardEntry, GenerationProgressState } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { deleteExistingCards, restoreDeletedCards } from "../writing/flashcardWriter";

export const OBCD_SIDEBAR_VIEW_TYPE = "obcd-sidebar";

export interface CardSidebarSnapshot {
	activeFile: TFile | null;
	existingCards: ExistingCardEntry[];
	generationProgress: GenerationProgressState | null;
	isMutating: boolean;
	hasUndoableDelete: boolean;
}

interface UndoDeleteOperation {
	filePath: string;
	deletedCount: number;
	beforeContent: string;
	afterContent: string;
}

export class CardSidebarController {
	private readonly plugin: ObcdPlugin;
	private readonly listeners = new Set<() => void>();
	private activeFile: TFile | null;
	private existingCards: ExistingCardEntry[] = [];
	private refreshToken = 0;
	private isMutating = false;
	private generationProgress: GenerationProgressState | null = null;
	private undoDeleteOperation: UndoDeleteOperation | null = null;

	constructor(plugin: ObcdPlugin) {
		this.plugin = plugin;
		this.activeFile = this.resolveActiveMarkdownFile();

		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", (file) => {
			this.activeFile = isMarkdownFile(file) ? file : null;
			void this.refreshDisplayedFileCards();
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (isMarkdownFile(file) && this.activeFile?.path === file.path) {
				void this.refreshDisplayedFileCards(file);
			}
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
			this.handleRename(file, oldPath);
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => {
			this.handleDelete(file);
		}));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	getSnapshot(): CardSidebarSnapshot {
		return {
			activeFile: this.activeFile,
			existingCards: [...this.existingCards],
			generationProgress: this.generationProgress === null ? null : { ...this.generationProgress },
			isMutating: this.isMutating,
			hasUndoableDelete: this.activeFile !== null && this.undoDeleteOperation?.filePath === this.activeFile.path,
		};
	}

	async open(): Promise<void> {
		await this.ensureViewOpen();
		await this.refresh();
	}

	async refresh(): Promise<void> {
		this.activeFile = this.resolveActiveMarkdownFile();
		await this.refreshDisplayedFileCards();
	}

	async startGenerationProgress(progress: GenerationProgressState): Promise<void> {
		const shouldEnsureView = this.generationProgress === null
			|| this.plugin.app.workspace.getLeavesOfType(OBCD_SIDEBAR_VIEW_TYPE).length === 0;
		this.generationProgress = normalizeGenerationProgress(progress);
		if (shouldEnsureView) {
			await this.ensureViewOpen();
		}
		this.notify();
	}

	updateGenerationProgress(progress: GenerationProgressState): void {
		this.generationProgress = normalizeGenerationProgress(progress);
		this.notify();
	}

	clearGenerationProgress(): void {
		if (this.generationProgress === null) {
			return;
		}

		this.generationProgress = null;
		this.notify();
	}

	async revealCard(card: ExistingCardEntry): Promise<void> {
		const leaf = this.plugin.app.workspace.getMostRecentLeaf() ?? this.plugin.app.workspace.getLeaf(false);
		await leaf.openFile(card.file);
		this.plugin.app.workspace.setActiveLeaf(leaf, { focus: true });

		if (!(leaf.view instanceof MarkdownView)) {
			return;
		}

		const from = leaf.view.editor.offsetToPos(card.range.from);
		const to = leaf.view.editor.offsetToPos(card.range.to);
		leaf.view.editor.setSelection(from, to);
		leaf.view.editor.scrollIntoView({ from, to }, true);
	}

	async deleteInsertedCards(cardIds: string[]): Promise<void> {
		if (this.isMutating || cardIds.length === 0) {
			return;
		}

		const file = this.activeFile;
		if (!isMarkdownFile(file)) {
			return;
		}

		this.isMutating = true;
		this.notify();

		try {
			const result = await deleteExistingCards(this.plugin.app.vault, file, cardIds);
			if (result.deletedCount === 0) {
				new Notice("No flashcards were deleted.");
				return;
			}

			this.undoDeleteOperation = {
				filePath: file.path,
				deletedCount: result.deletedCount,
				beforeContent: result.beforeContent,
				afterContent: result.afterContent,
			};

			await this.refreshDisplayedFileCards(file);
			new Notice(`Deleted ${result.deletedCount} flashcard${result.deletedCount === 1 ? "" : "s"}. Use Undo delete to restore them.`);
		} catch (error) {
			new Notice(`Failed to delete flashcards: ${getErrorMessage(error)}`);
			throw error;
		} finally {
			this.isMutating = false;
			this.notify();
		}
	}

	async undoDelete(): Promise<void> {
		if (this.isMutating || this.undoDeleteOperation === null) {
			return;
		}

		const file = this.plugin.app.vault.getAbstractFileByPath(this.undoDeleteOperation.filePath);
		if (!isMarkdownFile(file)) {
			this.undoDeleteOperation = null;
			this.notify();
			new Notice("Undo delete is no longer available because the file was removed.");
			return;
		}

		this.isMutating = true;
		this.notify();

		try {
			const operation = this.undoDeleteOperation;
			const restored = await restoreDeletedCards(this.plugin.app.vault, file, operation);
			if (!restored) {
				this.undoDeleteOperation = null;
				new Notice("Undo delete is no longer available because the file changed.");
				return;
			}

			this.undoDeleteOperation = null;
			await this.refreshDisplayedFileCards(file);
			new Notice(`Restored ${operation.deletedCount} flashcard${operation.deletedCount === 1 ? "" : "s"}.`);
		} catch (error) {
			new Notice(`Failed to restore flashcards: ${getErrorMessage(error)}`);
			throw error;
		} finally {
			this.isMutating = false;
			this.notify();
		}
	}

	private async ensureViewOpen(): Promise<void> {
		const existingLeaf = this.plugin.app.workspace.getLeavesOfType(OBCD_SIDEBAR_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.plugin.app.workspace.getRightLeaf(false) ?? this.plugin.app.workspace.getLeaf(false);

		await leaf.setViewState({
			type: OBCD_SIDEBAR_VIEW_TYPE,
			active: true,
		});

		this.plugin.app.workspace.setActiveLeaf(leaf, { focus: false });
	}

	private async refreshDisplayedFileCards(forcedFile?: TFile | null): Promise<void> {
		const file = forcedFile ?? this.activeFile;
		const token = ++this.refreshToken;

		if (!isMarkdownFile(file)) {
			this.existingCards = [];
			this.notify();
			return;
		}

		const content = await this.readFileContent(file);
		if (token !== this.refreshToken) {
			return;
		}

		this.existingCards = collectExistingCardEntries(file, content);
		this.notify();
	}

	private resolveActiveMarkdownFile(): TFile | null {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		return isMarkdownFile(activeFile) ? activeFile : null;
	}

	private async readFileContent(file: TFile): Promise<string> {
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView?.file?.path === file.path) {
			return activeView.editor.getValue();
		}

		return await this.plugin.app.vault.cachedRead(file);
	}

	private handleRename(file: TAbstractFile, oldPath: string): void {
		if (!isMarkdownFile(file)) {
			return;
		}

		if (this.activeFile?.path === oldPath) {
			this.activeFile = file;
		}

		if (this.undoDeleteOperation?.filePath === oldPath) {
			this.undoDeleteOperation.filePath = file.path;
		}

		if (this.activeFile?.path === file.path || oldPath === this.activeFile?.path) {
			void this.refreshDisplayedFileCards(file);
		}
	}

	private handleDelete(file: TAbstractFile): void {
		if (this.activeFile?.path === file.path) {
			this.activeFile = null;
			this.existingCards = [];
		}

		if (this.undoDeleteOperation?.filePath === file.path) {
			this.undoDeleteOperation = null;
		}

		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
	return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function normalizeGenerationProgress(progress: GenerationProgressState): GenerationProgressState {
	const totalFiles = Math.max(progress.totalFiles, 1);
	return {
		...progress,
		currentFileIndex: Math.max(1, Math.min(progress.currentFileIndex, totalFiles)),
		totalFiles,
		currentChunkIndex: Math.max(0, progress.currentChunkIndex),
		totalChunks: Math.max(0, progress.totalChunks),
		progress: Math.max(0, Math.min(1, progress.progress)),
	};
}
