import { writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema } from "./index.js";

writeFileSync(new URL("../loage.config.schema.json", import.meta.url), JSON.stringify(z.toJSONSchema(ConfigSchema), null, 2) + "\n");
