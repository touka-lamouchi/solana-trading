import { loadConfig } from "./config_loader";

const { bot } = loadConfig();

export const DEVNET_RPC = bot.network.rpc_url;
export const DEVNET_WS = bot.network.ws_url;
export const AI_SERVER_HOST = bot.ai_server.host;
export const AI_SERVER_PORT = bot.ai_server.port;
export const REDIS_HOST = bot.redis.host;
export const REDIS_PORT = bot.redis.port;
export const PG_DATABASE = bot.database.name;
