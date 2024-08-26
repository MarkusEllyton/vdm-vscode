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
import { JarFile } from "../util/JarFile";
import { Readable } from "stream";
import { LibrarySource, VDMJExtensionsHandler } from "./VDMJExtensionsHandler";

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
        const libraries: LibrarySource[] = await VDMJExtensionsHandler.getAllLibrarySources(wsFolder);

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
