// SPDX-License-Identifier: GPL-3.0-or-later

import * as Fs from "fs-extra";
import * as Path from "path";
import { commands, QuickPickItem, QuickPickItemKind, Uri, window, workspace, WorkspaceFolder } from "vscode";
import { ClientManager } from "../ClientManager";
import AutoDisposable from "../helper/AutoDisposable";
import { getDialect, VdmDialect } from "../util/DialectUtil";
import * as Util from "../util/Util";

// Encoding library
import * as iconv from "iconv-lite";
import { getFilesFromDirRecur } from "../util/DirectoriesUtil";
import { getExtensionPath } from "../util/ExtensionUtil";
import { JarFile } from "../util/JarFile";
import { Readable } from "stream";

type LibraryType = "builtin" | "user";

interface LibrarySource {
    type: LibraryType;
    jarPath: string;
}

interface LibraryMetadata {
    name: string;
    description: string;
    depends: string[];
    files: string[];
}

interface SourcedLibraryMetadata extends LibraryMetadata {
    source: LibrarySource;
}

type LibrarySourceMap = Map<string, SourcedLibraryMetadata>;
type LibrarySourceMapDuplicates = Map<string, SourcedLibraryMetadata[]>;
type LibraryImportMap = Map<LibrarySource, SourcedLibraryMetadata[]>;

interface QuickPickLibraryItem extends QuickPickItem {
    metadata?: SourcedLibraryMetadata;
}

interface DependencyResolutionResult {
    resolved: LibrarySourceMap;
    unresolved: string[];
}

export class AddLibraryHandler extends AutoDisposable {
    private readonly _libraryEncoding: BufferEncoding = "utf8";

    constructor(private readonly clientManager: ClientManager) {
        super();
        commands.executeCommand("setContext", "vdm-vscode.addLibrary", true);
        Util.registerCommand(this._disposables, "vdm-vscode.addLibrary", (inputUri: Uri) =>
            this.addLibrary(workspace.getWorkspaceFolder(inputUri))
        );
        Util.registerCommand(this._disposables, "vdm-vscode.addLibraryJarFolders", () =>
            Util.addToSettingsArray(true, "VDM libraries", "vdm-vscode.server.libraries", "VDM-Libraries")
        );
        Util.registerCommand(this._disposables, "vdm-vscode.addLibraryJars", () =>
            Util.addToSettingsArray(false, "VDM libraries", "vdm-vscode.server.libraries", "VDM-Libraries")
        );
    }

    // Utils
    private showAndLogWarning(msg: string, err?: string) {
        window.showWarningMessage(msg);
        console.log(err ? `${msg} - ${err}` : msg);
    }

    // Add library handler main entrypoint
    private async addLibrary(wsFolder: WorkspaceFolder) {
        window.setStatusBarMessage("Adding Libraries.", this.handleAddLibrary(wsFolder));
    }

    private async handleAddLibrary(wsFolder: WorkspaceFolder): Promise<void> {
        try {
            const dialect = await getDialect(wsFolder, this.clientManager);
            const discoveredLibraries = await this.getAllLibInfo(dialect, wsFolder);

            if (discoveredLibraries.size === 0) {
                // No libraries available. Let user go to settings
                await this.promptForLibrarySettings("Cannot locate any VDM libraries. These can be added in the settings");
                return;
            }

            // Let user select libraries
            const selectedLibraries = await this.promptUserToSelectLibraries(discoveredLibraries);
            if (selectedLibraries === undefined || selectedLibraries.length === 0) {
                // "Empty selection. Add library completed."
                return;
            }

            await this.addLibFilesToTarget(wsFolder, selectedLibraries, discoveredLibraries);
        } catch (e) {
            this.showAndLogWarning(`Adding library failed.`, e);
        }
    }

    private async promptForLibrarySettings(msg: string) {
        const jumpToSettings = await window.showInformationMessage(msg, "Go to settings");

        if (jumpToSettings) {
            commands.executeCommand("workbench.action.openSettings", "vdm-vscode.server.libraries");
        }
    }

