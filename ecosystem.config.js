// pm2 ecosystem — run everything in the background, iMessage-only UX.
// pm2 start ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'jptr-messaging',
      script: 'messaging/server.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
    },
    {
      name: 'jptr-agent',
      script: 'agent/server.js', // Siri's orchestrator (Runware LLM + terac client)
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
    },
    {
      name: 'jptr-tunnel',
      script: 'cloudflared',
      args: 'tunnel --url http://localhost:4000',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
    },
  ],
};
