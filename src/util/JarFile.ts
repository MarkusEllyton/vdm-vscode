// SPDX-License-Identifier: GPL-3.0-or-later

import * as fs from "node:fs/promises";
import * as JSZip from "jszip";

export class JarFile {
    private constructor(private readonly _zipFile: JSZip) {}

    public static async open(path: string): Promise<JarFile> {
        try {
            const jarFileBuffer = await fs.readFile(path);
            const zipFile = await JSZip.loadAsync(jarFileBuffer);
            return new JarFile(zipFile);
        } catch (err) {
            throw new Error(`Failed to open JAR file with error: ${err}`);
        }
    }

    public fileExists(path: string): boolean {
        const fileObject = this._zipFile.file(path);

        return fileObject === null;
    }

    public async readFile(path: string): Promise<Buffer | undefined> {
        try {
            const fileObject = this._zipFile.file(path);
            return fileObject.async("nodebuffer");
        } catch (err) {
            return undefined;
        }
    }
}