    private async promptUserToSelectLibraries(libSourceMap: LibrarySourceMap): Promise<SourcedLibraryMetadata[] | undefined> {
        const defaultLibraryItems: QuickPickLibraryItem[] = [];
        const userLibraryItems: QuickPickLibraryItem[] = [];

        for (const libInfo of libSourceMap.values()) {
            if (libInfo.source.type === "builtin") {
                defaultLibraryItems.push({
                    label: libInfo.name,
                    description: libInfo.description,
                    metadata: libInfo,
                });
            } else if (libInfo.source.type === "user") {
                userLibraryItems.push({
                    label: libInfo.name,
                    description: libInfo.description,
                    metadata: libInfo,
                });
            }
        }

        const selectedLibraries = await window.showQuickPick<QuickPickLibraryItem>(
            [
                {
                    label: "Built-in libraries",
                    kind: QuickPickItemKind.Separator,
                },
                ...defaultLibraryItems,
                {
                    label: "User libraries",
                    kind: QuickPickItemKind.Separator,
                },
                ...userLibraryItems,
            ],
            {
                placeHolder: libSourceMap.values().next() === undefined ? "No libraries available.." : "Choose libraries..",
                canPickMany: true,
            }
        );

        if (selectedLibraries === undefined) {
            return undefined;
        }

        return selectedLibraries.map((lib) => lib.metadata);
    }

    private async addLibFilesToTarget(wsFolder: WorkspaceFolder, selectedLibs: SourcedLibraryMetadata[], libSourceMap: LibrarySourceMap) {
        const libPathTarget = Path.resolve(wsFolder.uri.fsPath, "lib");

        try {
            await Fs.ensureDir(libPathTarget);
        } catch (e) {
            this.showAndLogWarning("Creating directory for library files failed", `Error: ${e}`);
            return;
        }

        const importMap: LibraryImportMap = new Map();
        selectedLibs.forEach((libInfo) => {
            const resolutionRes = this.resolveLibraryDependencies(libInfo, libSourceMap);

            if (resolutionRes.resolved.size > 0) {
                // Inform of libraries being added as part of a dependency
                window.showInformationMessage(
                    `Additionally including '${Array.from(resolutionRes.resolved.keys()).join(", ")}' as required by '${
                        libInfo.name
                    }' library dependencies`
                );
            }

            // Map from jarPath to libraries to import from that jarPath
            for (const depLibInfo of [libInfo, ...resolutionRes.resolved.values()]) {
                const libsFromJar = importMap.get(depLibInfo.source) ?? [];
                libsFromJar.push(depLibInfo);
                importMap.set(depLibInfo.source, libsFromJar);
            }

            // Warn of any unresolved dependencies
            if (resolutionRes.unresolved.length > 0) {
                this.showAndLogWarning(
                    `Unable to resolve all dependencies for the library '${
                        libInfo.name
                    }' as the following dependencies could not be found: ${resolutionRes.unresolved.reduce(
                        (prev: string, cur: string) => prev + ", " + cur
                    )}. '${libInfo.name}' has not been added!`
                );
            }
        });

        // Copy library files from jars to the target folder
        const wsEncoding = workspace.getConfiguration("files", wsFolder).get("encoding", "utf8");

        try {
            return await this.copyLibFilesToTarget(importMap, libPathTarget, wsEncoding);
        } catch (err) {
            const msg: string = "Failed to add library";
            this.showAndLogWarning(msg, `Error: ${err}`);
        }
    }

