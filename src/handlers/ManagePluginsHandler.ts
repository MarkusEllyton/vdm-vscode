// SPDX-License-Identifier: GPL-3.0-or-later

import * as Fs from "fs-extra";
import * as Path from "path";
import { ConfigurationTarget, QuickPickItem, QuickPickItemKind, Uri, WorkspaceFolder, commands, window, workspace } from "vscode";
import { ClientManager } from "../ClientManager";
import AutoDisposable from "../helper/AutoDisposable";
import { VdmDialect, getDialect } from "../util/DialectUtil";
import { getFilesFromDirRecur } from "../util/DirectoriesUtil";
import { JarFile } from "../util/JarFile";
import * as Util from "../util/Util";
import { getExtensionPath } from "../util/ExtensionUtil";
import { VDMJPrecision } from "../util/Util";

type PluginType = "builtin" | "user";

interface PluginSource {
    type: PluginType;
    jarPath: string;
}

interface PluginMetadata {
    name: string;
    description: string;
    dialects: VdmDialect[];
    precision: VDMJPrecision;
}

interface SourcedPluginMetadata extends PluginMetadata {
    source: PluginSource;
}

interface PluginMetadataState extends SourcedPluginMetadata {
    enabled: boolean;
}

type PluginState = Map<string, PluginMetadataState>;

type PluginSourceMap = Map<string, SourcedPluginMetadata>;
type PluginSourceMapDuplicates = Map<string, SourcedPluginMetadata[]>;

interface QuickPickPluginItem extends QuickPickItem {
    metadata?: SourcedPluginMetadata;
}

export class ManagePluginsHandler extends AutoDisposable {
    constructor(private readonly clientManager: ClientManager) {
        super();
        commands.executeCommand("setContext", "vdm-vscode.managePlugins", true);
        Util.registerCommand(this._disposables, "vdm-vscode.managePlugins", (inputUri: Uri) =>
            this.handleManagePlugins(workspace.getWorkspaceFolder(inputUri))
        );

        Util.registerCommand(this._disposables, "vdm-vscode.addPluginJarFolders", () =>
            Util.addToSettingsArray(true, "VDM plugins", "vdm-vscode.server.plugins", "searchPaths")
        );
        Util.registerCommand(this._disposables, "vdm-vscode.addPluginJars", () =>
            Util.addToSettingsArray(false, "VDM plugins", "vdm-vscode.server.plugins", "searchPaths")
        );
    }

    // Utils
    private static showAndLogWarning(msg: string, err?: string) {
        window.showWarningMessage(msg);
        console.log(err ? `${msg} - ${err}` : msg);
    }

    private static async getPluginState(wsFolder: WorkspaceFolder, dialect: VdmDialect, precision: VDMJPrecision): Promise<PluginState> {
        const discoveredPlugins = await ManagePluginsHandler.getAllPluginInfo(dialect, precision, wsFolder);
        const enabledPlugins = new Set(ManagePluginsHandler.getEnabledPlugins(wsFolder));

        const currentPluginState: PluginState = new Map();

        for (const [pluginName, pluginInfo] of discoveredPlugins) {
            currentPluginState.set(pluginName, {
                ...pluginInfo,
                enabled: enabledPlugins.has(pluginName),
            });
        }

        return currentPluginState;
    }

    private async promptUserManagePlugins(currentState: PluginState): Promise<PluginState> {
        const defaultPluginItems: QuickPickPluginItem[] = [];
        const userPluginItems: QuickPickPluginItem[] = [];

        for (const pluginInfo of currentState.values()) {
            if (pluginInfo.source.type === "builtin") {
                defaultPluginItems.push({
                    label: pluginInfo.name,
                    description: pluginInfo.description,
                    picked: pluginInfo.enabled,
                    metadata: pluginInfo,
                });
            } else if (pluginInfo.source.type === "user") {
                userPluginItems.push({
                    label: pluginInfo.name,
                    description: pluginInfo.description,
                    picked: pluginInfo.enabled,
                    metadata: pluginInfo,
                });
            }
        }

        const selectedPlugins = await window.showQuickPick<QuickPickPluginItem>(
            [
                {
                    label: "Built-in plugins",
                    kind: QuickPickItemKind.Separator,
                },
                ...defaultPluginItems,
                {
                    label: "User plugins",
                    kind: QuickPickItemKind.Separator,
                },
                ...userPluginItems,
            ],
            {
                placeHolder: currentState.values().next() === undefined ? "No plugins available.." : "Choose plugins..",
                canPickMany: true,
            }
        );

        if (selectedPlugins === undefined) {
            return undefined;
        }

        // Initialize new state by disabling all plugins, and then only enabling those that were selected.
        const newPluginState = new Map(currentState);
        for (const [pluginName, pluginInfo] of currentState) {
            newPluginState.set(pluginName, {
                ...pluginInfo,
                enabled: false,
            });
        }

        for (const plugin of selectedPlugins) {
            newPluginState.get(plugin.metadata.name).enabled = true;
        }

        return newPluginState;
    }

