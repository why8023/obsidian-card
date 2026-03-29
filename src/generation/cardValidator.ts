import type { CardCandidate, ChunkGenerationResult, GeneratedBasicCard, ReviewGroup } from "../types";
import { collapseWhitespace, makePreview } from "../utils/markdown";

export function buildReviewGroups(results: ChunkGenerationResult[]): ReviewGroup[] {
	const groups: ReviewGroup[] = [];
	const seenKeys = new Set<string>();

	for (const result of results) {
		const candidates: CardCandidate[] = [];

		for (const rawCard of result.cards) {
			const normalizedCard = normalizeCard(rawCard);
			if (normalizedCard === null) {
				continue;
			}

			const dedupeKey = `${normalizedCard.front.toLowerCase()}::${normalizedCard.back.toLowerCase()}`;
			if (seenKeys.has(dedupeKey)) {
				continue;
			}
			seenKeys.add(dedupeKey);

			candidates.push({
				id: `${result.chunk.sectionKey}-${candidates.length}`,
				chunkId: result.chunk.sectionKey,
				filePath: result.chunk.filePath,
				titleHint: result.chunk.titleHint,
				sourcePreview: makePreview(result.chunk.text),
				card: normalizedCard,
				approved: true,
			});
		}

		if (candidates.length === 0) {
			continue;
		}

		groups.push({
			chunk: result.chunk,
			sourcePreview: makePreview(result.chunk.text),
			candidates,
		});
	}

	return groups;
}

function normalizeCard(card: GeneratedBasicCard): GeneratedBasicCard | null {
	const front = collapseWhitespace(card.front);
	const back = collapseWhitespace(card.back);
	const tags = normalizeTags(card.tags);

	if (front.length === 0 || back.length === 0) {
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
