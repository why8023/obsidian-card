import { MarkdownView, Notice, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";

import type ObcdPlugin from "../main";
import type { ExistingCardEntry, GenerationProgressState } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { deleteExistingCards, restoreDeletedCards } from "../writing/flashcardWriter";

export const OBCD_SIDEBAR_VIEW_TYPE = "obcd-sidebar";

export interface CardSidebarSnapshot {
	activeFile: TFile | null;
	existingCards: ExistingCardEntry[];
	generationProgress: GenerationProgressState | null;
	isRefreshingFile: boolean;
	isMutating: boolean;
	hasUndoableDelete: boolean;
}

interface UndoDeleteOperation {
	filePath: string;
	deletedCount: number;
	beforeContent: string;
	afterContent: string;
}

interface ResolvedMarkdownViewContext {
	view: MarkdownView | null;
	source: "active-view" | "most-recent-leaf" | "root-leaf-fallback" | "none";
}

export class CardSidebarController {
	private readonly plugin: ObcdPlugin;
	private readonly listeners = new Set<() => void>();
	private activeFile: TFile | null;
	private existingCards: ExistingCardEntry[] = [];
	private refreshToken = 0;
	private isRefreshingFile = false;
	private isMutating = false;
	private generationProgress: GenerationProgressState | null = null;
	private undoDeleteOperation: UndoDeleteOperation | null = null;

	constructor(plugin: ObcdPlugin) {
		this.plugin = plugin;
		this.activeFile = this.resolveActiveMarkdownFile();

		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", (file) => {
			const nextFile = isMarkdownFile(file) ? file : null;
			if ((nextFile?.path ?? null) === (this.activeFile?.path ?? null)) {
				return;
			}
			void this.handleActiveFileChange(nextFile, "workspace:file-open");
		}));

		this.plugin.registerEvent(this.plugin.app.workspace.on("active-leaf-change", () => {
			const nextFile = this.resolveActiveMarkdownFile();
			if ((nextFile?.path ?? null) === (this.activeFile?.path ?? null)) {
				return;
			}
			void this.handleActiveFileChange(nextFile, "workspace:active-leaf-change");
		}));

		this.plugin.registerEvent(this.plugin.app.workspace.on("layout-change", () => {
			const nextFile = this.resolveActiveMarkdownFile();
			if ((nextFile?.path ?? null) === (this.activeFile?.path ?? null)) {
				return;
			}
			void this.handleActiveFileChange(nextFile, "workspace:layout-change");
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (isMarkdownFile(file) && this.activeFile?.path === file.path) {
				void this.refreshDisplayedFileCards(file, "vault:modify");
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
			isRefreshingFile: this.isRefreshingFile,
			isMutating: this.isMutating,
			hasUndoableDelete: this.activeFile !== null && this.undoDeleteOperation?.filePath === this.activeFile.path,
		};
	}

	async open(): Promise<void> {
		await this.ensureViewOpen();
		await this.refresh();
	}

	async refresh(): Promise<void> {
		const nextFile = this.resolveActiveMarkdownFile();
		await this.handleActiveFileChange(nextFile, "manual-refresh");
	}

	async refreshFromVault(forcedFile?: TFile | null): Promise<void> {
		await this.refreshDisplayedFileCards(forcedFile ?? this.activeFile, "mutation:refresh");
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

			this.applyDisplayedFileContent(file, result.afterContent);
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
			this.applyDisplayedFileContent(file, operation.beforeContent);
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
	}

	private async refreshDisplayedFileCards(forcedFile?: TFile | null, reason = "unspecified"): Promise<void> {
		const file = forcedFile ?? this.activeFile;
		const token = ++this.refreshToken;

		if (!isMarkdownFile(file)) {
			this.existingCards = [];
			this.isRefreshingFile = false;
			this.notify();
			return;
		}

		this.isRefreshingFile = true;
		const readResult = await this.readFileContent(file, reason);
		if (token !== this.refreshToken) {
			return;
		}

		this.applyDisplayedFileContent(file, readResult.content);
	}

	private resolveActiveMarkdownFile(): TFile | null {
		const markdownViewContext = this.resolveCurrentMarkdownViewContext();
		const file = markdownViewContext.view?.file ?? null;
		return isMarkdownFile(file) ? file : null;
	}

	private async readFileContent(file: TFile, reason: string): Promise<{
		content: string;
	}> {
		if (reason.startsWith("vault:") || reason.startsWith("mutation:")) {
			return {
				content: await this.plugin.app.vault.read(file),
			};
		}

		const preferCachedRead = reason.startsWith("workspace:");
		const markdownViewContext = this.resolveCurrentMarkdownViewContext();
		const markdownView = markdownViewContext.view;
		if (!preferCachedRead && markdownView?.file?.path === file.path) {
			return {
				content: markdownView.editor.getValue(),
			};
		}

		return {
			content: await this.plugin.app.vault.cachedRead(file),
		};
	}

	private applyDisplayedFileContent(file: TFile, content: string): void {
		if (this.activeFile?.path !== file.path) {
			return;
		}

		this.existingCards = collectExistingCardEntries(file, content);
		this.isRefreshingFile = false;
		this.notify();
	}

	private resolveCurrentMarkdownViewContext(): ResolvedMarkdownViewContext {
		const activeView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
		if (activeView !== null) {
			return {
				view: activeView,
				source: "active-view",
			};
		}

		const mostRecentLeaf = this.resolveMostRecentMarkdownLeaf();
		if (mostRecentLeaf?.view instanceof MarkdownView) {
			return {
				view: mostRecentLeaf.view,
				source: "most-recent-leaf",
			};
		}

		let fallbackView: MarkdownView | null = null;
		this.plugin.app.workspace.iterateRootLeaves((leaf) => {
			if (fallbackView === null && leaf.view instanceof MarkdownView) {
				fallbackView = leaf.view;
			}
		});
		if (fallbackView !== null) {
			return {
				view: fallbackView,
				source: "root-leaf-fallback",
			};
		}

		return {
			view: null,
			source: "none",
		};
	}

	private resolveMostRecentMarkdownLeaf(): WorkspaceLeaf | null {
		const leaf = this.plugin.app.workspace.getMostRecentLeaf();
		return leaf?.view instanceof MarkdownView ? leaf : null;
	}

	private async handleActiveFileChange(file: TFile | null, reason = "unspecified"): Promise<void> {
		const nextFile = isMarkdownFile(file) ? file : null;
		const activeFileChanged = this.activeFile?.path !== nextFile?.path;
		this.activeFile = nextFile;
		this.isRefreshingFile = nextFile !== null;
		if (activeFileChanged) {
			this.existingCards = [];
		}
		this.notify();
		await this.refreshDisplayedFileCards(nextFile, reason);
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
			void this.refreshDisplayedFileCards(file, "vault:rename");
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