    private async handleManagePlugins(wsFolder: WorkspaceFolder) {
        try {
            const dialect = await getDialect(wsFolder, this.clientManager);
            const precision: VDMJPrecision = this.clientManager.isHighPrecisionClient(this.clientManager.get(wsFolder)) ? "hp" : "standard";
            const initialPluginState = await ManagePluginsHandler.getPluginState(wsFolder, dialect, precision);
            const updatedPluginState = await this.promptUserManagePlugins(initialPluginState);

            if (updatedPluginState === undefined) {
                // The selection window was probably dismissed, the settings have not changed.
                return;
            }

            // Commit changes
            if (this.areStatesEqual(initialPluginState, updatedPluginState)) {
                console.log([...updatedPluginState], [...initialPluginState]);
                // Nothing has changed, so don't apply the new configuration.
                // This is done to prevent an unnecessary prompt to reload VS Code in the case where a plugin is enabled on the user-level,
                // and remains enabled after managing plugins on the workspace-level.
                // Without an early return, the workspace-level setting would be updated and redundantly prompt the user to reload.
                return;
            }

            const newPluginEnabledConfig: Record<string, boolean> = {};
            for (const [pluginName, pluginInfo] of updatedPluginState) {
                newPluginEnabledConfig[pluginName] = pluginInfo.enabled;
            }
            await workspace
                .getConfiguration("vdm-vscode.server.plugins", wsFolder.uri)
                .update("enabled", newPluginEnabledConfig, ConfigurationTarget.WorkspaceFolder);
        } catch (err) {
            ManagePluginsHandler.showAndLogWarning(`Plugin management failed.`, err);
        }
    }

    public static getIncludedPluginsFolderPath(): string {
        const pluginPath: string = Path.resolve(getExtensionPath(), "resources", "jars", "plugins");

        if (!Fs.existsSync(pluginPath)) {
            console.log("Invalid path for default plugins: " + pluginPath);
            return "";
        }

        return pluginPath;
    }

    public static getEnabledPlugins(wsFolder: WorkspaceFolder): string[] {
        const enabledPluginsConfiguration: Record<string, boolean> =
            workspace.getConfiguration("vdm-vscode.server.plugins", wsFolder.uri)?.get("enabled") ?? {};

        // Merge settings
        const enabledPluginNames: string[] = [];

        for (const [pluginName, enabled] of Object.entries(enabledPluginsConfiguration)) {
            if (enabled) {
                enabledPluginNames.push(pluginName);
            }
        }

        return enabledPluginNames;
    }

    private static resolveJarPathsFromSettings(
        jarPaths: string[],
        resolveFailedPaths: string[],
        settingsLevel: string,
        rootUri?: Uri
    ): string[] {
        // Resolve jar paths, flatten directories, filter duplicate jar names and inform the user
        const visitedJarPaths: Map<string, string> = new Map<string, string>();
        return jarPaths
            .flatMap((originalPath: string) => {
                let resolvedPath: string = originalPath;
                if (rootUri && !Path.isAbsolute(originalPath)) {
                    // Path should be relative to the project
                    resolvedPath = Path.resolve(...[rootUri.fsPath, originalPath]);
                }
                if (!Fs.existsSync(resolvedPath)) {
                    resolveFailedPaths.push(originalPath);
                    return [];
                }
                return Fs.lstatSync(resolvedPath).isDirectory() ? getFilesFromDirRecur(resolvedPath, "jar") : [resolvedPath];
            })
            .filter((jarPath: string) => {
                const jarName: string = Path.basename(jarPath);
                if (!visitedJarPaths.has(jarName)) {
                    visitedJarPaths.set(jarName, jarPath);
                    return true;
                }
                window.showInformationMessage(
                    `The plugin jar '${jarName}' is in multiple paths for the setting level ${settingsLevel}. Using the path '${visitedJarPaths.get(
                        jarName
                    )}'.`
                );
                return false;
            });
    }

