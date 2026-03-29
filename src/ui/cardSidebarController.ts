import { MarkdownView, Notice, TAbstractFile, TFile } from "obsidian";

import type ObsidianCardPlugin from "../main";
import type { ExistingCardEntry, ReviewGroup, ReviewResult, SidebarReviewSession } from "../types";
import { collectExistingCardEntries } from "../utils/cardBlockParser";
import { cloneReviewGroups, collectApprovedGroups } from "./reviewState";
import { deleteExistingCards, restoreDeletedCards } from "../writing/flashcardWriter";

export const OBCARD_SIDEBAR_VIEW_TYPE = "obcard-sidebar";

interface OpenReviewSessionOptions {
	file: TFile;
	groups: ReviewGroup[];
}

export interface CardSidebarSnapshot {
	activeFile: TFile | null;
	displayFile: TFile | null;
	pendingSession: SidebarReviewSession | null;
	existingCards: ExistingCardEntry[];
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
	private readonly plugin: ObsidianCardPlugin;
	private readonly listeners = new Set<() => void>();
	private activeFile: TFile | null;
	private existingCards: ExistingCardEntry[] = [];
	private pendingSession: SidebarReviewSession | null = null;
	private pendingResolve: ((result: ReviewResult) => void) | null = null;
	private refreshToken = 0;
	private isMutating = false;
	private undoDeleteOperation: UndoDeleteOperation | null = null;

	constructor(plugin: ObsidianCardPlugin) {
		this.plugin = plugin;
		this.activeFile = this.resolveActiveMarkdownFile();

		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", (file) => {
			this.activeFile = isMarkdownFile(file) ? file : null;
			void this.refreshDisplayedFileCards();
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			if (isMarkdownFile(file) && this.getDisplayFile()?.path === file.path) {
				void this.refreshDisplayedFileCards();
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
		const displayFile = this.getDisplayFile();

		return {
			activeFile: this.activeFile,
			displayFile,
			pendingSession: this.pendingSession,
			existingCards: [...this.existingCards],
			isMutating: this.isMutating,
			hasUndoableDelete: displayFile !== null && this.undoDeleteOperation?.filePath === displayFile.path,
		};
	}

	async open(): Promise<void> {
		await this.ensureViewOpen();
		await this.refreshDisplayedFileCards();
	}

	async refresh(): Promise<void> {
		this.activeFile = this.resolveActiveMarkdownFile();
		await this.refreshDisplayedFileCards();
	}

	async openReviewSession(options: OpenReviewSessionOptions): Promise<ReviewResult> {
		if (this.pendingResolve !== null) {
			this.finishPendingReview({
				action: "cancel",
				approvedGroups: [],
			}, true);
			new Notice("Previous flashcard review was replaced.");
		} else if (this.pendingSession !== null) {
			this.pendingSession = null;
		}

		this.pendingSession = {
			file: options.file,
			filePath: options.file.path,
			groups: cloneReviewGroups(options.groups),
			status: "reviewing",
		};

		await this.ensureViewOpen();
		await this.refreshDisplayedFileCards();

		return new Promise((resolve) => {
			this.pendingResolve = resolve;
			this.notify();
		});
	}

	cancelPendingReview(): void {
		this.finishPendingReview({
			action: "cancel",
			approvedGroups: [],
		}, true);
	}

	requestConfirmPendingReview(): void {
		if (this.pendingSession === null || this.pendingResolve === null) {
			return;
		}

		this.pendingSession.status = "submitting";
		this.notify();

		const resolve = this.pendingResolve;
		this.pendingResolve = null;
		resolve({
			action: "confirm",
			approvedGroups: collectApprovedGroups(this.pendingSession.groups),
		});
	}

	async completePendingSessionAfterWrite(file: TFile): Promise<void> {
		if (this.pendingSession?.file.path === file.path) {
			this.pendingSession = null;
		}

		await this.refreshDisplayedFileCards(file);
	}

	resetPendingSessionAfterError(file: TFile): void {
		if (this.pendingSession?.file.path !== file.path || this.pendingSession.status !== "submitting") {
			return;
		}

		this.pendingSession.status = "reviewing";
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

		const file = this.getDisplayFile();
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
		const existingLeaf = this.plugin.app.workspace.getLeavesOfType(OBCARD_SIDEBAR_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.plugin.app.workspace.getRightLeaf(false) ?? this.plugin.app.workspace.getLeaf(false);

		await leaf.setViewState({
			type: OBCARD_SIDEBAR_VIEW_TYPE,
			active: true,
		});

		this.plugin.app.workspace.setActiveLeaf(leaf, { focus: false });
	}

	private async refreshDisplayedFileCards(forcedFile?: TFile | null): Promise<void> {
		const file = forcedFile ?? this.getDisplayFile();
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

	private finishPendingReview(result: ReviewResult, clearSession: boolean): void {
		if (clearSession) {
			this.pendingSession = null;
		}

		const resolve = this.pendingResolve;
		this.pendingResolve = null;
		this.notify();
		resolve?.(result);
	}

	private getDisplayFile(): TFile | null {
		return this.pendingSession?.file ?? this.activeFile;
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

		if (this.pendingSession?.file.path === oldPath) {
			this.pendingSession.file = file;
			this.pendingSession.filePath = file.path;
		}

		if (this.undoDeleteOperation?.filePath === oldPath) {
			this.undoDeleteOperation.filePath = file.path;
		}

		if (this.getDisplayFile()?.path === file.path || oldPath === this.getDisplayFile()?.path) {
			void this.refreshDisplayedFileCards();
		}
	}

	private handleDelete(file: TAbstractFile): void {
		if (this.activeFile?.path === file.path) {
			this.activeFile = null;
		}

		if (this.pendingSession?.file.path === file.path) {
			this.pendingSession = null;
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			resolve?.({
				action: "cancel",
				approvedGroups: [],
			});
			new Notice("Awaiting flashcard review was cleared because the file was removed.");
		}

		if (this.undoDeleteOperation?.filePath === file.path) {
			this.undoDeleteOperation = null;
		}

		if (this.getDisplayFile()?.path === file.path) {
			this.existingCards = [];
			this.notify();
		}
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
