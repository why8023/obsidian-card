import {
	ButtonComponent,
	ItemView,
	SearchComponent,
	setIcon,
} from "obsidian";

import type { WorkspaceLeaf } from "obsidian";

import type ObcdPlugin from "../main";
import type {
	ExistingCardEntry,
	SidebarTableColumnId,
} from "../types";
import { makePreview } from "../utils/markdown";
import { OBCD_SIDEBAR_VIEW_TYPE, type CardSidebarSnapshot } from "./cardSidebarController";
import {
	findSidebarTableColumn,
	getSearchableCardValues,
	SIDEBAR_TABLE_COLUMNS,
	type SidebarTableColumnDefinition,
} from "./sidebarTableColumns";

type CardFilterScope = "all" | "generated";

export class CardSidebarView extends ItemView {
	private readonly plugin: ObcdPlugin;
	private unsubscribe: (() => void) | null = null;
	private searchText = "";
	private cardFilterScope: CardFilterScope = "all";
	private actionsInitialized = false;
	private isColumnSettingsExpanded = false;
	private selectedInsertedCardIds = new Set<string>();
	private pendingSingleDeleteCardId: string | null = null;
	private isBulkDeleteConfirmationPending = false;
	private renderedDisplayFilePath: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: ObcdPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return OBCD_SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Flashcards";
	}

	getIcon(): string {
		return "panel-right-open";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("obcd-sidebar-view");

		if (!this.actionsInitialized) {
			this.addAction("refresh-cw", "Refresh flashcards", () => {
				void this.plugin.sidebar.refresh();
			});
			this.actionsInitialized = true;
		}

		this.unsubscribe = this.plugin.sidebar.subscribe(() => this.render());
		await this.plugin.sidebar.refresh();
		this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	private render(): void {
		const state = this.plugin.sidebar.getSnapshot();
		const { contentEl } = this;
		contentEl.empty();

		const rootEl = contentEl.createDiv({ cls: "obcd-sidebar" });
		const activeFile = state.activeFile;
		this.syncInsertedSelection(activeFile?.path ?? null, state.existingCards);

		if (state.generationProgress !== null) {
			this.renderGenerationProgress(rootEl, state.generationProgress);
		}

		if (activeFile === null) {
			if (state.generationProgress === null) {
				this.renderEmptyState(rootEl, "Open a Markdown file to inspect flashcards.");
			}
			return;
		}

		const generatedCardCount = state.existingCards.filter((card) => card.isPluginGenerated).length;

		this.renderFileHeader(rootEl, {
			name: activeFile.basename,
			path: activeFile.path,
			cardCount: state.existingCards.length,
			generatedCardCount,
			isGeneratingCurrentFile: state.generationProgress !== null,
		});

		this.renderSearchBar(rootEl);
		this.renderInsertedSection(rootEl, state.existingCards, state);
	}

	private syncInsertedSelection(displayFilePath: string | null, cards: ExistingCardEntry[]): void {
		if (this.renderedDisplayFilePath !== displayFilePath) {
			this.selectedInsertedCardIds.clear();
			this.resetDeleteConfirmations();
			this.renderedDisplayFilePath = displayFilePath;
			return;
		}

		const validCardIds = new Set(cards.map((card) => card.id));
		for (const cardId of Array.from(this.selectedInsertedCardIds)) {
			if (!validCardIds.has(cardId)) {
				this.selectedInsertedCardIds.delete(cardId);
			}
		}

		if (this.pendingSingleDeleteCardId !== null && !validCardIds.has(this.pendingSingleDeleteCardId)) {
			this.pendingSingleDeleteCardId = null;
		}

		if (this.selectedInsertedCardIds.size === 0) {
			this.isBulkDeleteConfirmationPending = false;
		}
	}

	private renderGenerationProgress(containerEl: HTMLElement, progress: NonNullable<CardSidebarSnapshot["generationProgress"]>): void {
		const sectionEl = containerEl.createDiv({ cls: "obcd-sidebar-progress" });
		const headerEl = sectionEl.createDiv({ cls: "obcd-sidebar-section-header" });
		headerEl.createEl("h4", {
			cls: "obcd-sidebar-section-title",
			text: "Generation progress",
		});

		const chipsEl = headerEl.createDiv({ cls: "obcd-sidebar-chips" });
		chipsEl.createEl("span", {
			cls: "obcd-sidebar-chip",
			text: this.getGenerationPhaseLabel(progress.phase),
		});
		chipsEl.createEl("span", {
			cls: "obcd-sidebar-chip",
			text: `File ${progress.currentFileIndex}/${progress.totalFiles}`,
		});
		if (progress.totalChunks > 0) {
			chipsEl.createEl("span", {
				cls: "obcd-sidebar-chip",
				text: `Chunk ${Math.min(progress.currentChunkIndex, progress.totalChunks)}/${progress.totalChunks}`,
			});
		}

		sectionEl.createEl("strong", {
			cls: "obcd-sidebar-progress-title",
			text: progress.summary,
		});
		sectionEl.createEl("p", {
			cls: "obcd-sidebar-path",
			text: progress.filePath,
		});
		sectionEl.createEl("p", {
			cls: "obcd-sidebar-note",
			text: progress.detail,
		});

		const meterEl = sectionEl.createDiv({ cls: "obcd-sidebar-progress-meter" });
		const trackEl = meterEl.createDiv({ cls: "obcd-sidebar-progress-track" });
		const fillEl = trackEl.createDiv({ cls: "obcd-sidebar-progress-fill" });
		fillEl.style.width = `${Math.round(progress.progress * 100)}%`;
		meterEl.createEl("span", {
			cls: "obcd-sidebar-progress-value",
			text: `${Math.round(progress.progress * 100)}%`,
		});
	}

	private renderFileHeader(
		containerEl: HTMLElement,
		state: {
			name: string;
			path: string;
			cardCount: number;
			generatedCardCount: number;
			isGeneratingCurrentFile: boolean;
		},
	): void {
		const headerEl = containerEl.createDiv({ cls: "obcd-sidebar-header" });
		headerEl.createEl("h3", {
			cls: "obcd-sidebar-title",
			text: state.name,
		});
		headerEl.createEl("p", {
			cls: "obcd-sidebar-path",
			text: state.path,
		});

		const chipsEl = headerEl.createDiv({ cls: "obcd-sidebar-chips" });
		chipsEl.createEl("span", {
			cls: "obcd-sidebar-chip",
			text: `Cards ${state.cardCount}`,
		});
		chipsEl.createEl("span", {
			cls: "obcd-sidebar-chip",
			text: `Plugin ${state.generatedCardCount}`,
		});

		const actionsEl = headerEl.createDiv({ cls: "obcd-sidebar-actions" });
		const generateButton = new ButtonComponent(actionsEl)
			.setButtonText(state.isGeneratingCurrentFile ? "Generating cards..." : "Generate cards")
			.setDisabled(state.isGeneratingCurrentFile)
			.onClick(() => {
				void this.plugin.workflow.generateForCurrentFile();
			});
		generateButton.setCta();
		generateButton.buttonEl.setAttr("title", `Generate flashcards for ${state.path}.`);
	}

	private renderSearchBar(containerEl: HTMLElement): void {
		const filterEl = containerEl.createDiv({ cls: "obcd-sidebar-filter" });
		const search = new SearchComponent(filterEl);
		search.setPlaceholder("Filter questions, tags, type, or source");
		search.setValue(this.searchText);
		search.onChange((value) => {
			this.searchText = value;
			this.resetDeleteConfirmations();
			this.render();
		});
	}

	private renderInsertedSection(
		containerEl: HTMLElement,
		cards: ExistingCardEntry[],
		state: CardSidebarSnapshot,
	): void {
		const sectionEl = containerEl.createDiv({ cls: "obcd-sidebar-section" });
		const headerEl = sectionEl.createDiv({ cls: "obcd-sidebar-section-header" });

		const generatedCardCount = cards.filter((card) => card.isPluginGenerated).length;
		this.renderScopeFilters(headerEl, cards.length, generatedCardCount, state.isMutating);

		const filteredCards = cards.filter((card) => this.matchesCard(card));
		const selectedCount = this.selectedInsertedCardIds.size;
		const actionsEl = headerEl.createDiv({ cls: "obcd-sidebar-actions" });

		if (selectedCount > 0) {
			this.createActionButton(actionsEl, "Select all visible", () => {
				for (const card of filteredCards) {
					this.selectedInsertedCardIds.add(card.id);
				}
				this.resetDeleteConfirmations();
				this.render();
			}, { disabled: state.isMutating || filteredCards.length === 0 });
			this.createActionButton(actionsEl, "Clear selection", () => {
				this.selectedInsertedCardIds.clear();
				this.resetDeleteConfirmations();
				this.render();
			}, { disabled: state.isMutating || selectedCount === 0 });
			this.createActionButton(
				actionsEl,
				this.isBulkDeleteConfirmationPending ? `Confirm delete (${selectedCount})` : `Delete selected (${selectedCount})`,
				() => {
					if (this.isBulkDeleteConfirmationPending) {
						void this.handleDeleteCards(Array.from(this.selectedInsertedCardIds));
						return;
					}

					this.isBulkDeleteConfirmationPending = true;
					this.pendingSingleDeleteCardId = null;
					this.render();
				},
				{ cta: true, disabled: state.isMutating || selectedCount === 0 },
			);
		}

		if (state.hasUndoableDelete) {
			this.createActionButton(actionsEl, "Undo delete", () => {
				void this.handleUndoDelete();
			}, { disabled: state.isMutating });
		}

		this.renderColumnSettings(sectionEl, state.isMutating);

		if (filteredCards.length === 0) {
			this.renderEmptyState(
				sectionEl,
				state.isRefreshingFile
					? "Loading flashcards..."
					: this.cardFilterScope === "generated"
					? "No plugin-generated flashcards match the current filter."
					: "No flashcards match the current filter.",
			);
			return;
		}

		this.renderInsertedTable(sectionEl, filteredCards, state.isMutating);
	}

	private renderScopeFilters(
		containerEl: HTMLElement,
		totalCount: number,
		generatedCount: number,
		isMutating: boolean,
	): void {
		const scopeEl = containerEl.createDiv({ cls: "obcd-sidebar-scope" });
		this.createScopeButton(scopeEl, `All cards (${totalCount})`, "all", isMutating);
		this.createScopeButton(scopeEl, `Plugin (${generatedCount})`, "generated", isMutating);
	}

	private renderColumnSettings(sectionEl: HTMLElement, isMutating: boolean): void {
		const detailsEl = sectionEl.createEl("details", { cls: "obcd-sidebar-column-settings" });
		detailsEl.open = this.isColumnSettingsExpanded;
		detailsEl.addEventListener("toggle", () => {
			this.isColumnSettingsExpanded = detailsEl.open;
		});
		detailsEl.createEl("summary", {
			text: "Visible columns",
		});

		const optionsEl = detailsEl.createDiv({ cls: "obcd-sidebar-column-options" });
		for (const column of SIDEBAR_TABLE_COLUMNS) {
			const optionEl = optionsEl.createEl("label", {
				cls: "obcd-sidebar-column-option",
				attr: {
					title: column.description,
				},
			});
			const checkboxEl = optionEl.createEl("input", {
				attr: {
					type: "checkbox",
				},
			});
			checkboxEl.checked = this.plugin.settings.sidebar.visibleTableColumns.includes(column.id);
			checkboxEl.disabled = isMutating;
			checkboxEl.addEventListener("change", () => {
				void this.toggleVisibleTableColumn(column.id, checkboxEl.checked);
			});
			optionEl.createSpan({
				text: column.label,
			});
		}
	}

	private renderInsertedTable(
		containerEl: HTMLElement,
		cards: ExistingCardEntry[],
		isMutating: boolean,
	): void {
		const visibleColumns = this.getVisibleInsertedColumns();
		const tableWrapperEl = containerEl.createDiv({ cls: "obcd-sidebar-table-wrapper" });
		const tableEl = tableWrapperEl.createEl("table", { cls: "obcd-sidebar-table" });
		const tableHeadEl = tableEl.createEl("thead");
		const headerRowEl = tableHeadEl.createEl("tr");

		const selectAllCell = headerRowEl.createEl("th", { cls: "obcd-sidebar-table-select-cell" });
		const selectAllCheckbox = selectAllCell.createEl("input", {
			attr: {
				type: "checkbox",
				"aria-label": "Select all visible cards",
			},
		});
		const visibleCardIds = cards.map((card) => card.id);
		const selectedVisibleCount = visibleCardIds.filter((cardId) => this.selectedInsertedCardIds.has(cardId)).length;
		selectAllCheckbox.checked = selectedVisibleCount > 0 && selectedVisibleCount === visibleCardIds.length;
		selectAllCheckbox.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visibleCardIds.length;
		selectAllCheckbox.disabled = isMutating || visibleCardIds.length === 0;
		selectAllCheckbox.addEventListener("change", () => {
			if (selectAllCheckbox.checked) {
				for (const cardId of visibleCardIds) {
					this.selectedInsertedCardIds.add(cardId);
				}
			} else {
				for (const cardId of visibleCardIds) {
					this.selectedInsertedCardIds.delete(cardId);
				}
			}
			this.render();
		});

		headerRowEl.createEl("th", {
			text: "Question",
		});

		for (const column of visibleColumns) {
			headerRowEl.createEl("th", {
				text: column.label,
			});
		}

		headerRowEl.createEl("th", {
			cls: "obcd-sidebar-table-action-cell",
			text: "Actions",
		});

		const tableBodyEl = tableEl.createEl("tbody");
		for (const card of cards) {
			const rowEl = tableBodyEl.createEl("tr", { cls: "obcd-sidebar-table-row" });
			rowEl.addClass("is-selectable");
			rowEl.addClass(card.isPluginGenerated ? "is-plugin-generated" : "is-other-card");
			rowEl.tabIndex = 0;
			rowEl.setAttr("aria-selected", this.selectedInsertedCardIds.has(card.id) ? "true" : "false");
			if (this.selectedInsertedCardIds.has(card.id)) {
				rowEl.addClass("is-selected");
			}
			this.bindInsertedRowInteraction(rowEl, card, isMutating);

			const selectionCell = rowEl.createEl("td", { cls: "obcd-sidebar-table-select-cell" });
			const checkboxEl = selectionCell.createEl("input", {
				attr: {
					type: "checkbox",
					"aria-label": `Select ${card.front}`,
				},
			});
			checkboxEl.checked = this.selectedInsertedCardIds.has(card.id);
			checkboxEl.disabled = isMutating;
			checkboxEl.addEventListener("change", () => {
				if (checkboxEl.checked) {
					this.selectedInsertedCardIds.add(card.id);
				} else {
					this.selectedInsertedCardIds.delete(card.id);
				}
				this.resetDeleteConfirmations();
				this.render();
			});

			this.createInsertedTableCell(
				rowEl,
				makePreview(card.front, this.plugin.settings.sidebar.frontPreviewLength),
				card.front,
				"obcd-sidebar-table-question",
			);

			for (const column of visibleColumns) {
				const rawValue = column.getValue(card);
				this.createInsertedTableCell(
					rowEl,
					rawValue.length > 0 ? makePreview(rawValue, column.previewLength) : "—",
					rawValue,
				);
			}

			const actionCell = rowEl.createEl("td", { cls: "obcd-sidebar-table-action-cell" });
			const isConfirmingDelete = this.pendingSingleDeleteCardId === card.id;
			const deleteButtonEl = actionCell.createEl("button", {
				cls: "clickable-icon obcd-sidebar-inline-icon",
				attr: {
					type: "button",
					"aria-label": isConfirmingDelete ? `Confirm delete ${card.front}` : `Delete ${card.front}`,
					title: isConfirmingDelete ? "Confirm delete" : "Delete card",
				},
			});
			deleteButtonEl.disabled = isMutating;
			setIcon(deleteButtonEl, isConfirmingDelete ? "check" : "trash-2");
			if (isConfirmingDelete) {
				deleteButtonEl.addClass("is-confirming");
			}
			deleteButtonEl.addEventListener("click", () => {
				if (isConfirmingDelete) {
					void this.handleDeleteCards([card.id]);
					return;
				}

				this.pendingSingleDeleteCardId = card.id;
				this.isBulkDeleteConfirmationPending = false;
				this.render();
			});
		}
	}

	private bindInsertedRowInteraction(rowEl: HTMLTableRowElement, card: ExistingCardEntry, isMutating: boolean): void {
		rowEl.addEventListener("click", (event) => {
			if (isMutating || this.isInteractiveEventTarget(event.target)) {
				return;
			}

			void this.plugin.sidebar.revealCard(card);
		});

		rowEl.addEventListener("keydown", (event) => {
			if (isMutating || this.isInteractiveEventTarget(event.target)) {
				return;
			}

			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}

			event.preventDefault();
			void this.plugin.sidebar.revealCard(card);
		});
	}

	private createInsertedTableCell(
		rowEl: HTMLElement,
		text: string,
		title: string,
		extraClass = "",
	): void {
		const cellEl = rowEl.createEl("td");
		if (extraClass.length > 0) {
			cellEl.addClass(extraClass);
		}

		cellEl.setAttr("title", title);
		cellEl.createEl("span", {
			cls: "obcd-sidebar-table-text",
			text,
		});
	}

	private async toggleVisibleTableColumn(columnId: SidebarTableColumnId, isVisible: boolean): Promise<void> {
		const columns = new Set(this.plugin.settings.sidebar.visibleTableColumns);
		if (isVisible) {
			columns.add(columnId);
		} else {
			columns.delete(columnId);
		}

		this.plugin.settings.sidebar.visibleTableColumns = SIDEBAR_TABLE_COLUMNS
			.filter((column) => columns.has(column.id))
			.map((column) => column.id);
		await this.plugin.saveSettings();
		this.render();
	}

	private async handleDeleteCards(cardIds: string[]): Promise<void> {
		if (cardIds.length === 0) {
			return;
		}

		try {
			await this.plugin.sidebar.deleteInsertedCards(cardIds);
			for (const cardId of cardIds) {
				this.selectedInsertedCardIds.delete(cardId);
			}
			this.resetDeleteConfirmations();
			this.render();
		} catch {
			// Notice is already shown by the controller.
		}
	}

	private async handleUndoDelete(): Promise<void> {
		try {
			await this.plugin.sidebar.undoDelete();
			this.render();
		} catch {
			// Notice is already shown by the controller.
		}
	}

	private getVisibleInsertedColumns(): SidebarTableColumnDefinition[] {
		return this.plugin.settings.sidebar.visibleTableColumns
			.map((columnId) => findSidebarTableColumn(columnId))
			.filter((column): column is SidebarTableColumnDefinition => column !== undefined);
	}

	private matchesCard(card: ExistingCardEntry): boolean {
		if (this.cardFilterScope === "generated" && !card.isPluginGenerated) {
			return false;
		}
		return this.matchesText(getSearchableCardValues(card));
	}

	private matchesText(values: string[]): boolean {
		const query = this.searchText.trim().toLowerCase();
		if (query.length === 0) {
			return true;
		}

		return values.some((value) => value.toLowerCase().includes(query));
	}

	private resetDeleteConfirmations(): void {
		this.pendingSingleDeleteCardId = null;
		this.isBulkDeleteConfirmationPending = false;
	}

	private createActionButton(
		containerEl: HTMLElement,
		label: string,
		onClick: () => void,
		options: { cta?: boolean; disabled?: boolean } = {},
	): void {
		const button = new ButtonComponent(containerEl)
			.setButtonText(label)
			.setDisabled(options.disabled ?? false)
			.onClick(() => onClick());

		if (options.cta) {
			button.setCta();
		}
	}

	private createScopeButton(
		containerEl: HTMLElement,
		label: string,
		scope: CardFilterScope,
		isMutating: boolean,
	): void {
		const button = new ButtonComponent(containerEl)
			.setButtonText(label)
			.setDisabled(isMutating)
			.onClick(() => {
				if (this.cardFilterScope === scope) {
					return;
				}

				this.cardFilterScope = scope;
				this.resetDeleteConfirmations();
				this.render();
			});
		button.buttonEl.addClass("obcd-sidebar-scope-button");
		if (this.cardFilterScope === scope) {
			button.buttonEl.addClass("is-active");
		}
	}

	private isInteractiveEventTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement
			&& target.closest("button, a, input, textarea, select, label, summary") !== null;
	}

	private getGenerationPhaseLabel(phase: NonNullable<CardSidebarSnapshot["generationProgress"]>["phase"]): string {
		switch (phase) {
			case "preparing":
				return "Preparing";
			case "generating":
				return "Generating";
			case "reviewing":
				return "Preparing cards";
			case "writing":
				return "Writing";
			default:
				return phase;
		}
	}

	private renderEmptyState(containerEl: HTMLElement, message: string): void {
		containerEl.createEl("p", {
			cls: "obcd-sidebar-empty",
			text: message,
		});
	}
}
