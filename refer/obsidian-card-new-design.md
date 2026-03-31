# OBCD 新制卡方案设计文档

## 需求重述

当前仓库的主流程仍然是“按选区 / 文件 / 文件夹切块，然后每个 chunk 直接调用模型生成 BASIC 卡片”，这会天然偏向局部抽取，而不是全文理解后的重要性排序。新的目标不是继续微调 prompt，而是把整体范式改成：先理解全文，再按重要性分配有限卡片预算，先产出核心卡，再决定是否产出次要卡；遇到超大内容时，不再强行全文制卡，而是先做结构规划或缩小范围。

## 当前仓库现状

当前入口仍然集中在 `src/main.ts`，由 `registerCommands`、`FlashcardWorkflow`、`CardSidebarController`、`CardSidebarView` 和设置页组成。命令层保留了四个生成入口：选区、当前文件、光标前内容、文件夹。当前工作流 `src/workflow/cardWorkflow.ts` 的主链路是：

1. 解析目标
2. 用 `buildSelectionChunks` / `buildFileChunks` 切出 `ContentChunk`
3. 对每个 chunk 调 `AiCardGenerator.generate`
4. 用 `buildReviewGroups` 组装候选卡
5. 直接写回 Markdown

当前 `types.ts` 里的核心结构仍然围绕 `ContentChunk -> GeneratedBasicCard -> ChunkGenerationResult` 设计，说明仓库还没有“知识单元”“全局排序”“策略选择器”这几层抽象。设置页 `src/settings.ts` 里也还是旧范式配置，例如 `maxCardsPerChunk`、`temperature`、`globalPrompt`、`folder prompt rules` 等，尚未出现全文预算、规模上限、降级模式等设置项。

因此，本次重构不是对单个函数做小修，而是要在保留现有插件壳、Provider、侧边栏、写回能力的前提下，重构生成范式。

## 新方案的核心原则

### 目标

1. 先做全文理解，再做卡片表达。
2. 卡片预算在全文级决定，而不是每个 chunk 各自产出几张。
3. 默认先生成核心卡；只有在预算允许且内容确实值得时，才生成次要卡。
4. 超大内容不强行全文制卡，而是自动降级成“结构规划”或“章节级制卡”。
5. 继续只支持 BASIC 卡片，不引入额外卡型复杂度。
6. 不恢复独立审核流，仍以“生成后写回 + 侧边栏管理/删除”为主。

### 非目标

1. 不在本插件内实现 Anki 同步协议。
2. 不引入稳定 `uid/id/rev` 体系作为当前阶段前提。
3. 不追求“整本书一次制卡”。
4. 不要求一次请求把全文原文全部送入模型。

## 新的总体架构

新的总体架构改为五层：

1. 文档解析层：把文件切成有结构信息的 chunk，但不直接出卡。
2. 知识提取层：把每个 chunk 提取成“知识单元”，而不是 flashcard。
3. 全局整合层：在全文级做去重、合并、重要性排序、预算分配。
4. 卡片生成层：仅对入选的知识主题，结合原文证据生成最终 BASIC 卡。
5. 写回与管理层：继续沿用当前 Markdown 写回、侧边栏展示、删除和撤销删除能力。

## 核心新概念

### 有效学习单元

系统不把“任意长度的文件”都视为可直接全文制卡的对象。需要引入“有效学习单元”概念：单篇文章、单章笔记、单主题长文通常是有效学习单元；整本书、超长资料汇编、多主题混杂大文件通常不是。

### 策略选择器

在正式生成前，必须先做一次范围估算，再选择处理策略，而不是直接进入生成。策略至少包含：

1. `direct-global`：适合小文档。直接做全文级知识单元整合和全局排序。
2. `hierarchical-global`：适合中等文档。先局部知识单元，再做章节级 / 中间层摘要，再做全文排序。
3. `chapter-planning`：适合超大文档。先输出内容地图和章节优先级，不直接出卡。
4. `refuse-or-scope`：适合极端超限。提示用户缩小范围，或只允许按选区/章节处理。

### 知识单元

新的中间表示不再是卡片，而是知识单元。建议定义为：

- `id`
- `filePath`
- `sectionKey`
- `headingPath`
- `titleHint`
- `statement`
- `kind`
- `importanceLocal`
- `candidateQuestionIntent`
- `evidenceExcerpt`
- `sourceHash`
- `tokenEstimate`

其中：

- `statement` 表示该知识点的标准化陈述。
- `kind` 区分“核心概念 / 重要结论 / 次要补充 / 背景 / 例子 / 流程细节 / 无需制卡”。
- `importanceLocal` 表示该知识点在当前 chunk 内的重要程度。
- `candidateQuestionIntent` 表示后续成卡的意图，而不是最终 question 文案。

