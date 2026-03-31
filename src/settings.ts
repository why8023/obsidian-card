import { App, Notice, PluginSettingTab, Setting } from "obsidian";

import { getDebugArtifactsDirectory } from "./debug/debugService";
import { LlmClient } from "./generation/llmClient";
import type ObcdPlugin from "./main";
import {
	DEFAULT_OBAR_FRONTMATTER_KEYS,
	normalizeObarFrontmatterKeys,
} from "./obarCompatibility";
import {
	PROVIDER_PRESET_INFO,
	createDefaultProvider,
	getActiveProvider,
	getDefaultModelForPreset,
	getProviderChatCompletionsUrl,
	type FlashcardProvider,
	type FlashcardProviderPresetType,
} from "./providerConfig";
import {
	listPromptTemplateFiles,
	normalizeConfiguredFolderPath,
	normalizeConfiguredTemplatePath,
} from "./prompts/promptResolver";
import { SIDEBAR_TABLE_COLUMN_IDS, type SidebarTableColumnId } from "./types";

const SETTINGS_SCHEMA_VERSION = 10;
export const DEFAULT_GENERATED_CARD_TAG = "OBCD";

export type OversizeStrategy = "chapter-planning" | "refuse-or-scope";
export type RegenerationPolicy = "full-document-rebuild" | "scope-rebuild";

export interface FlashcardGenerationSettings {
	model: string;
	temperature: number;
	addObcdTag: boolean;
	defaultTag: string;
	coreCardBudget: number;
	secondaryCardBudget: number;
	maxTotalCardsPerDocument: number;
	maxCardsPerTopic: number;
	maxKnowledgeUnitsPerChunk: number;
	maxChunksForDirectGlobal: number;
	maxTokensForDirectGlobal: number;
	maxTaskInputTokens: number;
	maxTaskChunks: number;
	maxTaskLlmCalls: number;
	maxHierarchyDepth: number;
	oversizeStrategy: OversizeStrategy;
	defaultRegenerationPolicy: RegenerationPolicy;
	maxCardsPerChunk: number;
}

export interface ObcdDebugSettings {
	enabled: boolean;
}

export interface ObcdSidebarSettings {
	frontPreviewLength: number;
	visibleTableColumns: SidebarTableColumnId[];
}

export interface ObcdObarCompatibilitySettings {
	enabled: boolean;
	frontmatterKeys: string[];
}

export interface ObcdCompatibilitySettings {
	obar: ObcdObarCompatibilitySettings;
}

export interface ObcdFolderPromptRule {
	noteFolder: string;
	templatePath: string;
}

export interface ObcdPromptSettings {
	globalPrompt: string;
	templatesFolder: string;
	folderRules: ObcdFolderPromptRule[];
}

export interface ObcdSettings {
	version: number;
	providers: FlashcardProvider[];
	activeProviderId: string;
	generation: FlashcardGenerationSettings;
	prompts: ObcdPromptSettings;
	sidebar: ObcdSidebarSettings;
	compatibility: ObcdCompatibilitySettings;
	debug: ObcdDebugSettings;
}

export const DEFAULT_GENERATION_SETTINGS: FlashcardGenerationSettings = {
	model: getDefaultModelForPreset("openrouter"),
	temperature: 0.2,
	addObcdTag: true,
	defaultTag: DEFAULT_GENERATED_CARD_TAG,
	coreCardBudget: 6,
	secondaryCardBudget: 4,
	maxTotalCardsPerDocument: 10,
	maxCardsPerTopic: 2,
	maxKnowledgeUnitsPerChunk: 4,
	maxChunksForDirectGlobal: 18,
	maxTokensForDirectGlobal: 12000,
	maxTaskInputTokens: 22000,
	maxTaskChunks: 36,
	maxTaskLlmCalls: 48,
	maxHierarchyDepth: 2,
	oversizeStrategy: "chapter-planning",
	defaultRegenerationPolicy: "full-document-rebuild",
	maxCardsPerChunk: 3,
};

export const DEFAULT_SIDEBAR_SETTINGS: ObcdSidebarSettings = {
	frontPreviewLength: 72,
	visibleTableColumns: ["target"],
};

