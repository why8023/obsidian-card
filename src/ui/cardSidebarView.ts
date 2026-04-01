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
import type {
	SidebarAnalysisSnapshot,
	SidebarBlockAnalysisItem,
	SidebarTopicAnalysisItem,
} from "./sidebarAnalysis";
import {
	findSidebarTableColumn,
	getSearchableCardValues,
	SIDEBAR_TABLE_COLUMNS,
	type SidebarTableColumnDefinition,
} from "./sidebarTableColumns";

interface CardTagFilterOption {
	tag: string;
	count: number;
}

interface SearchInputSelectionState {
	wasFocused: boolean;
	selectionStart: number | null;
	selectionEnd: number | null;
}

export class CardSidebarView extends ItemView {
	private readonly plugin: ObcdPlugin;
	private unsubscribe: (() => void) | null = null;
	private searchText = "";
	private searchInputEl: HTMLInputElement | null = null;
	private activeTagFilter: string | null = null;
	private actionsInitialized = false;
	private isTagFiltersExpanded = false;
	private isColumnSettingsExpanded = false;
	private selectedInsertedCardIds = new Set<string>();
	private pendingSingleDeleteCardId: string | null = null;
	private isBulkDeleteConfirmationPending = false;
	private renderedDisplayFilePath: string | null = null;
	private isTopicSectionExpanded = true;
	private isBlockSectionExpanded = true;
	private isFlashcardSectionExpanded = true;

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
		this.searchInputEl = null;
		this.contentEl.empty();
	}

	private render(): void {
		const state = this.plugin.sidebar.getSnapshot();
		const { contentEl } = this;
		this.searchInputEl = null;
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

		this.renderFlashcardsSection(rootEl, state.existingCards, state);
		this.renderTopicSection(rootEl, state.analysis);
		this.renderBlockSection(rootEl, state.analysis);
	}

	private syncInsertedSelection(displayFilePath: string | null, cards: ExistingCardEntry[]): void {
		if (this.renderedDisplayFilePath !== displayFilePath) {
			this.selectedInsertedCardIds.clear();
			this.activeTagFilter = null;
			this.isTagFiltersExpanded = false;
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

		if (this.activeTagFilter !== null) {
			const availableTags = new Set(cards.flatMap((card) => card.tags));
			if (!availableTags.has(this.activeTagFilter)) {
				this.activeTagFilter = null;
			}
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
				text: `${this.getGenerationUnitLabel(progress.phase)} ${Math.min(progress.currentChunkIndex, progress.totalChunks)}/${progress.totalChunks}`,
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

	private renderTopicSection(containerEl: HTMLElement, analysis: SidebarAnalysisSnapshot | null): void {
		const sectionEl = this.createCollapsibleSection(containerEl, {
			title: "Topic",
			detail: this.getTopicSectionSummary(analysis),
			isOpen: this.isTopicSectionExpanded,
			onToggle: (isOpen) => {
				this.isTopicSectionExpanded = isOpen;
			},
		});

		if (analysis === null) {
			this.renderEmptyState(sectionEl, "No saved topic analysis was found in the note front matter.");
			return;
		}

		const summaryEl = sectionEl.createDiv({ cls: "obcd-sidebar-card obcd-sidebar-analysis-summary" });
		const chipsEl = summaryEl.createDiv({ cls: "obcd-sidebar-chips" });
		this.createAnalysisChip(chipsEl, `Chunks ${analysis.knowledgeChunkCount}`);
		this.createAnalysisChip(chipsEl, `Topics ${analysis.topicCount}`);
		this.createAnalysisChip(chipsEl, `Planned ${analysis.plannedCardCount}`);
		this.createAnalysisChip(chipsEl, `Inserted ${analysis.insertedCardCount}`);
		this.createAnalysisChip(chipsEl, `Core ${analysis.coreTopicCount}`);
		if (analysis.secondaryTopicCount > 0) {
			this.createAnalysisChip(chipsEl, `Secondary ${analysis.secondaryTopicCount}`);
		}
		if (analysis.analysisOnlyTopicCount > 0) {
			this.createAnalysisChip(chipsEl, `Analysis only ${analysis.analysisOnlyTopicCount}`);
		}

		const metaLine = this.getAnalysisMetaLine(analysis);
		if (metaLine.length > 0) {
			summaryEl.createEl("p", {
				cls: "obcd-sidebar-note",
				text: metaLine,
			});
		}

		if (analysis.budget !== null || analysis.remainingLlmCalls !== null) {
			const budgetEl = summaryEl.createDiv({ cls: "obcd-sidebar-chips" });
			if (analysis.budget !== null) {
				this.createAnalysisChip(budgetEl, `Core budget ${analysis.budget.coreCardBudget}`);
				this.createAnalysisChip(budgetEl, `Secondary budget ${analysis.budget.secondaryCardBudget}`);
				this.createAnalysisChip(budgetEl, `Max/topic ${analysis.budget.maxCardsPerTopic}`);
			}
			if (analysis.remainingLlmCalls !== null) {
				this.createAnalysisChip(budgetEl, `Calls left ${analysis.remainingLlmCalls}`);
			}
		}

		if (analysis.topics.length === 0) {
			this.renderEmptyState(sectionEl, "This note has generation metadata, but no topic list was saved.");
			return;
		}

		const topicListEl = sectionEl.createDiv({ cls: "obcd-sidebar-analysis-list" });
		for (const topic of analysis.topics) {
			this.renderTopicAnalysisCard(topicListEl, topic);
		}
	}

	private renderBlockSection(containerEl: HTMLElement, analysis: SidebarAnalysisSnapshot | null): void {
		const sectionEl = this.createCollapsibleSection(containerEl, {
			title: "Blocks",
			detail: this.getBlockSectionSummary(analysis),
			isOpen: this.isBlockSectionExpanded,
			onToggle: (isOpen) => {
				this.isBlockSectionExpanded = isOpen;
			},
		});

		if (analysis === null || analysis.blocks.length === 0) {
			this.renderEmptyState(sectionEl, "No saved block analysis was found in the note body.");
			return;
		}

		const summaryEl = sectionEl.createDiv({ cls: "obcd-sidebar-card obcd-sidebar-analysis-summary" });
		const chipsEl = summaryEl.createDiv({ cls: "obcd-sidebar-chips" });
		this.createAnalysisChip(chipsEl, `Blocks ${analysis.blockCount}`);
		this.createAnalysisChip(chipsEl, `Knowledge ${analysis.knowledgeBlockCount}`);
		if (analysis.skippedBlockCount > 0) {
			this.createAnalysisChip(chipsEl, `Skipped ${analysis.skippedBlockCount}`);
		}

		const listEl = sectionEl.createDiv({ cls: "obcd-sidebar-analysis-list" });
		for (const block of analysis.blocks) {
			this.renderBlockAnalysisCard(listEl, block);
		}
	}

	private renderFlashcardsSection(
		containerEl: HTMLElement,
		cards: ExistingCardEntry[],
		state: CardSidebarSnapshot,
	): void {
		const sectionEl = this.createCollapsibleSection(containerEl, {
			title: "Flashcards",
			detail: this.getFlashcardSectionSummary(cards),
			isOpen: this.isFlashcardSectionExpanded,
			onToggle: (isOpen) => {
				this.isFlashcardSectionExpanded = isOpen;
			},
		});

		this.renderSearchBar(sectionEl);
		this.renderInsertedSection(sectionEl, cards, state);
	}

	private renderTopicAnalysisCard(containerEl: HTMLElement, topic: SidebarTopicAnalysisItem): void {
		const cardEl = containerEl.createDiv({ cls: "obcd-sidebar-card obcd-sidebar-analysis-card" });
		cardEl.addClass(`is-${topic.status}`);

		const chipsEl = cardEl.createDiv({ cls: "obcd-sidebar-chips" });
		this.createAnalysisChip(chipsEl, this.getTopicStatusLabel(topic), `obcd-sidebar-analysis-status is-${topic.status}`);
		this.createAnalysisChip(chipsEl, topic.tier === "core" ? "Core" : "Secondary");
		this.createAnalysisChip(chipsEl, `Chunks ${topic.memberChunkCount}`);
		this.createAnalysisChip(chipsEl, `Score ${topic.importanceScore.toFixed(2)}`);
		if (topic.plannedCardCount > 0) {
			this.createAnalysisChip(chipsEl, `Planned ${topic.plannedCardCount}`);
		} else if (topic.recommendedCardCount > 0) {
			this.createAnalysisChip(chipsEl, `Suggested ${topic.recommendedCardCount}`);
		}
		if (topic.insertedCardCount > 0) {
			this.createAnalysisChip(chipsEl, `Inserted ${topic.insertedCardCount}`);
		}

		const statementEl = cardEl.createEl("strong", {
			cls: "obcd-sidebar-analysis-statement",
			text: makePreview(topic.canonicalStatement, 140),
		});
		statementEl.setAttr("title", topic.canonicalStatement);

		if (topic.summary.trim().length > 0 && topic.summary.trim() !== topic.canonicalStatement.trim()) {
			const summaryEl = cardEl.createEl("p", {
				cls: "obcd-sidebar-analysis-summary-text",
				text: makePreview(topic.summary, 160),
			});
			summaryEl.setAttr("title", topic.summary);
		}

		const groupEl = cardEl.createEl("p", {
			cls: "obcd-sidebar-subtle",
			text: `Group: ${topic.knowledgeGroup}`,
		});
		groupEl.setAttr("title", topic.knowledgeGroup);

		if (topic.status !== "planned" && topic.rejectionReason.trim().length > 0) {
			const reasonEl = cardEl.createEl("p", {
				cls: "obcd-sidebar-note",
				text: topic.rejectionReason,
			});
			reasonEl.setAttr("title", topic.rejectionReason);
		}
	}

	private renderBlockAnalysisCard(containerEl: HTMLElement, block: SidebarBlockAnalysisItem): void {
		const cardEl = containerEl.createDiv({ cls: "obcd-sidebar-card obcd-sidebar-analysis-card" });
		cardEl.addClass(`is-${block.status === "knowledge" ? "planned" : "analysis-only"}`);
		cardEl.addClass("is-selectable");
		cardEl.tabIndex = 0;
		cardEl.setAttr("aria-label", `Reveal source block ${block.blockIndex}`);
		this.bindBlockAnalysisInteraction(cardEl, block);

		const chipsEl = cardEl.createDiv({ cls: "obcd-sidebar-chips" });
		this.createAnalysisChip(
			chipsEl,
			block.status === "knowledge" ? "Knowledge block" : "Skipped block",
			`obcd-sidebar-analysis-status is-${block.status === "knowledge" ? "planned" : "analysis-only"}`,
		);
		this.createAnalysisChip(chipsEl, `Block ${block.blockIndex}`);
		if (block.topicHint.trim().length > 0) {
			this.createAnalysisChip(chipsEl, block.topicHint);
		}

		const summaryEl = cardEl.createEl("strong", {
			cls: "obcd-sidebar-analysis-statement",
			text: makePreview(block.summary, 140),
		});
		summaryEl.setAttr("title", block.summary);

		if (block.evidenceExcerpt.trim().length > 0) {
			const evidenceEl = cardEl.createEl("p", {
				cls: "obcd-sidebar-analysis-summary-text",
				text: makePreview(block.evidenceExcerpt, 180),
			});
			evidenceEl.setAttr("title", block.evidenceExcerpt);
		}

		if (block.status === "no-knowledge" && block.rejectionReason.trim().length > 0) {
			const reasonEl = cardEl.createEl("p", {
				cls: "obcd-sidebar-note",
				text: block.rejectionReason,
			});
			reasonEl.setAttr("title", block.rejectionReason);
		}

		const extractedLabel = this.formatTimestamp(block.extractedAt);
		if (extractedLabel.length > 0) {
			cardEl.createEl("p", {
				cls: "obcd-sidebar-subtle",
				text: `Extracted ${extractedLabel}`,
			});
		}
	}

	private bindBlockAnalysisInteraction(cardEl: HTMLElement, block: SidebarBlockAnalysisItem): void {
		cardEl.addEventListener("click", (event) => {
			if (this.isInteractiveEventTarget(event.target)) {
				return;
			}

			void this.plugin.sidebar.revealBlock(block.bodyRange);
		});

		cardEl.addEventListener("keydown", (event) => {
			if (this.isInteractiveEventTarget(event.target)) {
				return;
			}

			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}

			event.preventDefault();
			void this.plugin.sidebar.revealBlock(block.bodyRange);
		});
	}

	private renderSearchBar(containerEl: HTMLElement): void {
		const filterEl = containerEl.createDiv({ cls: "obcd-sidebar-filter" });
		const search = new SearchComponent(filterEl);
		this.searchInputEl = search.inputEl;
		search.setPlaceholder("Filter questions, tags, type, or source");
		search.setValue(this.searchText);
		search.onChange((value) => {
			const selectionState = this.captureSearchInputSelection(search.inputEl);
			this.searchText = value;
			this.resetDeleteConfirmations();
			this.render();
			this.restoreSearchInputSelection(selectionState);
		});
	}

	private renderInsertedSection(
		containerEl: HTMLElement,
		cards: ExistingCardEntry[],
		state: CardSidebarSnapshot,
	): void {
		const sectionEl = containerEl.createDiv({ cls: "obcd-sidebar-section" });
		const tagFilters = this.getTagFilterOptions(cards);
		this.renderScopeFilters(sectionEl, cards.length, tagFilters, state.isMutating);

		const filteredCards = cards.filter((card) => this.matchesCard(card));
		const selectedCount = this.selectedInsertedCardIds.size;
		const shouldRenderActions = selectedCount > 0 || state.hasUndoableDelete;
		const actionsEl = shouldRenderActions
			? sectionEl.createDiv({ cls: "obcd-sidebar-actions obcd-sidebar-section-actions" })
			: null;

		if (actionsEl !== null && selectedCount > 0) {
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

		if (actionsEl !== null && state.hasUndoableDelete) {
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
					: this.activeTagFilter !== null
					? `No flashcards with the tag "${this.activeTagFilter}" match the current filter.`
					: "No flashcards match the current filter.",
			);
			return;
		}

		this.renderInsertedCards(sectionEl, filteredCards, state.isMutating);
	}

	private renderScopeFilters(
		containerEl: HTMLElement,
		totalCount: number,
		tagFilters: CardTagFilterOption[],
		isMutating: boolean,
	): void {
		if (tagFilters.length === 0) {
			return;
		}

		const detailsEl = containerEl.createEl("details", { cls: "obcd-sidebar-tag-filters" });
		detailsEl.open = this.isTagFiltersExpanded;
		detailsEl.addEventListener("toggle", () => {
			this.isTagFiltersExpanded = detailsEl.open;
		});
		detailsEl.createEl("summary", {
			text: this.getTagFiltersSummaryLabel(totalCount, tagFilters),
		});

		const scopeEl = detailsEl.createDiv({ cls: "obcd-sidebar-scope" });
		this.createScopeButton(scopeEl, `All cards (${totalCount})`, this.activeTagFilter === null, isMutating, () => {
			if (this.activeTagFilter === null) {
				return;
			}

			this.activeTagFilter = null;
			this.resetDeleteConfirmations();
			this.render();
		});

		for (const tagFilter of tagFilters) {
			const isActive = this.activeTagFilter === tagFilter.tag;
			this.createScopeButton(scopeEl, `${tagFilter.tag} (${tagFilter.count})`, isActive, isMutating, () => {
				const nextTagFilter = isActive ? null : tagFilter.tag;
				if (this.activeTagFilter === nextTagFilter) {
					return;
				}

				this.activeTagFilter = nextTagFilter;
				this.resetDeleteConfirmations();
				this.render();
			});
		}
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

	private renderInsertedCards(
		containerEl: HTMLElement,
		cards: ExistingCardEntry[],
		isMutating: boolean,
	): void {
		const visibleColumns = this.getVisibleInsertedColumns();
		const listEl = containerEl.createDiv({ cls: "obcd-sidebar-inserted-list" });
		const listHeaderEl = listEl.createDiv({ cls: "obcd-sidebar-card-list-header" });
		const selectAllLabelEl = listHeaderEl.createEl("label", {
			cls: "obcd-sidebar-card-list-select-all",
		});
		const selectAllCheckbox = selectAllLabelEl.createEl("input", {
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
			this.resetDeleteConfirmations();
			this.render();
		});
		selectAllLabelEl.createSpan({
			text: `Select all visible (${cards.length})`,
		});
		listHeaderEl.createEl("span", {
			cls: "obcd-sidebar-subtle",
			text: `${selectedVisibleCount} selected`,
		});

		for (const card of cards) {
			const cardEl = listEl.createDiv({ cls: "obcd-sidebar-card obcd-sidebar-inserted-card" });
			cardEl.addClass("is-selectable");
			cardEl.addClass(card.isPluginGenerated ? "is-plugin-generated" : "is-other-card");
			cardEl.tabIndex = 0;
			cardEl.setAttr("aria-selected", this.selectedInsertedCardIds.has(card.id) ? "true" : "false");
			if (this.selectedInsertedCardIds.has(card.id)) {
				cardEl.addClass("is-selected");
			}
			this.bindInsertedCardInteraction(cardEl, card, isMutating);

			const headerEl = cardEl.createDiv({ cls: "obcd-sidebar-inserted-card-header" });
			const metaEl = headerEl.createDiv({ cls: "obcd-sidebar-chips obcd-sidebar-inserted-card-meta" });
			for (const column of visibleColumns) {
				if (column.id === "target" || column.id === "tags") {
					continue;
				}

				const rawValue = column.getValue(card).trim();
				if (rawValue.length === 0) {
					continue;
				}

				this.createAnalysisChip(
					metaEl,
					`${column.label}: ${makePreview(rawValue, column.previewLength)}`,
					"obcd-sidebar-inserted-card-info",
				);
			}

			const tags = card.tags.length > 0 ? card.tags : ["No tags"];
			for (const tag of tags) {
				this.createAnalysisChip(
					metaEl,
					tag,
					`obcd-sidebar-inserted-card-tag ${tag === "No tags" ? "is-empty" : ""}`,
				);
			}

			const controlsEl = headerEl.createDiv({ cls: "obcd-sidebar-inserted-card-controls" });
			const checkboxEl = controlsEl.createEl("input", {
				attr: {
					type: "checkbox",
					"aria-label": `Select ${card.front}`,
					title: "Select card",
				},
			});
			checkboxEl.addClass("obcd-sidebar-inserted-card-checkbox");
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
			const actionEl = controlsEl.createDiv({ cls: "obcd-sidebar-inserted-card-actions" });
			const isConfirmingDelete = this.pendingSingleDeleteCardId === card.id;
			const deleteButtonEl = actionEl.createEl("button", {
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

			const questionEl = cardEl.createEl("strong", {
				cls: "obcd-sidebar-inserted-card-question",
				text: card.front,
			});
			questionEl.setAttr("title", card.front);

			const answerEl = cardEl.createEl("p", {
				cls: "obcd-sidebar-inserted-card-answer",
				text: card.back,
			});
			answerEl.setAttr("title", card.back);
		}
	}

	private bindInsertedCardInteraction(cardEl: HTMLElement, card: ExistingCardEntry, isMutating: boolean): void {
		cardEl.addEventListener("click", (event) => {
			if (isMutating || this.isInteractiveEventTarget(event.target)) {
				return;
			}

			void this.plugin.sidebar.revealCard(card);
		});

		cardEl.addEventListener("keydown", (event) => {
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

	private getTagFilterOptions(cards: ExistingCardEntry[]): CardTagFilterOption[] {
		const counts = new Map<string, number>();
		for (const card of cards) {
			for (const tag of new Set(card.tags)) {
				counts.set(tag, (counts.get(tag) ?? 0) + 1);
			}
		}

		return Array.from(counts.entries())
			.sort(([leftTag], [rightTag]) => leftTag.localeCompare(rightTag))
			.map(([tag, count]) => ({ tag, count }));
	}

	private matchesCard(card: ExistingCardEntry): boolean {
		if (this.activeTagFilter !== null && !card.tags.includes(this.activeTagFilter)) {
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

	private captureSearchInputSelection(inputEl: HTMLInputElement): SearchInputSelectionState {
		return {
			wasFocused: document.activeElement === inputEl,
			selectionStart: inputEl.selectionStart,
			selectionEnd: inputEl.selectionEnd,
		};
	}

	private restoreSearchInputSelection(selectionState: SearchInputSelectionState): void {
		if (!selectionState.wasFocused || this.searchInputEl === null) {
			return;
		}

		const maxOffset = this.searchInputEl.value.length;
		const selectionStart = Math.min(selectionState.selectionStart ?? maxOffset, maxOffset);
		const selectionEnd = Math.min(selectionState.selectionEnd ?? selectionStart, maxOffset);
		this.searchInputEl.focus();

		try {
			this.searchInputEl.setSelectionRange(selectionStart, selectionEnd);
		} catch {
			// Ignore selection restoration failures on unsupported input states.
		}
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
		isActive: boolean,
		isMutating: boolean,
		onClick: () => void,
	): void {
		const button = new ButtonComponent(containerEl)
			.setButtonText(label)
			.setDisabled(isMutating)
			.onClick(() => {
				onClick();
			});
		button.buttonEl.addClass("obcd-sidebar-scope-button");
		if (isActive) {
			button.buttonEl.addClass("is-active");
		}
	}

	private createCollapsibleSection(
		containerEl: HTMLElement,
		options: {
			title: string;
			detail: string;
			isOpen: boolean;
			onToggle: (isOpen: boolean) => void;
		},
	): HTMLElement {
		const detailsEl = containerEl.createEl("details", { cls: "obcd-sidebar-region" });
		detailsEl.open = options.isOpen;
		detailsEl.addEventListener("toggle", () => {
			options.onToggle(detailsEl.open);
		});

		const summaryEl = detailsEl.createEl("summary", { cls: "obcd-sidebar-region-summary" });
		summaryEl.createEl("span", {
			cls: "obcd-sidebar-region-title",
			text: options.title,
		});
		if (options.detail.trim().length > 0) {
			summaryEl.createEl("span", {
				cls: "obcd-sidebar-region-detail",
				text: options.detail,
			});
		}

		return detailsEl.createDiv({ cls: "obcd-sidebar-region-body" });
	}

	private createAnalysisChip(containerEl: HTMLElement, text: string, extraClass = ""): void {
		const chipEl = containerEl.createEl("span", {
			cls: "obcd-sidebar-chip",
			text,
		});
		if (extraClass.length > 0) {
			chipEl.addClass(...extraClass.split(" ").filter((value) => value.length > 0));
		}
	}

	private getTagFiltersSummaryLabel(totalCount: number, tagFilters: CardTagFilterOption[]): string {
		if (this.activeTagFilter === null) {
			return `Tag filters: All cards (${totalCount})`;
		}

		const activeTagOption = tagFilters.find((tagFilter) => tagFilter.tag === this.activeTagFilter);
		if (activeTagOption === undefined) {
			return `Tag filters: ${this.activeTagFilter}`;
		}

		return `Tag filters: ${activeTagOption.tag} (${activeTagOption.count})`;
	}

	private isInteractiveEventTarget(target: EventTarget | null): boolean {
		return target instanceof HTMLElement
			&& target.closest("button, a, input, textarea, select, label, summary") !== null;
	}

	private getGenerationPhaseLabel(phase: NonNullable<CardSidebarSnapshot["generationProgress"]>["phase"]): string {
		switch (phase) {
			case "preparing":
				return "Preparing";
			case "extracting":
				return "Extracting";
			case "grouping":
				return "Grouping";
			case "composing":
				return "Composing";
			case "writing":
				return "Writing";
			default:
				return phase;
		}
	}

	private getGenerationUnitLabel(phase: NonNullable<CardSidebarSnapshot["generationProgress"]>["phase"]): string {
		switch (phase) {
			case "composing":
				return "Topic";
			case "grouping":
				return "Topic";
			default:
				return "Chunk";
		}
	}

	private getAnalysisMetaLine(analysis: SidebarAnalysisSnapshot): string {
		const parts: string[] = [];
		const formattedTimestamp = this.formatTimestamp(analysis.generatedAt);
		if (formattedTimestamp.length > 0) {
			parts.push(`Generated ${formattedTimestamp}`);
		}
		if (analysis.mode !== null) {
			parts.push(this.getGenerationModeLabel(analysis.mode));
		}
		if (analysis.model.trim().length > 0) {
			parts.push(analysis.model.trim());
		}
		if (analysis.promptSource.trim().length > 0) {
			parts.push(`Prompt ${analysis.promptSource.trim()}`);
		}

		return parts.join(" • ");
	}

	private getTopicSectionSummary(analysis: SidebarAnalysisSnapshot | null): string {
		if (analysis === null || analysis.topicCount === 0) {
			return "No topics";
		}

		if (analysis.plannedTopicCount === 0) {
			return `${analysis.topicCount} topics`;
		}

		return `${analysis.topicCount} topics • ${analysis.plannedTopicCount} planned`;
	}

	private getBlockSectionSummary(analysis: SidebarAnalysisSnapshot | null): string {
		if (analysis === null || analysis.blockCount === 0) {
			return "No blocks";
		}

		if (analysis.skippedBlockCount === 0) {
			return `${analysis.blockCount} blocks`;
		}

		return `${analysis.blockCount} blocks • ${analysis.skippedBlockCount} skipped`;
	}

	private getFlashcardSectionSummary(cards: ExistingCardEntry[]): string {
		if (cards.length === 0) {
			return "No cards";
		}

		const generatedCount = cards.filter((card) => card.isPluginGenerated).length;
		if (generatedCount === 0) {
			return `${cards.length} cards`;
		}

		return `${cards.length} cards • ${generatedCount} generated`;
	}

	private getTopicStatusLabel(topic: SidebarTopicAnalysisItem): string {
		switch (topic.status) {
			case "planned":
				return "Selected for cards";
			case "eligible":
				return "Eligible";
			case "analysis-only":
			default:
				return "Analysis only";
		}
	}

	private getGenerationModeLabel(mode: NonNullable<SidebarAnalysisSnapshot["mode"]>): string {
		switch (mode) {
			case "folder-file":
				return "Folder run";
			case "selection":
				return "Selection";
			case "file":
			default:
				return "Current file";
		}
	}

	private formatTimestamp(value: string): string {
		if (value.trim().length === 0) {
			return "";
		}

		const date = new Date(value);
		if (Number.isNaN(date.getTime())) {
			return value;
		}

		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date);
	}

	private renderEmptyState(containerEl: HTMLElement, message: string): void {
		containerEl.createEl("p", {
			cls: "obcd-sidebar-empty",
			text: message,
		});
	}
}
