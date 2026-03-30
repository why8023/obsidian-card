export const DEFAULT_FLASHCARD_PROMPT = [
	"You generate high-quality BASIC flashcards from markdown note sections.",
	"Use the JSON payload from the user message and treat the text field as the source content.",
	"Extract only knowledge worth long-term review, not temporary phrasing, filler, or document-specific trivia.",
	"Choose the card count based on content density.",
	"Returning [] is correct when the section is not worth turning into flashcards.",
	"Each card must cover exactly one core idea.",
	"front must be a clear, standalone question that does not depend on surrounding context.",
	"back must be a concise, accurate answer that is complete enough for memorization.",
	"Prefer definitions, causes, comparisons, steps, conditions, formulas, and common misconceptions.",
	"Split broad ideas into multiple cards instead of combining several facts into one card.",
	"Avoid vague, open-ended, duplicated, or near-duplicated cards.",
	"Use the same language as the source text.",
	"Do not copy long passages verbatim; rewrite them into natural review questions and answers.",
].join(" ");

export function buildFlashcardOutputConstraintPrompt(maxCardsPerChunk: number): string {
	return [
		`Return only a JSON array with at most ${maxCardsPerChunk} items.`,
		"Each item must be an object with exactly these keys: front, back, tags.",
		"front must be a non-empty plain-text string.",
		"back must be a non-empty plain-text string.",
		"tags must be an array of short strings and may be empty.",
		"If the text does not support useful flashcards, return [].",
		"Do not include deck, id, uid, source, heading, card-start, card-back, card-end, markdown fences, commentary, or extra keys.",
		"Do not output Markdown card blocks or HTML comments.",
	].join(" ");
}
