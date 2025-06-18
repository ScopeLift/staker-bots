# Staker Bots Monorepo

- [`rari/`](./rari/) - Rari staker bot implementation

## Architecture Overview

The Rari staker bot is built with a modular architecture that includes:

- **Calculator**: Handles reward calculations and eligibility computations
- **Monitor**: Monitors blockchain events and manages event processing
- **Database**: Provides data persistence with JSON and Supabase implementations
- **Executor**: Manages transaction execution and queue processing
- **Profitability**: Analyzes profitability and determines optimal actions
- **Shared**: Common utilities including price feeds and shared logic

## Development Workflow

1. Install dependencies from the root:
   ```bash
   pnpm install
   ```

2. Navigate to the Rari package and run commands:
   ```bash
   cd rari
   pnpm dev # Development mode
   # or
   pnpm build && pnpm prod # Production mode
   ```

## Project-Specific Documentation

- [Rari Staker Bot](./rari/README.md) - Main implementation

## License

ISC
