import { runScheduledCollection } from "./trigger.js";

export default {
  async scheduled(controller, env) {
    return runScheduledCollection({
      scheduledTime: controller.scheduledTime,
      env,
    });
  },
};