### 全局主题

在知识单元之上，再定义“全局主题”。多个相近知识单元经全局去重与合并后，可归并为一个全局主题。建议定义为：

- `topicId`
- `canonicalStatement`
- `memberUnitIds`
- `importanceGlobal`
- `coverageSections`
- `tier`
- `recommendedCardCount`
- `evidenceRefs`

其中 `tier` 至少有两档：`core` 和 `secondary`。

## 详细流程设计

### 第 0 步：目标解析

保留当前命令入口和 `targetResolver` 体系，但要在工作流内区分“作用域”：

- 选区模式：默认允许直接走 `direct-global`，因为范围天然有限。
- 当前文件模式：根据估算结果决定策略。
- 光标前模式：视为文件的截断子范围。
- 文件夹模式：不做跨文件全文排序。仍按文件逐个处理，但每个文件内部采用新的全文制卡范式。

### 第 1 步：范围估算

新增 `ScopeEstimator`，输入为 `TFile + content + chunks`，输出：

- `characterCount`
- `chunkCount`
- `headingCount`
- `headingDepth`
- `estimatedInputTokens`
- `estimatedKnowledgeUnitCount`
- `isLikelyBookLikeDocument`
- `recommendedStrategy`
- `reason`

估算不能只看字符数，还要看 chunk 数和 heading 结构。因为从制卡角度，“20 万字但结构单一”和“5 万字但有 300 个小节”的复杂度不同。

### 第 2 步：文档解析

继续复用 `buildSelectionChunks` / `buildFileChunks`。这层仍然保留当前能力：

- 跳过已有 card block
- 保留 `sectionKey`
- 保留 `headingPath`
- 保留 `insertOffset`
- 支持 `upToOffset`

但这层不再把 chunk 视为“最终出卡单元”，而只视为“理解单元”。

### 第 3 步：知识提取

新增 `KnowledgeExtractor`。对每个 chunk 请求模型时，不再要求直接返回 `front/back/tags` 数组，而要求返回知识单元数组。典型输出应包含：

- 该段的主题是什么
- 有哪些值得长期记忆的知识点
- 每个知识点属于核心还是次要
- 哪些属于例子/背景/流程痕迹，不应制卡
- 每个知识点对应的原文证据片段

这里要强调：

1. 可以返回空数组。
2. 默认每个 chunk 的知识单元数量也要有上限。
3. 同一 chunk 不应为了“覆盖全面”而拆太多单元。

### 第 4 步：分层整合

根据策略不同，整合方式不同。

#### `direct-global`

直接将所有 chunk 的知识单元送入 `GlobalRanker`，完成：

- 去重
- 相似合并
- 全局重要性排序
- 分配核心/次要层级
- 按全文预算截断

#### `hierarchical-global`

先按高层 heading 对知识单元做一轮章节级合并，再把章节级结果做全文合并。这个模式最多允许 2~3 层压缩，不允许无限级摘要。

#### `chapter-planning`

不直接产出卡片。只产出：

- 内容地图
- 各章节一句话摘要
- 各章节预计卡片价值密度
- 推荐优先制卡章节

然后停止当前任务，或者只继续处理最优先的一章 / 用户指定章节。

### 第 5 步：全局预算分配

必须新增预算器 `CardBudgetAllocator`，负责控制：

- 全文最大总卡数
- 核心卡最大数
- 次要卡最大数
- 单个主题最大可生成张数
- 单个章节最多可占用的预算比例

预算分配原则：

1. 先分配核心卡预算。
2. 若核心卡已覆盖主要知识骨架，次要卡可为 0。
3. 不为了“覆盖全面”凑满预算。
4. 核心主题内部也要限制拆卡数量，防止一个主题内部再次碎裂。

### 第 6 步：回原文生成卡片

新增 `CardComposer`。只对已入选的全局主题生成最终 BASIC 卡。这里不能只基于压缩后的全局摘要写卡，必须把：

- 全局主题的标准化陈述
- 该主题关联的源知识单元
- 相关原文证据片段
- 目标作用域的语言

一起送给模型，要求产出最终 `front/back/tags`。

这一步的作用是避免“摘要损失导致的错误成卡”。

### 第 7 步：写回与展示

继续复用当前 `writeApprovedCardGroups`、`cardBlockParser`、`CardSidebarController` 和 `CardSidebarView`。

但需要增加一类新元信息（内部使用，不必写进 card block 元数据）：

- 本次任务类型
- 策略类型
- 预算信息
- 每张卡对应的主题来源

