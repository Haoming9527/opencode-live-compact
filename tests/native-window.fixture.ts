import { randomUUID } from "node:crypto";
import { Plugin } from "@opencode/plugin";

export default Plugin.define({
  id: "native-window-fixture",
  async setup(ctx) {
    const admitted = new Map<string, { id: string; stage: number }>();
    const seenTurns = new Set<string>();
    await ctx.session.hook("experimental.idle", async (event) => {
      if (event.background.length > 0) return;
      const { sessionID } = event;
      const history = await ctx.session.context({ sessionID });
      const user = history.findLast((item) => item.type === "user");
      const assistant = history.findLast((item) => item.type === "assistant");
      if (!user || !assistant || assistant.error || seenTurns.has(assistant.id)) return;
      const stage = Number(user.text.match(/^lc-integration-stage-(\d+)$/)?.[1]);
      if (![11, 13, 15].includes(stage)) return;
      seenTurns.add(assistant.id);
      const id = `msg_${randomUUID().replaceAll("-", "")}`;
      admitted.set(sessionID, { id, stage });
      await ctx.session.compact({ sessionID, id, delivery: "queue" });
    });
    await ctx.session.hook("compaction", async (event) => {
      const plan = admitted.get(event.sessionID);
      if (!plan) return;
      const history = await ctx.session.context({ sessionID: event.sessionID });
      const running = history.find((item) => item.type === "compaction" && item.status === "running" && item.id === plan.id);
      if (!running) return;
      admitted.delete(event.sessionID);
      const compact = new Set([`call_lc_read_${plan.stage}_1`, `call_lc_read_${plan.stage}_2`]);
      const messages = event.messages.map((message) => {
        if (plan.stage === 15 || message.role !== "tool") return message;
        return {
          ...message,
          content: message.content.map((part) => {
            if (!compact.has(part.id) || part.result.type !== "text" || typeof part.result.value !== "string") return part;
            const head = part.result.value.split("\n").slice(0, 2).join("\n");
            return { ...part, result: { ...part.result, value: `${head}\n[Fixture replacement]` } };
          }),
        };
      });
      event.result = {
        summary: "Offline replacement fixture",
        native: { messages: JSON.parse(JSON.stringify(messages)) },
        metadata: { keepID: null, fixtureReplacement: plan.id },
      };
    });
  },
});
