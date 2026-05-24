module.exports = {
  ...require("./config.js"),
  ...require("./git.js"),
  ...require("./hooks.js"),
  ...require("./manifest.js"),
  ...require("./worker-runner.js"),
  ...require("./orchestrator.js"),
  multitask: require("./multitask/index.js"),
};
