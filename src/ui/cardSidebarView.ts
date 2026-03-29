import {
	ButtonComponent,
	ItemView,
	SearchComponent,
	TextAreaComponent,
	TextComponent,
} from "obsidian";

import type { WorkspaceLeaf } from "obsidian";

import type ObsidianCardPlugin from "../main";
import type { CardCandidate, ExistingCardEntry, ReviewGroup, SidebarReviewSession } from "../types";
import { setAllReviewGroupsApproved, setReviewGroupApproved } from "./reviewState";
import { OBCARD_SIDEBAR_VIEW_TYPE } from "./cardSidebarController";

type SidebarScope = "all" | "pending" | "inserted";

export class CardSidebarView extends ItemView {
	private readonly plugin: ObsidianCardPlugin;
	private unsubscribe: (() => void) | null = null;
	private searchText = "";
	private filterScope: SidebarScope = "all";
	private actionsInitialized = false;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianCardPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return OBCARD_SIDEBAR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Flashcards";
	}

	getIcon(): string {
		return "panel-right-open";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("obcard-sidebar-view");

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

		const rootEl = contentEl.createDiv({ cls: "obcard-sidebar" });
		const displayFile = state.displayFile;

		if (displayFile === null) {
			this.renderEmptyState(rootEl, "Open a Markdown file or generate flashcards to start reviewing.");
			return;
		}

		const pendingSession = state.pendingSession?.file.path === displayFile.path
			? state.pendingSession
			: null;

		const pendingCandidateCount = pendingSession === null
			? 0
			: pendingSession.groups.reduce((sum, group) => sum + group.candidates.length, 0);
		const approvedPendingCount = pendingSession === null
			? 0
			: pendingSession.groups.reduce((sum, group) => sum + group.candidates.filter((candidate) => candidate.approved).length, 0);

		this.renderFileHeader(rootEl, {
			name: displayFile.basename,
			path: displayFile.path,
			pendingCandidateCount,
			approvedPendingCount,
			insertedCount: state.existingCards.length,
			isDetachedFromActiveFile: pendingSession !== null && state.activeFile?.path !== displayFile.path,
			activeFileName: state.activeFile?.basename ?? "",
		});

		this.renderFilterBar(rootEl);

		const hasPendingScope = this.filterScope === "all" || this.filterScope === "pending";
		const hasInsertedScope = this.filterScope === "all" || this.filterScope === "inserted";

		if (pendingSession !== null && hasPendingScope) {
			this.renderPendingSection(rootEl, pendingSession);
		}

		if (hasInsertedScope) {
			this.renderInsertedSection(rootEl, state.existingCards);
		}
	}

	private renderFileHeader(
		containerEl: HTMLElement,
		state: {
			name: string;
			path: string;
			pendingCandidateCount: number;
			approvedPendingCount: number;
			insertedCount: number;
			isDetachedFromActiveFile: boolean;
			activeFileName: string;
		},
	): void {
		const headerEl = containerEl.createDiv({ cls: "obcard-sidebar-header" });
		headerEl.createEl("h3", {
			cls: "obcard-sidebar-title",
			text: state.name,
		});
		headerEl.createEl("p", {
			cls: "obcard-sidebar-path",
			text: state.path,
		});

		const chipsEl = headerEl.createDiv({ cls: "obcard-sidebar-chips" });
		if (state.pendingCandidateCount > 0) {
			chipsEl.createEl("span", {
				cls: "obcard-sidebar-chip",
				text: `Pending ${state.approvedPendingCount}/${state.pendingCandidateCount}`,
			});
		}

		chipsEl.createEl("span", {
			cls: "obcard-sidebar-chip",
			text: `Inserted ${state.insertedCount}`,
		});

		if (state.isDetachedFromActiveFile && state.activeFileName.length > 0) {
			headerEl.createEl("p", {
				cls: "obcard-sidebar-note",
				text: `Review stays pinned to this file. Current editor: ${state.activeFileName}.`,
			});
		}
	}

	private renderFilterBar(containerEl: HTMLElement): void {
		const filterEl = containerEl.createDiv({ cls: "obcard-sidebar-filter" });
		const search = new SearchComponent(filterEl);
		search.setPlaceholder("Filter cards, sections, or tags");
		search.setValue(this.searchText);
		search.onChange((value) => {
			this.searchText = value;
			this.render();
		});

		const scopeEl = filterEl.createDiv({ cls: "obcard-sidebar-scope" });
		this.createScopeButton(scopeEl, "All", "all");
		this.createScopeButton(scopeEl, "Pending", "pending");
		this.createScopeButton(scopeEl, "Inserted", "inserted");
	}

	private createScopeButton(containerEl: HTMLElement, label: string, value: SidebarScope): void {
		const button = new ButtonComponent(containerEl)
			.setButtonText(label)
			.onClick(() => {
				this.filterScope = value;
				this.render();
			});

		button.buttonEl.addClass("obcard-sidebar-scope-button");
		if (this.filterScope === value) {
			button.buttonEl.addClass("is-active");
		}
	}

	private renderPendingSection(containerEl: HTMLElement, session: SidebarReviewSession): void {
		const sectionEl = containerEl.createDiv({ cls: "obcard-sidebar-section" });
		sectionEl.createEl("h4", {
			cls: "obcard-sidebar-section-title",
			text: "Pending review",
		});

		const actionsEl = sectionEl.createDiv({ cls: "obcard-sidebar-actions" });
		const isSubmitting = session.status === "submitting";
		this.createActionButton(actionsEl, "Keep all", () => {
			setAllReviewGroupsApproved(session.groups, true);
			this.render();
		}, { disabled: isSubmitting });
		this.createActionButton(actionsEl, "Discard all", () => {
			setAllReviewGroupsApproved(session.groups, false);
			this.render();
		}, { disabled: isSubmitting });
		this.createActionButton(actionsEl, "Cancel", () => {
			this.plugin.sidebar.cancelPendingReview();
		}, { disabled: isSubmitting });
		this.createActionButton(actionsEl, "Confirm insert", () => {
			this.plugin.sidebar.requestConfirmPendingReview();
		}, { cta: true, disabled: isSubmitting });

		if (isSubmitting) {
			sectionEl.createEl("p", {
				cls: "obcard-sidebar-note",
				text: "Writing approved cards into the note...",
			});
		}

		const listEl = sectionEl.createDiv({ cls: "obcard-sidebar-group-list" });
		const filteredGroups = this.getFilteredPendingGroups(session.groups);

		if (filteredGroups.length === 0) {
			this.renderEmptyState(listEl, "No pending cards match the current filter.");
			return;
		}

		for (const group of filteredGroups) {
			this.renderPendingGroup(listEl, group, isSubmitting);
		}
	}

	private renderPendingGroup(
		containerEl: HTMLElement,
		group: {
			group: ReviewGroup;
			candidates: CardCandidate[];
		},
		isSubmitting: boolean,
	): void {
		const groupEl = containerEl.createDiv({ cls: "obcard-sidebar-card" });
		const headerEl = groupEl.createDiv({ cls: "obcard-sidebar-card-header" });
		const headingEl = headerEl.createDiv({ cls: "obcard-sidebar-card-heading" });
		headingEl.createEl("strong", {
			text: group.group.chunk.titleHint ?? group.group.chunk.file.basename,
		});
		headingEl.createEl("span", {
			cls: "obcard-sidebar-chip",
			text: `${group.candidates.filter((candidate) => candidate.approved).length}/${group.candidates.length}`,
		});

		if (group.group.chunk.headingPath.length > 1) {
			groupEl.createEl("p", {
				cls: "obcard-sidebar-subtle",
				text: group.group.chunk.headingPath.join(" > "),
			});
		}

		const groupActionsEl = headerEl.createDiv({ cls: "obcard-sidebar-actions" });
		this.createActionButton(groupActionsEl, "Keep section", () => {
			setReviewGroupApproved([group.group], group.group.chunk.sectionKey, true);
			this.render();
		}, { disabled: isSubmitting });
		this.createActionButton(groupActionsEl, "Discard section", () => {
			setReviewGroupApproved([group.group], group.group.chunk.sectionKey, false);
			this.render();
		}, { disabled: isSubmitting });

		const previewDetails = groupEl.createEl("details", { cls: "obcard-sidebar-preview" });
		previewDetails.createEl("summary", {
			text: "Source preview",
		});
		previewDetails.createEl("div", {
			cls: "obcard-sidebar-preview-body",
			text: group.group.sourcePreview,
		});

		for (const candidate of group.candidates) {
			const cardEl = groupEl.createDiv({ cls: "obcard-sidebar-field" });
			const cardHeaderEl = cardEl.createDiv({ cls: "obcard-sidebar-card-header" });
			const checkboxEl = cardHeaderEl.createEl("input", {
				attr: {
					type: "checkbox",
				},
			});
			checkboxEl.checked = candidate.approved;
			checkboxEl.disabled = isSubmitting;
			checkboxEl.addEventListener("change", () => {
				candidate.approved = checkboxEl.checked;
			});

			cardHeaderEl.createEl("strong", {
				text: "Card",
			});

			this.createTextAreaField(cardEl, "Front", candidate.card.front, 3, isSubmitting, (value) => {
				candidate.card.front = value;
			});
			this.createTextAreaField(cardEl, "Back", candidate.card.back, 4, isSubmitting, (value) => {
				candidate.card.back = value;
			});
			this.createTextField(cardEl, "Tags", candidate.card.tags.join(", "), isSubmitting, (value) => {
				candidate.card.tags = value
					.split(",")
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 0);
			});
		}
	}

	private renderInsertedSection(containerEl: HTMLElement, cards: ExistingCardEntry[]): void {
		const sectionEl = containerEl.createDiv({ cls: "obcard-sidebar-section" });
		sectionEl.createEl("h4", {
			cls: "obcard-sidebar-section-title",
			text: "Inserted cards",
		});

		const filteredCards = cards.filter((card) => this.matchesCard(card));
		if (filteredCards.length === 0) {
			this.renderEmptyState(sectionEl, "No inserted cards match the current filter.");
			return;
		}

		const listEl = sectionEl.createDiv({ cls: "obcard-sidebar-inserted-list" });
		for (const card of filteredCards) {
			const buttonEl = listEl.createEl("button", {
				cls: "obcard-sidebar-inserted-card",
				attr: {
					type: "button",
				},
			});
			buttonEl.addEventListener("click", () => {
				void this.plugin.sidebar.revealCard(card);
			});

			buttonEl.createEl("div", {
				cls: "obcard-sidebar-card-front",
				text: card.front,
			});
			buttonEl.createEl("div", {
				cls: "obcard-sidebar-card-back",
				text: card.back,
			});

			const metaEl = buttonEl.createDiv({ cls: "obcard-sidebar-card-meta" });
			metaEl.createEl("span", {
				text: card.titleHint,
			});
			metaEl.createEl("span", {
				text: `Card ${card.indexInSection + 1}`,
			});

			if (card.tags.length > 0) {
				const tagsEl = buttonEl.createDiv({ cls: "obcard-sidebar-tag-list" });
				for (const tag of card.tags) {
					tagsEl.createEl("span", {
						cls: "obcard-sidebar-chip",
						text: tag,
					});
				}
			}
		}
	}

	private getFilteredPendingGroups(groups: ReviewGroup[]): Array<{ group: ReviewGroup; candidates: CardCandidate[] }> {
		const results: Array<{ group: ReviewGroup; candidates: CardCandidate[] }> = [];

		for (const group of groups) {
			const groupMatches = this.matchesText([
				group.chunk.titleHint ?? "",
				group.chunk.headingPath.join(" > "),
				group.sourcePreview,
			]);

			const candidates = groupMatches
				? group.candidates
				: group.candidates.filter((candidate) => this.matchesText([
					candidate.card.front,
					candidate.card.back,
					candidate.card.tags.join(" "),
					candidate.sourcePreview,
				]));

			if (candidates.length === 0) {
				continue;
			}

			results.push({
				group,
				candidates,
			});
		}

		return results;
	}

	private matchesCard(card: ExistingCardEntry): boolean {
		return this.matchesText([
			card.front,
			card.back,
			card.tags.join(" "),
			card.titleHint,
			card.metadata.headingPath.join(" > "),
		]);
	}

	private matchesText(values: string[]): boolean {
		const query = this.searchText.trim().toLowerCase();
		if (query.length === 0) {
			return true;
		}

		return values.some((value) => value.toLowerCase().includes(query));
	}

	private createTextAreaField(
		containerEl: HTMLElement,
		label: string,
		value: string,
		rows: number,
		disabled: boolean,
		onChange: (value: string) => void,
	): void {
		const fieldEl = containerEl.createDiv({ cls: "obcard-sidebar-field" });
		fieldEl.createEl("label", {
			cls: "obcard-sidebar-label",
			text: label,
		});

		const textArea = new TextAreaComponent(fieldEl);
		textArea.inputEl.rows = rows;
		textArea.inputEl.addClass("obcard-sidebar-textarea");
		textArea.setDisabled(disabled);
		textArea
			.setValue(value)
			.onChange(onChange);
	}

	private createTextField(
		containerEl: HTMLElement,
		label: string,
		value: string,
		disabled: boolean,
		onChange: (value: string) => void,
	): void {
		const fieldEl = containerEl.createDiv({ cls: "obcard-sidebar-field" });
		fieldEl.createEl("label", {
			cls: "obcard-sidebar-label",
			text: label,
		});

		const text = new TextComponent(fieldEl);
		text.inputEl.addClass("obcard-sidebar-input");
		text.setDisabled(disabled);
		text
			.setValue(value)
			.setPlaceholder("Enter tags")
			.onChange(onChange);
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

	private renderEmptyState(containerEl: HTMLElement, message: string): void {
		containerEl.createEl("p", {
			cls: "obcard-sidebar-empty",
			text: message,
		});
	}
}
