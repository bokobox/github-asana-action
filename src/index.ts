import action from "./action";
const core = require("@actions/core");

async function run() {
  try {
    await action();
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();
