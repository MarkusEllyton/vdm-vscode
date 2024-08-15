import { z } from "zod";

export const packageJsonSchema = z
    .object({
        vdmjEnhancements: z
            .array(z.string().describe("Path to a JAR containing VDMJ enhancements, i.e. annotations, libraries or plugins."))
            .optional()
            .describe("List of paths to all VDMJ enhancements of the VS Code extension represented by this package."),
    })
    .passthrough();

export const quickcheckConfigSchema = z
    .object({
        config: z
            .object({
                timeout: z
                    .number()
                    .int()
                    .gte(1, "The timeout has to be at least 1 second.")
                    .describe("The timeout of a QuickCheck execution in seconds."),
                obligations: z
                    .array(z.number().int().gte(1))
                    .optional()
                    .describe(
                        "A list of proof obligation indexes to run QuickCheck on. When left undefined or as an empty list, the default behavior is to check all proof obligations left after search filtering."
                    ),
            })
            .describe("General configuration."),
        strategies: z
            .array(z.object({}).passthrough().describe("A single strategy configuration."))
            .optional()
            .describe("Configuration of QuickCheck strategies."),
    })
    .describe("Configuration of the QuickCheck plugin.");
