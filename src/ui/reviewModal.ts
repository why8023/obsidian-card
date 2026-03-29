import { ButtonComponent, Modal, TextAreaComponent, TextComponent } from "obsidian";

import type { App } from "obsidian";

import type { ReviewGroup, ReviewResult } from "../types";
import { cloneReviewGroups, collectApprovedGroups, setAllReviewGroupsApproved, setReviewGroupApproved } from "./reviewState";

interface ReviewModalOptions {
	filePath: string;
	groups: ReviewGroup[];
	isBatchMode: boolean;
}

export class ReviewModal extends Modal {
	private readonly groups: ReviewGroup[];
	private readonly options: ReviewModalOptions;
	private readonly groupCheckboxes = new Map<string, HTMLInputElement[]>();
	private resolvePromise: ((result: ReviewResult) => void) | null = null;
	private completed = false;

	constructor(app: App, options: ReviewModalOptions) {
		super(app);
		this.options = options;
		this.groups = cloneReviewGroups(options.groups);
	}

	openAndWait(): Promise<ReviewResult> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("obcard-review-modal");
		this.titleEl.setText("Review flashcards by section");

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("obcard-review-content");

		contentEl.createEl("p", {
			cls: "obcard-review-file-path",
			text: this.options.filePath,
		});

		const totalCandidateCount = this.groups.reduce((sum, group) => sum + group.candidates.length, 0);
		contentEl.createEl("p", {
			cls: "obcard-review-summary",
			text: `${totalCandidateCount} candidate card${totalCandidateCount === 1 ? "" : "s"} across ${this.groups.length} section${this.groups.length === 1 ? "" : "s"}`,
		});

		const bulkActions = contentEl.createDiv({ cls: "obcard-review-actions" });
		this.createActionButton(bulkActions, "Keep all", () => this.setApprovedState(true));
		this.createActionButton(bulkActions, "Discard all", () => this.setApprovedState(false));

		const listEl = contentEl.createDiv({ cls: "obcard-review-list" });
		this.renderGroups(listEl);

		const footerEl = contentEl.createDiv({ cls: "obcard-review-actions obcard-review-actions--footer" });

		if (this.options.isBatchMode) {
			this.createActionButton(footerEl, "Skip file", () => {
				this.finish({
					action: "skip-file",
					approvedGroups: [],
				});
			});

			this.createActionButton(footerEl, "Stop batch", () => {
				this.finish({
					action: "stop-batch",
					approvedGroups: [],
				});
			}, { warning: true });
		}

		this.createActionButton(footerEl, "Cancel", () => {
			this.finish({
				action: "cancel",
				approvedGroups: [],
			});
		});

