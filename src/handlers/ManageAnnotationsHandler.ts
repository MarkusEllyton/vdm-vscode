// SPDX-License-Identifier: GPL-3.0-or-later

import { ConfigurationTarget, QuickPickItem, Uri, WorkspaceFolder, commands, window, workspace } from "vscode";
import { ClientManager } from "../ClientManager";
import AutoDisposable from "../helper/AutoDisposable";
import { VdmDialect, getDialect } from "../util/DialectUtil";
import { JarFile } from "../util/JarFile";
import * as Util from "../util/Util";
import { VDMJPrecision } from "../util/Util";
import { AnnotationSource, VDMJExtensionsHandler } from "./VDMJExtensionsHandler";

interface AnnotationMetadata {
    name: string;
    description: string;
    dialects: VdmDialect[];
    precision: VDMJPrecision;
}

interface SourcedAnnotationMetadata extends AnnotationMetadata {
    source: AnnotationSource;
}

interface AnnotationMetadataState extends SourcedAnnotationMetadata {
    enabled: boolean;
}

type AnnotationState = Map<string, AnnotationMetadataState>;

type AnnotationSourceMap = Map<string, SourcedAnnotationMetadata>;
type AnnotationSourceMapDuplicates = Map<string, SourcedAnnotationMetadata[]>;

interface QuickPickAnnotationItem extends QuickPickItem {
    metadata?: SourcedAnnotationMetadata;
}

export class ManageAnnotationsHandler extends AutoDisposable {
    constructor(private readonly clientManager: ClientManager) {
        super();
        commands.executeCommand("setContext", "vdm-vscode.manageAnnotations", true);
        Util.registerCommand(this._disposables, "vdm-vscode.manageAnnotations", (inputUri: Uri) =>
            this.handleManageAnnotations(workspace.getWorkspaceFolder(inputUri))
        );
    }

    // Utils
    private static showAndLogWarning(msg: string, err?: string) {
        window.showWarningMessage(msg);
        console.log(err ? `${msg} - ${err}` : msg);
    }

    private static async getAnnotationState(
        wsFolder: WorkspaceFolder,
        dialect: VdmDialect,
        precision: VDMJPrecision
    ): Promise<AnnotationState> {
        const discoveredAnnotations = await ManageAnnotationsHandler.getAllAnnotationInfo(dialect, precision, wsFolder);
        const enabledAnnotations = new Set(ManageAnnotationsHandler.getEnabledAnnotations(wsFolder));

        const currentAnnotationState: AnnotationState = new Map();

        for (const [annotationName, annotationInfo] of discoveredAnnotations) {
            currentAnnotationState.set(annotationName, {
                ...annotationInfo,
                enabled: enabledAnnotations.has(annotationName),
            });
        }

        return currentAnnotationState;
    }

    private async promptUserManageAnnotations(currentState: AnnotationState): Promise<AnnotationState> {
        const userAnnotationItems: QuickPickAnnotationItem[] = [];

        for (const annotationInfo of currentState.values()) {
            if (annotationInfo.source.type === "user") {
                userAnnotationItems.push({
                    label: annotationInfo.name,
                    description: annotationInfo.description,
                    picked: annotationInfo.enabled,
                    metadata: annotationInfo,
                });
            }
        }

        const selectedAnnotations = await window.showQuickPick<QuickPickAnnotationItem>(userAnnotationItems, {
            placeHolder: currentState.values().next() === undefined ? "No annotations available.." : "Choose annotations..",
            canPickMany: true,
        });

        if (selectedAnnotations === undefined) {
            return undefined;
        }

        // Initialize new state by disabling all annotations, and then only enabling those that were selected.
        const newAnnotationState = new Map(currentState);
        for (const [annotationName, annotationInfo] of currentState) {
            newAnnotationState.set(annotationName, {
                ...annotationInfo,
                enabled: false,
            });
        }

        for (const annotation of selectedAnnotations) {
            newAnnotationState.get(annotation.metadata.name).enabled = true;
        }

        return newAnnotationState;
    }

    private async handleManageAnnotations(wsFolder: WorkspaceFolder) {
        try {
            const dialect = await getDialect(wsFolder, this.clientManager);
            const precision: VDMJPrecision = this.clientManager.isHighPrecisionClient(this.clientManager.get(wsFolder)) ? "hp" : "standard";
            const initialAnnotationState = await ManageAnnotationsHandler.getAnnotationState(wsFolder, dialect, precision);
            const updatedAnnotationState = await this.promptUserManageAnnotations(initialAnnotationState);

            if (updatedAnnotationState === undefined) {
                // The selection window was probably dismissed, the settings have not changed.
                return;
            }

            // Commit changes
            if (this.areStatesEqual(initialAnnotationState, updatedAnnotationState)) {
                console.log([...updatedAnnotationState], [...initialAnnotationState]);
                // Nothing has changed, so don't apply the new configuration.
                // This is done to prevent an unnecessary prompt to reload VS Code in the case where an annotation is enabled on the user-level,
                // and remains enabled after managing annotations on the workspace-level.
                // Without an early return, the workspace-level setting would be updated and redundantly prompt the user to reload.
                return;
            }

            const newAnnotationEnabledConfig: Record<string, boolean> = {};
            for (const [annotationName, annotationInfo] of updatedAnnotationState) {
                newAnnotationEnabledConfig[annotationName] = annotationInfo.enabled;
            }
            await workspace
                .getConfiguration("vdm-vscode.server.annotations", wsFolder.uri)
                .update("enabled", newAnnotationEnabledConfig, ConfigurationTarget.WorkspaceFolder);
        } catch (err) {
            ManageAnnotationsHandler.showAndLogWarning(`Annotation management failed.`, err);
        }
    }

