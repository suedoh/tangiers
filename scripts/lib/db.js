import { MongoClient } from 'mongodb';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env into process.env (ES-module-safe, mirrors lib/env.js behaviour)
(function loadEnv() {
  const envFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
  if (!fs.existsSync(envFile)) return;
  fs.readFileSync(envFile, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const i = trimmed.indexOf('=');
    if (i < 1) return;
    const key = trimmed.slice(0, i).trim();
    if (!process.env[key]) process.env[key] = trimmed.slice(i + 1).trim();
  });
})();

const MONGO_URL = process.env.MONGO_URL
  || 'mongodb://ace:changeme@127.0.0.1:27017/ace_trading?authSource=admin';

let _client = null;
let _db = null;

export async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URL, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await _client.connect();
  _db = _client.db('ace_trading');
  return _db;
}

export async function disconnect() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}

export const trades          = () => _db.collection('trades');
export const triggerState    = () => _db.collection('trigger_state');
export const triggerCooldowns= () => _db.collection('trigger_cooldowns');
export const newsState       = () => _db.collection('news_state');
export const discordBotState = () => _db.collection('discord_bot_state');