		this.createActionButton(footerEl, "Confirm insert", () => {
			this.finish({
				action: "confirm",
				approvedGroups: collectApprovedGroups(this.groups),
			});
		}, { cta: true });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.completed) {
			this.finish({
				action: "cancel",
				approvedGroups: [],
			});
		}
	}

	private renderGroups(containerEl: HTMLElement): void {
		for (const group of this.groups) {
			const groupEl = containerEl.createDiv({ cls: "obcard-review-card" });

			const headerEl = groupEl.createDiv({ cls: "obcard-review-card-header" });
			const headingEl = headerEl.createDiv({ cls: "obcard-review-card-heading" });
			headingEl.createEl("strong", {
				text: group.chunk.titleHint ?? this.options.filePath.split("/").pop() ?? "Section",
			});
			headingEl.createEl("span", {
				cls: "obcard-review-chip",
				text: `${group.candidates.length} card${group.candidates.length === 1 ? "" : "s"}`,
			});

			if (group.chunk.headingPath.length > 1) {
				headingEl.createEl("div", {
					cls: "obcard-review-source-preview",
					text: group.chunk.headingPath.join(" > "),
				});
			}

			const groupActionsEl = headerEl.createDiv({ cls: "obcard-review-actions" });
			this.createActionButton(groupActionsEl, "Keep section", () => this.setGroupApprovedState(group.chunk.sectionKey, true));
			this.createActionButton(groupActionsEl, "Discard section", () => this.setGroupApprovedState(group.chunk.sectionKey, false));

			const previewEl = groupEl.createDiv({ cls: "obcard-review-source" });
			previewEl.createEl("div", {
				cls: "obcard-review-field-label",
				text: "Source preview",
			});
			previewEl.createEl("pre", {
				cls: "obcard-review-source-preview",
				text: group.sourcePreview,
			});

			const checkboxElements: HTMLInputElement[] = [];
			for (const [index, candidate] of group.candidates.entries()) {
				const cardEl = groupEl.createDiv({ cls: "obcard-review-field" });
				const cardHeaderEl = cardEl.createDiv({ cls: "obcard-review-card-header" });
				const checkboxEl = cardHeaderEl.createEl("input", {
					attr: {
						type: "checkbox",
					},
				});
				checkboxEl.checked = candidate.approved;
				checkboxEl.addEventListener("change", () => {
					candidate.approved = checkboxEl.checked;
				});
				checkboxElements.push(checkboxEl);

				cardHeaderEl.createEl("strong", {
					text: `Card ${index + 1}`,
				});

				this.createTextAreaField(cardEl, "Front", candidate.card.front, 3, (value) => {
					candidate.card.front = value;
				});
				this.createTextAreaField(cardEl, "Back", candidate.card.back, 4, (value) => {
					candidate.card.back = value;
				});
				this.createTextField(cardEl, "Tags", candidate.card.tags.join(", "), (value) => {
					candidate.card.tags = value
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag.length > 0);
				});
			}

			this.groupCheckboxes.set(group.chunk.sectionKey, checkboxElements);
		}
	}

	private createTextAreaField(containerEl: HTMLElement, label: string, value: string, rows: number, onChange: (value: string) => void): void {
		const fieldEl = containerEl.createDiv({ cls: "obcard-review-field" });
		fieldEl.createEl("label", {
			cls: "obcard-review-field-label",
			text: label,
		});

		const textArea = new TextAreaComponent(fieldEl);
		textArea.inputEl.rows = rows;
		textArea.inputEl.addClass("obcard-review-textarea");
		textArea
			.setValue(value)
			.onChange(onChange);
	}

	private createTextField(containerEl: HTMLElement, label: string, value: string, onChange: (value: string) => void): void {
		const fieldEl = containerEl.createDiv({ cls: "obcard-review-field" });
		fieldEl.createEl("label", {
			cls: "obcard-review-field-label",
			text: label,
		});

		const text = new TextComponent(fieldEl);
		text.inputEl.addClass("obcard-review-input");
		text
			.setValue(value)
			.setPlaceholder("Enter tags")
			.onChange(onChange);
	}

	private createActionButton(containerEl: HTMLElement, label: string, onClick: () => void, options?: { cta?: boolean; warning?: boolean }): void {
		const button = new ButtonComponent(containerEl).setButtonText(label).onClick(() => onClick());
		if (options?.cta) {
			button.setCta();
		}
		if (options?.warning) {
			button.setWarning();
		}
	}

	private setApprovedState(approved: boolean): void {
		setAllReviewGroupsApproved(this.groups, approved);

		for (const group of this.groups) {
			for (const checkboxEl of this.groupCheckboxes.get(group.chunk.sectionKey) ?? []) {
				checkboxEl.checked = approved;
			}
		}
	}

	private setGroupApprovedState(sectionKey: string, approved: boolean): void {
		setReviewGroupApproved(this.groups, sectionKey, approved);

		for (const checkboxEl of this.groupCheckboxes.get(sectionKey) ?? []) {
			checkboxEl.checked = approved;
		}
	}

	private finish(result: ReviewResult): void {
		if (this.completed) {
			return;
		}

		this.completed = true;
		const resolve = this.resolvePromise;
		this.resolvePromise = null;
		resolve?.(result);
		this.close();
	}
}