这些信息至少应写入 debug artifact，方便排查“为什么这张卡入选了、为什么另一张没入选”。

## 超大内容与极端情况处理

### 输入规模上限

必须新增以下上限：

1. 单次任务最大估算输入 token
2. 单次任务最大 chunk 数
3. 单次任务最大累计 LLM 调用次数
4. 单次任务最大摘要层级深度
5. 单次任务最大 wall time

只要任一项触发上限，就不能继续走全文制卡。

### 自动降级

当文件过大、结构过深或看起来像“整本书”时，系统必须自动切换到 `chapter-planning` 或 `refuse-or-scope`，而不是硬做。

推荐输出应包括：

- 当前内容超出单次全文制卡的有效范围
- 推荐优先制卡的章节 / 片段
- 是否可只对前 N 个一级标题做第一轮制卡
- 是否建议改用“按选区制卡”或“按章节制卡”

### 文件夹模式的边界

文件夹模式不做跨文件全局排序。原因是跨文件全文理解会使问题变得像“整本书/整套资料制卡”，复杂度和失真都会显著上升。文件夹模式继续保持“逐文件处理”，但每个文件内部采用新方案。

## 更新机制设计

新的范式下，更新策略不建议做“旧卡保留 + 智能补充”，因为这会引入严重的重复和残留问题。推荐采用“作用域重建”。

### 默认策略

1. 选区模式：删除该选区作用域下原有插件卡，再重新生成。
2. 当前文件模式：支持两种策略：
   - 全文件重建
   - 章节级重建（推荐作为增强功能）
3. 光标前模式：只重建光标前涉及的作用域。
4. 文件夹模式：逐文件按上述规则处理。

### 原因

当前插件内部没有稳定卡片身份和强来源绑定，因此“精细 diff 更新”成本高且容易出错；作用域重建更符合当前仓库边界，也更容易保持结果一致性。

## 模块重构建议

### 保留模块

以下模块建议保留主体能力：

- `src/main.ts`
- `src/commands/index.ts`
- `src/generation/contentChunkBuilder.ts`
- `src/generation/targetResolver.ts`
- `src/providerConfig.ts`
- `src/prompts/promptResolver.ts`
- `src/writing/flashcardWriter.ts`
- `src/utils/cardBlockParser.ts`
- `src/ui/cardSidebarController.ts`
- `src/ui/cardSidebarView.ts`
- `src/debug/debugService.ts`

### 需要重写或大改的模块

#### `src/workflow/cardWorkflow.ts`

应从“单阶段 chunk -> card orchestrator”改为“多阶段 strategy-driven orchestrator”。

#### `src/generation/cardGenerator.ts`

当前它专门负责“chunk 直接出卡”。应改造成更底层的通用 LLM 调用器，或者拆成：

- `llmClient.ts`
- `knowledgeExtractor.ts`
- `globalRanker.ts`
- `cardComposer.ts`

### 建议新增模块

1. `src/planning/scopeEstimator.ts`
2. `src/planning/strategyChooser.ts`
3. `src/knowledge/knowledgeExtractor.ts`
4. `src/knowledge/knowledgeNormalizer.ts`
5. `src/knowledge/globalRanker.ts`
6. `src/knowledge/budgetAllocator.ts`
7. `src/composition/cardComposer.ts`
8. `src/debug/debugSchemas.ts`

## 类型系统改造建议

`src/types.ts` 需要扩充，而不是只围绕 `GeneratedBasicCard`。

建议新增：

- `ScopeEstimate`
- `GenerationStrategy`
- `KnowledgeUnit`
- `KnowledgeTopic`
- `BudgetPlan`
- `PlanningResult`
- `CardDraftSource`
- `CompositionRequest`
- `RegenerationScope`

同时现有 `GenerationProgressPhase` 也建议扩展为：

- `preparing`
- `estimating`
- `extracting`
- `ranking`
- `composing`
- `writing`
- `planning-only`

## 设置项改造建议

当前设置里仍然是旧范式参数，例如 `maxCardsPerChunk`。新方案需要新增一组更高层配置。

### 建议新增设置

1. `coreCardBudget`：核心卡预算。
2. `secondaryCardBudget`：次要卡预算。
3. `maxTotalCardsPerDocument`：全文总卡上限。
4. `maxKnowledgeUnitsPerChunk`：单 chunk 最多提取多少知识单元。
5. `maxChunksForDirectGlobal`：超过该阈值不再使用 `direct-global`。
6. `maxTokensForDirectGlobal`：全文直接整合估算 token 上限。
7. `maxHierarchyDepth`：最大摘要层级深度。
8. `oversizeStrategy`：超限时是自动做章节规划，还是拒绝并提示缩小范围。
9. `defaultRegenerationPolicy`：默认更新策略，是全文件重建还是局部重建。

