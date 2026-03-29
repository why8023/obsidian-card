import type { ApprovedCardGroup, ReviewGroup } from "../types";

export function cloneReviewGroups(groups: ReviewGroup[]): ReviewGroup[] {
	return groups.map((group) => ({
		...group,
		chunk: {
			...group.chunk,
			headingPath: [...group.chunk.headingPath],
			range: { ...group.chunk.range },
			bodyRange: { ...group.chunk.bodyRange },
		},
		candidates: group.candidates.map((candidate) => ({
			...candidate,
			card: {
				...candidate.card,
				tags: [...candidate.card.tags],
			},
		})),
	}));
}

export function collectApprovedGroups(groups: ReviewGroup[]): ApprovedCardGroup[] {
	const results: ApprovedCardGroup[] = [];

	for (const group of groups) {
		const cards = group.candidates
			.filter((candidate) => candidate.approved)
			.map((candidate) => ({
				front: candidate.card.front,
				back: candidate.card.back,
				tags: [...candidate.card.tags],
			}));

		if (cards.length === 0) {
			continue;
		}

		results.push({
			chunk: group.chunk,
			cards,
		});
	}

	return results;
}

export function setAllReviewGroupsApproved(groups: ReviewGroup[], approved: boolean): void {
	for (const group of groups) {
		setReviewGroupApproved(groups, group.chunk.sectionKey, approved);
	}
}

export function setReviewGroupApproved(groups: ReviewGroup[], sectionKey: string, approved: boolean): void {
	const group = groups.find((entry) => entry.chunk.sectionKey === sectionKey);
	if (!group) {
		return;
	}

	for (const candidate of group.candidates) {
		candidate.approved = approved;
	}
}
