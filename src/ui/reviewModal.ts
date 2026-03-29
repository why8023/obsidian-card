import { ButtonComponent, Modal, TextAreaComponent, TextComponent } from "obsidian";

import type { App } from "obsidian";

import type { CardCandidate, GeneratedBasicCard, ReviewResult } from "../types";

interface ReviewModalOptions {
	filePath: string;
	candidates: CardCandidate[];
	isBatchMode: boolean;
}

export class ReviewModal extends Modal {
	private readonly candidates: CardCandidate[];
	private readonly options: ReviewModalOptions;
	private resolvePromise: ((result: ReviewResult) => void) | null = null;
	private completed = false;

	constructor(app: App, options: ReviewModalOptions) {
		super(app);
		this.options = options;
		this.candidates = options.candidates.map((candidate) => ({
			...candidate,
			card: {
				...candidate.card,
				tags: [...candidate.card.tags],
			},
		}));
	}

	openAndWait(): Promise<ReviewResult> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}

	onOpen(): void {
		this.modalEl.addClass("obcard-review-modal");
		this.titleEl.setText("Review basic flashcards");

		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("obcard-review-content");

		contentEl.createEl("p", {
			cls: "obcard-review-file-path",
			text: this.options.filePath,
		});

		contentEl.createEl("p", {
			cls: "obcard-review-summary",
			text: `${this.candidates.length} candidate card${this.candidates.length === 1 ? "" : "s"}`,
		});

		const bulkActions = contentEl.createDiv({ cls: "obcard-review-actions" });
		this.createActionButton(bulkActions, "Keep all", () => this.setApprovedState(true));
		this.createActionButton(bulkActions, "Discard all", () => this.setApprovedState(false));

		const listEl = contentEl.createDiv({ cls: "obcard-review-list" });
		this.renderCandidates(listEl);

		const footerEl = contentEl.createDiv({ cls: "obcard-review-actions obcard-review-actions--footer" });

		if (this.options.isBatchMode) {
			this.createActionButton(footerEl, "Skip file", () => {
				this.finish({
					action: "skip-file",
					approvedCards: [],
				});
			});

			this.createActionButton(footerEl, "Stop batch", () => {
				this.finish({
					action: "stop-batch",
					approvedCards: [],
				});
			}, { warning: true });
		}

		this.createActionButton(footerEl, "Cancel", () => {
			this.finish({
				action: "cancel",
				approvedCards: [],
			});
		});

		this.createActionButton(footerEl, "Confirm insert", () => {
			this.finish({
				action: "confirm",
				approvedCards: this.collectApprovedCards(),
			});
		}, { cta: true });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.completed) {
			this.finish({
				action: "cancel",
				approvedCards: [],
			});
		}
	}

	private renderCandidates(containerEl: HTMLElement): void {
		for (const [index, candidate] of this.candidates.entries()) {
			const cardEl = containerEl.createDiv({ cls: "obcard-review-card" });

			const headerEl = cardEl.createDiv({ cls: "obcard-review-card-header" });
			const checkboxEl = headerEl.createEl("input", {
				attr: {
					type: "checkbox",
				},
			});
			checkboxEl.checked = candidate.approved;
			checkboxEl.addEventListener("change", () => {
				candidate.approved = checkboxEl.checked;
			});

			const headingEl = headerEl.createDiv({ cls: "obcard-review-card-heading" });
			headingEl.createEl("strong", { text: `Card ${index + 1}` });
			if (candidate.titleHint) {
				headingEl.createEl("span", {
					cls: "obcard-review-chip",
					text: candidate.titleHint,
				});
			}

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

			const previewEl = cardEl.createDiv({ cls: "obcard-review-source" });
			previewEl.createEl("div", {
				cls: "obcard-review-field-label",
				text: "Source preview",
			});
			previewEl.createEl("pre", {
				cls: "obcard-review-source-preview",
				text: candidate.sourcePreview,
			});
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
		const checkboxElements = this.contentEl.findAll(".obcard-review-card-header input[type='checkbox']");
		for (const [index, candidate] of this.candidates.entries()) {
			candidate.approved = approved;
			const checkboxEl = checkboxElements[index] as HTMLInputElement | undefined;
			if (checkboxEl) {
				checkboxEl.checked = approved;
			}
		}
	}

	private collectApprovedCards(): GeneratedBasicCard[] {
		return this.candidates
			.filter((candidate) => candidate.approved)
			.map((candidate) => ({
				front: candidate.card.front,
				back: candidate.card.back,
				tags: [...candidate.card.tags],
			}));
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
