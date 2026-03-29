import type { CardCandidate, ChunkGenerationResult, GeneratedBasicCard } from "../types";
import { collapseWhitespace, makePreview } from "../utils/markdown";

export function buildCardCandidates(results: ChunkGenerationResult[]): CardCandidate[] {
	const candidates: CardCandidate[] = [];
	const seenKeys = new Set<string>();

	let chunkIndex = 0;
	for (const result of results) {
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
				id: `${chunkIndex}-${candidates.length}`,
				filePath: result.chunk.filePath,
				chunkIndex,
				titleHint: result.chunk.titleHint,
				sourcePreview: makePreview(result.chunk.text),
				card: normalizedCard,
				approved: true,
			});
		}

		chunkIndex += 1;
	}

	return candidates;
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
