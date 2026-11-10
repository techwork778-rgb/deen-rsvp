const path = require('path');

// Secrets stay in /var/www/deen-rsvp/.env. This file only pins the process PM2
// resurrects after a reboot: one fork, absolute script path, app cwd.
module.exports = {
  apps: [
    {
      name: 'deen-rsvp-bridge',
      script: path.join(__dirname, 'dev', 'crm-bridge.mjs'),
      cwd: __dirname,
      interpreter: 'node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '5s',
    },
  ],
};