### 兼容旧设置

保留 `maxCardsPerChunk` 一段时间作为兼容配置，但标记为旧模式参数。最终应由“知识单元上限”和“全文预算”替代。

## Prompt 设计改造建议

新的 prompt 不应再只有一套“从 section 直接生成 flashcards”的默认提示。建议拆成三类 prompt。

### 1. 知识提取 prompt

任务：从 chunk 中提取知识单元，不要直接输出卡片。

输出应强调：

- 哪些知识点值得长期记忆
- 哪些不值得
- 每个点的局部重要性
- 每个点的类型与证据

### 2. 全局排序 prompt

任务：从多个知识单元中进行全局去重、合并、排序和层级划分。

输出应强调：

- 全文最核心的知识骨架
- 重要性排序
- 哪些只是次要补充
- 为什么不选某些点

### 3. 成卡 prompt

任务：对已入选的主题，结合原文证据写成 BASIC 卡。

输出应强调：

- 问题要独立成立
- 答案要精炼但足够完整
- 不重复主题
- 不为了拆卡而拆卡

## 侧边栏与交互建议

当前侧边栏已经能展示现有卡、删除卡、撤销删除和显示进度。这个方向应继续保留。

建议新增的仅是“任务解释性”信息，而不是恢复独立审核流。例如：

1. 当前任务采用了哪种策略。
2. 这轮总预算是多少。
3. 核心卡和次要卡分别生成了多少张。
4. 是否因为超限而降级成章节规划。
5. 是否执行了全文件重建 / 局部重建。

这些信息可以优先放在 debug artifact；UI 只需暴露必要摘要，避免侧边栏过重。

## Debug 与可观测性

当前仓库已有 `DebugService`。新方案必须继续强化 debug，因为多阶段流程的可观测性比旧方案更重要。

建议每次运行至少记录：

1. 范围估算结果。
2. 选择了哪种策略，以及原因。
3. 每个 chunk 抽取出的知识单元。
4. 全局合并前后的知识主题变化。
5. 预算分配结果。
6. 最终入选主题列表。
7. 最终生成的卡片及其来源主题。
8. 超限降级信息。

## 实施顺序建议

### 第一阶段：最小可用重构

目标：用尽量少的改动，把“chunk 直接出卡”改成“chunk 先提知识单元 -> 全局排序 -> 再出卡”。

实施：

1. 新增 `KnowledgeUnit` 类型。
2. 新增 `KnowledgeExtractor`。
3. 新增 `GlobalRanker`。
4. 新增 `CardComposer`。
5. 将 `cardWorkflow.ts` 改成三阶段 orchestrator。
6. 暂时只支持 `direct-global` 和 `refuse-or-scope`。

### 第二阶段：中等文档支持

目标：支持 `hierarchical-global`。

实施：

1. 新增中间层摘要 / 合并器。
2. 新增层级深度控制。
3. 新增更多 debug 记录。

### 第三阶段：超大文档降级与更新策略

目标：处理“像一本书”的极端情况。

实施：

1. 新增 `chapter-planning`。
2. 新增范围重建策略。
3. 新增设置页中的规模上限配置。
4. 新增重建命令或重建选项。

## 验收标准

### 功能验收

1. 对中短文章，卡片总数明显低于旧方案，但核心覆盖率更高。
2. 同一篇文章中，不同 section 的知识点会在全文预算下竞争，而不是各自产卡。
3. 对超大文件，不会无限执行，而会自动降级到章节规划或提示缩小范围。
4. 更新同一文件时，不会持续堆积重复卡，而是按作用域重建。
5. 侧边栏仍可正常查看、删除、撤销删除和显示进度。

### 质量验收

1. 核心卡优先，次要卡可选。
2. 卡片数量受全文预算控制，而不是 chunk 数量线性膨胀。
3. 卡片问题和答案明显更接近“全文主干知识”，而不是局部碎片。
4. 对例子、背景、局部过程记录的误生成率显著下降。

## 最终结论

本次重构的本质，不是继续优化“局部抽卡 prompt”，而是把 OBCD 的生成范式从“按块直接抽卡”升级为“按全文做知识竞争后再成卡”。

一句话概括新的主链路：

先估算范围，决定策略；再按 chunk 抽取知识单元；再在全文级做去重、排序和预算分配；最后只对入选主题结合原文生成 BASIC 卡片；若内容超出有效学习单元，则自动降级为章节规划或缩小范围处理。
