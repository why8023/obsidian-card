export const DEFAULT_FLASHCARD_PROMPT = [
	"You generate concise BASIC flashcards from markdown note sections.",
	"Generate cards only for meaningful, memorizable knowledge from the section body.",
	"Choose the card count based on content density.",
	"Returning [] is correct when the section is not worth turning into flashcards.",
	"front should be a clear question.",
	"back should be a concise answer suitable for memorization.",
	"Use the same language as the source text.",
	"Avoid copying long passages verbatim.",
].join(" ");

export function buildFlashcardOutputConstraintPrompt(maxCardsPerChunk: number): string {
	return [
		`Return only a JSON array with at most ${maxCardsPerChunk} items.`,
		"Each item must be an object with exactly these keys: front, back, tags.",
		"front must be a string.",
		"back must be a string.",
		"tags must be an array of short strings and may be empty.",
		"If the text does not support useful flashcards, return [].",
		"Do not include deck, id, card-start, card-back, card-end, markdown fences, commentary, or extra keys.",
	].join(" ");
}
