const { app, prepareApp } = require('../dist/index.js');

const appReady = prepareApp({ initializeScheduledJobs: false });

module.exports = async function handler(req, res) {
  await appReady;
  return app(req, res);
};