    public static getUserPluginSources(wsFolder: WorkspaceFolder): PluginSource[] {
        // Get plugin jars specified by the user at the folder level setting - if not defined at this level then the "next up" level where it is defined is returned.
        let folderSettings: string[] =
            workspace.getConfiguration("vdm-vscode.server.plugins", wsFolder.uri)?.get("searchPaths") ?? ([] as string[]);

        // Get plugin jars specified by the user at the user or workspace level setting - if the workspace level setting is defined then it is returned instead of the user level setting.
        let userOrWorkspaceSettings: string[] = (workspace.getConfiguration("vdm-vscode.server.plugins")?.get("searchPaths") ??
            []) as string[];

        const resolveFailedPaths: string[] = [];
        const jarPathsFromSettings: string[] = ManagePluginsHandler.resolveJarPathsFromSettings(
            folderSettings,
            resolveFailedPaths,
            "Folder",
            wsFolder.uri
        );

        console.log(folderSettings, userOrWorkspaceSettings);

        // Determine if settings are equal, e.g. if the setting is not defined at the folder level.
        if (
            folderSettings.length !== userOrWorkspaceSettings.length ||
            !folderSettings.every((ujp: string) => userOrWorkspaceSettings.find((fjp: string) => fjp === ujp))
        ) {
            // If the settings are not equal then merge them and in case of duplicate jar names the folder level takes precedence over the workspace/user level.
            jarPathsFromSettings.push(
                ...ManagePluginsHandler.resolveJarPathsFromSettings(
                    userOrWorkspaceSettings,
                    resolveFailedPaths,
                    "User or Workspace"
                ).filter((uwsPath: string) => {
                    const uwsPathName: string = Path.basename(uwsPath);
                    const existingJarPath: string = jarPathsFromSettings.find(
                        (fsPath: string) => Path.basename(fsPath) === Path.basename(uwsPath)
                    );
                    if (existingJarPath) {
                        window.showInformationMessage(
                            `The library jar ${uwsPathName} has been defined on multiple setting levels. The path '${existingJarPath}' from the 'folder' level is being used.`
                        );
                        return false;
                    }
                    return true;
                })
            );
        }

        if (resolveFailedPaths.length > 0) {
            const msg: string = `Unable to resolve the following VDM plugin jar/folder paths: <${resolveFailedPaths.reduce(
                (prev, curr) => (curr += `> <${prev}`)
            )}>. These can be changed in the settings.`;
            console.log(msg);
        }

        return jarPathsFromSettings.map((jarPath) => ({
            type: "user",
            jarPath,
        }));
    }

    public static getDefaultPluginSources(userDefinedPluginSources: PluginSource[]): PluginSource[] {
        let includedJarsPaths: string[] = getFilesFromDirRecur(this.getIncludedPluginsFolderPath(), "jar");

        if (userDefinedPluginSources.length > 0) {
            includedJarsPaths = includedJarsPaths.filter((ijp: string) => {
                const jarName: string = Path.basename(ijp);
                const existingLibrarySource = userDefinedPluginSources.find((userLib) => Path.basename(userLib.jarPath) === jarName);
                if (existingLibrarySource) {
                    console.log(
                        `The included library jar '${jarName}' is also defined by the user in the path '${existingLibrarySource.jarPath}'. Ignoring the version included with the extension.`
                    );

                    return false;
                }
                return true;
            });
        }

        return includedJarsPaths.map((jarPath) => ({
            type: "builtin",
            jarPath,
        }));
    }

