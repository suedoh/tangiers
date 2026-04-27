'use strict';

const { MongoClient } = require('mongodb');
const fs   = require('fs');
const path = require('path');

// Load .env into process.env (mirrors lib/env.js behaviour, safe to call multiple times)
(function loadEnv() {
  const envFile = path.resolve(__dirname, '../../.env');
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

async function connect() {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URL, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await _client.connect();
  _db = _client.db('ace_trading');
  return _db;
}

async function disconnect() {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}

const trades          = () => _db.collection('trades');
const triggerState    = () => _db.collection('trigger_state');
const triggerCooldowns= () => _db.collection('trigger_cooldowns');
const newsState       = () => _db.collection('news_state');
const discordBotState = () => _db.collection('discord_bot_state');
const weathermenData  = () => _db.collection('weathermen_data');
const weathermenState = () => _db.collection('weathermen_state');

module.exports = { connect, disconnect, trades, triggerState, triggerCooldowns, newsState, discordBotState, weathermenData, weathermenState };
