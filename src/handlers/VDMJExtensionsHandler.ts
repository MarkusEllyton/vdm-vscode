import { commands, Uri, window, workspace, WorkspaceFolder } from "vscode";
import AutoDisposable from "../helper/AutoDisposable";
import * as Util from "../util/Util";
import * as Path from "path";
import * as Fs from "fs-extra";
import { getFilesFromDirRecur } from "../util/DirectoriesUtil";
import { getExtensionPath } from "../util/ExtensionUtil";
import { JarFile } from "../util/JarFile";

type ExtensionType = "builtin" | "user";

interface ExtensionSource {
    type: ExtensionType;
    jarPath: string;
}

export type LibrarySource = ExtensionSource;
export type PluginSource = ExtensionSource;
export type AnnotationSource = ExtensionSource;

export class VDMJExtensionsHandler extends AutoDisposable {
    private static jarCache: string[] | undefined;

    constructor() {
        super();
        Util.registerCommand(this._disposables, "vdm-vscode.addExtensionJarFolders", () =>
            Util.addToSettingsArray(true, "Extension Search Path", "vdm-vscode.server", "extensionSearchPaths")
        );
        Util.registerCommand(this._disposables, "vdm-vscode.addExtensionJars", () =>
            Util.addToSettingsArray(false, "Extension Search Path", "vdm-vscode.server", "extensionSearchPaths")
        );
    }

