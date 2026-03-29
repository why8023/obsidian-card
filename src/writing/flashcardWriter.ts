import type { TFile, Vault } from "obsidian";

import type { GeneratedBasicCard } from "../types";
import { collectMarkdownHeadings, detectNewline } from "../utils/markdown";

const FLASHCARDS_HEADING = "## Flashcards";

export async function appendCardsToFlashcardsSection(vault: Vault, file: TFile, cards: GeneratedBasicCard[]): Promise<number> {
	if (cards.length === 0) {
		return 0;
	}

	await vault.process(file, (content) => insertCards(content, cards));
	return cards.length;
}

export function renderBasicCard(card: GeneratedBasicCard, newline = "\n"): string {
	const tags = sanitizeTags(card.tags);
	const tagsAttribute = tags.length > 0 ? ` tags="${tags.join(",")}"` : "";

	return [
		`<!-- card-start${tagsAttribute} -->`,
		card.front.trim(),
		"<!-- card-back -->",
		card.back.trim(),
		"<!-- card-end -->",
	].join(newline);
}

function insertCards(content: string, cards: GeneratedBasicCard[]): string {
	const newline = detectNewline(content);
	const renderedBlock = cards.map((card) => renderBasicCard(card, newline)).join(`${newline}${newline}`);
	const flashcardsSection = findFlashcardsSection(content);

	if (flashcardsSection === null) {
		return appendNewFlashcardsSection(content, renderedBlock, newline);
	}

	const beforeSectionEnd = content.slice(0, flashcardsSection.end).replace(/\s*$/, "");
	const afterSectionEnd = content.slice(flashcardsSection.end).replace(/^\s*/, "");

	if (afterSectionEnd.length === 0) {
		return `${beforeSectionEnd}${newline}${newline}${renderedBlock}${newline}`;
	}

	return `${beforeSectionEnd}${newline}${newline}${renderedBlock}${newline}${newline}${afterSectionEnd}`;
}

function appendNewFlashcardsSection(content: string, renderedBlock: string, newline: string): string {
	const trimmedContent = content.replace(/\s*$/, "");
	if (trimmedContent.length === 0) {
		return `${FLASHCARDS_HEADING}${newline}${newline}${renderedBlock}${newline}`;
	}

	return `${trimmedContent}${newline}${newline}${FLASHCARDS_HEADING}${newline}${newline}${renderedBlock}${newline}`;
}

function findFlashcardsSection(content: string): { end: number } | null {
	const headings = collectMarkdownHeadings(content);
	const flashcardsHeadingIndex = headings.findIndex((heading) => heading.level === 2 && heading.title.trim().toLowerCase() === "flashcards");

	if (flashcardsHeadingIndex === -1) {
		return null;
	}

	let end = content.length;

	for (const heading of headings.slice(flashcardsHeadingIndex + 1)) {
		if (heading.level <= 2) {
			end = heading.from;
			break;
		}
	}

	return { end };
}

function sanitizeTags(tags: string[]): string[] {
	const results: string[] = [];
	const seenTags = new Set<string>();

	for (const rawTag of tags) {
		const sanitizedTag = rawTag
			.replace(/"/g, "")
			.replace(/,/g, " ")
			.trim();

		if (sanitizedTag.length === 0) {
			continue;
		}

		const dedupeKey = sanitizedTag.toLowerCase();
		if (seenTags.has(dedupeKey)) {
			continue;
		}

		seenTags.add(dedupeKey);
		results.push(sanitizedTag);
	}

	return results;
}
