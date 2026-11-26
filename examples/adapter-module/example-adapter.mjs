// Example custom adapter for omp-channel (see docs/protocol.md, section 6).
// It shows the shape of the contract. It keeps everything in memory and contacts no service.
// Replace the in-memory queue with calls to your own service.

const queue = [];
const replies = [];

export default {
  async *receive(signal) {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      yield { deliveryId: `local-${next.messageId}`, event: next };
    }
  },

  async reply(reply) {
    replies.push(reply);
  },

  async ack() {
    // Nothing to acknowledge: the queue is in memory and is consumed on delivery.
  },

  async status() {
    // Optional: a real adapter would forward the agent state to the service.
  },
};

// Helper for local experiments: call from another module in the same process.
export function enqueueExample(text) {
  queue.push({
    type: "message",
    conversationId: "example-conversation",
    messageId: `example-${queue.length + 1}`,
    sender: "example-user",
    text,
  });
}
