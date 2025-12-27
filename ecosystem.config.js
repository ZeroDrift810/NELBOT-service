module.exports = {
  apps: [
    {
      name: 'nel-master',
      script: 'dist/index.js',
      cwd: 'C:\\LeagueHQ\\NELBOTMASTER',
      interpreter: 'node',
      interpreter_args: ['--env-file=.env'],
      watch: false,
      autorestart: true
    },
    {
      name: 'nel-tunnel',
      script: 'C:\\TOOLS\\CLOUDFLARED.EXE',
      args: 'tunnel run nelbot-tunnel',
      watch: false,
      autorestart: true
    }
  ]
};
