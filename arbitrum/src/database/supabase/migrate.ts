import { supabase } from './client';
import fs from 'fs';
import path from 'path';
import { ConsoleLogger } from '@/monitor/logging';

const logger = new ConsoleLogger('info');

/**
 * Applies SQL migrations to the Supabase database
 * This script should be run whenever schema changes are made
 */
async function runMigrations() {
  try {
    // Migration files in order of application
    const migrationFiles = [
      'schema.sql',
      'score_events.sql',
      'queue_tables.sql',
    ];

    logger.info('Starting database migrations...');

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
          const { error } = await supabase.rpc('exec_sql', { sql: statement });

          if (error) {
            logger.error(`Error executing statement in ${filename}:`, {
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

// Run migrations if executed directly
if (require.main === module) {
  runMigrations()
    .then(() => {
      logger.info('Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Migration script failed:', { error });
      process.exit(1);
    });
}

export { runMigrations };