    public static async getClasspathAdditions(wsFolder: WorkspaceFolder, dialect: VdmDialect, precision: VDMJPrecision) {
        const currentState = await ManagePluginsHandler.getPluginState(wsFolder, dialect, precision);

        return Array.from(currentState.values())
            .filter((pluginInfo) => pluginInfo.enabled)
            .map((pluginInfo) => pluginInfo.source.jarPath);
    }

    private static async getPluginInfoFromSource(source: PluginSource): Promise<SourcedPluginMetadata | undefined> {
        const jarFile = await JarFile.open(source.jarPath);
        const rawPluginInfo = await jarFile.readFile("META-INF/plugin.json");

        if (!rawPluginInfo) {
            return undefined;
        }

        const pluginInfo = JSON.parse(rawPluginInfo.toString());

        // It is allowed to omit the precision field in the plugin configuration, but in that case it is implied that the precision is 'standard'.
        if (!pluginInfo["precision"]) {
            pluginInfo["precision"] = "standard";
        }

        return {
            ...pluginInfo,
            source,
        };
    }

    private static findDuplicatePlugins(pluginSourceMap: PluginSourceMapDuplicates): Map<PluginSource, SourcedPluginMetadata[]> {
        const duplicateMap: Map<PluginSource, SourcedPluginMetadata[]> = new Map();
        for (const [_, pluginInfos] of pluginSourceMap) {
            if (pluginInfos.length === 1) {
                continue;
            }

            // The first plugin that was resolved is the one that "wins" and is used
            const firstPlugin = pluginInfos[0];
            const duplicatePluginsInSource = duplicateMap.get(firstPlugin.source) ?? [];
            duplicatePluginsInSource.push(firstPlugin);
            duplicateMap.set(firstPlugin.source, duplicatePluginsInSource);
        }

        return duplicateMap;
    }

    private static async getAllPluginInfo(
        dialect: VdmDialect,
        precision: VDMJPrecision,
        wsFolder: WorkspaceFolder
    ): Promise<PluginSourceMap> {
        const userPlugins: PluginSource[] = ManagePluginsHandler.getUserPluginSources(wsFolder);
        const plugins: PluginSource[] = [...userPlugins, ...ManagePluginsHandler.getDefaultPluginSources(userPlugins)];

        if (plugins.length === 0) {
            return new Map();
        }

        // Map plugin names to possible sources
        const pluginSourceMapWithDuplicates: PluginSourceMapDuplicates = new Map();
        for (const pluginSource of plugins) {
            const pluginInfo = await ManagePluginsHandler.getPluginInfoFromSource(pluginSource);

            if (!pluginInfo) {
                const errMsg = `The plugin jar '${pluginSource.jarPath}' is malformed and does not contain the expected metadata.`;
                ManagePluginsHandler.showAndLogWarning(errMsg);
                continue;
            }

            if (pluginInfo.dialects.includes(dialect) && pluginInfo.precision === precision) {
                const pluginSources = pluginSourceMapWithDuplicates.get(pluginInfo.name) ?? [];
                pluginSources.push(pluginInfo);
                pluginSourceMapWithDuplicates.set(pluginInfo.name, pluginSources);
            }
        }

        // Inform of plugins with identical names - this is done per jar to avoid generating too many messages.
        const duplicateMap = ManagePluginsHandler.findDuplicatePlugins(pluginSourceMapWithDuplicates);

        for (const [pluginSource, pluginInfos] of duplicateMap) {
            ManagePluginsHandler.showAndLogWarning(
                `Plugins '${pluginInfos.map((lib) => lib.name).join(", ")}' are in multiple jars. Using plugins from '${
                    pluginSource.jarPath
                }.'`
            );
        }

        // Picking first library source for all libraries
        const pluginSourceMap: PluginSourceMap = new Map();
        for (const [pluginName, pluginInfos] of pluginSourceMapWithDuplicates) {
            pluginSourceMap.set(pluginName, pluginInfos[0]);
        }

        return pluginSourceMap;
    }

    private areStatesEqual(stateA: PluginState, stateB: PluginState) {
        // Assuming maps have the same keys, which always holds in the way plugin states are generated in this class.
        for (const [pluginName, pluginInfo] of stateA) {
            if (pluginInfo.enabled !== stateB.get(pluginName).enabled) {
                return false;
            }
        }

        return true;
    }
}
