// pm2-конфиг магазина.  Запуск:  pm2 start deploy/ecosystem.config.js
// Правка окружения → pm2 restart sigma-shop --update-env
module.exports = {
  apps: [
    {
      name: 'sigma-shop',
      script: 'server.js',
      cwd: '/home/ubuntu/sigma-shop',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        SITE_URL: 'https://portotecnica.kz',
      },
    },
  ],
};
