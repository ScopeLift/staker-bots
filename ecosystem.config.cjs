module.exports = {
  apps: [
    {
      name: "staker-bots",
      script: "npx",
      args: "tsx src/index.ts",
      env: {
        NODE_ENV: "production",
        EXECUTOR_TYPE: "wallet",
        COMPONENTS: "all"
      },
      // Process management
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1000G",

      // Logging configuration
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,

      // Process monitoring
      max_restarts: 0, // Changed from 10000 to 0 for infinite restarts
      restart_delay: 4000,
      exp_backoff_restart_delay: 100,

      // Node.js specific
      node_args: "--max-old-space-size=2048",
      exec_mode: "fork"
    }
  ]
}