export const DEFAULT_PROMPT_SETTINGS: ObcdPromptSettings = {
	globalPrompt: "",
	templatesFolder: "",
	folderRules: [],
};

export const DEFAULT_DEBUG_SETTINGS: ObcdDebugSettings = {
	enabled: false,
};

export const DEFAULT_COMPATIBILITY_SETTINGS: ObcdCompatibilitySettings = {
	obar: {
		enabled: false,
		frontmatterKeys: [...DEFAULT_OBAR_FRONTMATTER_KEYS],
	},
};

export const DEFAULT_SETTINGS: ObcdSettings = createDefaultSettings();

export function createDefaultSettings(): ObcdSettings {
	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers: [createDefaultProvider("openrouter")],
		activeProviderId: "primary",
		generation: {
			...DEFAULT_GENERATION_SETTINGS,
		},
		prompts: {
			...DEFAULT_PROMPT_SETTINGS,
			folderRules: [],
		},
		sidebar: {
			...DEFAULT_SIDEBAR_SETTINGS,
			visibleTableColumns: [...DEFAULT_SIDEBAR_SETTINGS.visibleTableColumns],
		},
		compatibility: {
			obar: {
				...DEFAULT_COMPATIBILITY_SETTINGS.obar,
				frontmatterKeys: [...DEFAULT_COMPATIBILITY_SETTINGS.obar.frontmatterKeys],
			},
		},
		debug: {
			...DEFAULT_DEBUG_SETTINGS,
		},
	};
}

export function parseSettings(data: unknown): ObcdSettings {
	const defaults = createDefaultSettings();
	if (!isRecord(data)) {
		return defaults;
	}

	const providers = parseProviders(data.providers, defaults.providers);
	const activeProviderId = typeof data.activeProviderId === "string" && providers.some((provider) => provider.id === data.activeProviderId)
		? data.activeProviderId
		: providers[0]?.id ?? defaults.activeProviderId;

	return {
		version: SETTINGS_SCHEMA_VERSION,
		providers,
		activeProviderId,
		generation: parseGenerationSettings(data.generation, defaults.generation),
		prompts: parsePromptSettings(data.prompts, defaults.prompts),
		sidebar: parseSidebarSettings(data.sidebar, defaults.sidebar),
		compatibility: parseCompatibilitySettings(data.compatibility, defaults.compatibility),
		debug: parseDebugSettings(data.debug, defaults.debug),
	};
}

export class ObcdSettingTab extends PluginSettingTab {
	plugin: ObcdPlugin;
	private isTestingConnection = false;

