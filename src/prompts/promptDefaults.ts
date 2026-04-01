const DEFAULT_OUTPUT_LANGUAGE_POLICY = [
	"所有自然语言输出字段默认使用简体中文。",
	"只有在任务本身、源材料、用户指令或领域惯例明确要求时，才切换为其他语言。",
	"代码、公式、文件路径、API 名称、专有名词以及为保证准确性必须保留的原文术语，可以保持原样。",
];

const LEGACY_OUTPUT_LANGUAGE_POLICY = [
	"Default to Simplified Chinese for all natural-language output fields.",
	"Switch to another language only when the task, source material, user instruction, or domain convention clearly requires it.",
	"Keep code, formulas, file paths, API names, proper nouns, and essential quoted terms in their original form when that improves accuracy.",
];

export const DEFAULT_KNOWLEDGE_EXTRACTION_PROMPT_TEMPLATE = [
	"你处在一个两阶段闪卡工作流的第 1 阶段，当前处理对象是一个合并后的 Markdown 知识块。",
	"不要生成闪卡。",
	"判断这个知识块是否包含值得带入后续主题归并的持久知识。",
	"如果包含，请返回简洁的 summary、简短的 topicHint 标签，以及一小段 evidenceExcerpt。",
	"如果不包含，请将 hasKnowledge 设为 false，保持 topicHint 为空，并在 rejectionReason 中说明原因。",
	"优先关注定义、核心概念、关键区分、因果关系、规则、结论以及对决策有价值的操作流程。",
	"降低对脚手架文字、过渡句、元数据、修辞性填充、孤立示例和低价值上下文的权重。",
	"summary 应概括这个知识块主要在讲什么。",
	"topicHint 应是一个简短的分组标签，用于归并讲述同一知识点的知识块。",
	"evidenceExcerpt 应是支持 summary 的最小必要原文片段。",
	"当 hasKnowledge 为 true 时，rejectionReason 应为空。",
	"如果 existingAnalysis 仍与当前知识块内容一致，请尽量保持一致。",
	...DEFAULT_OUTPUT_LANGUAGE_POLICY,
	"只返回 JSON，格式必须为 {\"hasKnowledge\":true|false,\"summary\":\"...\",\"topicHint\":\"...\",\"evidenceExcerpt\":\"...\",\"rejectionReason\":\"...\"}。",
].join("\n");

export const LEGACY_KNOWLEDGE_EXTRACTION_PROMPT_TEMPLATE = [
	"You are stage 1 of a two-stage flashcard workflow for one merged markdown chunk.",
	"Do not generate flashcards.",
	"Decide whether the chunk contains durable knowledge worth carrying into later topic grouping.",
	"If it does, return a concise summary, a short topicHint label, and a small evidenceExcerpt.",
	"If it does not, set hasKnowledge to false, keep topicHint empty, and explain why in rejectionReason.",
	"Prefer definitions, core concepts, distinctions, causal relations, rules, conclusions, and decision-relevant procedures.",
	"Down-rank scaffolding, transition text, metadata, rhetorical filler, isolated examples, and low-value context.",
	"summary should capture what the chunk mainly teaches.",
	"topicHint should be a short grouping label for chunks that teach the same knowledge point.",
	"evidenceExcerpt should be the smallest useful excerpt that supports the summary.",
	"rejectionReason should be empty when hasKnowledge is true.",
	"Stay consistent with any existingAnalysis when it still matches the current chunk content.",
	...LEGACY_OUTPUT_LANGUAGE_POLICY,
	"Return only JSON in the shape {\"hasKnowledge\":true|false,\"summary\":\"...\",\"topicHint\":\"...\",\"evidenceExcerpt\":\"...\",\"rejectionReason\":\"...\"}.",
].join("\n");

