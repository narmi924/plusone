import { Render } from "@renderinc/sdk";
import type { TaskContext, TaskDefinition } from "@renderinc/sdk/workflows";
import type { FastifyBaseLogger } from "fastify";

// Starting a task from the web server. With a Render API key and the workflow's
// slug, it becomes a Render Workflows run; without them (local dev) the same
// function runs right here in the background, chained runs included.

export function createJobs(input: {
  apiKey?: string | undefined;
  workflowSlug?: string | undefined;
  log: FastifyBaseLogger;
}) {
  const { apiKey, workflowSlug, log } = input;
  const render = apiKey && workflowSlug ? new Render({ token: apiKey }) : null;
  const here: TaskContext = {
    metadata: { taskRunId: "local" },
    run: async (t, ...args) => t.func(here, ...args),
  };

  return {
    onRender: Boolean(render),
    /** Fire and forget. The key makes a repeat start the same run, not a second one. */
    async start<A extends unknown[], R>(
      def: TaskDefinition<A, R>,
      args: A,
      idempotencyKey: string,
    ): Promise<string | null> {
      if (render) {
        const run = await render.workflows.startTask(`${workflowSlug}/${def.name}`, args, {
          idempotencyKey,
        });
        log.info({ task: def.name, run: run.taskRunId }, "started Render Workflows run");
        return run.taskRunId;
      }
      void Promise.resolve()
        .then(() => def.func(here, ...args))
        .then((result) => log.info({ task: def.name, result }, "task finished"))
        .catch((err: unknown) => log.error({ err, task: def.name }, "task failed"));
      return null;
    },
  };
}

export type Jobs = ReturnType<typeof createJobs>;