	constructor(app: App, plugin: ObcdPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const activeProvider = getActiveProvider(this.plugin.settings);
		const presetInfo = PROVIDER_PRESET_INFO[activeProvider.presetType];
		const templateOptions = listPromptTemplateFiles(this.app, this.plugin.settings.prompts.templatesFolder);

		new Setting(containerEl)
			.setName("模型服务")
			.setDesc("配置用于生成卡片候选结果的大模型服务。")
			.setHeading();

		containerEl.createEl("p", {
			cls: "obcd-settings-hint",
			text: presetInfo.description,
		});

		new Setting(containerEl)
			.setName("服务商预设")
			.setDesc("先选择平台预设，再按需调整实际请求的 Base URL。")
			.addDropdown((dropdown) => {
				for (const [presetType, info] of Object.entries(PROVIDER_PRESET_INFO) as Array<[FlashcardProviderPresetType, typeof presetInfo]>) {
					dropdown.addOption(presetType, info.label);
				}

				dropdown
					.setValue(activeProvider.presetType)
					.onChange(async (value) => {
						const currentProvider = getActiveProvider(this.plugin.settings);
						const nextPresetType = value as FlashcardProviderPresetType;
						const previousDefaultModel = getDefaultModelForPreset(currentProvider.presetType);
						const nextDefaultModel = getDefaultModelForPreset(nextPresetType);

						this.updateActiveProvider({
							...currentProvider,
							presetType: nextPresetType,
							baseUrl: PROVIDER_PRESET_INFO[nextPresetType].defaultBaseUrl,
						});

						if (this.plugin.settings.generation.model.trim().length === 0 || this.plugin.settings.generation.model === previousDefaultModel) {
							this.plugin.settings.generation.model = nextDefaultModel;
						}

						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("基础 URL")
			.setDesc("这里只填写基础地址，插件会自动补上 chat completions 路径。")
			.addText((text) => text
				.setPlaceholder(PROVIDER_PRESET_INFO[activeProvider.presetType].defaultBaseUrl)
				.setValue(activeProvider.baseUrl)
				.onChange(async (value) => {
					this.updateActiveProvider({
						...getActiveProvider(this.plugin.settings),
						baseUrl: value.trim(),
					});
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("API Key")
			.setDesc(presetInfo.requireApiKey
				? "当前预设必须填写。"
				: "本地服务或代理服务可选。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("输入 API Key")
					.setValue(activeProvider.apiKey)
					.onChange(async (value) => {
						this.updateActiveProvider({
							...getActiveProvider(this.plugin.settings),
							apiKey: value.trim(),
						});
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("最终请求地址")
			.setDesc("根据预设和 Base URL 自动计算。这是插件实际发起生成请求的终点地址。")
			.addText((text) => text
				.setValue(getProviderChatCompletionsUrl(activeProvider))
				.setDisabled(true));

		new Setting(containerEl)
			.setName("生成参数")
			.setDesc("配置模型名称和采样参数。")
			.setHeading();

		new Setting(containerEl)
			.setName("模型名称")
			.setDesc(`${presetInfo.label} 推荐默认值：${presetInfo.defaultModel}`)
			.addText((text) => text
				.setPlaceholder(presetInfo.defaultModel)
				.setValue(this.plugin.settings.generation.model)
				.onChange(async (value) => {
					this.plugin.settings.generation.model = value.trim();
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("连接测试")
			.setDesc("使用当前基础 URL、API Key 和模型名称发起一次最小请求，检查接口是否可连通。")
			.addButton((button) => {
				button
					.setButtonText(this.isTestingConnection ? "测试中..." : "测试连接")
					.setDisabled(this.isTestingConnection)
					.onClick(async () => {
						if (this.isTestingConnection) {
							return;
						}

						this.isTestingConnection = true;
						button.setButtonText("测试中...");
						button.setDisabled(true);

						try {
							await this.testProviderConnection();
						} finally {
							this.isTestingConnection = false;
							this.display();
						}
					});
			});

		new Setting(containerEl)
			.setName("核心卡片预算")
			.setDesc("优先分配给核心主题。若笔记内容较少，实际生成数量仍可能低于该值。")
			.addText((text) => text
				.setPlaceholder("6")
				.setValue(String(this.plugin.settings.generation.coreCardBudget))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.coreCardBudget = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("次级卡片预算")
			.setDesc("用于非核心主题的补充卡片。设为 0 时只生成主要知识骨架。")
			.addText((text) => text
				.setPlaceholder("4")
				.setValue(String(this.plugin.settings.generation.secondaryCardBudget))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue >= 0) {
						this.plugin.settings.generation.secondaryCardBudget = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("单篇文档最大卡片数")
			.setDesc("单次整篇文档生成时，核心和次级主题合计的硬上限。")
			.addText((text) => text
				.setPlaceholder("10")
				.setValue(String(this.plugin.settings.generation.maxTotalCardsPerDocument))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxTotalCardsPerDocument = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("单个主题最大卡片数")
			.setDesc("防止某个合并后的主题扩展出过多卡片。")
			.addText((text) => text
				.setPlaceholder("2")
				.setValue(String(this.plugin.settings.generation.maxCardsPerTopic))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxCardsPerTopic = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("每个分块最大知识单元数")
			.setDesc("限制全局排序前，每个文本分块最多提取多少个候选知识点。")
			.addText((text) => text
				.setPlaceholder("4")
				.setValue(String(this.plugin.settings.generation.maxKnowledgeUnitsPerChunk))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxKnowledgeUnitsPerChunk = parsedValue;
						this.plugin.settings.generation.maxCardsPerChunk = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("直接全局生成的分块上限")
			.setDesc("如果文档分块数超过这个值，插件将不再使用直接全局生成流程。")
			.addText((text) => text
				.setPlaceholder("18")
				.setValue(String(this.plugin.settings.generation.maxChunksForDirectGlobal))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxChunksForDirectGlobal = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("直接全局生成的 Token 上限")
			.setDesc("估算的整篇文档 Token 上限。超过后将退出完整文档排序流程。")
			.addText((text) => text
				.setPlaceholder("12000")
				.setValue(String(this.plugin.settings.generation.maxTokensForDirectGlobal))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxTokensForDirectGlobal = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("单次任务 Token 上限")
			.setDesc("单次生成任务的硬上限。超大文件会在开始前降级处理或直接拒绝。")
			.addText((text) => text
				.setPlaceholder("22000")
				.setValue(String(this.plugin.settings.generation.maxTaskInputTokens))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxTaskInputTokens = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("单次任务分块上限")
			.setDesc("单次生成任务中允许处理的分块总数上限。")
			.addText((text) => text
				.setPlaceholder("36")
				.setValue(String(this.plugin.settings.generation.maxTaskChunks))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxTaskChunks = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("单次任务 API 调用上限")
			.setDesc("单次任务中抽取、排序和组合阶段允许的总调用次数上限。")
			.addText((text) => text
				.setPlaceholder("48")
				.setValue(String(this.plugin.settings.generation.maxTaskLlmCalls))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxTaskLlmCalls = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("最大层级深度")
			.setDesc("控制插件在文档级排序前是否先压缩章节知识。大于 1 时启用分层全局生成。")
			.addText((text) => text
				.setPlaceholder("2")
				.setValue(String(this.plugin.settings.generation.maxHierarchyDepth))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue > 0) {
						this.plugin.settings.generation.maxHierarchyDepth = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("超大文档处理方式")
			.setDesc("决定超大笔记是降级为章节规划，还是直接停止并提示缩小范围。")
			.addDropdown((dropdown) => dropdown
				.addOption("chapter-planning", "降级为章节规划")
				.addOption("refuse-or-scope", "停止并提示缩小范围")
				.setValue(this.plugin.settings.generation.oversizeStrategy)
				.onChange(async (value) => {
					this.plugin.settings.generation.oversizeStrategy = value as OversizeStrategy;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("重新生成策略")
			.setDesc("控制整篇运行时，是替换文件中所有插件卡片，还是仅重建当前范围内的卡片。")
			.addDropdown((dropdown) => dropdown
				.addOption("full-document-rebuild", "重建整篇文档")
				.addOption("scope-rebuild", "仅重建当前范围")
				.setValue(this.plugin.settings.generation.defaultRegenerationPolicy)
				.onChange(async (value) => {
					this.plugin.settings.generation.defaultRegenerationPolicy = value as RegenerationPolicy;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("温度")
			.setDesc("值越低，抽取、排序和卡片组合会越稳定、越可预测。")
			.addText((text) => text
				.setPlaceholder("0.2")
				.setValue(String(this.plugin.settings.generation.temperature))
				.onChange(async (value) => {
					const parsedValue = Number.parseFloat(value);
					if (Number.isFinite(parsedValue) && parsedValue >= 0 && parsedValue <= 2) {
						this.plugin.settings.generation.temperature = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("追加默认标签")
			.setDesc("在插入前，为每张生成的卡片自动附加默认标签。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.generation.addObcdTag)
				.onChange(async (value) => {
					this.plugin.settings.generation.addObcdTag = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("默认标签")
			.setDesc("启用默认标签后，为每张卡片附加这一项单独标签。")
			.addText((text) => text
				.setPlaceholder(DEFAULT_GENERATED_CARD_TAG)
				.setValue(this.plugin.settings.generation.defaultTag)
				.onChange(async (value) => {
					this.plugin.settings.generation.defaultTag = normalizeConfiguredDefaultTag(value, DEFAULT_GENERATED_CARD_TAG);
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("提示词")
			.setDesc("配置会追加到抽取、排序、规划和组合阶段的共享提示词。")
			.setHeading();

		new Setting(containerEl)
			.setName("全局提示词")
			.setDesc("当没有任何文件夹规则命中时使用。留空则仅使用插件内置工作流提示词。")
			.addTextArea((textArea) => {
				textArea
					.setPlaceholder("补充这个仓库或知识库的统一生成偏好。")
					.setValue(this.plugin.settings.prompts.globalPrompt)
					.onChange(async (value) => {
						this.plugin.settings.prompts.globalPrompt = value;
						await this.plugin.saveSettings();
					});

				textArea.inputEl.rows = 8;
				textArea.inputEl.cols = 40;
			});

		new Setting(containerEl)
			.setName("提示词模板文件夹")
			.setDesc("填写仓库内用于存放 Markdown 提示词模板的相对路径。仓库根目录用 / 表示。")
			.addText((text) => {
				text
					.setPlaceholder("Prompts/flashcards")
					.setValue(this.plugin.settings.prompts.templatesFolder)
					.onChange(async (value) => {
						this.plugin.settings.prompts.templatesFolder = normalizeConfiguredFolderPath(value);
						await this.plugin.saveSettings();
					});

				text.inputEl.addEventListener("blur", () => this.display());
			});

		containerEl.createEl("p", {
			cls: "obcd-settings-hint",
			text: this.describePromptTemplateState(templateOptions),
		});

		new Setting(containerEl)
			.setName("文件夹提示词规则")
			.setDesc("按最近匹配原则生效。规则会应用到该文件夹及其所有子目录。")
			.addButton((button) => button
				.setButtonText("添加规则")
				.onClick(async () => {
					this.plugin.settings.prompts.folderRules = [
						...this.plugin.settings.prompts.folderRules,
						createEmptyFolderPromptRule(),
					];
					await this.plugin.saveSettings();
					this.display();
				}));

		if (this.plugin.settings.prompts.folderRules.length === 0) {
			containerEl.createEl("p", {
				cls: "obcd-settings-hint",
				text: "当前还没有文件夹提示词规则。",
			});
		}

		this.plugin.settings.prompts.folderRules.forEach((rule, index) => {
			new Setting(containerEl)
				.setName(`文件夹规则 ${index + 1}`)
				.setDesc("将笔记文件夹映射到已配置模板目录中的某个提示词模板文件。")
				.addText((text) => text
					.setPlaceholder("Projects/biology")
					.setValue(rule.noteFolder)
					.onChange(async (value) => {
						await this.updateFolderPromptRule(index, {
							noteFolder: normalizeConfiguredFolderPath(value),
						});
					}))
				.addDropdown((dropdown) => {
					dropdown.addOption("", templateOptions.length === 0 ? "未找到模板" : "选择模板");

					for (const templateOption of templateOptions) {
						dropdown.addOption(templateOption, templateOption);
					}

					const normalizedTemplatePath = normalizeConfiguredTemplatePath(rule.templatePath);
					if (normalizedTemplatePath.length > 0 && !templateOptions.includes(normalizedTemplatePath)) {
						dropdown.addOption(normalizedTemplatePath, `${normalizedTemplatePath}（缺失）`);
					}

					dropdown
						.setValue(normalizedTemplatePath)
						.onChange(async (value) => {
							await this.updateFolderPromptRule(index, {
								templatePath: normalizeConfiguredTemplatePath(value),
							});
						});
				})
				.addExtraButton((button) => button
					.setIcon("trash")
					.setTooltip("删除文件夹规则")
					.onClick(async () => {
						this.plugin.settings.prompts.folderRules = this.plugin.settings.prompts.folderRules
							.filter((_, currentIndex) => currentIndex !== index);
						await this.plugin.saveSettings();
						this.display();
					}));
		});

		new Setting(containerEl)
			.setName("侧边栏")
			.setDesc("配置侧边栏里已插入卡片表格的显示方式。")
			.setHeading();

		new Setting(containerEl)
			.setName("问题预览长度")
			.setDesc("控制侧边栏表格中每条问题的最大显示字符数，范围 20 到 200。")
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SIDEBAR_SETTINGS.frontPreviewLength))
				.setValue(String(this.plugin.settings.sidebar.frontPreviewLength))
				.onChange(async (value) => {
					const parsedValue = Number.parseInt(value, 10);
					if (Number.isFinite(parsedValue) && parsedValue >= 20 && parsedValue <= 200) {
						this.plugin.settings.sidebar.frontPreviewLength = parsedValue;
						await this.plugin.saveSettings();
					}
				}));

		new Setting(containerEl)
			.setName("兼容性")
			.setDesc("配置与其他插件生成笔记的兼容行为。")
			.setHeading();

		new Setting(containerEl)
			.setName("启用 obar 兼容模式")
			.setDesc("当笔记 frontmatter 中包含指定 obar 字段时，把插入的卡片包裹到 obar 自定义 note block 中。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.compatibility.obar.enabled)
				.onChange(async (value) => {
					this.plugin.settings.compatibility.obar.enabled = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Obar frontmatter 字段")
			.setDesc("使用逗号分隔。只要 frontmatter 中出现任意一个已配置字段，就把该文件视为 obar 记录。")
			.addText((text) => text
				.setPlaceholder(DEFAULT_OBAR_FRONTMATTER_KEYS.join(", "))
				.setValue(this.plugin.settings.compatibility.obar.frontmatterKeys.join(", "))
				.onChange(async (value) => {
					this.plugin.settings.compatibility.obar.frontmatterKeys = parseCommaSeparatedValues(
						value,
						DEFAULT_OBAR_FRONTMATTER_KEYS,
					);
					await this.plugin.saveSettings();
				}));

		const debugArtifactsDirectory = getDebugArtifactsDirectory(
			this.plugin.app.vault.configDir,
			this.plugin.manifest.dir,
			this.plugin.manifest.id,
		);

		new Setting(containerEl)
			.setName("调试")
			.setDesc("开启详细日志并保存本地调试数据，便于排查生成问题。")
			.setHeading();

		new Setting(containerEl)
			.setName("调试模式")
			.setDesc(`将详细日志输出到开发者控制台，并把调试产物保存到 ${debugArtifactsDirectory}。保存的数据可能包含笔记片段和 AI 响应。`)
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.debug.enabled)
				.onChange(async (value) => {
					this.plugin.settings.debug.enabled = value;
					await this.plugin.saveSettings();
				}));
	}

	private updateActiveProvider(provider: FlashcardProvider): void {
		this.plugin.settings.providers = this.plugin.settings.providers.map((currentProvider) => (
			currentProvider.id === provider.id ? provider : currentProvider
		));
	}

	private describePromptTemplateState(templateOptions: string[]): string {
		const templatesFolder = this.plugin.settings.prompts.templatesFolder;
		if (templatesFolder.length === 0) {
			return "设置提示词模板文件夹后，才能启用可复用的 Markdown 提示词文件。";
		}

		if (templateOptions.length === 0) {
			return `${templatesFolder} 中没有找到 Markdown 提示词模板。`;
		}

		return `${templatesFolder} 中可用的提示词模板数量：${templateOptions.length}。`;
	}

	private async updateFolderPromptRule(index: number, update: Partial<ObcdFolderPromptRule>): Promise<void> {
		this.plugin.settings.prompts.folderRules = this.plugin.settings.prompts.folderRules.map((rule, currentIndex) => (
			currentIndex === index
				? {
					...rule,
					...update,
				}
				: rule
		));
		await this.plugin.saveSettings();
	}

	private async testProviderConnection(): Promise<void> {
		const activeProvider = getActiveProvider(this.plugin.settings);
		const presetInfo = PROVIDER_PRESET_INFO[activeProvider.presetType];
		const normalizedModel = this.plugin.settings.generation.model.trim();

		if (presetInfo.requireApiKey && activeProvider.apiKey.trim().length === 0) {
			new Notice("请先填写 API Key，再测试连接。", 8000);
			return;
		}

		if (normalizedModel.length === 0) {
			new Notice("请先填写模型名称，再测试连接。", 8000);
			return;
		}

		this.plugin.settings.generation.model = normalizedModel;
		await this.plugin.saveSettings();

		try {
			const result = await new LlmClient(this.plugin.settings).testConnection();
			new Notice(`连接成功：${presetInfo.label} / ${result.model}（状态码 ${result.status}）`, 8000);
		} catch (error) {
			new Notice(getErrorMessage(error), 12000);
		}
	}
}

function parseProviders(value: unknown, fallback: FlashcardProvider[]): FlashcardProvider[] {
	if (!Array.isArray(value)) {
		return fallback.map(cloneProvider);
	}

	const providers = value
		.map((entry, index) => parseProvider(entry, index))
		.filter((provider): provider is FlashcardProvider => provider !== null);

	return providers.length > 0 ? providers : fallback.map(cloneProvider);
}

function parseGenerationSettings(value: unknown, fallback: FlashcardGenerationSettings): FlashcardGenerationSettings {
	const generationSource = isRecord(value) ? value : {};
	const legacyMaxCardsPerChunk = readNumber(generationSource.maxCardsPerChunk, fallback.maxCardsPerChunk, { min: 1, max: 20 });

	return {
		model: readString(generationSource.model, fallback.model),
		temperature: readNumber(generationSource.temperature, fallback.temperature, { min: 0, max: 2 }),
		addObcdTag: readBoolean(generationSource.addObcdTag, fallback.addObcdTag),
		defaultTag: normalizeConfiguredDefaultTag(generationSource.defaultTag, fallback.defaultTag),
		coreCardBudget: readNumber(generationSource.coreCardBudget, fallback.coreCardBudget, { min: 1, max: 50 }),
		secondaryCardBudget: readNumber(generationSource.secondaryCardBudget, fallback.secondaryCardBudget, { min: 0, max: 50 }),
		maxTotalCardsPerDocument: readNumber(generationSource.maxTotalCardsPerDocument, fallback.maxTotalCardsPerDocument, { min: 1, max: 80 }),
		maxCardsPerTopic: readNumber(generationSource.maxCardsPerTopic, fallback.maxCardsPerTopic, { min: 1, max: 5 }),
		maxKnowledgeUnitsPerChunk: readNumber(
			generationSource.maxKnowledgeUnitsPerChunk,
			legacyMaxCardsPerChunk > 0 ? Math.max(fallback.maxKnowledgeUnitsPerChunk, legacyMaxCardsPerChunk) : fallback.maxKnowledgeUnitsPerChunk,
			{ min: 1, max: 12 },
		),
		maxChunksForDirectGlobal: readNumber(generationSource.maxChunksForDirectGlobal, fallback.maxChunksForDirectGlobal, { min: 1, max: 80 }),
		maxTokensForDirectGlobal: readNumber(generationSource.maxTokensForDirectGlobal, fallback.maxTokensForDirectGlobal, { min: 1000, max: 50000 }),
		maxTaskInputTokens: readNumber(generationSource.maxTaskInputTokens, fallback.maxTaskInputTokens, { min: 2000, max: 100000 }),
		maxTaskChunks: readNumber(generationSource.maxTaskChunks, fallback.maxTaskChunks, { min: 1, max: 120 }),
		maxTaskLlmCalls: readNumber(generationSource.maxTaskLlmCalls, fallback.maxTaskLlmCalls, { min: 3, max: 200 }),
		maxHierarchyDepth: readNumber(generationSource.maxHierarchyDepth, fallback.maxHierarchyDepth, { min: 1, max: 4 }),
		oversizeStrategy: readOversizeStrategy(generationSource.oversizeStrategy, fallback.oversizeStrategy),
		defaultRegenerationPolicy: readRegenerationPolicy(generationSource.defaultRegenerationPolicy, fallback.defaultRegenerationPolicy),
		maxCardsPerChunk: legacyMaxCardsPerChunk,
	};
}

function parsePromptSettings(value: unknown, fallback: ObcdPromptSettings): ObcdPromptSettings {
	const promptSource = isRecord(value) ? value : {};

	return {
		globalPrompt: readString(promptSource.globalPrompt, fallback.globalPrompt),
		templatesFolder: normalizeConfiguredFolderPath(readString(promptSource.templatesFolder, fallback.templatesFolder)),
		folderRules: parseFolderPromptRules(promptSource.folderRules),
	};
}

function parseSidebarSettings(value: unknown, fallback: ObcdSidebarSettings): ObcdSidebarSettings {
	const sidebarSource = isRecord(value) ? value : {};

	return {
		frontPreviewLength: readNumber(sidebarSource.frontPreviewLength, fallback.frontPreviewLength, { min: 20, max: 200 }),
		visibleTableColumns: readSidebarColumns(sidebarSource.visibleTableColumns, fallback.visibleTableColumns),
	};
}

function parseDebugSettings(value: unknown, fallback: ObcdDebugSettings): ObcdDebugSettings {
	const debugSource = isRecord(value) ? value : {};

	return {
		enabled: readBoolean(debugSource.enabled, fallback.enabled),
	};
}

function parseCompatibilitySettings(value: unknown, fallback: ObcdCompatibilitySettings): ObcdCompatibilitySettings {
	const compatibilitySource = isRecord(value) ? value : {};
	const obarSource = isRecord(compatibilitySource.obar) ? compatibilitySource.obar : {};

	return {
		obar: {
			enabled: readBoolean(obarSource.enabled, fallback.obar.enabled),
			frontmatterKeys: normalizeObarFrontmatterKeys(obarSource.frontmatterKeys, fallback.obar.frontmatterKeys),
		},
	};
}

function parseProvider(value: unknown, index: number): FlashcardProvider | null {
	if (!isRecord(value)) {
		return null;
	}

	const presetType = readPresetType(value.presetType, "openrouter");
	const defaultProvider = createDefaultProvider(presetType);

	return {
		id: readString(value.id, index === 0 ? "primary" : `provider-${index + 1}`),
		presetType,
		baseUrl: readString(value.baseUrl, defaultProvider.baseUrl),
		apiKey: readString(value.apiKey, ""),
	};
}

function cloneProvider(provider: FlashcardProvider): FlashcardProvider {
	return {
		...provider,
	};
}

function readPresetType(value: unknown, fallback: FlashcardProviderPresetType): FlashcardProviderPresetType {
	if (typeof value === "string" && value in PROVIDER_PRESET_INFO) {
		return value as FlashcardProviderPresetType;
	}

	return fallback;
}

function readOversizeStrategy(value: unknown, fallback: OversizeStrategy): OversizeStrategy {
	return value === "chapter-planning" || value === "refuse-or-scope" ? value : fallback;
}

function readRegenerationPolicy(value: unknown, fallback: RegenerationPolicy): RegenerationPolicy {
	return value === "full-document-rebuild" || value === "scope-rebuild" ? value : fallback;
}

function readString(value: unknown, fallback: string): string {
	return typeof value === "string" ? value : fallback;
}

function normalizeConfiguredDefaultTag(value: unknown, fallback: string): string {
	const normalizedValue = typeof value === "string"
		? value
			.replace(/"/g, "")
			.replace(/,/g, " ")
			.trim()
		: "";

	return normalizedValue.length > 0 ? normalizedValue : fallback;
}

function readNumber(value: unknown, fallback: number, range: { min: number; max: number }): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}

	if (value < range.min || value > range.max) {
		return fallback;
	}

	return value;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function readSidebarColumns(value: unknown, fallback: SidebarTableColumnId[]): SidebarTableColumnId[] {
	if (!Array.isArray(value)) {
		return [...fallback];
	}

	return value
		.filter((entry): entry is SidebarTableColumnId => (
			typeof entry === "string" && SIDEBAR_TABLE_COLUMN_IDS.includes(entry as SidebarTableColumnId)
		))
		.filter((entry, index, items) => items.indexOf(entry) === index);
}

function parseFolderPromptRules(value: unknown): ObcdFolderPromptRule[] {
	if (!Array.isArray(value)) {
		return [];
	}

	return value
		.map((entry) => parseFolderPromptRule(entry))
		.filter((entry): entry is ObcdFolderPromptRule => entry !== null);
}

function parseFolderPromptRule(value: unknown): ObcdFolderPromptRule | null {
	if (!isRecord(value)) {
		return null;
	}

	return {
		noteFolder: normalizeConfiguredFolderPath(readString(value.noteFolder, "")),
		templatePath: normalizeConfiguredTemplatePath(readString(value.templatePath, "")),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseCommaSeparatedValues(value: string, fallback: string[]): string[] {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0)
		.filter((entry, index, items) => items.indexOf(entry) === index);

	return entries.length > 0 ? entries : [...fallback];
}

function createEmptyFolderPromptRule(): ObcdFolderPromptRule {
	return {
		noteFolder: "",
		templatePath: "",
	};
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}
