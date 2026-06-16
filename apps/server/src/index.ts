import cors from "cors";
import express from "express";
import { z } from "zod";
import { proposeCodeChange } from "../../../packages/core/src/aiProvider";
import { applyFileChanges, listProjectFiles, readProjectFiles } from "../../../packages/core/src/workspace";

const PORT = Number(process.env.ODOT_PORT ?? 4317);

const providerSchema = z.object({
  name: z.string().min(1).default("OpenAI-compatible"),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional()
});

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    name: "oDot local API",
    version: "0.1.0"
  });
});

app.post("/api/project/files", async (request, response, next) => {
  try {
    const body = z
      .object({
        root: z.string().min(1)
      })
      .parse(request.body);

    const files = await listProjectFiles(body.root);
    response.json({ files });
  } catch (error) {
    next(error);
  }
});

app.post("/api/project/read", async (request, response, next) => {
  try {
    const body = z
      .object({
        root: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1)
      })
      .parse(request.body);

    const files = await readProjectFiles(body.root, body.paths);
    response.json({ files });
  } catch (error) {
    next(error);
  }
});

app.post("/api/ai/propose", async (request, response, next) => {
  try {
    const body = z
      .object({
        root: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        instruction: z.string().min(1),
        provider: providerSchema
      })
      .parse(request.body);

    const files = await readProjectFiles(body.root, body.paths);
    const plan = await proposeCodeChange(body.provider, body.instruction, files);
    response.json({ plan });
  } catch (error) {
    next(error);
  }
});

app.post("/api/changes/apply", async (request, response, next) => {
  try {
    const body = z
      .object({
        root: z.string().min(1),
        changes: z
          .array(
            z.object({
              path: z.string().min(1),
              originalContent: z.string(),
              updatedContent: z.string(),
              patch: z.string()
            })
          )
          .min(1)
      })
      .parse(request.body);

    const result = await applyFileChanges(body.root, body.changes);
    response.json({ result });
  } catch (error) {
    next(error);
  }
});

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    const message =
      error instanceof Error ? error.message : "Unexpected oDot server error.";
    response.status(400).json({ error: message });
  }
);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`oDot local API listening on http://127.0.0.1:${PORT}`);
});