export const DEFAULT_GLOBAL_RANKING_PROMPT_TEMPLATE = [
	"你处在一个两阶段闪卡工作流的第 1b 阶段。",
	"你会收到同一篇笔记的分块分析结果，请把讲述同一知识点的知识块归并起来。",
	"即使两个知识点在原文中相邻，也要保持彼此独立，不要混成一个主题。",
	"把结果视为一次知识块划分：每个 chunk id 最多只能出现在一个 topic 中。",
	"即使某个主题暂时不应该生成闪卡，只要它代表一个独立知识点，也应创建 topic。",
	"对每个 topic 判断它是否值得制作闪卡。",
	"只有当一个 topic 表达了可长期复习、且并不琐碎的知识时，它通常才值得制卡。",
	"优先合并重复知识块，而不是为同一想法创建多个并行主题。",
	"文档预算如下：core={{coreCardBudget}}，secondary={{secondaryCardBudget}}，total={{maxTotalCardsPerDocument}}，maxCardsPerTopic={{maxCardsPerTopic}}。",
	"importanceScore 必须是 0 到 1 之间的数字。",
	"tier 只能是 core 或 secondary。",
	"当 shouldCreateCards 为 false 时，recommendedCardCount 必须为 0；否则它必须是不大于 maxCardsPerTopic 的小整数。",
	"当 shouldCreateCards 为 true 时，rejectionReason 应为空。",
	...DEFAULT_OUTPUT_LANGUAGE_POLICY,
	"只返回 JSON，格式必须为 {\"topics\": [...]}，其中字段包含 canonicalStatement、knowledgeGroup、summary、memberChunkIds、importanceScore、tier、recommendedCardCount、shouldCreateCards、rejectionReason。",
].join("\n");

export const LEGACY_GLOBAL_RANKING_PROMPT_TEMPLATE = [
	"You are stage 1b of a two-stage flashcard workflow.",
	"You receive chunk-level analyses for one note. Group chunks that teach the same knowledge point.",
	"Keep different knowledge points separate even if they are adjacent in the note.",
	"Treat the result as a chunk partition: each chunk id should appear in at most one topic.",
	"Create a topic even when it should not become flashcards yet, as long as it represents a distinct knowledge point.",
	"For each topic, decide whether it is worth making flashcards.",
	"A topic is usually card-worthy only when it expresses durable, non-trivial knowledge that can support standalone review.",
	"Prefer merging duplicate chunks over creating parallel topics for the same idea.",
	"The document budgets are: core={{coreCardBudget}}, secondary={{secondaryCardBudget}}, total={{maxTotalCardsPerDocument}}, maxCardsPerTopic={{maxCardsPerTopic}}.",
	"importanceScore must be a number from 0 to 1.",
	"tier must be either core or secondary.",
	"recommendedCardCount must be 0 when shouldCreateCards is false, otherwise a small integer no larger than maxCardsPerTopic.",
	"rejectionReason should be empty when shouldCreateCards is true.",
	...LEGACY_OUTPUT_LANGUAGE_POLICY,
	"Return only JSON in the shape {\"topics\": [...]} with fields: canonicalStatement, knowledgeGroup, summary, memberChunkIds, importanceScore, tier, recommendedCardCount, shouldCreateCards, rejectionReason.",
].join("\n");

export const DEFAULT_CARD_COMPOSITION_PROMPT_TEMPLATE = [
	"你需要基于提供的 source chunks，为一个知识主题生成最终的 BASIC 闪卡。",
	"问题必须能够独立成立，不能依赖标题、上下文段落，也不能使用“本节”“上文”“下文”“这里”“标题”等指代性说法。",
	"答案必须简洁、完整，并忠实于源材料。",
	"每张卡只考察一个清晰、稳定的知识点，不要考察琐碎信息或纯文档脚手架内容。",
	"不要把多个独立想法揉进同一张卡片。",
	"如果请求的数量高于真正高质量卡片的数量，可以返回更少的卡片。",
	"在遵循默认输出语言规则的同时，保持对源证据的忠实。",
	...DEFAULT_OUTPUT_LANGUAGE_POLICY,
	"最多返回 {{cardCount}} 张卡片。",
	"只返回 JSON 数组，格式为 {front, back, tags}。tags 可以为空。",
].join("\n");

