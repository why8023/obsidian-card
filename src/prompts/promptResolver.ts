import { App, TFile, TFolder, normalizePath } from "obsidian";

import type { ObcdFolderPromptRule, ObcdPromptSettings } from "../settings";

export interface ResolvedGenerationPrompt {
	prompt: string;
	source: "folder-rule" | "global" | "default";
	noteFolder?: string;
	templatePath?: string;
}

interface RankedPromptRule {
	rule: ObcdFolderPromptRule;
	index: number;
	normalizedNoteFolder: string;
}

export function normalizeConfiguredFolderPath(value: string): string {
	const trimmedValue = value.trim().replace(/\\/g, "/");
	if (trimmedValue.length === 0) {
		return "";
	}

	if (trimmedValue === "/") {
		return "/";
	}

	const normalizedValue = normalizePath(trimmedValue);
	if (normalizedValue === "." || normalizedValue.length === 0) {
		return "/";
	}

	const vaultRelativePath = normalizedValue
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");

	return vaultRelativePath.length > 0 ? vaultRelativePath : "/";
}

export function normalizeConfiguredTemplatePath(value: string): string {
	const trimmedValue = value.trim().replace(/\\/g, "/");
	if (trimmedValue.length === 0) {
		return "";
	}

	return normalizePath(trimmedValue).replace(/^\/+/, "");
}

export function listPromptTemplateFiles(app: App, templatesFolder: string): string[] {
	const resolvedFolder = resolveConfiguredFolder(app, templatesFolder);
	if (resolvedFolder === null) {
		return [];
	}

	const results: string[] = [];
	const rootPath = toVaultRelativeFolderPath(normalizeConfiguredFolderPath(templatesFolder));
	collectTemplateFiles(resolvedFolder, rootPath, results);
	return results.sort((left, right) => left.localeCompare(right));
}

export async function resolveGenerationPrompt(
	app: App,
	promptSettings: ObcdPromptSettings,
	file: TFile,
): Promise<ResolvedGenerationPrompt> {
	const rankedRules = getRankedMatchingRules(file, promptSettings.folderRules);
	for (const rankedRule of rankedRules) {
		const prompt = await readPromptTemplate(app, promptSettings.templatesFolder, rankedRule.rule.templatePath);
		if (prompt !== null) {
			return {
				prompt,
				source: "folder-rule",
				noteFolder: rankedRule.rule.noteFolder,
				templatePath: rankedRule.rule.templatePath,
			};
		}
	}

	const globalPrompt = normalizePromptText(promptSettings.globalPrompt);
	if (globalPrompt !== null) {
		return {
			prompt: globalPrompt,
			source: "global",
		};
	}

	return {
		prompt: "",
		source: "default",
	};
}

async function readPromptTemplate(app: App, templatesFolder: string, templatePath: string): Promise<string | null> {
	const resolvedTemplatePath = resolveTemplateFilePath(templatesFolder, templatePath);
	if (resolvedTemplatePath === null) {
		return null;
	}

	const abstractFile = app.vault.getAbstractFileByPath(resolvedTemplatePath);
	if (!(abstractFile instanceof TFile) || abstractFile.extension.toLowerCase() !== "md") {
		return null;
	}

	try {
		return normalizePromptText(await app.vault.cachedRead(abstractFile));
	} catch {
		return null;
	}
}

function resolveTemplateFilePath(templatesFolder: string, templatePath: string): string | null {
	const normalizedTemplatesFolder = normalizeConfiguredFolderPath(templatesFolder);
	if (normalizedTemplatesFolder.length === 0) {
		return null;
	}

	const normalizedTemplatePath = normalizeConfiguredTemplatePath(templatePath);
	if (normalizedTemplatePath.length === 0 || !normalizedTemplatePath.toLowerCase().endsWith(".md")) {
		return null;
	}

	const baseFolderPath = toVaultRelativeFolderPath(normalizedTemplatesFolder);
	const candidatePath = joinVaultPath(baseFolderPath, normalizedTemplatePath);

	if (!isSameOrDescendantPath(candidatePath, baseFolderPath)) {
		return null;
	}

	return candidatePath;
}

function resolveConfiguredFolder(app: App, folderPath: string): TFolder | null {
	const normalizedFolder = normalizeConfiguredFolderPath(folderPath);
	if (normalizedFolder.length === 0) {
		return null;
	}

	if (normalizedFolder === "/") {
		return app.vault.getRoot();
	}

	const abstractFile = app.vault.getAbstractFileByPath(normalizedFolder);
	return abstractFile instanceof TFolder ? abstractFile : null;
}

function collectTemplateFiles(folder: TFolder, rootPath: string, results: string[]): void {
	for (const child of folder.children) {
		if (child instanceof TFolder) {
			collectTemplateFiles(child, rootPath, results);
			continue;
		}

		if (!(child instanceof TFile) || child.extension.toLowerCase() !== "md") {
			continue;
		}

		const relativePath = rootPath.length > 0 && child.path.startsWith(`${rootPath}/`)
			? child.path.slice(rootPath.length + 1)
			: child.path;

		results.push(relativePath);
	}
}

function getRankedMatchingRules(file: TFile, rules: ObcdFolderPromptRule[]): RankedPromptRule[] {
	const normalizedFileFolder = normalizePathForComparison(file.parent?.path ?? "/");

	return rules
		.map((rule, index) => {
			const normalizedNoteFolder = normalizeConfiguredFolderPath(rule.noteFolder);
			if (normalizedNoteFolder.length === 0 || normalizeConfiguredTemplatePath(rule.templatePath).length === 0) {
				return null;
			}

			return {
				rule,
				index,
				normalizedNoteFolder,
			} satisfies RankedPromptRule;
		})
		.filter((rule): rule is RankedPromptRule => rule !== null)
		.filter((rule) => isMatchingFolder(normalizedFileFolder, normalizePathForComparison(rule.normalizedNoteFolder)))
		.sort((left, right) => {
			const specificityDifference = getFolderSpecificity(right.normalizedNoteFolder) - getFolderSpecificity(left.normalizedNoteFolder);
			if (specificityDifference !== 0) {
				return specificityDifference;
			}

			return left.index - right.index;
		});
}

function normalizePathForComparison(value: string): string {
	const normalizedFolder = normalizeConfiguredFolderPath(value);
	if (normalizedFolder === "/") {
		return "";
	}

	return normalizedFolder.toLowerCase();
}

function isMatchingFolder(fileFolderPath: string, ruleFolderPath: string): boolean {
	if (ruleFolderPath.length === 0) {
		return true;
	}

	return fileFolderPath === ruleFolderPath || fileFolderPath.startsWith(`${ruleFolderPath}/`);
}

function getFolderSpecificity(folderPath: string): number {
	if (folderPath === "/") {
		return 0;
	}

	return folderPath.split("/").length;
}

function normalizePromptText(value: string): string | null {
	const trimmedValue = value.trim();
	return trimmedValue.length > 0 ? trimmedValue : null;
}

function toVaultRelativeFolderPath(value: string): string {
	return value === "/" ? "" : value;
}

function joinVaultPath(...segments: string[]): string {
	return normalizePath(
		segments
			.filter((segment) => segment.length > 0)
			.join("/"),
	);
}

function isSameOrDescendantPath(candidatePath: string, parentPath: string): boolean {
	if (parentPath.length === 0) {
		return true;
	}

	return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}
