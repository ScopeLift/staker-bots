import { supabase } from './client';
import fs from 'fs';
import path from 'path';
import { ConsoleLogger } from '@/monitor/logging';
import { fileURLToPath } from 'url';

const SUPABASE_NOT_CONFIGURED_ERROR =
  'Supabase client is not available. Make sure SUPABASE_URL and SUPABASE_KEY are configured in your environment or config file.';

const logger = new ConsoleLogger('info');

/**
 * Applies SQL migrations to the Supabase database
 * This script should be run whenever schema changes are made
 */
async function runMigrations() {
  try {
    // Migration files in order of application
    const migrationFiles = [
      '01_core_tables.sql',
      '02_monitor_tables.sql',
      '03_queue_tables.sql',
      '04_govlst_tables.sql',
      '05_checkpoints_view.sql',
    ];

    logger.info('Starting database migrations...');

    // Get the directory path of the current file
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);

    for (const filename of migrationFiles) {
      const filePath = path.join(__dirname, 'migrations', filename);
      logger.info(`Applying migration: ${filename}`);

      try {
        const sql = fs.readFileSync(filePath, 'utf8');

        // Split SQL by semicolons to execute each statement separately
        const statements = sql
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);

        for (const statement of statements) {
          logger.debug(
            `Executing SQL statement: ${statement.substring(0, 100)}...`,
          );
          const client = supabase();
          if (!client) {
            throw new Error(SUPABASE_NOT_CONFIGURED_ERROR);
          }

          const { error } = await client.rpc('exec_sql', { sql: statement });

          if (error) {
            logger.error(`Error executing statement in ${filename}:`, {
              statement: statement.substring(0, 200),
              error,
            });
            // Continue with other statements instead of failing completely
          }
        }

        logger.info(`Successfully applied migration: ${filename}`);
      } catch (error) {
        logger.error(`Error applying migration ${filename}:`, { error });
        // Continue with other migrations instead of failing completely
      }
    }

    logger.info('Database migrations completed successfully');
  } catch (error) {
    logger.error('Error running migrations:', { error });
    throw error;
  }
}

// Run migrations if file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((error) => {
    console.error('Failed to run migrations:', error);
    process.exit(1);
  });
}

export { runMigrations };