    // Library resolution
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
            return "";
        }

        return libPath;
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
                    `The library jar '${jarName}' is in multiple paths for the setting level ${settingsLevel}. Using the path '${visitedJarPaths.get(
                        jarName
                    )}'.`
                );
                return false;
            });
    }

    public static getUserLibrarySources(wsFolder: WorkspaceFolder): LibrarySource[] {
        // Get library jars specified by the user at the folder level setting - if not defined at this level then the "next up" level where it is defined is returned.
        let folderSettings: string[] = (workspace.getConfiguration("vdm-vscode.server.libraries", wsFolder.uri)?.get("VDM-Libraries") ??
            []) as string[];

        // Get library jars specified by the user at the user or workspace level setting - if the workspace level setting is defined then it is returned instead of the user level setting.
        let userOrWorkspaceSettings: string[] = (workspace.getConfiguration("vdm-vscode.server.libraries")?.get("VDM-Libraries") ??
            []) as string[];
        const resolveFailedPaths: string[] = [];
        const jarPathsFromSettings: string[] = AddLibraryHandler.resolveJarPathsFromSettings(
            folderSettings,
            resolveFailedPaths,
            "Folder",
            wsFolder.uri
        );

        // Determine if settings are equal, e.g. if the setting is not defined at the folder level.
        if (
            folderSettings.length !== userOrWorkspaceSettings.length ||
            !folderSettings.every((ujp: string) => userOrWorkspaceSettings.find((fjp: string) => fjp === ujp))
        ) {
            // If the settings are not equal then merge them and in case of duplicate jar names the folder level takes precedence over the workspace/user level.
            jarPathsFromSettings.push(
                ...AddLibraryHandler.resolveJarPathsFromSettings(userOrWorkspaceSettings, resolveFailedPaths, "User or Workspace").filter(
                    (uwsPath: string) => {
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
                    }
                )
            );
        }

        if (resolveFailedPaths.length > 0) {
            const msg: string = `Unable to resolve the following VDM library jar/folder paths: <${resolveFailedPaths.reduce(
                (prev, curr) => (curr += `> <${prev}`)
            )}>. These can be changed in the settings.`;
            console.log(msg);
            window
                .showInformationMessage(msg, ...["Go to settings"])
                .then(() => commands.executeCommand("workbench.action.openSettings", "vdm-vscode.server.libraries"));
        }

        return jarPathsFromSettings.map((jarPath) => ({
            type: "user",
            jarPath,
        }));
    }

    public static getDefaultLibrarySources(wsFolder: WorkspaceFolder, userDefinedLibrarySources: LibrarySource[]): LibrarySource[] {
        let includedJarsPaths: string[] = getFilesFromDirRecur(this.getIncludedLibrariesFolderPath(wsFolder), "jar");

        if (userDefinedLibrarySources.length > 0) {
            includedJarsPaths = includedJarsPaths.filter((ijp: string) => {
                const jarName: string = Path.basename(ijp);
                const existingLibrarySource = userDefinedLibrarySources.find((userLib) => Path.basename(userLib.jarPath) === jarName);
                if (existingLibrarySource) {
                    window.showInformationMessage(
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

    private async getLibInfoFromSource(source: LibrarySource, dialect: VdmDialect): Promise<SourcedLibraryMetadata[]> {
        const jarFile = await JarFile.open(source.jarPath);
        const jsonData = JSON.parse((await jarFile.readFile("META-INF/library.json")).toString());
        const libraries: LibraryMetadata[] = jsonData[dialect] ?? [];

        return libraries.map((lib) => ({
            ...lib,
            source,
        }));
    }

    private findDuplicateLibraries(libSourceMap: LibrarySourceMapDuplicates): Map<LibrarySource, SourcedLibraryMetadata[]> {
        const duplicateMap: Map<LibrarySource, SourcedLibraryMetadata[]> = new Map();
        for (const [_, libInfos] of libSourceMap) {
            if (libInfos.length === 1) {
                continue;
            }

            // The first library that was resolved is the one that "wins" and is used
            const firstLib = libInfos[0];
            const duplicateLibsInSource = duplicateMap.get(firstLib.source) ?? [];
            duplicateLibsInSource.push(firstLib);
            duplicateMap.set(firstLib.source, duplicateLibsInSource);
        }

        return duplicateMap;
    }

    private async getAllLibInfo(dialect: VdmDialect, wsFolder: WorkspaceFolder): Promise<LibrarySourceMap> {
        const libraries: LibrarySource[] = AddLibraryHandler.getUserLibrarySources(wsFolder);

        if (workspace.getConfiguration("vdm-vscode.server.libraries", wsFolder).includeDefaultLibraries) {
            const defaultLibraries = AddLibraryHandler.getDefaultLibrarySources(wsFolder, libraries);
            libraries.push(...defaultLibraries);
        }

        if (libraries.length === 0) {
            return new Map();
        }

        // Map library names to possible sources
        const libSourceMapWithDuplicates: LibrarySourceMapDuplicates = new Map();
        for (const libSource of libraries) {
            const libInfos = await this.getLibInfoFromSource(libSource, dialect);

            for (const libInfo of libInfos) {
                const librarySources = libSourceMapWithDuplicates.get(libInfo.name) ?? [];
                librarySources.push(libInfo);
                libSourceMapWithDuplicates.set(libInfo.name, librarySources);
            }
        }

        // Inform of libraries with identical names - this is done per jar to avoid generating too many messages.
        const duplicateMap = this.findDuplicateLibraries(libSourceMapWithDuplicates);

        for (const [libSource, libInfos] of duplicateMap) {
            this.showAndLogWarning(
                `Libraries '${libInfos.map((lib) => lib.name).join(", ")}' are in multiple jars. Using libraries from '${
                    libSource.jarPath
                }.'`
            );
        }

        // Picking first library source for all libraries
        const libSourceMap: LibrarySourceMap = new Map();
        for (const [libName, libInfos] of libSourceMapWithDuplicates) {
            libSourceMap.set(libName, libInfos[0]);
        }

        return libSourceMap;
    }

    private resolveLibraryDependencies(libInfo: SourcedLibraryMetadata, libSourceMap: LibrarySourceMap): DependencyResolutionResult {
        const unresolvedDependencies: string[] = [];
        let resolvedDependencies: LibrarySourceMap = new Map();

        for (const dependencyName of libInfo.depends) {
            const resolvedDependency = libSourceMap.get(dependencyName);

            if (!resolvedDependency) {
                unresolvedDependencies.push(dependencyName);
                continue;
            }

            const dependenciesOfDependency = this.resolveLibraryDependencies(resolvedDependency, libSourceMap);
            unresolvedDependencies.push(...dependenciesOfDependency.unresolved);
            resolvedDependencies = new Map([
                ...resolvedDependencies,
                [dependencyName, resolvedDependency],
                ...dependenciesOfDependency.resolved,
            ]);
        }

        return {
            resolved: resolvedDependencies,
            unresolved: unresolvedDependencies,
        };
    }

    private async copySingleFileToTarget(fileBuffer: Buffer, targetPath: string, wsEncoding: string): Promise<void> {
        // Create a read stream from the file and pipe it to a write stream to the target folder.
        const readStream = Readable.from(fileBuffer);

        // Create writestream with needed encoding to the target path
        const writeStream = Fs.createWriteStream(targetPath, {
            encoding: wsEncoding === this._libraryEncoding || !Buffer.isEncoding(wsEncoding) ? this._libraryEncoding : wsEncoding,
        });

        readStream
            .pipe(iconv.decodeStream(this._libraryEncoding))
            .pipe(iconv.encodeStream(wsEncoding))
            .pipe(writeStream)
            .on("error", (err) => {
                throw new Error(`Copy library files failed with error: ${err}`);
            });
    }

    private async getLibFileNames(libInfos: SourcedLibraryMetadata[]) {
        let libFileNames: Set<string> = new Set();

        for (const libInfo of libInfos) {
            libFileNames = new Set([...libFileNames, ...libInfo.files]);
        }

        return Array.from(libFileNames);
    }

    private async copyLibFilesToTarget(importMap: LibraryImportMap, targetFolderPath: string, wsEncoding: string): Promise<void> {
        // Extract library from jar file and write it to the target folder
        for (const [libSource, libInfos] of importMap) {
            const libFileNames = await this.getLibFileNames(libInfos);
            const jarFile = await JarFile.open(libSource.jarPath);

            const missingFiles: string[] = [];
            for (const fileName of libFileNames) {
                const targetPath = Path.join(targetFolderPath, fileName);
                const fileBuffer = await jarFile.readFile(fileName);

                if (!fileBuffer) {
                    missingFiles.push(fileName);
                    continue;
                }

                this.copySingleFileToTarget(fileBuffer, targetPath, wsEncoding);
            }

            if (missingFiles.length !== 0) {
                throw new Error(`Unable to locate and copy the following files: ${libFileNames.join(", ")}`);
            }
        }
    }
}
