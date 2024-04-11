// SPDX-License-Identifier: GPL-3.0-or-later

import * as yauzl from "yauzl";
import * as consumers from "node:stream/consumers";

/**
 * Type that represents a mapping from a path within the JAR file to an `Entry` within the ZIP.
 */
type EntryMap = Record<string, yauzl.Entry>;

export class JarFile {
    private _entries: EntryMap = {};

    private constructor(private readonly _zipFile: yauzl.ZipFile) {
        this._zipFile.on("entry", this.handleEntry.bind(this));
    }

    private handleEntry(entry: yauzl.Entry) {
        this._entries[entry.fileName] = entry;
    }

    public static async open(path: string): Promise<JarFile> {
        return new Promise((resolve, reject) => {
            yauzl.open(path, { autoClose: false, lazyEntries: true }, (err, zipfile) => {
                if (err) {
                    return reject(err);
                }

                return resolve(new JarFile(zipfile));
            });
        });
    }

    public async readFile(path: string): Promise<Buffer | undefined> {
        if (!this._zipFile.isOpen) {
            throw new Error("The JAR has already been closed, it is not possible to read from it.");
        }

        const cachedEntry = this._entries[path];

        // Cache hit
        if (cachedEntry) {
            return await this.readEntryToBuffer(cachedEntry);
        }

        // Cache miss
        const fileEntry = await this.consumeEntriesUntilMatch(path);

        if (!fileEntry) {
            // File not found. `path` does not exist within the JAR file.
            return undefined;
        }

        return this.readEntryToBuffer(fileEntry);
    }

    public close() {
        this._zipFile.removeAllListeners();
        this._zipFile.close();
    }

    private async consumeEntriesUntilMatch(path: string): Promise<yauzl.Entry | undefined> {
        // Consume until file matches or until no more files to be read
        const fileEntry = await new Promise<yauzl.Entry | undefined>((resolve, _) => {
            const handleEntryMatch = (entry: yauzl.Entry) => {
                this.handleEntry(entry);
                if (entry.fileName === path) {
                    this._zipFile.removeListener("entry", handleEntryMatch);
                    this._zipFile.removeListener("end", handleEnd);
                    return resolve(entry);
                }
                this._zipFile.readEntry();
            };

            const handleEnd = () => {
                this._zipFile.removeListener("entry", handleEntryMatch);
                this._zipFile.removeListener("end", handleEnd);
                return resolve(undefined);
            };

            this._zipFile.on("entry", handleEntryMatch);
            this._zipFile.on("end", handleEnd);

            this._zipFile.readEntry();
        });

        return fileEntry;
    }

    private async readEntryToBuffer(entry: yauzl.Entry): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            this._zipFile.openReadStream(entry, (error, readStream) => {
                if (error) {
                    reject(error);
                }
                resolve(consumers.buffer(readStream));
            });
        });
    }
}
