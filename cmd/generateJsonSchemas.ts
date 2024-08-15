import { zodToJsonSchema } from "zod-to-json-schema";
import * as fs from "fs";
import { resolve } from "path";
import {} from "../src/util/PluginConfigurationUtil";
import { packageJsonSchema, quickcheckConfigSchema } from "../src/util/Schemas";

const schemasDir = "./resources/schemas";

if (!fs.existsSync(schemasDir)) {
    fs.mkdirSync(schemasDir, { recursive: true });
}

function writeSchemaToFile(schema: Zod.ZodType, path: fs.PathLike) {
    const jsonSchema = zodToJsonSchema(schema);
    const jsonSchemaText = JSON.stringify(jsonSchema);

    fs.writeFileSync(path, jsonSchemaText);
}

writeSchemaToFile(packageJsonSchema, resolve(schemasDir, "schema.package.json"));
writeSchemaToFile(quickcheckConfigSchema, resolve(schemasDir, "schema.quickcheck.json"));
