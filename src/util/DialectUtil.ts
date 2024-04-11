// SPDX-License-Identifier: GPL-3.0-or-later

import { WorkspaceFolder, RelativePattern, workspace, window } from "vscode";

export enum VdmDialect {
    VDMSL = "vdmsl",
    VDMPP = "vdmpp",
    VDMRT = "vdmrt",
}

export const dialectToPrettyFormat: Map<VdmDialect, string> = new Map([
    [VdmDialect.VDMSL, "VDM-SL"],
    [VdmDialect.VDMPP, "VDM++"],
    [VdmDialect.VDMRT, "VDM-RT"],
]);

export const dialectToFileExtensions: Map<VdmDialect, string[]> = new Map([
    [VdmDialect.VDMSL, ["vdmsl", "vsl"]],
    [VdmDialect.VDMPP, ["vdmpp", "vpp"]],
    [VdmDialect.VDMRT, ["vdmrt", "vrt"]],
]);

export const vdmFileExtensions: Set<string> = new Set(Array.from(dialectToFileExtensions.values()).reduce((prev, cur) => prev.concat(cur)));

export const dialectToAlias: Map<VdmDialect, string[]> = new Map([
    [VdmDialect.VDMSL, [...dialectToFileExtensions.get(VdmDialect.VDMSL), "vdm-sl", "sl"]],
    [VdmDialect.VDMPP, [...dialectToFileExtensions.get(VdmDialect.VDMPP), "vdm-pp", "pp", "vdm++"]],
    [VdmDialect.VDMRT, [...dialectToFileExtensions.get(VdmDialect.VDMRT), "vdm-rt", "rt"]],
]);

export function vdmFilePattern(fsPath: string): RelativePattern {
    return new RelativePattern(
        fsPath,
        `*.{${Array.from(dialectToFileExtensions.values())
            .map((dialects) => dialects.reduce((prev, cur) => `${prev},${cur}`))
            .reduce((prev, cur) => `${prev},${cur}`)}}`
    );
}

export async function guessDialect(wsFolder: WorkspaceFolder): Promise<VdmDialect> {
    return new Promise(async (resolve, reject) => {
        for await (const [dialect, extensions] of dialectToFileExtensions) {
            const pattern: RelativePattern = new RelativePattern(
                wsFolder.uri.path,
                `*.{${extensions.reduce((prev, cur) => `${prev},${cur}`)}}`
            );
            if ((await workspace.findFiles(pattern, null, 1)).length > 0) {
                return resolve(dialect);
            }
        }

        return reject(`Could not guess dialect for workspace folder: ${wsFolder.name}`);
    });
}

export function getDialectFromAlias(alias: string): VdmDialect {
    let returnDialect: VdmDialect;
    dialectToAlias.forEach((aliases, dialect) => {
        for (const knownAlias of aliases) {
            if (alias.toLowerCase() == knownAlias) {
                returnDialect = dialect;
                return;
            }
        }
    });
    if (!returnDialect) {
        console.log(`Input alias '${alias}' does not match any known alias`);
    }
    return returnDialect;
}

export async function pickDialect(): Promise<VdmDialect> {
    return new Promise(async (resolve, reject) => {
        // Let user choose
        const chosenDialect: string = await window.showQuickPick(Array.from(dialectToPrettyFormat.values()), {
            placeHolder: "Choose dialect",
            canPickMany: false,
        });
        if (!chosenDialect) return reject("No dialect picked");
        else {
            dialectToPrettyFormat.forEach((val, key) => {
                if (val == chosenDialect) return resolve(key);
            });
        }
    });
}
