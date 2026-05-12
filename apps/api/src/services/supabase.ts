import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { configDotenv } from "dotenv";
import { config } from "../config";
import { logger } from "../lib/logger";
configDotenv();

/** PostgREST code when .single() returns 0 or >1 rows. Use to distinguish "no row" from real DB errors. */
const POSTGREST_NO_ROWS_CODE = "PGRST116";

export function isPostgrestNoRowsError(
  error: { code?: string } | null | undefined,
): boolean {
  return error?.code === POSTGREST_NO_ROWS_CODE;
}

// SupabaseService class initializes the Supabase client conditionally based on environment variables.
class SupabaseService {
  private client: SupabaseClient | null = null;
  private rrClient: SupabaseClient | null = null;

  constructor() {
    const supabaseUrl = config.SUPABASE_URL;
    const supabaseReplicaUrl = config.SUPABASE_REPLICA_URL;
    const supabaseServiceToken = config.SUPABASE_SERVICE_TOKEN;
    const useDbAuthentication = config.USE_DB_AUTHENTICATION;

    if (supabaseUrl && supabaseServiceToken) {
      this.client = createClient(supabaseUrl, supabaseServiceToken, {
        global: {
          headers: {
            "sb-lb-routing-mode": "alpha-all-services",
          },
        },
      });

      const replicaUrl = supabaseReplicaUrl || supabaseUrl;
      this.rrClient = createClient(replicaUrl, supabaseServiceToken);

      if (!useDbAuthentication) {
        logger.info(
          "Supabase client initialized (auth disabled, data features available).",
        );
      }
    } else if (useDbAuthentication) {
      logger.error(
        "USE_DB_AUTHENTICATION is enabled but SUPABASE_URL or SUPABASE_SERVICE_TOKEN is missing. Supabase client will not be initialized.",
      );
    } else {
      logger.warn(
        "Supabase not configured. Features requiring Supabase (interact, profiles) will be unavailable.",
      );
    }
  }

  getClient(): SupabaseClient | null {
    return this.client;
  }

  getRRClient(): SupabaseClient | null {
    return this.rrClient;
  }

  isAvailable(): boolean {
    return this.client !== null;
  }
}

const serv = new SupabaseService();

// Using a Proxy to handle dynamic access to the Supabase client or service methods.
// This approach ensures that if Supabase is not configured, any attempt to use it will result in a clear error.
export const supabase_service: SupabaseClient = new Proxy(serv, {
  get: function (target, prop, receiver) {
    const client = target.getClient();
    // If the Supabase client is not initialized, intercept property access to provide meaningful error feedback.
    if (client === null) {
      return () => {
        throw new Error("Supabase client is not configured.");
      };
    }
    // Direct access to SupabaseService properties takes precedence.
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    // Otherwise, delegate access to the Supabase client.
    return Reflect.get(client, prop, receiver);
  },
}) as unknown as SupabaseClient;

export function isSupabaseAvailable(): boolean {
  return serv.isAvailable();
}

export const supabase_rr_service: SupabaseClient = new Proxy(serv, {
  get: function (target, prop, receiver) {
    const client = target.getRRClient();
    // If the Supabase client is not initialized, intercept property access to provide meaningful error feedback.
    if (client === null) {
      return () => {
        throw new Error("Supabase RR client is not configured.");
      };
    }
    // Direct access to SupabaseService properties takes precedence.
    if (prop in target) {
      return Reflect.get(target, prop, receiver);
    }
    // Otherwise, delegate access to the Supabase client.
    return Reflect.get(client, prop, receiver);
  },
}) as unknown as SupabaseClient;
