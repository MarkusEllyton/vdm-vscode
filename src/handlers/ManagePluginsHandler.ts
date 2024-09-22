// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigurationTarget, QuickPickItem, QuickPickItemKind, Uri, WorkspaceFolder, commands, window, workspace } from "vscode";
import { ClientManager } from "../ClientManager";
import AutoDisposable from "../helper/AutoDisposable";
import { VdmDialect, getDialect } from "../util/DialectUtil";
import { JarFile } from "../util/JarFile";
import * as Util from "../util/Util";
import { VDMJPrecision } from "../util/Util";
import { PluginSource, VDMJExtensionsHandler } from "./VDMJExtensionsHandler";

const DEFAULT_ENABLED_PLUGINS = ["quickcheck", "uml"];

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
    }

    // Utils
    private static showAndLogWarning(msg: string, err?: string) {
        window.showWarningMessage(msg);
        console.log(err ? `${msg} - ${err}` : msg);
    }

    private static async getPluginState(wsFolder: WorkspaceFolder, dialect: VdmDialect, precision: VDMJPrecision): Promise<PluginState> {
        const discoveredPlugins = await ManagePluginsHandler.getAllPluginInfo(dialect, precision, wsFolder);
        const enabledPlugins = new Set(ManagePluginsHandler.getEnabledPlugins(wsFolder));
        const disabledPlugins = new Set(ManagePluginsHandler.getDisabledPlugins(wsFolder));

        const currentPluginState: PluginState = new Map();

        for (const [pluginName, pluginInfo] of discoveredPlugins) {
            currentPluginState.set(pluginName, {
                ...pluginInfo,
                enabled:
                    enabledPlugins.has(pluginName) || (DEFAULT_ENABLED_PLUGINS.includes(pluginName) && !disabledPlugins.has(pluginName)),
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
            const precision: VDMJPrecision = this.clientManager.isHighPrecisionClient(this.clientManager.get(wsFolder))
                ? "high"
                : "standard";
            const initialPluginState = await ManagePluginsHandler.getPluginState(wsFolder, dialect, precision);
            const updatedPluginState = await this.promptUserManagePlugins(initialPluginState);

            if (updatedPluginState === undefined) {
                // The selection window was probably dismissed, the settings have not changed.
                return;
            }

            // Commit changes
            if (this.areStatesEqual(initialPluginState, updatedPluginState)) {
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

    public static getDisabledPlugins(wsFolder: WorkspaceFolder): string[] {
        const enabledPluginsConfiguration: Record<string, boolean> =
            workspace.getConfiguration("vdm-vscode.server.plugins", wsFolder.uri)?.get("enabled") ?? {};

        // Merge settings
        const disabledPluginNames: string[] = [];

        for (const [pluginName, enabled] of Object.entries(enabledPluginsConfiguration)) {
            if (!enabled) {
                disabledPluginNames.push(pluginName);
            }
        }

        return disabledPluginNames;
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
        const plugins: PluginSource[] = await VDMJExtensionsHandler.getAllPluginSources(wsFolder);

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
