module.exports = {
  apps: [{
    name: 'besu-loader',
    script: 'dist/app.js',
    instances: 8,
    exec_mode: 'cluster',
    instance_var: 'INSTANCE_ID',
    env: {
      PORT: 3000,
      BESU_RPC_URL: 'http://localhost:8545',
      ACCOUNT_DATA_DIR: './data',
      GAS_PRICE_WEI: '875000000',
      RPC_TIMEOUT_MS: '5000',
      RECEIPT_TIMEOUT_MS: '30000',
      RECEIPT_POLL_MS: '500',
      TOKEN_DECIMALS: '18',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_USERNAME: 'bcapp',
      REDIS_PASSWORD: '!bok20240',
      NONCE_TTL_SECONDS: '300',
      NODE_ENV: 'production'
    },
    env_development: {
      PORT: 3000,
      BESU_RPC_URL: 'http://localhost:8545',
      ACCOUNT_DATA_DIR: './data',
      GAS_PRICE_WEI: '875000000',
      RPC_TIMEOUT_MS: '5000',
      RECEIPT_TIMEOUT_MS: '30000',
      RECEIPT_POLL_MS: '500',
      TOKEN_DECIMALS: '18',
      REDIS_URL: 'redis://localhost:6379',
      REDIS_USERNAME: 'bcapp',
      REDIS_PASSWORD: '!bok20240',
      NONCE_TTL_SECONDS: '300',
      NODE_ENV: 'development',
      instances: 1
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss.SSS',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
    merge_logs: false
  }]
};
