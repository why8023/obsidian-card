import type { TextRange } from "../types";

export interface ProtectedBlockRule {
	name: string;
	startPattern: string;
	endPattern: string;
}

type PatternMatch = TextRange;

interface CompiledProtectedBlockRule {
	name: string;
	startPattern: RegExp;
	endPattern: RegExp;
}

export const DEFAULT_PROTECTED_BLOCK_RULES: ProtectedBlockRule[] = [
	{
		name: "Obar record",
		startPattern: "<!--\\s*obar-record-start:",
		endPattern: "<!--\\s*obar-record-end\\s*-->",
	},
];

export function cloneProtectedBlockRules(rules: ProtectedBlockRule[]): ProtectedBlockRule[] {
	return rules.map((rule) => ({
		name: rule.name,
		startPattern: rule.startPattern,
		endPattern: rule.endPattern,
	}));
}

export function normalizeProtectedBlockRules(
	value: unknown,
	fallback = DEFAULT_PROTECTED_BLOCK_RULES,
): ProtectedBlockRule[] {
	if (!Array.isArray(value)) {
		return cloneProtectedBlockRules(fallback);
	}

	return value
		.map((entry) => parseProtectedBlockRule(entry))
		.filter((entry): entry is ProtectedBlockRule => entry !== null);
}

export function collectProtectedBlockRanges(content: string, rules: ProtectedBlockRule[]): TextRange[] {
	const ranges = compileProtectedBlockRules(rules)
		.flatMap((rule) => collectRangesForRule(content, rule));

	return mergeOverlappingRanges(ranges);
}

function parseProtectedBlockRule(value: unknown): ProtectedBlockRule | null {
	if (!isRecord(value)) {
		return null;
	}

	return {
		name: readString(value.name),
		startPattern: readPattern(value.startPattern),
		endPattern: readPattern(value.endPattern),
	};
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readPattern(value: unknown): string {
	return typeof value === "string"
		? value.replace(/\r\n/g, "\n").trim()
		: "";
}

function compileProtectedBlockRules(rules: ProtectedBlockRule[]): CompiledProtectedBlockRule[] {
	return rules
		.map((rule, index) => compileProtectedBlockRule(rule, index))
		.filter((rule): rule is CompiledProtectedBlockRule => rule !== null);
}

function compileProtectedBlockRule(rule: ProtectedBlockRule, index: number): CompiledProtectedBlockRule | null {
	const name = rule.name.trim().length > 0 ? rule.name.trim() : `Rule ${index + 1}`;
	const startPattern = compilePattern(rule.startPattern, name, "start");
	const endPattern = compilePattern(rule.endPattern, name, "end");
	if (!startPattern || !endPattern) {
		return null;
	}

	return {
		name,
		startPattern,
		endPattern,
	};
}

function compilePattern(source: string, ruleName: string, boundary: "start" | "end"): RegExp | null {
	const normalizedSource = source.trim();
	if (normalizedSource.length === 0) {
		return null;
	}

	try {
		return new RegExp(normalizedSource, "gm");
	} catch (error) {
		console.warn(`OBCD protected block rule "${ruleName}" has an invalid ${boundary} pattern.`, error);
		return null;
	}
}

function collectRangesForRule(content: string, rule: CompiledProtectedBlockRule): TextRange[] {
	const ranges: TextRange[] = [];
	let searchOffset = 0;

	while (searchOffset < content.length) {
		const startMatch = findNextPatternMatch(content, rule.startPattern, searchOffset);
		if (startMatch === null) {
			break;
		}

		const endMatch = findNextPatternMatch(content, rule.endPattern, startMatch.to);
		if (endMatch === null) {
			ranges.push({
				from: startMatch.from,
				to: content.length,
			});
			break;
		}

		ranges.push({
			from: startMatch.from,
			to: endMatch.to,
		});
		searchOffset = endMatch.to;
	}

	return ranges;
}

function findNextPatternMatch(content: string, pattern: RegExp, offset: number): PatternMatch | null {
	pattern.lastIndex = offset;

	let match = pattern.exec(content);
	while (match) {
		const matchedText = match[0] ?? "";
		if (matchedText.length > 0) {
			return {
				from: match.index,
				to: pattern.lastIndex,
			};
		}

		const nextOffset = match.index + 1;
		if (nextOffset > content.length) {
			break;
		}

		pattern.lastIndex = nextOffset;
		match = pattern.exec(content);
	}

	return null;
}

function mergeOverlappingRanges(ranges: TextRange[]): TextRange[] {
	if (ranges.length === 0) {
		return [];
	}

	const sortedRanges = [...ranges].sort((left, right) => (
		left.from - right.from
		|| left.to - right.to
	));
	const merged: TextRange[] = [];

	for (const range of sortedRanges) {
		const previousRange = merged[merged.length - 1];
		if (!previousRange || range.from >= previousRange.to) {
			merged.push({
				from: range.from,
				to: range.to,
			});
			continue;
		}

		previousRange.to = Math.max(previousRange.to, range.to);
	}

	return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
