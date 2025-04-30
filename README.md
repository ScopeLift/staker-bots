# Staker Bots Monorepo

This monorepo contains various implementations of staker bots for different protocols and chains.

-   [`obol/`](./obol/) - Obol Network staker bot implementation. This is the reference implementation.
-   [`arbitrum/`](./arbitrum/) - Arbitrum staker bot implementation. **(Refactoring In Progress)**

## Goal: Align Arbitrum with Obol Standards

The `arbitrum` bot was developed earlier and has been substantially refactored to match the architecture, code quality, and conventions established in the `obol` bot. This ensures consistency, maintainability, and leverages the latest best practices defined in our development guidelines.

## Arbitrum Refactoring Progress

The following areas in the `arbitrum` package have been reviewed and refactored, using the `obol` package as the template and adhering to the project's coding standards:

1.  **README Enhancement:** 🔄
    *   Updating `arbitrum/README.md` to match the detail and structure of `obol/README.md`. 
    *   Will include architecture diagrams, component descriptions, detailed configuration guidance, and usage instructions.

2.  **Configuration Standardization:** ✅
    *   Implemented a dedicated `src/configuration` directory similar to `obol`.
    *   Standardized environment variable handling and validation to match `obol`.

3.  **Component Architecture Alignment:** ✅
    *   Refactored `arbitrum`'s core components (`calculator`, `monitor`, `profitability`, `executor`, `database`).
    *   Aligned directory structure, interfaces (`src/*/interfaces/`), and core logic patterns with `obol`.
    *   Maintained the `calculator` component but refactored to follow functional patterns.
    *   Ensured clear separation of concerns between components.

4.  **Database Implementation:** ✅
    *   Aligned `arbitrum`'s database interfaces with `obol`'s.
    *   Verified both JSON and Supabase implementations for consistency.
    *   Updated Supabase migrations as needed.

5.  **Build & Run Scripts:** ✅
    *   Standardized `arbitrum/package.json` scripts to mirror `obol/package.json`.
    *   Implemented component selection via environment variables.

6.  **Testing Strategy:** ✅
    *   Enhanced tests in `arbitrum/src/tests/`.
    *   Improved test coverage based on `obol/src/tests/`, focusing on integration tests.
    *   Ensured all tests use real functions (no mocking).

7.  **Dependency Management:** ✅
    *   Audited and updated `arbitrum/package.json` dependencies.
    *   Removed unused packages and aligned versions with `obol`.

8.  **Code Style & Conventions:** ✅
    *   Refactored the entire `arbitrum` codebase to follow project standards.
    *   Applied TypeScript, functional programming, RORO pattern, and error handling patterns.
    *   Converted class-based implementations to functional approaches.
    *   Established consistent naming conventions.

9.  **Price Feeds / Shared Logic:** ✅
    *   Aligned `arbitrum/src/shared/price-feeds/` with `obol/src/prices/`.
    *   Standardized the approach for fetching and managing price data.
    *   Integrated shared logic appropriately across the codebase.

## Development Workflow

1.  Install dependencies from the root:
    ```bash
    pnpm install
    ```
2.  Navigate to the target package and run commands:
    ```bash
    # For Obol
    cd obol
    pnpm dev # Or pnpm build && pnpm prod

    # For Arbitrum (during/after refactoring)
    cd arbitrum
    pnpm dev # Or pnpm build && pnpm prod
    ```

## Project-Specific Documentation

-   [Obol Staker Bot](./obol/README.md) - Reference Implementation
-   [Arbitrum Staker Bot](./arbitrum/README.md) - *(Documentation Update In Progress)*

## License

ISC 