    public static getEnabledAnnotations(wsFolder: WorkspaceFolder): string[] {
        const enabledAnnotationsConfiguration: Record<string, boolean> =
            workspace.getConfiguration("vdm-vscode.server.annotations", wsFolder.uri)?.get("enabled") ?? {};

        // Merge settings
        const enabledAnnotationNames: string[] = [];

        for (const [annotationName, enabled] of Object.entries(enabledAnnotationsConfiguration)) {
            if (enabled) {
                enabledAnnotationNames.push(annotationName);
            }
        }

        return enabledAnnotationNames;
    }

    public static async getClasspathAdditions(wsFolder: WorkspaceFolder, dialect: VdmDialect, precision: VDMJPrecision) {
        const currentState = await ManageAnnotationsHandler.getAnnotationState(wsFolder, dialect, precision);

        return Array.from(currentState.values())
            .filter((annotationInfo) => annotationInfo.enabled)
            .map((annotationInfo) => annotationInfo.source.jarPath);
    }

    private static async getAnnotationInfoFromSource(source: AnnotationSource): Promise<SourcedAnnotationMetadata | undefined> {
        const jarFile = await JarFile.open(source.jarPath);
        const rawAnnotationInfo = await jarFile.readFile("META-INF/annotation.json");

        if (!rawAnnotationInfo) {
            return undefined;
        }

        const annotationInfo = JSON.parse(rawAnnotationInfo.toString());

        // It is allowed to omit the precision field in the annotation configuration, but in that case it is implied that the precision is 'standard'.
        if (!annotationInfo["precision"]) {
            annotationInfo["precision"] = "standard";
        }

        return {
            ...annotationInfo,
            source,
        };
    }

    private static findDuplicateAnnotations(
        annotationSourceMap: AnnotationSourceMapDuplicates
    ): Map<AnnotationSource, SourcedAnnotationMetadata[]> {
        const duplicateMap: Map<AnnotationSource, SourcedAnnotationMetadata[]> = new Map();
        for (const [_, annotationInfos] of annotationSourceMap) {
            if (annotationInfos.length === 1) {
                continue;
            }

            // The first annotation that was resolved is the one that "wins" and is used
            const firstAnnotation = annotationInfos[0];
            const duplicateAnnotationsInSource = duplicateMap.get(firstAnnotation.source) ?? [];
            duplicateAnnotationsInSource.push(firstAnnotation);
            duplicateMap.set(firstAnnotation.source, duplicateAnnotationsInSource);
        }

        return duplicateMap;
    }

    private static async getAllAnnotationInfo(
        dialect: VdmDialect,
        precision: VDMJPrecision,
        wsFolder: WorkspaceFolder
    ): Promise<AnnotationSourceMap> {
        const annotations: AnnotationSource[] = VDMJExtensionsHandler.getAllAnnotationSources(wsFolder);

        if (annotations.length === 0) {
            return new Map();
        }

        // Map annotation names to possible sources
        const annotationSourceMapWithDuplicates: AnnotationSourceMapDuplicates = new Map();
        for (const annotationSource of annotations) {
            const annotationInfo = await ManageAnnotationsHandler.getAnnotationInfoFromSource(annotationSource);

            if (!annotationInfo) {
                const errMsg = `The annotation jar '${annotationSource.jarPath}' is malformed and does not contain the expected metadata.`;
                ManageAnnotationsHandler.showAndLogWarning(errMsg);
                continue;
            }

            if (annotationInfo.dialects.includes(dialect) && annotationInfo.precision === precision) {
                const annotationSources = annotationSourceMapWithDuplicates.get(annotationInfo.name) ?? [];
                annotationSources.push(annotationInfo);
                annotationSourceMapWithDuplicates.set(annotationInfo.name, annotationSources);
            }
        }

        // Inform of annotation with identical names - this is done per jar to avoid generating too many messages.
        const duplicateMap = ManageAnnotationsHandler.findDuplicateAnnotations(annotationSourceMapWithDuplicates);

        for (const [annotationSource, annotationInfos] of duplicateMap) {
            ManageAnnotationsHandler.showAndLogWarning(
                `Annotations '${annotationInfos.map((lib) => lib.name).join(", ")}' are in multiple jars. Using annotations from '${
                    annotationSource.jarPath
                }.'`
            );
        }

        // Picking first library source for all libraries
        const annotationSourceMap: AnnotationSourceMap = new Map();
        for (const [annotationName, annotationInfos] of annotationSourceMapWithDuplicates) {
            annotationSourceMap.set(annotationName, annotationInfos[0]);
        }

        return annotationSourceMap;
    }

    private areStatesEqual(stateA: AnnotationState, stateB: AnnotationState) {
        // Assuming maps have the same keys, which always holds in the way annotation states are generated in this class.
        for (const [annotationName, annotationInfo] of stateA) {
            if (annotationInfo.enabled !== stateB.get(annotationName).enabled) {
                return false;
            }
        }

        return true;
    }
}