export const LEGACY_CARD_COMPOSITION_PROMPT_TEMPLATE = [
	"You compose final BASIC flashcards for one knowledge topic using only the provided source chunks.",
	"Questions must stand on their own and must not rely on headings, surrounding prose, or phrases like this section, above, below, here, or the title.",
	"Answers must be concise, complete, and faithful to the source material.",
	"Each card should test one clear, durable knowledge point, not trivia or mere document scaffolding.",
	"Do not blend separate ideas into one card.",
	"If the requested count is higher than the number of good cards, return fewer cards.",
	"Stay faithful to the source evidence while following the default output-language policy.",
	...LEGACY_OUTPUT_LANGUAGE_POLICY,
	"Return at most {{cardCount}} cards for the topic.",
	"Return only a JSON array of {front, back, tags}. tags may be empty.",
].join("\n");

export function buildKnowledgeExtractionPrompt(template: string, customInstruction: string): string {
	return withCustomInstruction(
		template,
		customInstruction,
		DEFAULT_KNOWLEDGE_EXTRACTION_PROMPT_TEMPLATE,
	);
}

export function buildGlobalRankingPrompt(
	options: {
		coreCardBudget: number;
		secondaryCardBudget: number;
		maxTotalCardsPerDocument: number;
		maxCardsPerTopic: number;
	},
	template: string,
	customInstruction: string,
): string {
	return withCustomInstruction(
		renderPromptTemplate(template, {
			coreCardBudget: options.coreCardBudget,
			secondaryCardBudget: options.secondaryCardBudget,
			maxTotalCardsPerDocument: options.maxTotalCardsPerDocument,
			maxCardsPerTopic: options.maxCardsPerTopic,
		}, DEFAULT_GLOBAL_RANKING_PROMPT_TEMPLATE),
		customInstruction,
		renderPromptTemplate(DEFAULT_GLOBAL_RANKING_PROMPT_TEMPLATE, {
			coreCardBudget: options.coreCardBudget,
			secondaryCardBudget: options.secondaryCardBudget,
			maxTotalCardsPerDocument: options.maxTotalCardsPerDocument,
			maxCardsPerTopic: options.maxCardsPerTopic,
		}, DEFAULT_GLOBAL_RANKING_PROMPT_TEMPLATE),
	);
}

export function buildCardCompositionPrompt(
	options: {
		cardCount: number;
	},
	template: string,
	customInstruction: string,
): string {
	return withCustomInstruction(
		renderPromptTemplate(template, {
			cardCount: options.cardCount,
		}, DEFAULT_CARD_COMPOSITION_PROMPT_TEMPLATE),
		customInstruction,
		renderPromptTemplate(DEFAULT_CARD_COMPOSITION_PROMPT_TEMPLATE, {
			cardCount: options.cardCount,
		}, DEFAULT_CARD_COMPOSITION_PROMPT_TEMPLATE),
	);
}

function withCustomInstruction(basePrompt: string, customInstruction: string, fallbackPrompt: string): string {
	const normalizedBasePrompt = normalizePromptTemplate(basePrompt, fallbackPrompt);
	const trimmedInstruction = customInstruction.trim();
	if (trimmedInstruction.length === 0) {
		return normalizedBasePrompt;
	}

	return [
		normalizedBasePrompt,
		`补充生成规则：${trimmedInstruction}`,
	].join("\n");
}

function renderPromptTemplate(
	template: string,
	variables: Record<string, string | number>,
	fallbackTemplate: string,
): string {
	const normalizedTemplate = normalizePromptTemplate(template, fallbackTemplate);
	return normalizedTemplate.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, variableName: string) => {
		const value = variables[variableName];
		return value === undefined ? match : String(value);
	});
}

function normalizePromptTemplate(template: string, fallbackTemplate: string): string {
	const normalizedTemplate = template.replace(/\r\n/g, "\n").trim();
	if (normalizedTemplate.length > 0) {
		return normalizedTemplate;
	}

	return fallbackTemplate;
}
