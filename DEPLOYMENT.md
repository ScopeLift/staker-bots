# Deployment Guide

This guide will help you deploy the Staker Bots application to a production environment using Digital Ocean and Supabase.

## Prerequisites

Before deploying, you'll need:

1. **Digital Ocean Account** - Sign up at [digitalocean.com](https://digitalocean.com)
2. **Supabase Account** - Sign up at [supabase.com](https://supabase.com)
3. **Node.js 18+** installed on your deployment server
4. **Git** for cloning the repository

## Environment Setup

### Required Environment Variables

Create a `.env` file in the root directory with the following variables:

```bash
# Required Core Variables
RPC_URL=your_ethereum_rpc_url
STAKER_CONTRACT_ADDRESS=your_staker_contract_address
CHAIN_ID=1
LST_ADDRESS=your_lst_token_address

# Supabase Configuration
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key

# Database Configuration
DB=supabase

# Network Configuration
NETWORK_NAME=mainnet
START_BLOCK=0
POLL_INTERVAL=15
MAX_BLOCK_RANGE=2000
MAX_RETRIES=5
REORG_DEPTH=64
CONFIRMATIONS=20

# Logging
LOG_LEVEL=info

# Executor Configuration
EXECUTOR_TYPE=defender
MIN_GAS_COST=20.0
MAX_GAS_COST=450.0
AVG_GAS_COST=200.0
EXECUTOR_APPROVAL_AMOUNT=1000000000000000000000000

# OpenZeppelin Defender (Required for production)
DEFENDER_MAIN_KEY=your_defender_main_key
DEFENDER_MAIN_SECRET=your_defender_main_secret
DEFENDER_API_KEY=your_defender_api_key
DEFENDER_SECRET_KEY=your_defender_secret_key
PUBLIC_ADDRESS_DEFENDER=your_defender_relayer_address

# Optional: Token Swapping
EXECUTOR_SWAP_TO_ETH=false
UNISWAP_ROUTER_ADDRESS=your_uniswap_router_address
SWAP_SLIPPAGE_TOLERANCE=0.5

# Optional: Price Feed
COINMARKETCAP_API_KEY=your_coinmarketcap_api_key
REWARD_TOKEN_ADDRESS=your_reward_token_address

# Optional: Tenderly Simulation
TENDERLY_USE_SIMULATE=false
TENDERLY_ACCESS_KEY=your_tenderly_access_key
TENDERLY_ACCOUNT_NAME=your_tenderly_account
TENDERLY_PROJECT_NAME=your_tenderly_project

# Profitability Engine
PROFITABILITY_INCLUDE_GAS_COST=true
PROFITABILITY_MIN_PROFIT_MARGIN_PERCENT=10
GOVLST_PAYOUT_AMOUNT=0
GOVLST_MAX_BATCH_SIZE=10
```

### Where to Get Environment Variables

1. **RPC_URL**: Get from providers like [Alchemy](https://alchemy.com), [Infura](https://infura.io), or [QuickNode](https://quicknode.com)
2. **SUPABASE_URL & SUPABASE_KEY**: From your Supabase project dashboard → Settings → API
3. **Contract Addresses**: From your deployed smart contracts
4. **Defender Keys**: From [OpenZeppelin Defender](https://defender.openzeppelin.com) → Relay → Create Relayer
5. **CoinMarketCap API**: From [CoinMarketCap Pro API](https://pro.coinmarketcap.com/api/v1)
6. **Tenderly Keys**: From [Tenderly](https://tenderly.co) → Account Settings → Authorization

## Supabase Setup

1. **Create a new Supabase project**

   - Go to [supabase.com](https://supabase.com)
   - Create a new project
   - Note your project URL and anon key

2. **Run database migrations**

   ```bash
   npm run migrate
   ```

3. **Configure Row Level Security (RLS)**
   - The migration files in `src/database/supabase/migrations/` will set up the required tables
   - Ensure your service key has the necessary permissions

## Digital Ocean Deployment

### Option 1: Local Development

You can run the application locally for development:

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Run specific components
npm run dev:monitor
npm run dev:executor
npm run dev:profitability
```

### Option 2: VPS Deployment (Recommended)

Digital Ocean provides reliable and affordable VPS hosting perfect for running Node.js applications.

#### 1. Create a Digital Ocean Droplet

1. Log into your Digital Ocean account
2. Create a new Droplet:
   - **Image**: Ubuntu 22.04 LTS
   - **Size**: Basic plan, 2GB RAM minimum (4GB recommended)
   - **Region**: Choose closest to your users
   - **Authentication**: SSH keys (recommended) or password

#### 2. Server Setup

Connect to your server via SSH:

```bash
ssh root@your_server_ip
```

Install Node.js and dependencies:

```bash
# Update system
apt update && apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
apt-get install -y nodejs

# Install PM2 globally
npm install -g pm2

# Install Git
apt install git -y

# Create app directory
mkdir -p /opt/staker-bots
cd /opt/staker-bots
```

#### 3. Deploy Application

```bash
# Clone your repository
git clone https://github.com/your-username/staker-bots.git .

# Install dependencies
npm install

# Create environment file
nano .env
# (Add your environment variables here)

# Build the application
npm run build

# Create logs directory
mkdir -p logs
```

#### 4. PM2 Process Management

PM2 is a production process manager that keeps your application running continuously, restarts it if it crashes, and provides monitoring capabilities.

**Why PM2 is Essential:**

- **Auto-restart**: Automatically restarts your app if it crashes
- **Load balancing**: Can run multiple instances
- **Monitoring**: Built-in monitoring and logging
- **Zero-downtime deployments**: Update without stopping service
- **Startup management**: Automatically starts on server boot

**Start the application with PM2:**

```bash
# Start using the ecosystem config
pm2 start ecosystem.config.cjs

# Save PM2 configuration
pm2 save

# Setup PM2 to start on boot
pm2 startup
# Follow the instructions provided by the command above
```

**PM2 Management Commands:**

```bash
# View running processes
pm2 list

# View logs
pm2 logs staker-bots

# Monitor in real-time
pm2 monit

# Restart application
pm2 restart staker-bots

# Stop application
pm2 stop staker-bots

# Delete application from PM2
pm2 delete staker-bots

# Reload application (zero-downtime)
pm2 reload staker-bots
```

#### 5. Firewall Configuration

```bash
# Enable UFW firewall
ufw enable

# Allow SSH
ufw allow ssh

# Allow HTTP/HTTPS if needed
ufw allow 80
ufw allow 443

# Check status
ufw status
```

## Production Checklist

- [ ] Environment variables are properly set
- [ ] Supabase database is set up and migrated
- [ ] OpenZeppelin Defender relayer is configured
- [ ] PM2 is running the application
- [ ] Server firewall is configured
- [ ] Monitoring and alerting are set up
- [ ] Backup strategy is in place

## Monitoring and Maintenance

### Log Management

PM2 automatically manages logs, but you can also:

```bash
# View logs
pm2 logs staker-bots --lines 100

# Clear logs
pm2 flush

# Rotate logs
pm2 install pm2-logrotate
```

### Health Checks

The application includes health check intervals. Monitor your application:

1. Check PM2 status regularly: `pm2 list`
2. Monitor server resources: `htop` or `top`
3. Check disk space: `df -h`
4. Monitor database connections in Supabase dashboard

### Updates

To update your application:

```bash
# Stop the application
pm2 stop staker-bots

# Pull latest changes
git pull origin main

# Install new dependencies
npm install

# Restart with PM2
pm2 restart staker-bots
```

## Troubleshooting

### Common Issues

1. **Environment Variables Not Loading**

   - Ensure `.env` file is in the root directory
   - Check file permissions: `chmod 644 .env`

2. **Database Connection Issues**

   - Verify Supabase URL and key
   - Check network connectivity
   - Ensure migrations have run successfully

3. **PM2 Not Starting on Boot**

   - Run `pm2 startup` and follow instructions
   - Ensure `pm2 save` was run after starting processes

4. **Out of Memory Errors**
   - Increase server RAM
   - Adjust `max_memory_restart` in `ecosystem.config.cjs`

### Getting Help

If you encounter issues:

1. Check PM2 logs: `pm2 logs staker-bots`
2. Check system logs: `journalctl -u pm2-root`
3. Verify environment variables are loaded correctly
4. Test database connectivity separately

## Security Considerations

- Keep your server updated: `apt update && apt upgrade`
- Use SSH key authentication
- Configure fail2ban for SSH protection
- Regularly rotate API keys and secrets
- Monitor application logs for unusual activity
- Use environment variables for all sensitive data (never commit secrets to git)

---

This deployment guide should get your Staker Bots application running in production. The combination of Digital Ocean's reliable infrastructure and PM2's process management provides a robust foundation for your application.