    // Common
    private static resolveJarPathsFromSettings(jarPaths: string[], resolveFailedPaths: string[], rootUri?: Uri): string[] {
        // Resolve jar paths, flatten directories
        if (this.jarCache) {
            return this.jarCache;
        }

        const visitedJarPaths: Map<string, string> = new Map<string, string>();
        const resolvedJarPaths = jarPaths
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
                return false;
            });

        this.jarCache = resolvedJarPaths;
        return resolvedJarPaths;
    }

    private static getUserExtensionSources(wsFolder: WorkspaceFolder): ExtensionSource[] {
        // Get extension jars specified by the user at the folder level setting - if not defined at this level then the "next up" level where it is defined is returned.
        let folderSettings: string[] = (workspace.getConfiguration("vdm-vscode.server", wsFolder.uri)?.get("extensionSearchPaths") ??
            []) as string[];

        // Get extension jars specified by the user at the user or workspace level setting - if the workspace level setting is defined then it is returned instead of the user level setting.
        let userOrWorkspaceSettings: string[] = (workspace.getConfiguration("vdm-vscode.server")?.get("extensionSearchPaths") ??
            []) as string[];
        const resolveFailedPaths: string[] = [];
        const jarPathsFromSettings: string[] = this.resolveJarPathsFromSettings(folderSettings, resolveFailedPaths, wsFolder.uri);

        // Determine if settings are equal, e.g. if the setting is not defined at the folder level.
        if (
            folderSettings.length !== userOrWorkspaceSettings.length ||
            !folderSettings.every((ujp: string) => userOrWorkspaceSettings.find((fjp: string) => fjp === ujp))
        ) {
            // If the settings are not equal then merge them and in case of duplicate jar names the folder level takes precedence over the workspace/user level.
            jarPathsFromSettings.push(
                ...this.resolveJarPathsFromSettings(userOrWorkspaceSettings, resolveFailedPaths).filter((uwsPath: string) => {
                    const existingJarPath: string = jarPathsFromSettings.find(
                        (fsPath: string) => Path.basename(fsPath) === Path.basename(uwsPath)
                    );
                    if (existingJarPath) {
                        return false;
                    }
                    return true;
                })
            );
        }

        if (resolveFailedPaths.length > 0) {
            const msg: string = `Unable to resolve the following VDM extension jar/folder paths: <${resolveFailedPaths.reduce(
                (prev, curr) => (curr += `> <${prev}`)
            )}>. These can be changed in the settings.`;
            window
                .showInformationMessage(msg, ...["Go to settings"])
                .then(() => commands.executeCommand("workbench.action.openSettings", "vdm-vscode.server.extensionSearchPaths"));
        }

        return jarPathsFromSettings.map((jarPath) => ({
            type: "user",
            jarPath,
        }));
    }

    private static getDefaultExtensionSources(jarPaths: string[], userDefinedExtensionSources: ExtensionSource[]): ExtensionSource[] {
        if (userDefinedExtensionSources.length > 0) {
            jarPaths = jarPaths.filter((ijp: string) => {
                const jarName: string = Path.basename(ijp);
                const existingExtensionSource = userDefinedExtensionSources.find((userLib) => Path.basename(userLib.jarPath) === jarName);
                return !existingExtensionSource;
            });
        }

        return jarPaths.map((jarPath) => ({
            type: "builtin",
            jarPath,
        }));
    }

    // Libraries
    public static getIncludedLibrariesFolderPath(wsFolder: WorkspaceFolder): string {
        // Get the standard or high precision path of the included library jars folder
        const libPath: string = Path.resolve(
            getExtensionPath(),
            "resources",
            "jars",
            workspace.getConfiguration("vdm-vscode.server", wsFolder)?.highPrecision ? "vdmj_hp" : "vdmj" ?? "vdmj",
            "libs"
        );

        if (!Fs.existsSync(libPath)) {
            console.log("Invalid path for default libraries: " + libPath);
            return undefined;
        }

        return libPath;
    }

    private static getUserLibrarySources(wsFolder: WorkspaceFolder): LibrarySource[] {
        const extensionSources = this.getUserExtensionSources(wsFolder);
        return extensionSources.filter(async (extSrc) => {
            const jarFile = await JarFile.open(extSrc.jarPath);
            return jarFile.fileExists("META-INF/library.json");
        });
    }

    private static getDefaultLibrarySources(wsFolder: WorkspaceFolder, userDefinedLibrarySources: LibrarySource[]): LibrarySource[] {
        const defaultLibrariesPath = this.getIncludedLibrariesFolderPath(wsFolder);

        if (!defaultLibrariesPath) {
            return [];
        }

        let includedJarsPaths: string[] = getFilesFromDirRecur(defaultLibrariesPath, "jar");

        return this.getDefaultExtensionSources(includedJarsPaths, userDefinedLibrarySources);
    }

    public static getAllLibrarySources(wsFolder: WorkspaceFolder): LibrarySource[] {
        const userLibraries = this.getUserLibrarySources(wsFolder);
        const defaultLibraries = this.getDefaultLibrarySources(wsFolder, userLibraries);

        return userLibraries.concat(defaultLibraries);
    }

    // Plugins
    public static getIncludedPluginsFolderPath(wsFolder: WorkspaceFolder): string {
        const pluginPath: string = Path.resolve(
            getExtensionPath(),
            "resources",
            "jars",
            workspace.getConfiguration("vdm-vscode.server", wsFolder)?.highPrecision ? "vdmj_hp" : "vdmj" ?? "vdmj",
            "plugins"
        );

        if (!Fs.existsSync(pluginPath)) {
            console.log("Invalid path for default plugins: " + pluginPath);
            return undefined;
        }

        return pluginPath;
    }

    public static getUserPluginSources(wsFolder: WorkspaceFolder): PluginSource[] {
        const extensionSources = this.getUserExtensionSources(wsFolder);
        return extensionSources.filter(async (extSrc) => {
            const jarFile = await JarFile.open(extSrc.jarPath);
            return jarFile.fileExists("META-INF/plugin.json");
        });
    }

    public static getDefaultPluginSources(wsFolder: WorkspaceFolder, userDefinedPluginSources: PluginSource[]): PluginSource[] {
        const defaultPluginSources = this.getIncludedPluginsFolderPath(wsFolder);

        if (!defaultPluginSources) {
            return [];
        }
        let includedJarsPaths: string[] = getFilesFromDirRecur(defaultPluginSources, "jar");

        return this.getDefaultExtensionSources(includedJarsPaths, userDefinedPluginSources);
    }

    public static getAllPluginSources(wsFolder: WorkspaceFolder): PluginSource[] {
        const userPlugins = this.getUserPluginSources(wsFolder);
        const defaultPlugins = this.getDefaultPluginSources(wsFolder, userPlugins);

        return userPlugins.concat(defaultPlugins);
    }

    // Annotations
    public static getIncludedAnnotationsFolderPath(wsFolder: WorkspaceFolder): string {
        const pluginPath: string = Path.resolve(
            getExtensionPath(),
            "resources",
            "jars",
            workspace.getConfiguration("vdm-vscode.server", wsFolder)?.highPrecision ? "vdmj_hp" : "vdmj" ?? "vdmj",
            "annotations"
        );

        if (!Fs.existsSync(pluginPath)) {
            console.log("Invalid path for default annotations: " + pluginPath);
            return undefined;
        }

        return pluginPath;
    }

    public static getUserAnnotationsSources(wsFolder: WorkspaceFolder): AnnotationSource[] {
        const extensionSources = this.getUserExtensionSources(wsFolder);
        return extensionSources.filter(async (extSrc) => {
            const jarFile = await JarFile.open(extSrc.jarPath);
            return jarFile.fileExists("META-INF/annotation.json");
        });
    }

    public static getDefaultAnnotationSources(wsFolder: WorkspaceFolder, userDefinedPluginSources: AnnotationSource[]): AnnotationSource[] {
        const defaultAnnotationsPath = this.getIncludedAnnotationsFolderPath(wsFolder);

        if (!defaultAnnotationsPath) {
            return [];
        }
        let includedJarsPaths: string[] = getFilesFromDirRecur(defaultAnnotationsPath, "jar");

        return this.getDefaultExtensionSources(includedJarsPaths, userDefinedPluginSources);
    }

    public static getAllAnnotationSources(wsFolder: WorkspaceFolder): AnnotationSource[] {
        const userAnnotations = this.getUserAnnotationsSources(wsFolder);
        const defaultAnnotations = this.getDefaultAnnotationSources(wsFolder, userAnnotations);

        return userAnnotations.concat(defaultAnnotations);
    }
}
