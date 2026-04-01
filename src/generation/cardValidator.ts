import type { GeneratedBasicCard } from "../types";
import { collapseWhitespace } from "../utils/markdown";

const CONTEXT_DEPENDENT_PATTERN = /\b(this section|this chapter|the section above|the section below|above|below|here|the title|this heading|that heading)\b/i;
const CONTEXT_DEPENDENT_PATTERN_ZH = /(本节|本章|上文|下文|前文|后文|这里|该节|该标题|这个标题)/;

export function validateGeneratedCards(cards: GeneratedBasicCard[]): GeneratedBasicCard[] {
	const acceptedCards: GeneratedBasicCard[] = [];
	const seenKeys = new Set<string>();

	for (const rawCard of cards) {
		const normalizedCard = normalizeCard(rawCard);
		if (normalizedCard === null) {
			continue;
		}

		if (!isStandaloneCard(normalizedCard)) {
			continue;
		}

		const dedupeKey = `${normalizedCard.front.toLowerCase()}::${normalizedCard.back.toLowerCase()}`;
		if (seenKeys.has(dedupeKey)) {
			continue;
		}

		seenKeys.add(dedupeKey);
		acceptedCards.push(normalizedCard);
	}

	return acceptedCards;
}

function normalizeCard(card: GeneratedBasicCard): GeneratedBasicCard | null {
	const front = collapseWhitespace(card.front);
	const back = collapseWhitespace(card.back);
	const tags = normalizeTags(card.tags);

	if (front.length < 8 || back.length < 4) {
		return null;
	}

	if (front.toLowerCase() === back.toLowerCase()) {
		return null;
	}

	return {
		front,
		back,
		tags,
	};
}

function isStandaloneCard(card: GeneratedBasicCard): boolean {
	return !containsContextDependentLanguage(card.front) && !containsContextDependentLanguage(card.back);
}

function containsContextDependentLanguage(value: string): boolean {
	return CONTEXT_DEPENDENT_PATTERN.test(value) || CONTEXT_DEPENDENT_PATTERN_ZH.test(value);
}

function normalizeTags(tags: string[]): string[] {
	const results: string[] = [];
	const seenTags = new Set<string>();

	for (const rawTag of tags) {
		const normalizedTag = rawTag.trim();
		if (normalizedTag.length === 0) {
			continue;
		}

		const dedupeKey = normalizedTag.toLowerCase();
		if (seenTags.has(dedupeKey)) {
			continue;
		}
		seenTags.add(dedupeKey);
		results.push(normalizedTag);
	}

	return results;
}
