import type ObsidianCardPlugin from "../main";
import { resolveCurrentFileTarget, resolveFolderTarget, resolveSelectionTarget } from "../generation/targetResolver";

export function registerCommands(plugin: ObsidianCardPlugin): void {
	plugin.addCommand({
		id: "generate-basic-flashcards-from-selection",
		name: "Generate basic flashcards from selection",
		editorCheckCallback: (checking, editor, ctx) => {
			if (resolveSelectionTarget(editor, ctx) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateFromSelection(editor, ctx);
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-for-current-file",
		name: "Generate basic flashcards for current file",
		checkCallback: (checking) => {
			if (resolveCurrentFileTarget(plugin.app) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateForCurrentFile();
			}

			return true;
		},
	});

	plugin.addCommand({
		id: "generate-basic-flashcards-for-folder",
		name: "Generate basic flashcards for folder",
		checkCallback: (checking) => {
			if (resolveFolderTarget(plugin.app) === null) {
				return false;
			}

			if (!checking) {
				void plugin.workflow.generateForFolder();
			}

			return true;
		},
	});
}
