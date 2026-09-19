import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "./index.js";

writeFileSync(new URL("../milford.config.schema.json", import.meta.url), JSON.stringify(z.toJSONSchema(ConfigSchema), null, 2) + "\n");
